import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alignMt5ProtectionPrices,
  assertFreshMt5Quote,
  assertSelectedMt5Account,
  isFreshMt5Quote,
  MT5_QUOTE_MAX_AGE_MS,
} from './chartMt5Orders.ts';

const connectedDemo = {
  connected: true,
  tradingAllowed: true,
  terminalTradingAllowed: true,
  accountTradingAllowed: true,
  accountMode: 'demo',
  accountLogin: '12345',
  server: 'Demo-Server',
};

test('chart orders require the explicitly selected, connected MT5 account', () => {
  assert.equal(assertSelectedMt5Account(connectedDemo, 'mt5:12345@Demo-Server'), connectedDemo);
  assert.throws(() => assertSelectedMt5Account(connectedDemo, 'local-demo'), /Select a connected MT5 account/);
  assert.throws(() => assertSelectedMt5Account(connectedDemo, 'mt5:54321@Demo-Server'), /does not match/);
});

test('MT5 protection prices are aligned outward to the broker tick size', () => {
  assert.deepEqual(alignMt5ProtectionPrices('buy', 1.080013, 1.080027, 0.00005, 5), {
    stopLoss: 1.08,
    takeProfit: 1.08005,
  });
  assert.deepEqual(alignMt5ProtectionPrices('sell', 1.080013, 1.079987, 0.00005, 5), {
    stopLoss: 1.08005,
    takeProfit: 1.07995,
  });
  assert.throws(() => alignMt5ProtectionPrices('buy', 0, 1.1, 0.01, 2), /positive finite values/);
});

test('chart orders are blocked when MT5 trading permissions are disabled but permit unknown account modes', () => {
  assert.throws(() => assertSelectedMt5Account({ ...connectedDemo, tradingAllowed: false }, 'mt5:12345@Demo-Server'), /does not currently permit trading/);
  assert.throws(() => assertSelectedMt5Account({ ...connectedDemo, terminalTradingAllowed: false }, 'mt5:12345@Demo-Server'), /Algo Trading/);
  assert.equal(assertSelectedMt5Account({ ...connectedDemo, accountMode: 'unknown' }, 'mt5:12345@Demo-Server').accountMode, 'unknown');
});

test('MT5 chart orders reject stale or missing broker quote timestamps', () => {
  const now = 1_800_000_000_000;
  assert.equal(isFreshMt5Quote(now - MT5_QUOTE_MAX_AGE_MS, now), true);
  assert.equal(isFreshMt5Quote(now - MT5_QUOTE_MAX_AGE_MS - 1, now), false);
  assert.doesNotThrow(() => assertFreshMt5Quote(now, now));
  assert.throws(() => assertFreshMt5Quote(now - 60_000, now), /last broker tick is 60 seconds old/);
  assert.throws(() => assertFreshMt5Quote(0, now), /timestamped quote/);
});
