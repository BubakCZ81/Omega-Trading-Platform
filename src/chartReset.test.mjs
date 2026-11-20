import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_RESET_CHART_CANDLES,
  MAX_RESET_CHART_CANDLES,
  parseResetChartCandleCount,
  refreshChart,
  resetChartView,
} from './chartReset.ts';

test('reset chart candle limits accept only whole numbers in the supported range', () => {
  assert.equal(parseResetChartCandleCount('50'), 50);
  assert.equal(parseResetChartCandleCount(1), 1);
  assert.equal(parseResetChartCandleCount(String(MAX_RESET_CHART_CANDLES)), MAX_RESET_CHART_CANDLES);
  for (const value of ['', '0', '-1', '1.5', '201', 'abc', null]) {
    assert.equal(parseResetChartCandleCount(value), null);
  }
  assert.equal(DEFAULT_RESET_CHART_CANDLES, 100);
  assert.equal(MAX_RESET_CHART_CANDLES, 200);
});

test('reset restores autoscale and asks Vela to frame the configured candle count', () => {
  const calls = [];
  const chart = {
    renderer: { set: (...args) => calls.push(args) },
    setVisibleBarCount: count => { calls.push(count); return 37; },
  };
  assert.equal(resetChartView(chart, 50), 37);
  assert.deepEqual(calls, [['autoScale', true], 50]);
  assert.equal(resetChartView(chart, 0), 37);
  assert.equal(calls.at(-1), 100);
});

test('reset falls back to Vela visible ranges when the optional count extension is unavailable', () => {
  const calls = [];
  const chart = {
    renderer: { set: (...args) => calls.push(args) },
    replay: { bounds: { first: 0, last: 9 * 60_000 } },
    market: { timeframe: '1', bars: 10 },
    setVisibleRange: range => calls.push(range),
  };
  assert.equal(resetChartView(chart, 5), 5);
  assert.deepEqual(calls, [
    ['autoScale', true],
    { from: 4.5 * 60_000, to: 9.5 * 60_000 },
  ]);
});

test('refresh explicitly reloads the current market', async () => {
  const chart = { async setMarket(request) { assert.deepEqual(request, { reload: true }); } };
  await refreshChart(chart);
});
