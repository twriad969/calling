const EventEmitter = require('events');
const WebSocket = require('ws');
const { base64ToInt16 } = require('./audio-utils');

class OpenAIRealtimeClient extends EventEmitter {
  constructor(options) {
    super();
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.instructions = options.instructions;
    this.voice = options.voice;
    this.ws = null;
    this.isReady = false;
  }

  connect() {
    if (!this.apiKey) {
      return Promise.reject(new Error('Missing OpenAI API key'));
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`wss://api.openai.com/v1/realtime?model=${this.model}`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'OpenAI-Beta': 'realtime=v1'
        }
      });

      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({
          type: 'session.update',
          session: {
            instructions: this.instructions,
            voice: this.voice,
            input_audio_format: 'pcm16',
            output_audio_format: 'pcm16',
            turn_detection: { type: 'server_vad' },
            input_audio_transcription: { model: 'gpt-4o-mini-transcribe' }
          }
        }));
        this.isReady = true;
        this.emit('ready');
        resolve();
      });

      this.ws.on('message', (data) => {
        let message;
        try {
          message = JSON.parse(data.toString());
        } catch (err) {
          this.emit('error', err);
          return;
        }

        switch (message.type) {
          case 'response.audio.delta': {
            if (message.delta) {
              const samples = base64ToInt16(message.delta);
              this.emit('audio', samples);
            }
            break;
          }
          case 'response.text.delta':
          case 'response.output_text.delta': {
            if (message.delta) {
              this.emit('text', message.delta);
            }
            break;
          }
          case 'input_audio_transcription.completed': {
            if (message.transcript) {
              this.emit('transcript', message.transcript);
            }
            break;
          }
          case 'error': {
            this.emit('error', new Error(message.error?.message || 'OpenAI realtime error'));
            break;
          }
          default:
            break;
        }
      });

      this.ws.on('close', () => {
        this.isReady = false;
        this.emit('close');
      });

      this.ws.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });
    });
  }

  sendAudio(base64Audio) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.isReady) {
      return;
    }
    this.ws.send(JSON.stringify({
      type: 'input_audio_buffer.append',
      audio: base64Audio
    }));
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

module.exports = OpenAIRealtimeClient;
