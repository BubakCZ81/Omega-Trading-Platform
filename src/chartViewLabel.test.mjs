import assert from 'node:assert/strict';
import test from 'node:test';
import { chartStyleCode, chartStyleName, chartViewLabel, formatTimeframeLabel } from './chartViewLabel.ts';

test('timeframe labels use compact minute/hour/day notation', () => {
  assert.equal(formatTimeframeLabel('1'), '1m');
  assert.equal(formatTimeframeLabel('5'), '5m');
  assert.equal(formatTimeframeLabel('60'), '1h');
  assert.equal(formatTimeframeLabel('240'), '4h');
  assert.equal(formatTimeframeLabel('D'), '1D');
  assert.equal(formatTimeframeLabel('W'), '1W');
  assert.equal(formatTimeframeLabel('T100'), '100T');
  assert.equal(formatTimeframeLabel('R5'), '5R');
  assert.equal(formatTimeframeLabel('RG10'), '10RG');
  assert.equal(formatTimeframeLabel('RATR'), 'ATR Renko');
});

test('the chart view shows the style next to the period', () => {
  assert.equal(chartViewLabel('candles', '1'), '1m');
  assert.equal(chartViewLabel('heikinashi', '1'), 'Heikin 1m');
  assert.equal(chartViewLabel('heikinashi', '60'), 'Heikin 1h');
  assert.equal(chartViewLabel('line', '15'), 'Line · 15m');
  assert.equal(chartViewLabel('tpo', '30'), 'Time At Price · 30m');
  assert.equal(chartViewLabel('footprint', '5'), 'Footprint · 5m');
  assert.equal(chartViewLabel('candles', 'R5'), 'Renko 5p');
  assert.equal(chartViewLabel('candles', 'RG10'), 'Range 10p');
  assert.equal(chartViewLabel('candles', 'RATR'), 'Renko · ATR(600 × 1m)');
});

test('statusline codes stay short and readable', () => {
  assert.equal(chartStyleCode('candles', '5'), '5m');
  assert.equal(chartStyleCode('candles', '60'), '1h');
  assert.equal(chartStyleCode('heikinashi', '5'), 'Hm5');
  assert.equal(chartStyleCode('heikinashi', '60'), 'Hm1h');
  assert.equal(chartStyleCode('heikinashi', 'D'), 'Hm1D');
  assert.equal(chartStyleCode('tpo', '30'), 'Tpo30');
  assert.equal(chartStyleCode('tpo', '60'), 'Tpo1h');
  assert.equal(chartStyleCode('footprint', '5'), 'Fp5');
  assert.equal(chartStyleCode('line', '15'), 'Li15');
  assert.equal(chartStyleCode('candles', 'T100'), '100T');
  assert.equal(chartStyleCode('candles', 'R5'), '5R');
  assert.equal(chartStyleCode('candles', 'RG10'), '10RG');
});

test('style names describe the active chart type', () => {
  assert.equal(chartStyleName('candles'), 'Candles');
  assert.equal(chartStyleName('heikinashi'), 'Heikin Ashi');
  assert.equal(chartStyleName('tpo'), 'Time At Price');
  assert.equal(chartStyleName('footprint'), 'Footprint');
});
