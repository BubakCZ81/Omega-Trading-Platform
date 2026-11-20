'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildBrokerTradingCapabilities } = require('./broker-capabilities.cjs');
const { SafeguardsSettingsStore, validateSafeguardSettings } = require('./safeguards-settings.cjs');

function withDirectory(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-safeguards-'));
  return Promise.resolve(run(directory)).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

test('persists validated safeguards settings and rejects invalid caps', async () => {
  await withDirectory(directory => {
    const store = new SafeguardsSettingsStore({ directory });
    const written = store.write({ maxMt5OrderVolume: 0.02, maxSdkOrderNotional: 250 });
    assert.deepEqual(written, { version: 1, maxMt5OrderVolume: 0.02, maxSdkOrderNotional: 250 });
    assert.deepEqual(store.read().settings, written);
    assert.equal(store.read().source, 'stored');
    assert.throws(() => validateSafeguardSettings({ maxMt5OrderVolume: 10000.01, maxSdkOrderNotional: 250 }), /no greater than 10000 lots/);
    assert.throws(() => validateSafeguardSettings({ maxMt5OrderVolume: 0.02, maxSdkOrderNotional: 0 }), /between 1 and 10000 USD/);
  });
});

test('fails closed when persisted safeguards settings are corrupt', async () => {
  await withDirectory(directory => {
    const store = new SafeguardsSettingsStore({ directory });
    fs.writeFileSync(store.file, '{bad json', 'utf8');
    assert.throws(() => store.read(), /corrupt.*live orders are blocked/);
  });
});

test('migrates a previously unlimited MT5 cap down to the enforced 10000-lot maximum', async () => {
  await withDirectory(directory => {
    const store = new SafeguardsSettingsStore({ directory });
    fs.writeFileSync(store.file, JSON.stringify({
      version: 1,
      maxMt5OrderVolume: Number.MAX_VALUE,
      maxSdkOrderNotional: 100,
    }), 'utf8');
    const result = store.read();
    assert.equal(result.settings.maxMt5OrderVolume, 10000);
    assert.equal(JSON.parse(fs.readFileSync(store.file, 'utf8')).maxMt5OrderVolume, 10000);
  });
});

test('reports only the supported Alpaca SDK provider without claiming app order integration', () => {
  const sdk = require('@luxalgo/broker-sdk');
  const capabilities = buildBrokerTradingCapabilities(sdk.listBrokers());
  assert.equal(capabilities.length, 1);
  assert.equal(capabilities.filter(provider => provider.sdkOrderApiAvailable).length, 1);
  assert.equal(capabilities[0].appTradingStatus, 'manual-market-orders');
  assert.deepEqual(
    capabilities.filter(provider => provider.sdkOrderApiAvailable).map(provider => provider.id).sort(),
    ['alpaca'],
  );
});
