const { EventEmitter } = require('events');
const chalk = require('chalk');

class LogStore extends EventEmitter {
  constructor(limit = 1000) {
    super();
    this.limit = limit;
    this.entries = [];
  }

  add(entry) {
    const rawContext = entry.context || {};
    const level = entry.level || rawContext.level || 'info';
    const { level: _ignored, ...context } = rawContext;
    const payload = {
      id: entry.id || null,
      level,
      message: entry.message,
      context,
      timestamp: new Date().toISOString()
    };
    this.entries.push(payload);
    if (this.entries.length > this.limit) {
      this.entries.shift();
    }
    this.print(payload);
    this.emit('log', payload);
    return payload;
  }

  list({ id, limit } = {}) {
    let result = this.entries;
    if (id) {
      result = result.filter((entry) => entry.id === id);
    }
    if (limit) {
      result = result.slice(-limit);
    }
    return result;
  }

  print(payload) {
    const levelColor = {
      info: chalk.cyan,
      warn: chalk.yellow,
      error: chalk.red,
      debug: chalk.gray
    }[payload.level] || chalk.white;
    const tag = payload.id ? `[${payload.id}]` : '';
    const context = Object.keys(payload.context || {}).length
      ? ` ${chalk.gray(JSON.stringify(payload.context))}`
      : '';
    // eslint-disable-next-line no-console
    console.log(
      `${chalk.dim(payload.timestamp)} ${levelColor(payload.level.toUpperCase())} ${tag} ${payload.message}${context}`.trim()
    );
  }
}

module.exports = LogStore;
