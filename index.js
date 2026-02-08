require('dotenv').config();
const http = require('http');
const { URL } = require('url');
const Srf = require('drachtio-srf');
const SipHandler = require('./sip-handler');
const LogStore = require('./logger');

const config = {
  drachtioHost: process.env.DRACHTIO_HOST || '127.0.0.1',
  drachtioPort: Number(process.env.DRACHTIO_PORT || 9022),
  drachtioSecret: process.env.DRACHTIO_SECRET || 'drachtioSecret',
  sipServer: process.env.SIP_SERVER || 'vibeacademy.alphapbx.net:8090',
  extension: process.env.SIP_EXTENSION || '101',
  password: process.env.SIP_PASSWORD || 'W4tP8Jg4TFbY47',
  transport: process.env.SIP_TRANSPORT || 'udp',
  phone: process.env.SIP_PHONE || '09647749047',
  rtpIp: process.env.RTP_IP,
  openAiKey: process.env.OPENAI_API_KEY || '',
  openAiModel: process.env.OPENAI_REALTIME_MODEL || 'gpt-4o-realtime-preview',
  openAiVoice: process.env.OPENAI_VOICE || 'alloy',
  openAiInstructions: process.env.OPENAI_INSTRUCTIONS || 'You are a helpful voice assistant for incoming callers.',
  apiPort: Number(process.env.BRIDGE_API_PORT || 8080)
};

const srf = new Srf();
const logger = new LogStore();
const sipHandler = new SipHandler(srf, config, logger);

function respondJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function startApiServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return respondJson(res, 200, { status: 'ok' });
    }

    if (req.method === 'GET' && url.pathname === '/logs') {
      const callId = url.searchParams.get('callId');
      const limit = url.searchParams.get('limit');
      return respondJson(res, 200, logger.list({ id: callId, limit: limit ? Number(limit) : undefined }));
    }

    if (req.method === 'GET' && url.pathname === '/logs/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });
      const onLog = (entry) => {
        res.write(`data: ${JSON.stringify(entry)}\n\n`);
      };
      logger.on('log', onLog);
      req.on('close', () => logger.off('log', onLog));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/calls') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk.toString();
      });
      req.on('end', async () => {
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch (err) {
          return respondJson(res, 400, { error: 'Invalid JSON body' });
        }

        const number = payload.number || config.phone;
        const topic = payload.topic || '';
        if (!number) {
          return respondJson(res, 400, { error: 'Missing number' });
        }

        try {
          const result = await sipHandler.makeOutboundCall({ number, topic });
          return respondJson(res, 200, { callId: result.callId });
        } catch (err) {
          logger.add({ level: 'error', message: `Outbound call failed: ${err.message}` });
          return respondJson(res, 500, { error: err.message });
        }
      });
      return;
    }

    respondJson(res, 404, { error: 'Not found' });
  });

  server.listen(config.apiPort, () => {
    logger.add({ message: `API server listening on ${config.apiPort}` });
  });
}

srf.connect({
  host: config.drachtioHost,
  port: config.drachtioPort,
  secret: config.drachtioSecret
});

srf.on('connect', async () => {
  logger.add({ message: 'Connected to drachtio server' });
  try {
    await sipHandler.register();
  } catch (err) {
    logger.add({ level: 'error', message: `SIP registration failed: ${err.message}` });
  }
});

srf.on('invite', (req, res) => {
  logger.add({ message: `Incoming call from ${req.callingNumber || 'unknown'}` });
  sipHandler.handleInvite(req, res).catch((err) => {
    logger.add({ level: 'error', message: `Failed to handle invite: ${err.message}` });
    res.send(500);
  });
});

srf.on('error', (err) => {
  logger.add({ level: 'error', message: `drachtio error: ${err.message}` });
});

startApiServer();
