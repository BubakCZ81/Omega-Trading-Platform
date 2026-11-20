'use strict';

const { parentPort: workerThreadPort } = require('node:worker_threads');
const { loadTickBars } = require('./footprint-ticks.cjs');

const parentPort = process.parentPort || workerThreadPort;
if (!parentPort) throw new Error('Tick-history process requires a parent message port.');

let requestSequence = 0;
const pendingTickRequests = new Map();
const subscriptions = new Map();
const fetchTicks = (provider, request) => new Promise((resolve, reject) => {
  requestSequence += 1;
  const id = `ticks-${requestSequence}`;
  pendingTickRequests.set(id, { resolve, reject });
  parentPort.postMessage({ type: 'fetch-ticks', id, provider, request });
});

function tickPrice(tick) {
  if (Number(tick.last) > 0) return Number(tick.last);
  if (Number(tick.bid) > 0) return Number(tick.bid);
  return Number(tick.ask);
}

function updateLiveTickBar(subscription, tick) {
  const time = Number(tick?.time);
  const price = tickPrice(tick ?? {});
  if (!Number.isFinite(time) || time < 0 || !Number.isFinite(price) || price <= 0) return;
  const current = subscription.current;
  if (!current) {
    subscription.current = {
      time: Math.max(time, subscription.previousBarTime + 1),
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Number(tick.volumeReal) > 0 ? Number(tick.volumeReal) : 0,
      tickCount: 0,
    };
  } else {
    current.high = Math.max(current.high, price);
    current.low = Math.min(current.low, price);
    current.close = price;
    if (Number(tick.volumeReal) > 0) current.volume += Number(tick.volumeReal);
  }
  const active = subscription.current;
  active.tickCount += 1;
  const { tickCount, ...bar } = active;
  parentPort.postMessage({ type: 'tick-bar', subscriptionId: subscription.id, bar });
  if (tickCount >= subscription.ticksPerBar) {
    subscription.previousBarTime = active.time;
    subscription.current = null;
  }
}

parentPort.on('message', event => {
  const message = event?.data ?? event;
  if (message?.type === 'fetch-ticks-result') {
    const pending = pendingTickRequests.get(message.id);
    if (!pending) return;
    pendingTickRequests.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.ticks);
    return;
  }
  if (message?.type === 'tick-bars-subscribe') {
    const subscriptionId = typeof message.subscriptionId === 'string' ? message.subscriptionId.trim() : '';
    const provider = typeof message.provider === 'string' ? message.provider.trim().toLowerCase() : '';
    const ticker = typeof message.ticker === 'string' ? message.ticker.trim() : '';
    const ticksPerBar = Number(message.ticksPerBar);
    const error = !subscriptionId || subscriptionId.length > 128 || !provider || provider.length > 40 || !ticker || ticker.length > 100
      || !Number.isSafeInteger(ticksPerBar) || ticksPerBar < 1 || ticksPerBar > 10_000
      ? 'Invalid tick-bar subscription.'
      : subscriptions.has(subscriptionId) ? 'Tick-bar subscription already exists.' : null;
    if (!error) {
      subscriptions.set(subscriptionId, {
        id: subscriptionId, provider, ticker, ticksPerBar, previousBarTime: -1, current: null,
      });
    }
    parentPort.postMessage({
      type: 'tick-bars-subscription-result',
      id: message.id,
      ...(error ? { error } : {}),
    });
    return;
  }
  if (message?.type === 'tick-bars-unsubscribe') {
    subscriptions.delete(message.subscriptionId);
    return;
  }
  if (message?.type === 'tick-bars-live-ticks') {
    const subscription = subscriptions.get(message.subscriptionId);
    if (!subscription || !Array.isArray(message.ticks)) return;
    for (const tick of message.ticks) updateLiveTickBar(subscription, tick);
    return;
  }
  if (message?.type !== 'tick-bars-request') return;

  void loadTickBars(request => fetchTicks(message.request.provider, request), message.request).then(
    bars => parentPort.postMessage({ type: 'tick-bars-result', id: message.id, bars }),
    error => parentPort.postMessage({
      type: 'tick-bars-result',
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
});
