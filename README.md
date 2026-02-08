# SIP ↔ OpenAI Realtime Bridge

This project runs a Dockerized SIP bridge that registers to your SIP provider, answers inbound calls, and streams RTP audio to the OpenAI Realtime API. Audio is transcoded between G.711 (8 kHz) and PCM16 (24 kHz).

## Architecture
- **drachtio-server**: SIP signaling server.
- **nodejs-bridge**: Node.js app that registers to the SIP server, answers calls, and connects to OpenAI Realtime API over WebSockets.

## Prerequisites
- Docker + Docker Compose
- OpenAI API key with access to the Realtime API

## Configuration
1. Update `.env` with your OpenAI API key.
2. If you need to force a specific RTP IP address (e.g., public IP), set `RTP_IP` in `.env`.
3. The bridge API listens on `BRIDGE_API_PORT` (default `8080`).

## Run
```bash
docker-compose up --build
```

The bridge will:
- Register extension **101** to **vibeacademy.alphapbx.net:8090**
- Answer inbound calls on UDP
- Stream audio to OpenAI Realtime API
- Log caller transcripts and assistant responses in the container logs

## Bridge API
The Node.js service exposes a small HTTP API for monitoring logs and placing outbound calls.

### Health
```bash
GET http://localhost:8080/health
```

### Logs
```bash
GET http://localhost:8080/logs
GET http://localhost:8080/logs?callId=<callId>&limit=200
```

### Log streaming (SSE)
```bash
GET http://localhost:8080/logs/stream
```

### Outbound call with topic
```bash
POST http://localhost:8080/calls
Content-Type: application/json

{
  "number": "09647749047",
  "topic": "Class schedule and enrollment"
}
```

If `number` is omitted, the bridge will dial the configured `SIP_PHONE`.

## Files
- `docker-compose.yml` — Compose stack for drachtio + Node.js bridge
- `Dockerfile` — Node.js app container
- `drachtio.conf.xml` — SIP server configuration
- `index.js`, `sip-handler.js`, `openai-handler.js`, `audio-utils.js` — bridge implementation
- `.env.example` — environment template
