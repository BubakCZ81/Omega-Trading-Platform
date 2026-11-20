import assert from 'node:assert/strict';
import { test } from 'node:test';
import { QuantowerDataProvider, findQuantowerFallback } from './quantowerFeed.ts';

test('Quantower chart subscription updates the forming candle from new trades', async () => {
  const now = Date.now();
  const candleTime = Math.floor(now / 60_000) * 60_000;
  let tradeCalls = 0;
  const provider = new QuantowerDataProvider({
    start: async () => ({ started: false }),
    health: async () => ({ connected: true, symbols: 1 }),
    symbols: async () => [],
    accounts: async () => [],
    placeOrder: async () => ({ status: 'submitted' }),
    closePosition: async () => ({ status: 'submitted' }),
    bars: async () => [{ time: candleTime, open: 1, high: 1.1, low: 0.9, close: 1, volume: 10 }],
    quote: async () => ({ ticker: 'EURUSD', bid: 1, ask: 1, last: 1, time: new Date(now).toISOString() }),
    trades: async request => {
      tradeCalls += 1;
      if (tradeCalls === 1) return [{ sequence: 10, time: now - 1, price: 1, volume: 1, side: 'BUY' }];
      if (request.after === 10) return [{ sequence: 11, time: now, price: 1.2, volume: 2, side: 'BUY' }];
      return [];
    },
    marketBook: async () => [],
  });
  provider.setSymbols([{ ticker: 'EURUSD', description: 'Euro / US Dollar' }]);

  let stop = () => {};
  let timeout;
  const update = new Promise((resolve, reject) => {
    stop = provider.subscribe('EURUSD', '1', resolve);
    timeout = setTimeout(() => reject(new Error('Quantower trade update timed out.')), 2_500);
  });
  try {
    const bar = await update;
    assert.equal(bar.time, candleTime);
    assert.equal(bar.high, 1.2);
    assert.equal(bar.close, 1.2);
    assert.equal(bar.volume, 12);
  } finally {
    clearTimeout(timeout);
    stop();
  }
});

test('Quantower symbol metadata retains minimum tick size and actual precision', async () => {
  const provider = new QuantowerDataProvider({
    start: async () => ({ started: false }),
    health: async () => ({ connected: true, symbols: 1 }),
    symbols: async () => [],
    accounts: async () => [],
    placeOrder: async () => ({ status: 'submitted' }),
    closePosition: async () => ({ status: 'submitted' }),
    bars: async () => [],
    quote: async () => ({ ticker: '/NQ:XCME', bid: 1, ask: 2, last: 1.5, time: new Date().toISOString() }),
    trades: async () => [],
    marketBook: async () => [],
  });

  provider.setSymbols([{ ticker: '/NQ:XCME', description: 'E-mini Nasdaq-100', path: 'XCME', type: 'Futures', digits: 1, point: 0.25 }]);

  const info = await provider.getSymbolInfo('/NQ:XCME');
  assert.equal(info?.digits, 1);
  assert.equal(info?.minTick, 0.25);
});

test('returns a validated timestamped Quantower bid/ask quote', async () => {
  const provider = new QuantowerDataProvider({
    start: async () => ({ started: false }),
    health: async () => ({ connected: true, symbols: 1 }),
    symbols: async () => [],
    accounts: async () => [],
    placeOrder: async () => ({ status: 'submitted' }),
    closePosition: async () => ({ status: 'submitted' }),
    bars: async () => [],
    quote: async () => ({ ticker: 'EURUSD', bid: 1.1, ask: 1.1002, last: 1.1, time: '2026-11-08T08:00:00Z' }),
    trades: async () => [],
    marketBook: async () => [],
  });
  provider.setSymbols([{ ticker: 'EURUSD', description: 'Euro / US Dollar' }]);
  const quote = await provider.getQuote('EURUSD');
  assert.equal(quote.bid, 1.1);
  assert.equal(quote.ask, 1.1002);
  assert.equal(quote.timeMsc, Date.parse('2026-11-08T08:00:00Z'));
});


test('Quantower widens a narrow minute history request when it contains only the current candle', async () => {
  const calls = [];
  const candles = [60_000, 120_000, 180_000].map(time => ({ time, open: 1, high: 1, low: 1, close: 1 }));
  const provider = new QuantowerDataProvider({
    bars: async request => {
      calls.push(request);
      return request.limit < 1000 ? candles.slice(-1) : candles;
    },
  });
  provider.setSymbols([{ ticker: '/NQ:XCME', description: 'E-mini Nasdaq' }]);

  assert.deepEqual(await provider.getBars('Quantower:/NQ:XCME', '1', { limit: 2 }), candles.slice(-2));
  assert.deepEqual(calls.map(request => request.limit), [2, 1000]);
  assert.ok(calls.every(request => request.symbol === '/NQ:XCME' && request.timeframe === '1'));
});

test('Quantower switches from unsupported tick history only to a period with real bars', async () => {
  const periods = [];
  const provider = {
    getBars: async (_symbol, period) => {
      periods.push(period);
      if (period === 'T75') throw new Error('Unsupported timeframe T75.');
      return period === '5' ? [{ time: 60_000 }] : [];
    },
  };
  assert.equal(await findQuantowerFallback(provider, 'Quantower:/NQ:XCME', 'T75', () => true), '5');
  assert.deepEqual(periods, ['T75', '5']);
});
