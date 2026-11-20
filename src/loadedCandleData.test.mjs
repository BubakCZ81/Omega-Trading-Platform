import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateAtr14, mergeLoadedCandleBars, readLoadedCandleBars } from './loadedCandleData.ts';

test('reads chart candle history from tuple, object, and wrapped data shapes', () => {
  const bars = readLoadedCandleBars({
    bars: [
      [1_700_000_000, 10, 12, 9, 11, 100],
      { timestamp: 1_700_000_060, open: 11, high: 13, low: 10, close: 12 },
      { t: '2023-11-14T22:14:20Z', h: 14, l: 11, c: 13 },
      { time: 4, high: 2, low: 3, close: 1 },
    ],
  });
  assert.deepEqual(bars.map(bar => [bar.time, bar.high, bar.low, bar.close]), [
    [1_700_000_000, 12, 9, 11],
    [1_700_000_060, 13, 10, 12],
    [1_700_000_060_000, 14, 11, 13],
  ]);
});

test('merges loaded candles and live updates by bar time', () => {
  const loaded = readLoadedCandleBars([[1, 1, 3, 0, 2], [2, 2, 4, 1, 3]]);
  const live = readLoadedCandleBars([[2, 2, 5, 1, 4], [3, 3, 5, 2, 4]]);
  assert.deepEqual(mergeLoadedCandleBars(loaded, live), [
    { time: 1, high: 3, low: 0, close: 2 },
    { time: 2, high: 5, low: 1, close: 4 },
    { time: 3, high: 5, low: 2, close: 4 },
  ]);
});

test('calculates ATR(14) from 15 loaded chart candles', () => {
  const bars = Array.from({ length: 15 }, (_, index) => ({
    time: index,
    high: 10 + index,
    low: 9 + index,
    close: 9.5 + index,
  }));
  assert.equal(calculateAtr14(bars.slice(0, 14)), null);
  assert.equal(calculateAtr14(bars), 1.5);
});
