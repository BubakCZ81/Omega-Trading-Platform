import assert from 'node:assert/strict';
import test from 'node:test';
import { runSafeguardScenarios } from './safeguardScenarios.ts';

test('offline safeguard scenarios exercise mocked order paths only', async () => {
  const scenarios = await runSafeguardScenarios();
  assert.equal(scenarios.length, 21);
  assert.ok(scenarios.every(scenario => scenario.passed), JSON.stringify(scenarios.filter(scenario => !scenario.passed)));
  assert.ok(scenarios.some(scenario => scenario.id === 'timeout-reconciliation'));
  assert.ok(scenarios.some(scenario => scenario.id === 'journal-integrity'));
  assert.ok(scenarios.some(scenario => scenario.id === 'read-only-provider-submission-blocked'));
  assert.ok(scenarios.every(scenario => !scenario.outcome.includes('real send')));
});
