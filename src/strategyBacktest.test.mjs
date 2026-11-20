import assert from 'node:assert/strict';
import test from 'node:test';

const { currentInternalStrategy } = await import('./strategyBacktest.ts');
const { runPineBacktest } = await import('./backtester/backtester.ts');

test('selects the chart strategy as local backtest source', () => {
  const result = currentInternalStrategy([
    { id: 'indicator', source: 'indicator("Trend")' },
    { id: 'scalp', title: 'Scalp strategy', source: '//@version=6\nstrategy("Scalp")\nstrategy.entry("L", strategy.long)' },
  ]);
  assert.deepEqual(result, {
    title: 'Scalp strategy',
    source: '//@version=6\nstrategy("Scalp")\nstrategy.entry("L", strategy.long)',
  });
});

test('does not treat an indicator as an executable strategy', () => {
  assert.equal(currentInternalStrategy([{ source: 'indicator("Trend")' }]), null);
});

test('executes Pine strategy entry and close orders into visible, timestamped fills', async () => {
  const candles = Array.from({ length: 12 }, (_, index) => ({
    time: 1_767_225_600 + index * 60,
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 100,
  }));
  const source = `//@version=6
strategy("Order fill regression", overlay=true, initial_capital=10000, default_qty_type=strategy.fixed, default_qty_value=2)
if bar_index == 2
    strategy.entry("Long", strategy.long)
if bar_index == 8
    strategy.close("Long")`;

  const result = await runPineBacktest(source, candles, 'TEST', '1m');

  assert.equal(result.trades.length, 1, 'strategy.entry must create a broker-emulator fill');
  assert.equal(result.trades[0].side, 'long');
  assert.equal(result.trades[0].qty, 2);
  assert.equal(result.trades[0].entry.id, 'Long');
  assert.ok(result.trades[0].entry.time > candles[2].time * 1000, 'default orders fill after the signal bar');
  assert.ok(result.trades[0].exit, 'strategy.close must create an exit fill');
  assert.ok(result.trades[0].exit.time > result.trades[0].entry.time);
  assert.ok(Number.isFinite(result.trades[0].entry.price));
  assert.ok(Number.isFinite(result.trades[0].exit.price));
  assert.equal(result.context.strategy?.wins, 1);
  assert.equal(result.context.strategy?.netPnl, 12);
});

test('executes TA-driven Pine strategy signals into backtest fills', async () => {
  const closes = [10, 9, 8, 7, 6, 5, 6, 7, 8, 9, 10, 11, 12, 11, 10, 9, 8, 7, 6];
  const candles = closes.map((close, index) => ({
    time: 1_767_225_600 + index * 60,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
  }));
  const source = `//@version=6
strategy("TA signal regression", overlay=true, initial_capital=10000)
fast = ta.ema(close, 3)
slow = ta.ema(close, 6)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")`;

  const result = await runPineBacktest(source, candles, 'TEST', '1m');

  assert.ok(result.trades.length > 0, 'TA crossover signals must reach the strategy order emulator');
  assert.ok(result.trades[0].entry, 'the TA signal must create a visible entry fill');
  assert.ok(Number.isFinite(result.trades[0].entry.price));
});


test('Pine plot metadata and values stay aligned with sub-second replay candles', async () => {
  const { visibleReplayPoints } = await import('./backtester/replayPlots.ts');
  const start = 1_767_225_600_000;
  const candles = Array.from({ length: 600 }, (_, index) => ({
    time: (start + index * 17) / 1000,
    open: 100 + index, high: 101 + index, low: 99 + index, close: 100 + index, volume: 1,
  }));
  const source = '//@version=6\nindicator("Replay overlay", overlay=true)\nplot(close, "Price")';
  const result = await runPineBacktest(source, candles, 'TEST', '100t');
  assert.equal(result.context.meta.overlay, true);
  const points = Object.values(result.context.plots)[0];
  assert.equal(points.length, 600);
  for (let cursor = 0; cursor < candles.length; cursor++) {
    const time = start + cursor * 17;
    const visible = visibleReplayPoints(points, time - 17 * 24, time);
    assert.equal(visible.at(-1).time, time);
    assert.equal(visible.at(-1).value, candles[cursor].close);
    assert.equal(visible.length, Math.min(cursor + 1, 25));
  }
});
