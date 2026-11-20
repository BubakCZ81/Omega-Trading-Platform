import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeBacktestTimeframe } from './timeframe.ts';

test('normalizes chart-native minute, calendar, and tick timeframe values', () => {
  assert.equal(normalizeBacktestTimeframe('2'), '2m');
  assert.equal(normalizeBacktestTimeframe('60'), '60m');
  assert.equal(normalizeBacktestTimeframe('D'), '1D');
  assert.equal(normalizeBacktestTimeframe('W'), '1W');
  assert.equal(normalizeBacktestTimeframe('M'), '1M');
  assert.equal(normalizeBacktestTimeframe('T100'), '100t');
});

test('preserves explicit backtest timeframe values and trims whitespace', () => {
  assert.equal(normalizeBacktestTimeframe(' 34m '), '34m');
  assert.equal(normalizeBacktestTimeframe('1D'), '1D');
  assert.equal(normalizeBacktestTimeframe('100t'), '100t');
});
