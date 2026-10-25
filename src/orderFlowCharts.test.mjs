import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRenkoBricks, layoutRenkoBricks } from './orderFlowCharts.ts';

test('Renko bodies keep one fixed price height for a fixed brick size', () => {
  const bricks = buildRenkoBricks([
    { time: 1, open: 100, high: 100, low: 100, close: 100 },
    { time: 2, open: 100, high: 104, low: 99, close: 103 },
    { time: 3, open: 103, high: 104, low: 97, close: 98 },
  ], { mode: 'fixed', boxSize: 1 });

  assert.ok(bricks.length > 2);
  for (const brick of bricks) assert.equal(Math.abs(brick.close - brick.open), 1);
});

test('visible Renko bricks use equal widths and evenly spaced chart positions', () => {
  const bricks = [
    { time: 1, open: 1, high: 2, low: 1, close: 2 },
    { time: 2, open: 2, high: 3, low: 2, close: 3 },
    { time: 3, open: 3, high: 4, low: 3, close: 4 },
  ];
  const positioned = layoutRenkoBricks(bricks.map((brick, index) => ({ brick, logical: index })), {
    from: 0,
    to: 2,
  }, 12);

  assert.equal(positioned.length, 3);
  assert.equal(new Set(positioned.map(entry => entry.width)).size, 1);
  for (const [index, entry] of positioned.entries()) {
    assert.ok(Math.abs(entry.logical - (1 / 3 + index * 2 / 3)) < 1e-9);
  }
});

test('Renko layout excludes off-screen bricks and rejects invalid ranges', () => {
  const brick = { time: 1, open: 1, high: 2, low: 1, close: 2 };
  const entries = [-1, 0.5, 2, 3].map(logical => ({ brick, logical }));
  const visible = layoutRenkoBricks(entries, { from: 0, to: 2 }, 10);

  assert.deepEqual(visible.map(entry => entry.logical), [0.5, 1.5]);
  assert.deepEqual(layoutRenkoBricks(entries, { from: 2, to: 2 }, 10), []);
});
