class Mt5TickStreamSubscriptions {
  constructor() {
    this.streams = new Map();
  }

  async acquire(key, subscriberId, start) {
    if (typeof key !== 'string' || !key || typeof subscriberId !== 'string' || !subscriberId
      || typeof start !== 'function') {
      throw new TypeError('A stream key, subscriber ID, and start function are required.');
    }

    let entry = this.streams.get(key);
    if (!entry) {
      entry = { subscribers: new Set(), stop: null, ready: null };
      this.streams.set(key, entry);
      entry.ready = Promise.resolve()
        .then(start)
        .then(stop => {
          if (typeof stop !== 'function') throw new TypeError('The MT5 tick stream did not return a stop function.');
          entry.stop = stop;
          if (this.streams.get(key) !== entry || entry.subscribers.size === 0) this.stopEntry(entry);
        })
        .catch(error => {
          if (this.streams.get(key) === entry) this.streams.delete(key);
          throw error;
        });
    }

    entry.subscribers.add(subscriberId);
    await entry.ready;
  }

  release(key, subscriberId) {
    const entry = this.streams.get(key);
    if (!entry || !entry.subscribers.delete(subscriberId) || entry.subscribers.size > 0) return;
    this.streams.delete(key);
    if (entry.stop) this.stopEntry(entry);
  }

  stopAll() {
    const entries = [...this.streams.values()];
    this.streams.clear();
    for (const entry of entries) {
      entry.subscribers.clear();
      if (entry.stop) this.stopEntry(entry);
    }
  }

  stopEntry(entry) {
    const stop = entry.stop;
    entry.stop = null;
    stop?.();
  }
}

module.exports = { Mt5TickStreamSubscriptions };
