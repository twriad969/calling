const crypto = require('crypto');
const dgram = require('dgram');
const os = require('os');
const { decodeG711, encodeG711, upsample8kTo24k, downsample24kTo8k, int16ToBase64 } = require('./audio-utils');
const OpenAIRealtimeClient = require('./openai-handler');

function md5(content) {
  return crypto.createHash('md5').update(content).digest('hex');
}

function parseWwwAuthenticate(header) {
  const params = {};
  header.replace(/(\w+)="?([^",]+)"?/g, (_, key, value) => {
    params[key] = value;
    return '';
  });
  return params;
}

function buildDigestAuth({ username, password, realm, nonce, uri, method, qop }) {
  const ha1 = md5(`${username}:${realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);
  const cnonce = crypto.randomBytes(8).toString('hex');
  const nc = '00000001';
  let response;
  if (qop) {
    response = md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  } else {
    response = md5(`${ha1}:${nonce}:${ha2}`);
  }
  const authParams = [
    `username="${username}"`,
    `realm="${realm}"`,
    `nonce="${nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`
  ];
  if (qop) {
    authParams.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  }
  return `Digest ${authParams.join(', ')}`;
}

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return '127.0.0.1';
}

function parseSdp(sdp) {
  const lines = sdp.split(/\r?\n/);
  let connection = null;
  let audioPort = null;
  const codecs = {};
  for (const line of lines) {
    if (line.startsWith('c=IN IP4')) {
      connection = line.split(' ')[2];
    }
    if (line.startsWith('m=audio')) {
      const parts = line.split(' ');
      audioPort = parseInt(parts[1], 10);
      parts.slice(3).forEach((pt) => {
        codecs[pt] = null;
      });
    }
    if (line.startsWith('a=rtpmap:')) {
      const [pt, codecInfo] = line.replace('a=rtpmap:', '').split(' ');
      codecs[pt] = codecInfo;
    }
  }
  return { connection, audioPort, codecs };
}

function buildSdp({ ip, port, codec, type }) {
  const payloadType = codec === 'PCMA' ? 8 : 0;
  const rtpmap = codec === 'PCMA' ? 'PCMA/8000' : 'PCMU/8000';
  return [
    'v=0',
    `o=- 0 0 IN IP4 ${ip}`,
    's=OpenAI Bridge',
    `c=IN IP4 ${ip}`,
    't=0 0',
    `m=audio ${port} RTP/AVP ${payloadType}`,
    `a=rtpmap:${payloadType} ${rtpmap}`,
    'a=ptime:20',
    `a=${type}`
  ].join('\r\n');
}

class CallSession {
  constructor({ config, logger, callId, direction, topic }) {
    this.config = config;
    this.logger = logger;
    this.callId = callId;
    this.direction = direction;
    this.topic = topic;
    this.codec = 'PCMU';
    this.remoteIp = null;
    this.remotePort = null;
    this.rtpSocket = null;
    this.openai = null;
    this.sequence = 0;
    this.timestamp = 0;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
  }

  log(message, context = {}) {
    this.logger.add({
      id: this.callId,
      message,
      context: { direction: this.direction, topic: this.topic, ...context }
    });
  }

  async setupRtp(codec) {
    this.codec = codec;
    this.rtpSocket = dgram.createSocket('udp4');
    this.rtpSocket.on('error', (err) => {
      this.log(`RTP socket error: ${err.message}`, { level: 'error' });
    });
    await new Promise((resolve) => this.rtpSocket.bind(0, resolve));
  }

  buildLocalSdp() {
    const localPort = this.rtpSocket.address().port;
    const localIp = this.config.rtpIp || getLocalIp();
    return buildSdp({ ip: localIp, port: localPort, codec: this.codec, type: 'sendrecv' });
  }

