import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findCandlePatternLabels,
  findMarketStructure,
  normalizeCandlePatternSettings,
  normalizeMarketStructureSettings,
} from './priceActionAlgorithm.ts';

const candleSettings = {
  lookback: 100,
  wickBodyRatio: 2,
  maxBodyRangeRatio: 0.3,
  volumeFilter: false,
  volumeLookback: 2,
  volumeMultiple: 1.2,
};

function bar(open, high, low, close, volume = 100, time = 0) {
  return { open, high, low, close, volume, time };
}

test('detects an engulfing candle and a long-wick reversal shape', () => {
  const engulfing = [
    bar(10, 10.2, 8.8, 9, 100, 1),
    bar(8.9, 10.2, 8.8, 10.1, 100, 2),
  ];
  assert.equal(findCandlePatternLabels(engulfing, candleSettings)[0]?.text, 'ENGULF ↑');

  const hammer = [bar(9.8, 10.1, 8, 10, 100, 3)];
  assert.equal(findCandlePatternLabels(hammer, candleSettings)[0]?.text, 'HAMMER');
});

test('volume confirmation filters patterns and live candles are not labeled before close', () => {
  const bars = [
    bar(10, 10.2, 8.8, 9, 100, 1),
    bar(8.9, 10.2, 8.8, 10.1, 100, 2),
    bar(9.8, 10.1, 8, 10, 500, 3),
  ];
  assert.equal(findCandlePatternLabels(bars, {
    ...candleSettings,
    volumeFilter: true,
    volumeLookback: 2,
    volumeMultiple: 1.2,
  }).length, 1);
  assert.deepEqual(findCandlePatternLabels(bars, candleSettings, { live: true }).map(label => label.text), ['ENGULF ↑']);
});

test('market structure marks confirmed swings and a close-based break', () => {
  const bars = [
    bar(3, 4, 2, 3.5, 100, 1),
    bar(3.5, 6, 3, 5, 100, 2),
    bar(5, 10, 4, 9, 100, 3),
    bar(6, 8, 3, 5, 100, 4),
    bar(8, 12, 7, 11, 100, 5),
  ];
  const result = findMarketStructure(bars, {
    lookback: 100,
    strength: 1,
    minimumSeparation: 1,
  });
  assert.ok(result.labels.some(label => label.text === 'SH'));
  assert.ok(result.labels.some(label => label.text === 'BOS ↑'));
  assert.equal(result.lines.length, 1);
  assert.equal(result.lines[0].y1, 10);
});

test('market structure avoids using the current live candle for pivots or break labels', () => {
  const bars = [
    bar(3, 4, 2, 3.5, 100, 1),
    bar(3.5, 6, 3, 5, 100, 2),
    bar(5, 10, 4, 9, 100, 3),
    bar(6, 8, 3, 5, 100, 4),
    bar(8, 12, 7, 11, 100, 5),
  ];
  const result = findMarketStructure(bars, {
    lookback: 100,
    strength: 1,
    minimumSeparation: 1,
  }, { live: true });
  assert.equal(result.labels.some(label => label.text === 'BOS ↑'), false);
});

test('detector inputs are clamped to supported lookback and thresholds', () => {
  assert.deepEqual(normalizeCandlePatternSettings({
    lookback: -10,
    wickBodyRatio: 100,
    maxBodyRangeRatio: Number.NaN,
    volumeFilter: 'yes',
    volumeLookback: 0,
    volumeMultiple: -1,
  }), {
    lookback: 10,
    wickBodyRatio: 10,
    maxBodyRangeRatio: 0.3,
    volumeFilter: false,
    volumeLookback: 2,
    volumeMultiple: 0.1,
  });
  assert.deepEqual(normalizeMarketStructureSettings({
    lookback: 10_000,
    strength: 0,
    minimumSeparation: -2,
  }), {
    lookback: 2000,
    strength: 2,
    minimumSeparation: 1,
  });
});
