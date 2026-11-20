'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runInNewContext } = require('node:vm');
const { Worker } = require('node:worker_threads');
const { loadTickBars } = require('./footprint-ticks.cjs');

test('preload forwards the main process tick-bar events to the chart subscription', () => {
  const mainSource = readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const channel = mainSource.match(/subscriber\.sender\.send\('([^']+)', \{ subscriptionId, bar \}\)/)?.[1];
  assert.ok(channel, 'main must publish tick bars');
  const ipcRenderer = new EventEmitter();
  let subscription;
  ipcRenderer.send = () => {};
  ipcRenderer.invoke = async (name, request) => {
    if (name === 'market-data:subscribe-tick-bars') subscription = request;
  };
  const exposed = {};
  runInNewContext(readFileSync(path.join(__dirname, 'preload.cjs'), 'utf8'), {
    require: () => ({
      ipcRenderer,
      contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
    }),
    window: { addEventListener() {} },
    document: { addEventListener() {} },
    MutationObserver: class { observe() {} },
  });
  const delivered = [];
  const stop = exposed.velaMt5.subscribeTickBars('mt5', 'EURUSD', 75, bar => delivered.push(bar));
  const bar = { time: 123, open: 1, high: 2, low: 1, close: 2 };
  ipcRenderer.emit(channel, {}, { subscriptionId: 'some-other-chart', bar });
  ipcRenderer.emit(channel, {}, { subscriptionId: subscription.subscriptionId, bar });
  stop();
  ipcRenderer.emit(channel, {}, { subscriptionId: subscription.subscriptionId, bar });
  assert.deepEqual(delivered, [bar]);
});

test('history uses the newest ticks even when the first forward page reaches the count', async () => {
  const ticks = Array.from({ length: 71 }, (_, index) => ({ time: 850_000 + index * 2_000, bid: 100 + index }));
  const fetchTicks = async ({ fromMsc, limit }) => ticks.filter(tick => tick.time >= fromMsc).slice(0, limit);
  const request = { ticker: 'EURUSD', ticksPerBar: 2, to: 1_000_000, limit: 2 };
  for (const from of [undefined, 850_000]) {
    const bars = await loadTickBars(fetchTicks, { ...request, from });
    assert.deepEqual(bars.map(bar => bar.close), [168, 170]);
  }
});

test('tick-bar process loads historical ticks and returns aggregated candles', async () => {
  const worker = new Worker(path.join(__dirname, 'tick-bar-process.cjs'));
  const ticks = Array.from({ length: 6 }, (_, index) => ({
    time: 100 + index * 100,
    bid: 10 + index,
    ask: 10 + index,
    last: 0,
    volume: 1,
    volumeReal: 1,
    flags: 0,
  }));

  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for tick-bar worker.')), 5_000);
      worker.on('message', message => {
        if (message.type === 'fetch-ticks') {
          worker.postMessage({ type: 'fetch-ticks-result', id: message.id, ticks });
        } else if (message.type === 'tick-bars-result') {
          clearTimeout(timeout);
          resolve(message);
        }
      });
      worker.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.postMessage({
        type: 'tick-bars-request',
        id: 'history-request',
        request: { provider: 'mt5', ticker: 'EURUSD', ticksPerBar: 2, from: 100, to: 600, limit: 2 },
      });
    });

    assert.equal(result.error, undefined);
    assert.deepEqual(result.bars.map(bar => [bar.time, bar.open, bar.high, bar.low, bar.close]), [
      [300, 12, 13, 12, 13],
      [500, 14, 15, 14, 15],
    ]);
  } finally {
    await worker.terminate();
  }
});

test('tick-bar process aggregates live ticks before publishing bars', async () => {
  const worker = new Worker(path.join(__dirname, 'tick-bar-process.cjs'));
  const bars = [];
  try {
    const result = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for live tick bars.')), 5_000);
      worker.on('message', message => {
        if (message.type === 'tick-bars-subscription-result') {
          worker.postMessage({
            type: 'tick-bars-live-ticks',
            subscriptionId: 'live-1',
            ticks: [
              { time: 100, bid: 10, ask: 10, last: 0, volumeReal: 1 },
              { time: 101, bid: 11, ask: 11, last: 0, volumeReal: 1 },
              { time: 102, bid: 9, ask: 9, last: 0, volumeReal: 1 },
            ],
          });
        } else if (message.type === 'tick-bar') {
          bars.push(message.bar);
          if (bars.length === 3) {
            clearTimeout(timeout);
            resolve();
          }
        }
      });
      worker.once('error', error => {
        clearTimeout(timeout);
        reject(error);
      });
      worker.postMessage({
        type: 'tick-bars-subscribe',
        id: 'subscribe-1',
        subscriptionId: 'live-1',
        provider: 'mt5',
        ticker: 'EURUSD',
        ticksPerBar: 2,
      });
    });

    await result;
    assert.deepEqual(bars.map(bar => [bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume]), [
      [100, 10, 10, 10, 10, 1],
      [100, 10, 11, 10, 11, 2],
      [102, 9, 9, 9, 9, 1],
    ]);
  } finally {
    await worker.terminate();
  }
});
