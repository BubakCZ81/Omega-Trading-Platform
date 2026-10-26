import assert from 'node:assert/strict';
import test from 'node:test';
import { getToolbarPopupPosition } from './toolbarDropdowns.ts';

test('keeps a wide popup inside a narrow viewport', () => {
  assert.deepEqual(
    getToolbarPopupPosition(
      { left: 255, right: 295, top: 0, bottom: 28 },
      { width: 740, height: 380 },
      { width: 971, height: 956 },
    ),
    { left: 219, top: 34 },
  );
});

test('moves a popup above its trigger when there is not enough room below', () => {
  assert.deepEqual(
    getToolbarPopupPosition(
      { left: 600, right: 660, top: 820, bottom: 850 },
      { width: 220, height: 200 },
      { width: 900, height: 900 },
    ),
    { left: 600, top: 614 },
  );
});

test('keeps a popup visible when its trigger is near the viewport edge', () => {
  assert.deepEqual(
    getToolbarPopupPosition(
      { left: 970, right: 1030, top: 0, bottom: 28 },
      { width: 128, height: 206 },
      { width: 971, height: 956 },
    ),
    { left: 831, top: 34 },
  );
});
