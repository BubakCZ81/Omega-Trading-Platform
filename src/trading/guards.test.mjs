import assert from 'node:assert/strict';
import test from 'node:test';
import { guardBar, guardBars, guardQuote, recentDataRejections } from './marketDataGuards.ts';
import { orderIntentKey, releaseOrderIntent, requestOrderIntent, trackedIntentCount } from './idempotency.ts';

// ---------------------------------------------------------------- quotes

test('a sane quote passes', () => {
  const result = guardQuote({ bid: 1.1, ask: 1.1002 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { bid: 1.1, ask: 1.1002 });
});

test('a crossed quote is rejected, not silently accepted as a wide spread', () => {
  const result = guardQuote({ bid: 1.2, ask: 1.1 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /below bid/);
});

test('a quote with NaN or a non-positive side is rejected', () => {
  assert.equal(guardQuote({ bid: Number.NaN, ask: 1.1 }).ok, false);
  assert.equal(guardQuote({ bid: 0, ask: 1.1 }).ok, false);
  assert.equal(guardQuote({ bid: -1, ask: 1.1 }).ok, false);
  assert.equal(guardQuote(null).ok, false);
});

// ---------------------------------------------------------------- bars

test('a sane bar passes', () => {
  const result = guardBar({ time: 1, open: 10, high: 12, low: 9, close: 11, volume: 5 });
  assert.equal(result.ok, true);
  assert.equal(result.value.close, 11);
});

test('a bar whose high is below its low is rejected', () => {
  const result = guardBar({ time: 1, open: 10, high: 9, low: 12, close: 10 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /below low/);
});

test('a bar whose body sits outside its high/low is rejected', () => {
  const result = guardBar({ time: 1, open: 20, high: 12, low: 9, close: 11 });
  assert.equal(result.ok, false);
  assert.match(result.reason, /outside/);
});

test('a bar with a non-finite price or bad volume is rejected', () => {
  assert.equal(guardBar({ time: 1, open: 10, high: 12, low: 9, close: Number.NaN }).ok, false);
  assert.equal(guardBar({ time: 1, open: 10, high: 12, low: 9, close: 11, volume: -1 }).ok, false);
  assert.equal(guardBar({ time: 1, open: 10, high: 12, low: 9, close: 11, volume: Number.NaN }).ok, false);
});

test('guardBars drops the broken samples, sorts and de-duplicates by time', () => {
  const bars = guardBars([
    { time: 3, open: 10, high: 12, low: 9, close: 11 },
    { time: 1, open: 10, high: 12, low: 9, close: 11 },
    { time: 2, open: 10, high: 9, low: 12, close: 10 },
    { time: 1, open: 20, high: 22, low: 19, close: 21 },
  ]);
  assert.deepEqual(bars.map(bar => bar.time), [1, 3]);
  // Newest sample for a duplicated open-time wins.
  assert.equal(bars[0].close, 21);
});

test('guardBars tolerates a non-array without throwing', () => {
  assert.deepEqual(guardBars('not bars'), []);
  assert.deepEqual(guardBars(null), []);
});

test('rejections are remembered so nothing fails silently', () => {
  guardQuote({ bid: 0, ask: 0 }, 'test-source');
  const recent = recentDataRejections();
  assert.ok(recent.length > 0);
  assert.ok(recent.some(item => item.source === 'test-source'));
});

// ---------------------------------------------------------------- idempotency

test('the same intent inside the window is refused', () => {
  const key = orderIntentKey({ cellId: 'c1', symbol: 'EURUSD', side: 'buy', lots: 0.1, at: 1_000 });
  assert.equal(requestOrderIntent(key).allowed, true);
  const second = requestOrderIntent(key);
  assert.equal(second.allowed, false);
  assert.match(second.reason, /Duplicate order/);
});

test('a genuinely different order is allowed', () => {
  const base = { cellId: 'c1', symbol: 'EURUSD', side: 'buy', at: 2_000 };
  assert.equal(requestOrderIntent(orderIntentKey({ ...base, lots: 0.1 })).allowed, true);
  assert.equal(requestOrderIntent(orderIntentKey({ ...base, lots: 0.2 })).allowed, true);
  assert.equal(requestOrderIntent(orderIntentKey({ ...base, side: 'sell', lots: 0.1 })).allowed, true);
});

test('two clicks in the same second collapse onto one key', () => {
  const a = orderIntentKey({ symbol: 'GBPUSD', side: 'sell', lots: 1, at: 5_000 });
  const b = orderIntentKey({ symbol: 'GBPUSD', side: 'sell', lots: 1, at: 5_400 });
  assert.equal(a, b);
});

test('cancelling a trade preview releases its intent so the same order can be retried', () => {
  const key = orderIntentKey({ cellId: 'c2', symbol: 'XAUUSD', side: 'buy', lots: 0.5, at: 9_000 });
  assert.equal(requestOrderIntent(key).allowed, true);
  assert.equal(requestOrderIntent(key).allowed, false);
  releaseOrderIntent(key);
  assert.equal(requestOrderIntent(key).allowed, true);
});

test('falling outside the window allows the same key again', () => {
  const key = orderIntentKey({ cellId: 'c3', symbol: 'US30', side: 'buy', lots: 1, at: 20_000 });
  assert.equal(requestOrderIntent(key, 1).allowed, true);
  const start = Date.now();
  while (Date.now() - start < 5) { /* let the 1ms window lapse */ }
  assert.equal(requestOrderIntent(key, 1).allowed, true);
  assert.ok(trackedIntentCount() >= 0);
});
