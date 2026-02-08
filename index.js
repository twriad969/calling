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
const diagnostics = {
  drachtio: { status: 'pending', message: 'Not connected' },
  sip: { status: 'pending', message: 'Not registered' },
  openai: { status: 'pending', message: 'Not validated' },
  api: { status: 'pending', message: 'Starting' }
};

function respondJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function startApiServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === 'GET' && url.pathname === '/health') {
      return respondJson(res, 200, diagnostics);
    }

    if (req.method === 'GET' && url.pathname === '/testing') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>OpenAI SIP Bridge Diagnostics</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 2rem; background: #0f172a; color: #e2e8f0; }
    h1 { margin-bottom: 0.5rem; }
    .card { background: #1e293b; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; }
    .status { display: flex; gap: 0.5rem; align-items: center; }
    .ok { color: #22c55e; }
    .warn { color: #eab308; }
    .err { color: #ef4444; }
    button { background: #38bdf8; border: none; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; }
    input { padding: 0.5rem; width: 100%; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #e2e8f0; }
  </style>
</head>
<body>
  <h1>OpenAI SIP Bridge Diagnostics</h1>
  <p>Live status and outbound call demo.</p>

  <div class="card">
    <h2>Status</h2>
    <div id="status"></div>
  </div>

  <div class="card">
    <h2>Make a Call</h2>
    <label>Number</label>
    <input id="number" placeholder="09647749047" />
    <label>Topic</label>
    <input id="topic" placeholder="Demo call topic" />
    <button id="callBtn">Start Call</button>
    <div id="callResult"></div>
  </div>

  <script>
    async function refreshStatus() {
      const res = await fetch('/health');
      const data = await res.json();
      const container = document.getElementById('status');
      container.innerHTML = '';
      for (const [key, value] of Object.entries(data)) {
        const statusClass = value.status === 'ok' ? 'ok' : value.status === 'warn' ? 'warn' : 'err';
        const emoji = value.status === 'ok' ? '✅' : value.status === 'warn' ? '⚠️' : value.status === 'pending' ? '⏳' : '❌';
        const div = document.createElement('div');
        div.className = 'status';
        div.innerHTML = '<strong>' + key + '</strong>: <span class="' + statusClass + '">' + emoji + ' ' + value.message + '</span>';
        container.appendChild(div);
      }
    }
    document.getElementById('callBtn').addEventListener('click', async () => {
      const number = document.getElementById('number').value.trim();
      const topic = document.getElementById('topic').value.trim();
      const res = await fetch('/calls', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ number, topic })
      });
      const data = await res.json();
      document.getElementById('callResult').textContent = JSON.stringify(data);
    });
    refreshStatus();
    setInterval(refreshStatus, 5000);
  </script>
</body>
</html>`);
      return;
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
    diagnostics.api = { status: 'ok', message: `Listening on ${config.apiPort}` };
    logger.add({ message: `✅ API server listening on ${config.apiPort}` });
  });
}

srf.connect({
  host: config.drachtioHost,
  port: config.drachtioPort,
  secret: config.drachtioSecret
});

srf.on('connect', async () => {
  diagnostics.drachtio = { status: 'ok', message: 'Connected' };
  logger.add({ message: '✅ Connected to drachtio server' });
  try {
    await sipHandler.register();
    diagnostics.sip = { status: 'ok', message: 'Registered' };
    logger.add({ message: '✅ SIP registration complete' });
  } catch (err) {
    diagnostics.sip = { status: 'error', message: err.message };
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
  diagnostics.drachtio = { status: 'error', message: err.message };
  logger.add({ level: 'error', message: `drachtio error: ${err.message}` });
});

function validateOpenAI() {
  if (!config.openAiKey) {
    diagnostics.openai = { status: 'error', message: 'Missing OPENAI_API_KEY' };
    logger.add({ level: 'error', message: '❌ Missing OPENAI_API_KEY' });
    return;
  }
  diagnostics.openai = { status: 'ok', message: 'API key present' };
  logger.add({ message: '✅ OpenAI API key present' });
}

validateOpenAI();
startApiServer();
