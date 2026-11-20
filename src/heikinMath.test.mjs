import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeikinTransform, HEIKIN_VARIANTS, heikinVariantFor, isHeikinStyle } from './heikinMath.ts';

const standard = createHeikinTransform(0, 5);

test('the standard formula matches the textbook on a two-bar example', () => {
  const out = standard.full([
    { time: 1, open: 100, high: 110, low: 90, close: 105 },
    { time: 2, open: 105, high: 115, low: 100, close: 112 },
  ]);

  // First bar: open is the midpoint of the first raw bar, close is the four-price average.
  assert.equal(out[0].close, (100 + 110 + 90 + 105) / 4);
  assert.equal(out[0].open, (100 + out[0].close) / 2);
  assert.equal(out[0].high, 110);
  assert.equal(out[0].low, 90);

  // Second bar: open is the midpoint of the previous Heikin bar.
  assert.equal(out[1].close, (105 + 115 + 100 + 112) / 4);
  assert.equal(out[1].open, (out[0].open + out[0].close) / 2);
});

test('a transform preserves the bar count and the timestamps', () => {
  const raw = Array.from({ length: 50 }, (_, index) => ({
    time: 1_000 + index * 60_000,
    open: 100 + index,
    high: 102 + index,
    low: 99 + index,
    close: 101 + index,
  }));
  for (const variant of HEIKIN_VARIANTS) {
    const out = createHeikinTransform(variant.smoothing, variant.length).full(raw);
    assert.equal(out.length, raw.length, `${variant.id} must not change the bar count`);
    assert.deepEqual(out.map(bar => bar.time), raw.map(bar => bar.time), `${variant.id} must keep the times`);
  }
});

test('every variant keeps the body inside its own high and low', () => {
  const raw = Array.from({ length: 40 }, (_, index) => ({
    time: index,
    open: 100 + Math.sin(index) * 5,
    high: 104 + Math.sin(index) * 5,
    low: 96 + Math.sin(index) * 5,
    close: 101 + Math.sin(index + 1) * 4,
  }));
  for (const variant of HEIKIN_VARIANTS) {
    for (const bar of createHeikinTransform(variant.smoothing, variant.length).full(raw)) {
      assert.ok(bar.high >= Math.max(bar.open, bar.close) - 1e-9, `${variant.id} high bounds the body`);
      assert.ok(bar.low <= Math.min(bar.open, bar.close) + 1e-9, `${variant.id} low bounds the body`);
    }
  }
});

test('smoothing actually changes the candles', () => {
  const raw = Array.from({ length: 30 }, (_, index) => ({
    time: index,
    open: 100 + Math.sin(index / 2) * 6,
    high: 104 + Math.sin(index / 2) * 6,
    low: 96 + Math.sin(index / 2) * 6,
    close: 101 + Math.sin(index / 2) * 6,
  }));
  const textbook = createHeikinTransform(0, 5).full(raw);
  const smooth = createHeikinTransform(0.85, 8).full(raw);
  const differences = textbook.filter((bar, index) => Math.abs(bar.close - smooth[index].close) > 1e-9);
  assert.ok(differences.length > 0, 'the very smooth variant must not reproduce the textbook output');
});

test('smoothing is clamped, so a bad setting cannot explode the series', () => {
  const raw = [
    { time: 1, open: 100, high: 110, low: 90, close: 105 },
    { time: 2, open: 105, high: 115, low: 100, close: 112 },
  ];
  for (const smoothing of [-5, 0, 0.5, 1, 42]) {
    for (const bar of createHeikinTransform(smoothing, 5).full(raw)) {
      assert.ok(Number.isFinite(bar.open) && Number.isFinite(bar.high) && Number.isFinite(bar.low) && Number.isFinite(bar.close));
    }
  }
});

test('the incremental path agrees with the full path on the first bar', () => {
  const raw = { time: 1, open: 100, high: 110, low: 90, close: 105 };
  const first = standard.next(raw, undefined);
  const full = standard.full([raw])[0];
  assert.equal(first.open, full.open);
  assert.equal(first.close, full.close);
  assert.equal(first.high, full.high);
  assert.equal(first.low, full.low);
});

test('an empty series stays empty', () => {
  assert.deepEqual(standard.full([]), []);
});

test('style ids map to variants, and the built-in style maps to standard', () => {
  assert.equal(isHeikinStyle('heikinashi'), true);
  assert.equal(isHeikinStyle('heikin-smooth'), true);
  assert.equal(isHeikinStyle('candles'), false);
  assert.equal(isHeikinStyle(null), false);

  assert.equal(heikinVariantFor('heikinashi')?.id, 'heikin-standard');
  assert.equal(heikinVariantFor('heikin-very-smooth')?.id, 'heikin-very-smooth');
  assert.equal(heikinVariantFor('candles'), null);
});
