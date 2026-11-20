'use strict';

class TickBarService {
  constructor({ utilityProcess, scriptPath, fetchTicks, onBar }) {
    if (!utilityProcess || typeof utilityProcess.fork !== 'function'
      || typeof scriptPath !== 'string' || typeof fetchTicks !== 'function' || typeof onBar !== 'function') {
      throw new Error('The tick-bar utility process is not configured.');
    }
    this.utilityProcess = utilityProcess;
    this.scriptPath = scriptPath;
    this.fetchTicks = fetchTicks;
    this.onBar = onBar;
    this.sequence = 0;
    this.pending = new Map();
    this.children = new Map();
    this.childProviders = new Map();
    this.subscriptions = new Map();
  }

  request(request) {
    const provider = typeof request?.provider === 'string' ? request.provider.trim().toLowerCase() : '';
    const child = this.ensureProcess(provider);
    return this.sendRequest(child, 'tick-bars-request', {
      request: { ...request, provider },
    }, 'tick-bars-result', 'tick-bars');
  }

  subscribe(subscriptionId, provider, ticker, ticksPerBar) {
    if (typeof subscriptionId !== 'string' || !subscriptionId.trim()
      || typeof provider !== 'string' || !provider.trim()
      || typeof ticker !== 'string' || !ticker.trim()
      || !Number.isSafeInteger(ticksPerBar) || ticksPerBar < 1 || ticksPerBar > 10_000) {
      throw new Error('A valid tick-bar subscription is required.');
    }
    provider = provider.trim().toLowerCase();
    if (this.subscriptions.has(subscriptionId)) throw new Error('Tick-bar subscription already exists.');
    const child = this.ensureProcess(provider);
    this.subscriptions.set(subscriptionId, provider);
    return this.sendRequest(child, 'tick-bars-subscribe', { subscriptionId, provider, ticker, ticksPerBar },
      'tick-bars-subscription-result', 'tick-subscribe').catch(error => {
      this.subscriptions.delete(subscriptionId);
      throw error;
    });
  }

  pushTicks(subscriptionId, ticks) {
    const provider = this.subscriptions.get(subscriptionId);
    const child = provider ? this.children.get(provider) : null;
    if (child) child.postMessage({ type: 'tick-bars-live-ticks', subscriptionId, ticks });
  }

  unsubscribe(subscriptionId) {
    const provider = this.subscriptions.get(subscriptionId);
    this.subscriptions.delete(subscriptionId);
    const child = provider ? this.children.get(provider) : null;
    if (child) child.postMessage({ type: 'tick-bars-unsubscribe', subscriptionId });
  }

  sendRequest(child, type, payload, responseType, idPrefix) {
    this.sequence += 1;
    const id = `${idPrefix}-${this.sequence}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { child, responseType, resolve, reject });
      try {
        child.postMessage({ type, id, ...payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  ensureProcess(provider) {
    if (typeof provider !== 'string' || !provider.trim() || provider.length > 40) {
      throw new Error('A valid tick-data provider is required.');
    }
    const key = provider.trim().toLowerCase();
    const existing = this.children.get(key);
    if (existing) return existing;
    const child = this.utilityProcess.fork(this.scriptPath, [], {
      serviceName: `Omega ${key} Tick Data`,
    });
    this.children.set(key, child);
    this.childProviders.set(child, key);
    child.on('message', message => this.handleMessage(child, message));
    child.on('error', (type, location) => {
      this.failProcess(child, new Error(`Tick-history process for ${key} failed (${type}) at ${location}.`));
    });
    child.on('exit', code => {
      this.failProcess(child, new Error(`Tick-history process for ${key} stopped unexpectedly (exit ${code}).`));
    });
    return child;
  }

  handleMessage(child, message) {
    const provider = this.childProviders.get(child);
    if (!provider) return;
    if (message?.type === 'fetch-ticks') {
      if (message.provider !== provider) return;
      Promise.resolve().then(() => this.fetchTicks(provider, message.request)).then(
        ticks => {
          if (this.children.get(provider) === child) child.postMessage({ type: 'fetch-ticks-result', id: message.id, ticks });
        },
        error => {
          if (this.children.get(provider) === child) {
            child.postMessage({
              type: 'fetch-ticks-result',
              id: message.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
      return;
    }
    if (message?.type === 'tick-bar') {
      if (this.children.get(provider) === child && this.subscriptions.get(message.subscriptionId) === provider) {
        this.onBar(message.subscriptionId, message.bar);
      }
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending || pending.child !== child || pending.responseType !== message.type) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.type === 'tick-bars-result' ? message.bars : true);
  }

  failProcess(child, error) {
    const provider = this.childProviders.get(child);
    if (!provider) return;
    if (this.children.get(provider) === child) this.children.delete(provider);
    this.childProviders.delete(child);
    for (const [id, subscriptionProvider] of this.subscriptions) {
      if (subscriptionProvider === provider) this.subscriptions.delete(id);
    }
    for (const [id, pending] of this.pending) {
      if (pending.child !== child) continue;
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  stop(provider) {
    const key = typeof provider === 'string' ? provider.trim().toLowerCase() : '';
    const children = key
      ? [[key, this.children.get(key)]]
      : [...this.children.entries()];
    for (const [key, child] of children) {
      if (!child) continue;
      this.failProcess(child, new Error(`Tick-history process for ${key} stopped.`));
      child.kill();
    }
  }
}

module.exports = { TickBarService };
