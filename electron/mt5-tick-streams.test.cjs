const assert = require('node:assert/strict');
const test = require('node:test');
const { Mt5TickStreamSubscriptions } = require('./mt5-tick-streams.cjs');

test('same-symbol chart subscribers share a stream until the last subscriber leaves', async () => {
  const subscriptions = new Mt5TickStreamSubscriptions();
  let starts = 0;
  let stops = 0;
  const start = () => {
    starts += 1;
    return () => { stops += 1; };
  };

  await subscriptions.acquire('window:EURUSD', 'chart-a', start);
  await subscriptions.acquire('window:EURUSD', 'chart-b', start);
  assert.equal(starts, 1);

  subscriptions.release('window:EURUSD', 'chart-a');
  assert.equal(stops, 0);
  subscriptions.release('window:EURUSD', 'chart-b');
  assert.equal(stops, 1);
});

test('a stream released before startup completes is stopped once it becomes ready', async () => {
  const subscriptions = new Mt5TickStreamSubscriptions();
  let finishStart;
  let stops = 0;
  const acquired = subscriptions.acquire('window:EURUSD', 'chart-a', () => new Promise(resolve => {
    finishStart = resolve;
  }));
  await Promise.resolve();

  subscriptions.release('window:EURUSD', 'chart-a');
  finishStart(() => { stops += 1; });
  await acquired;
  assert.equal(stops, 1);
});

test('disconnecting all providers clears stream state so a reconnect starts a new stream', async () => {
  const subscriptions = new Mt5TickStreamSubscriptions();
  let starts = 0;
  let stops = 0;
  const start = () => {
    starts += 1;
    return () => { stops += 1; };
  };

  await subscriptions.acquire('window:EURUSD', 'chart-a', start);
  subscriptions.stopAll();
  await subscriptions.acquire('window:EURUSD', 'chart-a', start);

  assert.equal(starts, 2);
  assert.equal(stops, 1);
});
