import assert from 'node:assert/strict';
import test from 'node:test';
import { AlpacaDataProvider } from './alpacaFeed.ts';

test('requests the Broker SDK supported minute, hourly, and daily timeframes', async () => {
  const requests = [];
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async request => {
      requests.push(request);
      return [];
    },
  });
  provider.setConnected(true);

  await provider.getBars('alpaca:aapl', '1', { limit: 20 });
  await provider.getBars('AAPL', '5', { limit: 15 });
  await provider.getBars('AAPL', '15', { limit: 10 });
  await provider.getBars('AAPL', '60', { limit: 10 });
  await provider.getBars('AAPL', 'D', { limit: 5 });

  assert.deepEqual(requests.map(request => [request.symbol, request.timeframe]), [
    ['AAPL', '1m'],
    ['AAPL', '5m'],
    ['AAPL', '15m'],
    ['AAPL', '1h'],
    ['AAPL', '1d'],
  ]);
});

test('uses the Broker SDK date-range API and restricts unsupported timeframes', async () => {
  let request;
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async value => {
      request = value;
      return [];
    },
  });
  provider.setConnected(true);

  const now = Date.now();
  await provider.getBars('AAPL', '1D', { limit: 10 });
  assert.equal(request.timeframe, '1d');
  assert.equal(request.symbol, 'AAPL');
  assert.equal(request.limit, 10);
  assert.ok(request.to >= now);
  assert.equal(request.from, request.to - 10 * 24 * 60 * 60_000);
  await assert.rejects(provider.getBars('AAPL', '2D', { limit: 10 }), /Broker SDK does not support/);
});

test('returns minute bars from the Broker SDK unchanged', async () => {
  const expectedBars = [
    { time: 1_760_000_000_000, open: 100, high: 102, low: 99, close: 101, volume: 42 },
  ];
  let request;
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async value => {
      request = value;
      return expectedBars;
    },
  });
  provider.setConnected(true);

  const bars = await provider.getBars('AAPL', '1', { limit: 3000 });

  assert.equal(request.symbol, 'AAPL');
  assert.equal(request.timeframe, '1m');
  assert.deepEqual(bars, expectedBars);
});

test('requires an active Broker SDK connection and does not use a second feed bridge', async () => {
  const provider = new AlpacaDataProvider({
    fetchHistoricalBars: async () => null,
  });

  await assert.rejects(provider.getBars('AAPL', '1', { limit: 10 }), /Connect Alpaca through the Broker panel/);
  provider.setConnected(true);
  await assert.rejects(provider.getBars('AAPL', '1', { limit: 10 }), /Broker SDK history is unavailable/);
});
