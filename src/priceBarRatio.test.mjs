import assert from 'node:assert/strict';
import test from 'node:test';
import { createPriceBarRatioController } from './priceBarRatio.ts';

test('mouse-wheel zoom changes both axes by default', () => {
  const element = Object.assign(new EventTarget(), {
    getBoundingClientRect: () => ({ left: 12, top: 34 }),
  });
  const pane = {
    kind: 'price',
    scale: { min: 10, max: 20 },
    manualScale: null,
  };
  let timeZooms = 0;
  let priceZooms = 0;
  let lastPriceZoomPoint = null;
  let barSpacing = 8;
  const viewportCallbacks = [];
  let input;
  const renderer = {
    name: 'native',
    scene: { panes: new Map([['price', pane]]) },
    coords: { barCount: 2, getViewport: () => ({ barSpacing }) },
    scaleDragHolder: null,
    scaleDragStart: null,
    beginPriceScale(x, y) { priceZooms += 1; lastPriceZoomPoint = { x, y }; },
    priceScaleBy() {},
    onViewportChange(callback) { viewportCallbacks.push(callback); return () => {}; },
    getVisibleRange: () => ({ from: 0, to: 10 }),
    setVisibleRange() {},
    readFeature: () => false,
    applyFeature() {},
  };
  input = {
    el: element,
    regionAt: () => 'data',
    onWheel(event) {
      if (input.regionAt(0, 0) === 'price') renderer.beginPriceScale(0, 0);
      else timeZooms += 1;
    },
  };
  renderer.input = input;
  element.addEventListener('wheel', input.onWheel, { passive: false });

  const controller = createPriceBarRatioController({ renderer });
  const wheel = new Event('wheel', { cancelable: true });
  Object.defineProperties(wheel, {
    deltaX: { value: 0 },
    deltaY: { value: 120 },
    shiftKey: { value: false },
    clientX: { value: 212 },
    clientY: { value: 334 },
  });
  element.dispatchEvent(wheel);

  assert.equal(timeZooms, 1);
  assert.equal(priceZooms, 0);
  assert.equal(pane.manualScale, null);

  barSpacing = 16;
  for (const callback of viewportCallbacks) callback({ from: 0, to: 10 });
  assert.deepEqual(pane.manualScale, { min: 12.5, max: 17.5 });

  controller.setWheelMode('price');
  element.dispatchEvent(wheel);
  assert.equal(timeZooms, 1);
  assert.equal(priceZooms, 1);
  assert.deepEqual(lastPriceZoomPoint, { x: 200, y: 300 });

  controller.setWheelMode('both');
  element.dispatchEvent(wheel);
  assert.equal(timeZooms, 2);
  assert.equal(priceZooms, 1);
  assert.deepEqual(lastPriceZoomPoint, { x: 200, y: 300 });
});
