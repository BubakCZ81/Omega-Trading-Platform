import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const profileUrl = new URL('../User_Workspaces/default.json', import.meta.url);

test('bundled default workspace starts on Solarized Dark with live Binance BTC candles', async () => {
  const profile = JSON.parse(await readFile(profileUrl, 'utf8'));
  assert.equal(profile.version, 1);
  assert.equal(profile.ext['omega.workspaceProfile'].name, 'default');
  assert.equal(profile.ext['omega.chartPreferences'].theme, 'solarized-dark');
  assert.deepEqual(profile.charts[0], {
    id: 'primary',
    symbol: 'binance:BTCUSDT',
    timeframe: '60',
    priceStyle: 'candles',
    bars: 500,
  });
});
