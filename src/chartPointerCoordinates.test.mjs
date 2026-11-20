import assert from 'node:assert/strict';
import test from 'node:test';
import { clientPointToElementLocal } from './chartPointerCoordinates.ts';

test('pointer coordinates map correctly for a resized chart host', () => {
  const scaledHost = {
    offsetWidth: 1000,
    offsetHeight: 500,
    getBoundingClientRect: () => ({ left: 40, top: 20, width: 800, height: 400 }),
  };
  assert.deepEqual(clientPointToElementLocal(scaledHost, 440, 220), { x: 500, y: 250 });
});

test('pointer coordinates preserve identity mapping and zero-size safety', () => {
  const normalHost = {
    offsetWidth: 900,
    offsetHeight: 600,
    getBoundingClientRect: () => ({ left: 10, top: 30, width: 900, height: 600 }),
  };
  assert.deepEqual(clientPointToElementLocal(normalHost, 410, 330), { x: 400, y: 300 });
  const hiddenHost = {
    offsetWidth: 0,
    offsetHeight: 0,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
  assert.deepEqual(clientPointToElementLocal(hiddenHost, 100, 100), { x: 0, y: 0 });
});
