import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { LoadedBarsController } from './loadedBars.ts';

test('panning left preloads past 2,000 candles, up to 200,000, and stops at the feed boundary', async t => {
  const previousDocument = globalThis.document;
  globalThis.document = { getElementById: () => null, querySelector: () => null, addEventListener: () => {} };
  t.after(() => { globalThis.document = previousDocument; });

  const candles = new EventEmitter();
  const requested = [];
  const market = { symbol: 'MT5:EURUSD', timeframe: '1', bars: 199_000 };
  const replay = { state: { active: false }, bounds: { first: 60_000_000 } };
  const chart = {
    market, replay,
    getVisibleRange: () => ({ from: 66_000_000, to: 72_000_000 }),
    on: (event, handler) => {
      candles.on(event, handler);
      return () => candles.off(event, handler);
    },
    setMarket: async ({ bars }) => {
      requested.push(bars);
      market.bars = bars;
      candles.emit('history:complete', { reason: 'genesis', oldestTime: replay.bounds.first, barsLoaded: 199_000 });
    },
    historyComplete: async () => {},
  };
  const controller = new LoadedBarsController({ cell: () => ({ chart }) });
  controller.watch('chart');
  controller.set('chart', 199_000);
  candles.emit('viewport:changed', { from: 64_000_000, to: 70_000_000 });
  assert.deepEqual(requested, []);
  candles.emit('viewport:changed', { from: 60_500_000, to: 66_500_000 });
  assert.deepEqual(requested, [199_500]);
  await new Promise(resolve => setImmediate(resolve));
  candles.emit('viewport:changed', { from: 60_200_000, to: 66_200_000 });
  assert.deepEqual(requested, [199_500]);

  candles.emit('load:start');
  market.bars = 199_900;
  replay.bounds.first = 50_000_000;
  candles.emit('history:complete', { reason: 'depth', oldestTime: 50_000_000, barsLoaded: 199_900 });
  candles.emit('viewport:changed', { from: 55_000_000, to: 61_000_000 });
  candles.emit('viewport:changed', { from: 50_500_000, to: 56_500_000 });
  assert.deepEqual(requested, [199_500, 200_000]);
  controller.unwatch('chart');
});
