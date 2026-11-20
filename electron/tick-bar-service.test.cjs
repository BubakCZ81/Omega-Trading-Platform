'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { TickBarService } = require('./tick-bar-service.cjs');

class FakeUtilityProcess extends EventEmitter {
  messages = [];
  killed = false;

  postMessage(message) {
    this.messages.push(message);
  }

  kill() {
    this.killed = true;
    return true;
  }
}

test('tick history requests run through a dedicated utility process', async () => {
  const child = new FakeUtilityProcess();
  const fetched = [];
  let forkOptions;
  const service = new TickBarService({
    utilityProcess: {
      fork: (scriptPath, args, options) => {
        forkOptions = { scriptPath, args, options };
        return child;
      },
    },
    scriptPath: 'tick-bar-process.cjs',
    fetchTicks: async (provider, request) => {
      assert.equal(provider, 'mt5');
      fetched.push(request);
      return [{ time: 100, bid: 1, ask: 2, last: 0 }];
    },
    onBar() {},
  });

  const response = service.request({ provider: 'mt5', ticker: 'EURUSD', ticksPerBar: 2 });
  assert.equal(forkOptions.scriptPath, 'tick-bar-process.cjs');
  assert.equal(forkOptions.options.serviceName, 'Omega mt5 Tick Data');
  const requestId = child.messages[0].id;
  child.emit('message', {
    type: 'fetch-ticks',
    id: 'ticks-1',
    provider: 'mt5',
    request: { ticker: 'EURUSD', fromMsc: 100, limit: 2 },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fetched.length, 1);
  assert.deepEqual(child.messages.at(-1), {
    type: 'fetch-ticks-result',
    id: 'ticks-1',
    ticks: [{ time: 100, bid: 1, ask: 2, last: 0 }],
  });

  child.emit('message', { type: 'tick-bars-result', id: requestId, bars: [{ time: 100, close: 1 }] });
  assert.deepEqual(await response, [{ time: 100, close: 1 }]);
  service.stop();
  assert.equal(child.killed, true);
});

test('tick history requests reject when their utility process exits', async () => {
  const child = new FakeUtilityProcess();
  const service = new TickBarService({
    utilityProcess: { fork: () => child },
    scriptPath: 'tick-bar-process.cjs',
    fetchTicks: async () => [],
    onBar() {},
  });

  const response = service.request({ provider: 'mt5', ticker: 'EURUSD', ticksPerBar: 2 });
  child.emit('exit', 1);

  await assert.rejects(response, /stopped unexpectedly \(exit 1\)/);
});

test('each tick-data provider gets its own utility process', async () => {
  const children = [];
  const service = new TickBarService({
    utilityProcess: {
      fork: (scriptPath, args, options) => {
        const child = new FakeUtilityProcess();
        children.push({ child, options });
        return child;
      },
    },
    scriptPath: 'tick-bar-process.cjs',
    fetchTicks: async () => [],
    onBar() {},
  });

  const mt5Response = service.request({ provider: 'mt5', ticker: 'EURUSD', ticksPerBar: 2 });
  const alpacaResponse = service.request({ provider: 'alpaca', ticker: 'AAPL', ticksPerBar: 2 });
  assert.equal(children.length, 2);
  assert.equal(children[0].options.serviceName, 'Omega mt5 Tick Data');
  assert.equal(children[1].options.serviceName, 'Omega alpaca Tick Data');
  children[0].child.emit('message', { type: 'tick-bars-result', id: children[0].child.messages[0].id, bars: [] });
  children[1].child.emit('message', { type: 'tick-bars-result', id: children[1].child.messages[0].id, bars: [] });
  assert.deepEqual(await Promise.all([mt5Response, alpacaResponse]), [[], []]);

  service.stop();
  assert.equal(children.every(({ child }) => child.killed), true);
});

test('tick subscriptions forward live updates and return process-produced bars', async () => {
  const child = new FakeUtilityProcess();
  const receivedBars = [];
  const service = new TickBarService({
    utilityProcess: { fork: () => child },
    scriptPath: 'tick-bar-process.cjs',
    fetchTicks: async () => [],
    onBar: (subscriptionId, bar) => receivedBars.push([subscriptionId, bar]),
  });

  const subscribed = service.subscribe('sub-1', 'mt5', 'EURUSD', 2);
  const subscribeRequest = child.messages[0];
  assert.equal(subscribeRequest.type, 'tick-bars-subscribe');
  child.emit('message', {
    type: 'tick-bars-subscription-result',
    id: subscribeRequest.id,
  });
  await subscribed;

  service.pushTicks('sub-1', [{ time: 100, bid: 1, ask: 2, last: 0 }]);
  assert.deepEqual(child.messages.at(-1), {
    type: 'tick-bars-live-ticks',
    subscriptionId: 'sub-1',
    ticks: [{ time: 100, bid: 1, ask: 2, last: 0 }],
  });
  const bar = { time: 100, open: 1, high: 1, low: 1, close: 1 };
  child.emit('message', { type: 'tick-bar', subscriptionId: 'sub-1', bar });
  assert.deepEqual(receivedBars, [['sub-1', bar]]);

  service.unsubscribe('sub-1');
  assert.deepEqual(child.messages.at(-1), {
    type: 'tick-bars-unsubscribe',
    subscriptionId: 'sub-1',
  });
  service.stop();
});
