import assert from 'node:assert/strict';
import test from 'node:test';
import { getChartAccountStatus, resolveChartOrderRoute } from './tradingAccountStatus.ts';
import { readFile } from 'node:fs/promises';

test('local demo and missing accounts show their own status', () => {
  assert.equal(getChartAccountStatus('local-demo', 'DEMO'), 'DEMO');
  assert.equal(getChartAccountStatus(null, null), 'OFFLINE');
});

test('connected account environment is shown without defaulting unknown modes to demo', () => {
  assert.equal(getChartAccountStatus('mt5:1', 'DEMO'), 'DEMO');
  assert.equal(getChartAccountStatus('saxo:1', 'simulation'), 'DEMO');
  assert.equal(getChartAccountStatus('ibkr:DU1', 'paper'), 'DEMO');
  assert.equal(getChartAccountStatus('saxo:1', 'LIVE'), 'LIVE');
  assert.equal(getChartAccountStatus('mt5:1', 'unknown'), 'CONNECTED');
  assert.equal(getChartAccountStatus('quantower:1', 'CONNECTED'), 'CONNECTED');
  assert.equal(getChartAccountStatus('quantower:local', 'DATA'), 'DATA ONLY');
});

test('chart account status is labeled as trading state, not feed connectivity', async () => {
  const source = await readFile(new URL('./tradingAccounts.ts', import.meta.url), 'utf8');
  assert.match(source, /modeLabel\.textContent = `Trading: \$\{selectedAccountMode\}`/);
  assert.match(source, /Selected trading account mode/);
});

test('the local demo never uses broker routing, even from the broker chart buttons', () => {
  assert.equal(resolveChartOrderRoute('local-demo', 'live'), 'paper');
  assert.equal(resolveChartOrderRoute('mt5:123@Demo', 'live'), 'live');
  assert.equal(resolveChartOrderRoute('mt5:123@Demo', 'paper'), 'paper');
});