  connectOpenAI() {
    const instructions = this.topic
      ? `${this.config.openAiInstructions}\nConversation topic: ${this.topic}`
      : this.config.openAiInstructions;

    this.openai = new OpenAIRealtimeClient({
      apiKey: this.config.openAiKey,
      model: this.config.openAiModel,
      instructions,
      voice: this.config.openAiVoice
    });

    this.openai.on('transcript', (text) => {
      this.log(`Caller: ${text}`);
    });

    let aiTextBuffer = '';
    this.openai.on('text', (delta) => {
      aiTextBuffer += delta;
      if (aiTextBuffer.length > 0 && /[.!?]\s$/.test(aiTextBuffer)) {
        this.log(`Assistant: ${aiTextBuffer.trim()}`);
        aiTextBuffer = '';
      }
    });

    this.openai.on('audio', (samples24k) => {
      const samples8k = downsample24kTo8k(samples24k);
      this.flushAudio(samples8k);
    });

    this.openai.on('error', (err) => {
      this.log(`OpenAI error: ${err.message}`, { level: 'error' });
    });

    return this.openai.connect();
  }

  setRemoteMedia({ ip, port }) {
    this.remoteIp = ip;
    this.remotePort = port;
  }

  sendRtp(payload) {
    if (!this.remoteIp || !this.remotePort) {
      return;
    }
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = this.codec === 'PCMA' ? 8 : 0;
    header.writeUInt16BE(this.sequence, 2);
    header.writeUInt32BE(this.timestamp, 4);
    header.writeUInt32BE(this.ssrc, 8);
    this.sequence = (this.sequence + 1) % 65536;
    this.timestamp += payload.length;
    this.rtpSocket.send(Buffer.concat([header, payload]), this.remotePort, this.remoteIp);
  }

  flushAudio(samples8k) {
    const frameSize = 160;
    for (let offset = 0; offset < samples8k.length; offset += frameSize) {
      const frame = samples8k.slice(offset, offset + frameSize);
      const padded = frame.length < frameSize ? new Int16Array(frameSize) : null;
      if (padded) {
        padded.set(frame);
      }
      const payload = encodeG711(padded || frame, this.codec);
      this.sendRtp(payload);
    }
  }

  startRtpListener() {
    if (!this.rtpSocket) return;
    this.rtpSocket.on('message', (msg) => {
      if (msg.length < 12) return;
      const payload = msg.slice(12);
      const samples8k = decodeG711(payload, this.codec);
      const samples24k = upsample8kTo24k(samples8k);
      this.openai.sendAudio(int16ToBase64(samples24k));
    });
  }

  async start(remoteSdp) {
    const { connection, audioPort, codecs } = parseSdp(remoteSdp || '');
    if (!audioPort) {
      this.log('Missing audio port in SDP response', { level: 'error' });
      throw new Error('Missing audio port in SDP response');
    }
    this.codec = Object.values(codecs).some((c) => c && c.startsWith('PCMA')) ? 'PCMA' : 'PCMU';
    if (!this.rtpSocket) {
      await this.setupRtp(this.codec);
    }
    this.setRemoteMedia({
      ip: connection || this.remoteIp,
      port: audioPort || this.remotePort
    });
    await this.connectOpenAI();
    this.startRtpListener();
    this.log('Media bridge started', { codec: this.codec, remoteIp: this.remoteIp, remotePort: this.remotePort });
  }

  close() {
    if (this.rtpSocket) {
      this.rtpSocket.close();
    }
    if (this.openai) {
      this.openai.close();
    }
    this.log('Call session closed');
  }
}

class SipHandler {
  constructor(srf, config, logger) {
    this.srf = srf;
    this.config = config;
    this.logger = logger;
    this.registrationTimer = null;
  }

  log(message, context = {}) {
    this.logger.add({ message, context });
  }

