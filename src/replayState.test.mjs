import assert from 'node:assert/strict';
import test from 'node:test';

const { areLiveStrategyFillsAllowed, isReplayActive, setReplayActive } = await import('./replayState.ts');

test('live Pine strategy fills are blocked for the full replay session', () => {
  setReplayActive(false);
  assert.equal(isReplayActive(), false);
  assert.equal(areLiveStrategyFillsAllowed(), true);

  setReplayActive(true);
  assert.equal(isReplayActive(), true);
  assert.equal(areLiveStrategyFillsAllowed(), false);

  setReplayActive(false);
  assert.equal(areLiveStrategyFillsAllowed(), true);
});
