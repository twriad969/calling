const { EventEmitter } = require('events');

class LogStore extends EventEmitter {
  constructor(limit = 1000) {
    super();
    this.limit = limit;
    this.entries = [];
  }

  add(entry) {
    const payload = {
      id: entry.id || null,
      level: entry.level || 'info',
      message: entry.message,
      context: entry.context || {},
      timestamp: new Date().toISOString()
    };
    this.entries.push(payload);
    if (this.entries.length > this.limit) {
      this.entries.shift();
    }
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
}

module.exports = LogStore;