  async register() {
    const uri = `sip:${this.config.sipServer}`;
    const registerRequest = async (authHeader) => {
      return this.srf.request(uri, {
        method: 'REGISTER',
        headers: {
          To: `<sip:${this.config.extension}@${this.config.sipServer}>`,
          From: `<sip:${this.config.extension}@${this.config.sipServer}>;tag=bridge`,
          Contact: `<sip:${this.config.extension}@${this.config.sipServer}>`,
          'User-Agent': 'OpenAI-Bridge',
          Expires: 300,
          ...(authHeader ? { Authorization: authHeader } : {})
        }
      });
    };

    const res = await registerRequest();
    if (res.status === 401 && res.get('www-authenticate')) {
      const challenge = parseWwwAuthenticate(res.get('www-authenticate'));
      const authHeader = buildDigestAuth({
        username: this.config.extension,
        password: this.config.password,
        realm: challenge.realm,
        nonce: challenge.nonce,
        uri,
        method: 'REGISTER',
        qop: challenge.qop
      });
      const authRes = await registerRequest(authHeader);
      if (authRes.status >= 300) {
        throw new Error(`REGISTER failed: ${authRes.status}`);
      }
      this.log('SIP registration complete', { status: authRes.status });
      this.scheduleRegistration();
      return;
    }
    if (res.status >= 300) {
      throw new Error(`REGISTER failed: ${res.status}`);
    }
    this.log('SIP registration complete', { status: res.status });
    this.scheduleRegistration();
  }

  scheduleRegistration() {
    if (this.registrationTimer) {
      clearTimeout(this.registrationTimer);
    }
    const refreshMs = 270 * 1000;
    this.registrationTimer = setTimeout(() => {
      this.register().catch((err) => {
        this.log(`SIP re-registration failed: ${err.message}`, { level: 'error' });
      });
    }, refreshMs);
  }

  async handleInvite(req, res) {
    const callId = req.get('Call-ID') || crypto.randomUUID();
    const session = new CallSession({
      config: this.config,
      logger: this.logger,
      callId,
      direction: 'inbound'
    });
    session.log(`Incoming call from ${req.callingNumber || 'unknown'}`);

    await session.setupRtp('PCMU');
    const { connection, audioPort, codecs } = parseSdp(req.body || '');
    if (!audioPort) {
      session.log('Missing audio port in SDP offer', { level: 'error' });
      res.send(488);
      session.close();
      return;
    }
    session.codec = Object.values(codecs).some((c) => c && c.startsWith('PCMA')) ? 'PCMA' : 'PCMU';
    session.setRemoteMedia({ ip: connection || req.source_address, port: audioPort });

    const answerSdp = buildSdp({
      ip: (this.config.rtpIp || getLocalIp()),
      port: session.rtpSocket.address().port,
      codec: session.codec,
      type: 'sendrecv'
    });
    res.send(200, { body: answerSdp, headers: { 'Content-Type': 'application/sdp' } });

    await session.connectOpenAI();
    session.startRtpListener();

    const cleanup = () => session.close();
    req.on('cancel', cleanup);
    req.on('bye', cleanup);
  }

  async makeOutboundCall({ number, topic }) {
    const callId = crypto.randomUUID();
    const session = new CallSession({
      config: this.config,
      logger: this.logger,
      callId,
      direction: 'outbound',
      topic
    });

    await session.setupRtp('PCMU');
    const localSdp = session.buildLocalSdp();
    const targetUri = `sip:${number}@${this.config.sipServer};transport=${this.config.transport}`;

    session.log(`Placing outbound call to ${number}`);

    const dialog = await this.srf.createUAC(targetUri, {
      localSdp,
      auth: {
        username: this.config.extension,
        password: this.config.password
      },
      headers: {
        From: `<sip:${this.config.extension}@${this.config.sipServer}>`,
        'User-Agent': 'OpenAI-Bridge'
      }
    });

    const remoteSdp = dialog.remote?.sdp;
    if (!remoteSdp) {
      session.log('Missing remote SDP in outbound call response', { level: 'error' });
      session.close();
      throw new Error('Missing remote SDP in outbound call response');
    }
    await session.start(remoteSdp);

    dialog.on('destroy', () => session.close());

    return { callId };
  }
}

module.exports = SipHandler;
