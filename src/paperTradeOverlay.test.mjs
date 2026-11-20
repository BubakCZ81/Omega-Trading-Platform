import assert from 'node:assert/strict';
import test from 'node:test';
import { isTradeOverlayLabelHit, isTradePlotX, nearestBarIndexAtX, resolveMeasurementPoint } from './paperTradeOverlay.ts';

test('protection interactions stay inside the plot and never claim the price axis', () => {
  assert.equal(isTradePlotX(400, 500), true);
  assert.equal(isTradePlotX(500, 500), true);
  assert.equal(isTradePlotX(501, 500), false);
  assert.equal(isTradePlotX(560, 500), false);
  assert.equal(isTradePlotX(-1, 500), false);
  assert.equal(isTradePlotX(20, Number.NaN), false);
});

test('protection levels can be dragged from their labels, not from the line', () => {
  const label = { x: 420, y: 180, width: 72, height: 30 };
  assert.equal(isTradeOverlayLabelHit(label, 450, 180), true);
  assert.equal(isTradeOverlayLabelHit(label, 410, 180), false);
  assert.equal(isTradeOverlayLabelHit(label, 450, 164), false);
  assert.equal(isTradeOverlayLabelHit(label, 450, 195), true);
});

test('measurement x coordinates resolve to the nearest actual chart bar', () => {
  const bars = [{ time: 100 }, { time: 200 }, { time: 300 }, { time: 400 }];
  const timeToX = time => time / 10;

  assert.equal(nearestBarIndexAtX(bars, 20, timeToX), 1);
  assert.equal(nearestBarIndexAtX(bars, 24, timeToX), 1);
  assert.equal(nearestBarIndexAtX(bars, 26, timeToX), 2);
  assert.equal(nearestBarIndexAtX(bars, Number.NaN, timeToX), null);
  assert.equal(nearestBarIndexAtX([], 20, timeToX), null);

  class MockCoords {
    logicalToX(logical) { return logical * 10; }
    timeToLogical(time) { return time / 100; }
    timeToX(time) { return this.logicalToX(this.timeToLogical(time)); }
  }
  const mockCoords = new MockCoords();
  assert.equal(nearestBarIndexAtX(bars, 20, time => mockCoords.timeToX(time)), 1);
});

test('measurement resolves a valid price even when chart bars are not available', () => {
  assert.deepEqual(resolveMeasurementPoint(200, 80, 500, () => 1.25, () => null), {
    price: 1.25,
    barIndex: null,
  });
  assert.deepEqual(resolveMeasurementPoint(200, 80, 500, () => 1.25), {
    price: 1.25,
    barIndex: null,
  });
  assert.equal(resolveMeasurementPoint(501, 80, 500, () => 1.25), null);
  assert.equal(resolveMeasurementPoint(200, 80, 500, () => Number.NaN), null);
});
