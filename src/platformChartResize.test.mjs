import assert from 'node:assert/strict';
import test from 'node:test';
import { bindPlatformChartResize } from './platformChartResize.ts';

test('platform layout resize requests resize Vela layout and each chart once per frame', () => {
  const target = new EventTarget();
  const frames = [];
  const calls = [];
  const binding = bindPlatformChartResize({
    resize() {
      calls.push('workspace');
    },
    cells() {
      return [
        { chart: { resize: () => calls.push('chart-a') } },
        { chart: { resize: () => calls.push('chart-b') } },
      ];
    },
  }, target, callback => {
    frames.push(callback);
    return frames.length;
  });

  target.dispatchEvent(new Event('omega:platform-layout-resize-request'));
  target.dispatchEvent(new Event('omega:platform-layout-resize-request'));
  assert.equal(frames.length, 1);
  frames.shift()(0);
  assert.deepEqual(calls, ['workspace', 'chart-a', 'chart-b']);

  target.dispatchEvent(new Event('omega:platform-layout-resize-request'));
  assert.equal(frames.length, 1);
  frames.shift()(0);
  assert.deepEqual(calls, ['workspace', 'chart-a', 'chart-b', 'workspace', 'chart-a', 'chart-b']);

  binding.dispose();
  target.dispatchEvent(new Event('omega:platform-layout-resize-request'));
  assert.equal(frames.length, 0);
});

test('initial layout readiness can request the same chart resize path', () => {
  const frames = [];
  let chartResizeCount = 0;
  const binding = bindPlatformChartResize({
    resize() {},
    cells: () => [{ chart: { resize: () => { chartResizeCount += 1; } } }],
  }, new EventTarget(), callback => {
    frames.push(callback);
    return frames.length;
  });

  binding.requestResize();
  frames.shift()(0);
  assert.equal(chartResizeCount, 1);
  binding.dispose();
});

test('chart stage layout changes trigger one resize and disconnect cleanly', () => {
  const previousDocument = globalThis.document;
  const PreviousResizeObserver = globalThis.ResizeObserver;
  const target = new EventTarget();
  const frames = [];
  const calls = [];
  let observed;
  let observerCallback;
  let disconnected = false;
  const stage = {};
  globalThis.document = { getElementById: id => id === 'chart-stage' ? stage : null };
  globalThis.ResizeObserver = class {
    constructor(callback) {
      observerCallback = callback;
    }

    observe(element) {
      observed = element;
    }

    disconnect() {
      disconnected = true;
    }
  };
  try {
    const binding = bindPlatformChartResize({
      resize: () => calls.push('workspace'),
      cells: () => [{ chart: { resize: () => calls.push('chart') } }],
    }, target, callback => {
      frames.push(callback);
      return frames.length;
    });

    assert.equal(observed, stage);
    observerCallback([]);
    observerCallback([]);
    assert.equal(frames.length, 1);
    frames.shift()(0);
    assert.deepEqual(calls, ['workspace', 'chart']);

    binding.dispose();
    assert.equal(disconnected, true);
    assert.equal(target.dispatchEvent(new Event('omega:platform-layout-resize-request')), true);
    assert.equal(frames.length, 0);
  } finally {
    globalThis.document = previousDocument;
    if (PreviousResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = PreviousResizeObserver;
  }
});
