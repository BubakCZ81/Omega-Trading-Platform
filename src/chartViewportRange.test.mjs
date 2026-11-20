import assert from 'node:assert/strict';
import test from 'node:test';
import { isAwayFromLatest, rangeEndingAtLatest } from './chartViewportRange.ts';

test('return-to-latest visibility ignores small right-edge gaps and detects a historical view', () => {
  const latest = 1_000_000;
  assert.equal(isAwayFromLatest({ from: 800_000, to: 990_000 }, latest, 10_000), false);
  assert.equal(isAwayFromLatest({ from: 500_000, to: 800_000 }, latest, 10_000), true);
  assert.equal(isAwayFromLatest(null, latest, 10_000), false);
});

test('return-to-latest preserves the visible time span', () => {
  assert.deepEqual(
    rangeEndingAtLatest({ from: 100, to: 250 }, 1_000),
    { from: 850, to: 1_000 },
  );
  assert.equal(rangeEndingAtLatest({ from: 250, to: 250 }, 1_000), null);
});
