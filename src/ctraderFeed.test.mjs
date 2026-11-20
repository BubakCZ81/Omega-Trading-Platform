import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CTraderDataProvider, fetchCTraderSpot, parseCTraderBars, parseCTraderSymbols } from './ctraderFeed.ts';

const symbolDetails = {
  symbolName: 'EURUSD', digits: 5, pipSize: 0.0001, lotSize: 100_000,
  minVolume: 1_000, maxVolume: 10_000_000, volumeStep: 1_000,
};

test('parses cTrader symbols and timestamped trend bars', () => {
  assert.deepEqual(parseCTraderSymbols({ symbols: [{ name: 'EURUSD', description: 'Euro vs US Dollar', category: 'FX Majors', assetClass: 'Forex' }] }), [
    { ticker: 'EURUSD', description: 'Euro vs US Dollar', type: 'Forex', group: 'FX Majors', prefix: 'cTrader', provider: 'ctrader' },
  ]);
  assert.deepEqual(parseCTraderBars({ bars: [{ timestamp: '2025-01-01T00:00:00Z', open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 4 }] }), [
    { time: Date.UTC(2025, 0, 1), open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 4 },
  ]);
});

test('exposes a validated cTrader spot quote to the watchlist', async () => {
  const provider = new CTraderDataProvider({
    connect: async () => { throw new Error('not used'); },
    status: async () => { throw new Error('not used'); },
    disconnect: async () => true,
    placeMarketOrder: async () => { throw new Error('not used'); },
    marketData: async (tool, args) => {
      assert.equal(tool, 'get_spot_prices');
      assert.deepEqual(args, { symbolName: 'EURUSD' });
      return { symbolName: 'EURUSD', bid: 1.1, ask: 1.1002 };
    },
  });
  provider.setSymbols(parseCTraderSymbols({ symbols: [{ name: 'EURUSD' }] }));
  assert.deepEqual(await provider.getQuote('EURUSD'), { bid: 1.1, ask: 1.1002 });
});

test('turns an unavailable cTrader subscription into an actionable no-order error', async () => {
  const bridge = {
    marketData: async () => {
      throw new Error('cTrader MCP get_spot_prices failed: No live quote for ETHUSD — symbol is unsubscribed or market data unavailable');
    },
  };
  await assert.rejects(
    fetchCTraderSpot(bridge, 'ETHUSD'),
    /Open ETHUSD in cTrader and confirm its bid\/ask is updating, then retry\. No order was sent/,
  );
});

test('maps chart history to cTrader trend bars and aggregates unsupported minute intervals', async () => {
  const start = Date.UTC(2025, 0, 1);
  let trendRequest;
  const provider = new CTraderDataProvider({
    connect: async () => { throw new Error('not used'); },
    status: async () => { throw new Error('not used'); },
    disconnect: async () => true,
    placeMarketOrder: async () => { throw new Error('not used'); },
    marketData: async (tool, args) => {
      assert.equal(tool, 'get_trendbars');
      trendRequest = args;
      return { bars: Array.from({ length: 6 }, (_value, index) => ({
        timestamp: new Date(start + index * 60_000).toISOString(),
        open: 1 + index, high: 1.5 + index, low: 0.5 + index, close: 1.25 + index, volume: 2,
      })) };
    },
  });
  provider.setSymbols(parseCTraderSymbols({ symbols: [{ name: 'EURUSD' }] }));

  const bars = await provider.getBars('EURUSD', '3', { from: start, to: start + 6 * 60_000, limit: 10 });
  assert.equal(trendRequest.symbolName, 'EURUSD');
  assert.equal(trendRequest.timeframe, 'm1');
  assert.equal(trendRequest.from, new Date(start).toISOString());
  assert.equal(bars.length, 2);
  assert.deepEqual(bars[0], { time: start, open: 1, high: 3.5, low: 0.5, close: 3.25, volume: 6 });
  assert.deepEqual(bars[1], { time: start + 3 * 60_000, open: 4, high: 6.5, low: 3.5, close: 6.25, volume: 6 });
});

test('seeds the active M1 candle from history and updates it with cTrader spot quotes', async () => {
  const currentMinute = Math.floor(Date.now() / 60_000) * 60_000;
  const requests = [];
  const provider = new CTraderDataProvider({
    connect: async () => { throw new Error('not used'); },
    status: async () => { throw new Error('not used'); },
    disconnect: async () => true,
    placeMarketOrder: async () => { throw new Error('not used'); },
    marketData: async (tool, args) => {
      requests.push({ tool, args });
      if (tool === 'get_trendbars') {
        return { bars: [{ timestamp: new Date(currentMinute).toISOString(), open: 1.1, high: 1.1, low: 1.1, close: 1.1 }] };
      }
      assert.equal(tool, 'get_spot_prices');
      return { symbolName: 'EURUSD', bid: 1.1002, ask: 1.1004 };
    },
  });
  provider.setSymbols(parseCTraderSymbols({ symbols: [{ name: 'EURUSD' }] }));

  let stop;
  const update = new Promise(resolve => { stop = provider.subscribe('EURUSD', '1', resolve); });
  const bar = await Promise.race([
    update,
    new Promise((_, reject) => setTimeout(() => reject(new Error('cTrader did not emit the active candle update.')), 500)),
  ]);
  stop();

  assert.deepEqual(requests.map(request => request.tool), ['get_trendbars', 'get_spot_prices']);
  assert.equal(requests[0].args.timeframe, 'm1');
  assert.equal(bar.time, currentMinute);
  assert.equal(bar.open, 1.1);
  assert.equal(bar.close, 1.1002);
  assert.equal(bar.high, 1.1002);
});

test('loads cTrader symbol precision and caches validated trading metadata', async () => {
  let detailCalls = 0;
  const provider = new CTraderDataProvider({
    connect: async () => { throw new Error('not used'); },
    status: async () => { throw new Error('not used'); },
    disconnect: async () => true,
    placeMarketOrder: async () => { throw new Error('not used'); },
    marketData: async tool => {
      assert.equal(tool, 'get_symbol_details');
      detailCalls += 1;
      return symbolDetails;
    },
  });
  provider.setSymbols(parseCTraderSymbols({ symbols: [{ name: 'EURUSD' }] }));
  const first = await provider.getSymbolInfo('EURUSD');
  const second = await provider.getSymbolInfo('EURUSD');
  assert.equal(first?.digits, 5);
  assert.equal(first?.minTick, 0.00001);
  assert.equal(first?.pipSize, 0.0001);
  assert.equal(first?.contractSize, 100_000);
  assert.deepEqual(second, first);
  assert.equal(detailCalls, 1);
});
