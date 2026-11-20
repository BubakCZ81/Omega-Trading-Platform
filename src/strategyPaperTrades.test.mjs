import assert from 'node:assert/strict';
import test from 'node:test';

const { resolvePineStrategyProtection, strategyBrokerEntrySide, strategyBrokerOrderSide, toInternalStrategyPaperTrades } = await import('./strategyPaperTrades.ts');

test('converts local strategy ledger entries without creating an execution request', () => {
  assert.deepEqual(toInternalStrategyPaperTrades('ema', 'BTCUSDT', [{
    id: 'long-1', side: 'long', qty: 2, entry: { time: 100, price: 10 }, exit: { time: 200, price: 12 }, open: false, pnl: 4,
  }]), [{
    id: 'strategy:ema:long-1', symbol: 'BTCUSDT', side: 'buy', qty: 2, entryTime: 100, entryPrice: 10, exitTime: 200, exitPrice: 12, open: false, pnl: 4,
  }]);
});

test('previews the opposite order side for strategy exits', () => {
  assert.equal(strategyBrokerEntrySide('long'), 'BUY');
  assert.equal(strategyBrokerEntrySide('short'), 'SELL');
  assert.equal(strategyBrokerOrderSide('long', 'open'), 'BUY');
  assert.equal(strategyBrokerOrderSide('short', 'open'), 'SELL');
  assert.equal(strategyBrokerOrderSide('long', 'close'), 'SELL');
  assert.equal(strategyBrokerOrderSide('short', 'close'), 'BUY');
});

test('uses configured SL/TP when Pine strategy fills do not expose protection levels', () => {
  assert.deepEqual(resolvePineStrategyProtection(
    'long', 1.1, 0.00001, 0.0001, { mode: 'pips', slValue: 20, tpValue: 40 }, null,
  ), { stopLoss: 1.098, takeProfit: 1.104 });
  assert.deepEqual(resolvePineStrategyProtection(
    'short', 1.1, 0.00001, 0.0001, { mode: 'pips', slValue: 20, tpValue: 40 }, null,
  ), { stopLoss: 1.102, takeProfit: 1.096 });
});

test('prefers valid Pine protection and rejects levels on the wrong side of entry', () => {
  assert.deepEqual(resolvePineStrategyProtection(
    'long', 100, 0.01, 0.01, { mode: 'pips', slValue: 20, tpValue: 40 }, null, 98, 104,
  ), { stopLoss: 98, takeProfit: 104 });
  assert.throws(() => resolvePineStrategyProtection(
    'long', 100, 0.01, 0.01, { mode: 'pips', slValue: 20, tpValue: 40 }, null, 101, 104,
  ), /wrong side/);
});

test('valid Pine protection does not depend on configured ATR availability', () => {
  assert.deepEqual(resolvePineStrategyProtection(
    'long', 100, 0.01, 0.01, { mode: 'atr', slValue: 2, tpValue: 4 }, null, 98, 104,
  ), { stopLoss: 98, takeProfit: 104 });
});

test('rounds protection levels outward to valid instrument ticks', () => {
  assert.deepEqual(resolvePineStrategyProtection(
    'long', 100, 0.05, 0.01, { mode: 'pips', slValue: 20, tpValue: 40 }, null, 98.03, 104.03,
  ), { stopLoss: 98, takeProfit: 104.05 });
  assert.deepEqual(resolvePineStrategyProtection(
    'short', 100, 0.05, 0.01, { mode: 'pips', slValue: 20, tpValue: 40 }, null, 102.03, 96.03,
  ), { stopLoss: 102.05, takeProfit: 96 });
});
