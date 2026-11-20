'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { evaluatePreTradeOrder, orderKey } = require('./trade-risk.cjs');

const NOW = Date.parse('2026-10-26T10:00:00.000Z');

function baseOrder(overrides = {}) {
  return {
    symbolId: '42',
    side: 'BUY',
    volume: 1,
    stopLoss: 95,
    takeProfit: 110,
    environment: 'demo',
    ...overrides,
  };
}

function baseContext(overrides = {}) {
  return {
    now: NOW,
    quote: { bid: 100, ask: 100.1, receivedAt: NOW - 100 },
    account: { id: 'demo-account', environment: 'demo', tradingEnabled: true },
    symbol: { id: '42', stepVolume: 0.01, minVolume: 0.01, maxVolume: 100, contractSize: 1 },
    ...overrides,
  };
}

function codes(result) {
  return result.violations.map((violation) => violation.code);
}

test('accepts a well-formed protected demo order', () => {
  const result = evaluatePreTradeOrder(baseOrder(), baseContext());
  assert.equal(result.ok, true);
  assert.deepEqual(result.violations, []);
  assert.equal(result.price, 100.1);
  assert.equal(result.riskAmount, 5);
});

test('requires a stop loss and a fresh valid quote', () => {
  const missingStop = evaluatePreTradeOrder(baseOrder({ stopLoss: undefined }), baseContext());
  assert.deepEqual(codes(missingStop), ['stop-loss-required']);

  const stale = evaluatePreTradeOrder(baseOrder(), baseContext({
    quote: { bid: 100, ask: 100.1, receivedAt: NOW - 60_000 },
  }));
  assert.deepEqual(codes(stale), ['quote-stale']);

  const missingQuote = evaluatePreTradeOrder(baseOrder(), baseContext({ quote: null }));
  assert.ok(codes(missingQuote).includes('quote-missing'));
});

test('rejects a stop on the wrong side and a too-wide spread', () => {
  const wrongSide = evaluatePreTradeOrder(baseOrder({ stopLoss: 101 }), baseContext());
  assert.deepEqual(codes(wrongSide), ['stop-loss-wrong-side']);

  const wide = evaluatePreTradeOrder(baseOrder(), baseContext({
    limits: { maxSpread: 0.05 },
  }));
  assert.deepEqual(codes(wide), ['spread-too-wide']);
});

test('enforces per-symbol volume step, minimum and maximum', () => {
  const misaligned = evaluatePreTradeOrder(baseOrder({ volume: 0.1 }), baseContext({
    symbol: { id: '42', stepVolume: 0.03, minVolume: 0.01, maxVolume: 100, contractSize: 1 },
  }));
  assert.deepEqual(codes(misaligned), ['volume-step']);

  const tooSmall = evaluatePreTradeOrder(baseOrder({ volume: 0.05 }), baseContext({
    symbol: { id: '42', stepVolume: 0.01, minVolume: 0.1, maxVolume: 100, contractSize: 1 },
  }));
  assert.deepEqual(codes(tooSmall), ['volume-too-small']);

  const tooLarge = evaluatePreTradeOrder(baseOrder({ volume: 101 }), baseContext());
  assert.deepEqual(codes(tooLarge), ['volume-too-large']);
});

test('blocks risk, notional, daily loss and position-count limits', () => {
  const risk = evaluatePreTradeOrder(baseOrder(), baseContext({
    limits: { maxRiskAmount: 4 },
  }));
  assert.deepEqual(codes(risk), ['risk-too-large']);

  const notional = evaluatePreTradeOrder(baseOrder(), baseContext({
    limits: { maxNotional: 50 },
  }));
  assert.deepEqual(codes(notional), ['notional-too-large']);

  const daily = evaluatePreTradeOrder(baseOrder(), baseContext({
    account: { id: 'demo-account', tradingEnabled: true, dayPnl: -250 },
    limits: { maxDailyLoss: 200 },
  }));
  assert.deepEqual(codes(daily), ['daily-loss-limit']);

  const positions = evaluatePreTradeOrder(baseOrder(), baseContext({
    account: { id: 'demo-account', tradingEnabled: true, openPositions: 3 },
    limits: { maxOpenPositions: 3 },
  }));
  assert.deepEqual(codes(positions), ['max-open-positions']);
});

test('enforces the kill switch, account state and the live lock', () => {
  assert.deepEqual(codes(evaluatePreTradeOrder(baseOrder(), baseContext({ killSwitch: true }))), ['kill-switch']);

  assert.deepEqual(codes(evaluatePreTradeOrder(baseOrder(), baseContext({
    account: { id: 'demo-account', tradingEnabled: false },
  }))), ['account-disabled']);

  assert.deepEqual(codes(evaluatePreTradeOrder(baseOrder({ environment: 'live' }), baseContext())), ['live-locked']);

  const allowed = evaluatePreTradeOrder(baseOrder({ environment: 'live' }), baseContext({
    limits: { allowLive: true },
  }));
  assert.equal(allowed.ok, true);
});

test('rejects an identical order inside the duplicate window', () => {
  const order = baseOrder();
  const key = orderKey({ ...order, accountId: 'demo-account' });
  const result = evaluatePreTradeOrder(order, baseContext({
    limits: { duplicateWindowMs: 2_000 },
    recentOrders: [{ key, at: NOW - 500 }],
  }));
  assert.deepEqual(codes(result), ['duplicate-order']);

  const expired = evaluatePreTradeOrder(order, baseContext({
    limits: { duplicateWindowMs: 2_000 },
    recentOrders: [{ key, at: NOW - 5_000 }],
  }));
  assert.equal(expired.ok, true);
});
