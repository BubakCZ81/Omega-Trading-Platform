const assert = require('node:assert/strict');
const test = require('node:test');
const { createRuntimeCleanup } = require('./runtime-cleanup.cjs');

test('runtime cleanup releases local models, AI requests, and providers once', async () => {
  const calls = [];
  let finishDisconnect;
  const cleanup = createRuntimeCleanup({
    stopLocalModels: () => calls.push('models'),
    cancelAiCompletions: () => calls.push('ai'),
    disconnectProviders: () => {
      calls.push('providers');
      return new Promise(resolve => { finishDisconnect = resolve; });
    },
  });

  const first = cleanup();
  const second = cleanup();
  assert.equal(first, second);
  await Promise.resolve();
  assert.deepEqual(calls, ['models', 'ai', 'providers']);
  finishDisconnect();
  await Promise.all([first, second]);
  assert.equal(cleanup(), first);
});

test('runtime cleanup preserves provider shutdown failures for the caller', async () => {
  const failure = new Error('one provider did not disconnect');
  const cleanup = createRuntimeCleanup({
    stopLocalModels() {},
    cancelAiCompletions() {},
    disconnectProviders: async () => { throw failure; },
  });

  const isCleanupFailure = error => error instanceof AggregateError && error.errors.includes(failure);
  await assert.rejects(cleanup(), isCleanupFailure);
  await assert.rejects(cleanup(), isCleanupFailure);
});
