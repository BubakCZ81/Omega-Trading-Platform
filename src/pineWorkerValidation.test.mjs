import assert from 'node:assert/strict';
import test from 'node:test';
import { validatePineSourceOnWorker } from './pineWorkerValidation.ts';

test('validates Pine source through the supplied worker engine', async () => {
  const calls = [];
  const engine = {
    prepare: async (source, instanceId) => {
      calls.push({ source, instanceId });
      return {};
    },
  };

  await validatePineSourceOnWorker('indicator("Worker check")', engine);
  await validatePineSourceOnWorker('plot(close)', engine);

  assert.deepEqual(calls.map(call => call.source), [
    'indicator("Worker check")',
    'plot(close)',
  ]);
  assert.ok(calls.every(call => call.instanceId.startsWith('omega-validation-')));
  assert.notEqual(calls[0].instanceId, calls[1].instanceId);
});

test('surfaces worker compilation errors', async () => {
  const error = new Error('Invalid Pine source');
  await assert.rejects(
    validatePineSourceOnWorker('invalid', { prepare: async () => { throw error; } }),
    error,
  );
});
