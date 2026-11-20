import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findAutoTrendline,
  findConfirmedPivots,
  normalizeAutoTrendlineSettings,
} from './autoTrendlineAlgorithm.ts';

function barsFromHighs(highs, lows = highs.map(high => high - 10)) {
  return highs.map((high, index) => ({
    time: index * 60_000,
    open: high - 1,
    high,
    low: lows[index],
    close: high - 2,
  }));
}

const settings = { lookback: 100, strength: 2, minimumSeparation: 3 };

test('only confirmed pivots with the configured fractal strength are returned', () => {
  const bars = barsFromHighs([1, 2, 3, 5, 3, 2, 1, 2, 4, 2, 1, 0]);
  const pivots = findConfirmedPivots(bars, 'upper', settings);
  assert.deepEqual(pivots, [{ index: 3, price: 5 }, { index: 8, price: 4 }]);
});

test('the latest confirmed descending highs form an upper resistance line', () => {
  const bars = barsFromHighs([1, 2, 3, 7, 3, 2, 1, 2, 5, 2, 1, 0]);
  assert.deepEqual(findAutoTrendline(bars, 'upper', settings), {
    first: { index: 3, price: 7 },
    second: { index: 8, price: 5 },
  });
});

test('the latest confirmed ascending lows form a lower support line', () => {
  const lows = [10, 9, 8, 7, 8, 9, 10, 9, 9, 8, 9, 10, 11];
  const bars = barsFromHighs(lows.map(low => low + 10), lows);
  assert.deepEqual(findAutoTrendline(bars, 'lower', settings), {
    first: { index: 3, price: 7 },
    second: { index: 9, price: 8 },
  });
});

test('a pivot that has not accumulated enough right-side bars is not confirmed', () => {
  const bars = barsFromHighs([1, 2, 3, 8, 3]);
  assert.deepEqual(findConfirmedPivots(bars, 'upper', settings), []);
});

test('pivots closer than the minimum separation retain the more extreme swing', () => {
  const bars = barsFromHighs([1, 2, 7, 3, 9, 3, 1, 2, 4, 2, 0]);
  assert.deepEqual(findConfirmedPivots(bars, 'upper', settings)[0], { index: 4, price: 9 });
});

test('settings are bounded and non-finite inputs fall back to defaults', () => {
  assert.deepEqual(normalizeAutoTrendlineSettings({
    lookback: 0,
    strength: Number.NaN,
    minimumSeparation: 900,
  }), {
    lookback: 30,
    strength: 5,
    minimumSeparation: 500,
  });
});
