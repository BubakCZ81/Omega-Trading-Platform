import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aggregateMt5Bars,
  mt5TimeframeBucketStart,
  initializeMt5Feed,
  Mt5DataProvider,
  resolveMt5Timeframe,
  updateMt5TimeframeBar,
} from './mt5Feed.ts';
import { filterSymbolsByCategory } from './symbolPickerCategories.ts';

function createDeferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class FakeElement extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.dataset = {};
    this.classList = { add() {}, remove() {}, contains: () => false };
    this.children = [];
  }

  setAttribute() {}
  replaceChildren(...children) { this.children = children; }
  append(...children) { this.children.push(...children); }
}

function createFeedHarness(t, connect) {
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousStorage = globalThis.localStorage;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousStorage === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previousStorage;
  });
  const elements = new Map();
  const documentTarget = new EventTarget();
  documentTarget.getElementById = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  documentTarget.createElement = () => new FakeElement();
  const registered = [];
  const unregistered = [];
  const chart = {
    data: {
      registerProvider: (name, provider) => { registered.push({ name, provider }); },
      ready: async () => {},
      unregisterProvider: name => { unregistered.push(name); },
    },
  };
  const workspace = {
    cells: () => [{ id: 'cell-1', chart }],
    cell: id => id === 'cell-1' ? { chart } : undefined,
    on: () => () => {},
    active: { setSymbol() {} },
  };
  const symbol = {
    ticker: 'EURUSD',
    description: 'Euro vs US Dollar',
    path: 'Forex\\Majors',
    digits: 5,
    point: 0.00001,
    currencyBase: 'EUR',
    currencyProfit: 'USD',
  };
  documentTarget.dispatchEvent = EventTarget.prototype.dispatchEvent;
  globalThis.document = documentTarget;
  globalThis.localStorage = { getItem: () => 'local-demo' };
  globalThis.window = {
    velaMt5: {
      connect,
      symbols: async () => [symbol],
      bars: async () => [],
      quote: async () => ({ bid: 1, ask: 2 }),
      ticks: async () => [],
      marketBook: async () => [],
      info: async () => symbol,
      disconnect: async () => true,
    },
  };
  initializeMt5Feed(() => workspace);
  return { documentTarget, elements, registered, unregistered, symbol };
}

test('resolves and aggregates MT5 timeframes into chronological OHLCV bars', () => {
  const minute = 60_000;
  const start = Date.UTC(2026, 0, 1);
  const source = Array.from({ length: 4 }, (_, index) => ({
    time: start + index * minute,
    open: 10 + index,
    high: 11 + index,
    low: 9 + index,
    close: 10 + index,
    volume: 2,
  }));

  assert.deepEqual(resolveMt5Timeframe('7'), {
    timeframe: 'M1',
    bucketMs: 7 * minute,
    sourceMinutes: 1,
    targetMinutes: 7,
  });
  assert.deepEqual(aggregateMt5Bars(source, 2 * minute), [
    { time: start, open: 10, high: 12, low: 9, close: 11, volume: 4 },
    { time: start + 2 * minute, open: 12, high: 14, low: 11, close: 13, volume: 4 },
  ]);
});

test('preserves every MT5 crypto descriptor and exposes them in the crypto picker category', async () => {
  const provider = new Mt5DataProvider({
    bars: async () => [],
    ticks: async () => [],
    quote: async () => ({ bid: 1, ask: 2 }),
    marketBook: async () => [],
    info: async () => undefined,
  });
  provider.setSymbols(Array.from({ length: 53 }, (_, index) => ({
    ticker: `COIN${index}USD`,
    description: `Crypto asset ${index}`,
    path: `Retail\\Cryptocurrencies\\Minor\\COIN${index}USD`,
    digits: 2,
    point: 0.01,
    currencyBase: `COIN${index}`,
    currencyProfit: 'USD',
  })));

  const symbols = await provider.listSymbols();
  assert.equal(symbols.length, 53);
  assert.equal(filterSymbolsByCategory(symbols, '', 'Crypto').length, 53);
});

test('strips MT5 chart prefixes before requesting terminal bars, ticks, symbol info, and streams', async () => {
  const calls = [];
  const symbol = {
    ticker: 'UK100',
    description: 'UK 100 Index',
    path: 'Indices\\UK',
    digits: 1,
    point: 0.1,
    currencyBase: 'GBP',
    currencyProfit: 'GBP',
  };
  const provider = new Mt5DataProvider({
    bars: async request => { calls.push(['bars', request.ticker]); return []; },
    ticks: async request => { calls.push(['ticks', request.ticker]); return []; },
    tickBars: async request => { calls.push(['tickBars', request.provider, request.ticker]); return []; },
    quote: async ticker => { calls.push(['quote', ticker]); return { bid: 1, ask: 2, timeMsc: Date.now() }; },
    marketBook: async () => [],
    info: async ticker => { calls.push(['info', ticker]); return symbol; },
    subscribeTicks: (ticker, onTicks) => {
      calls.push(['subscribeTicks', ticker]);
      return () => {};
    },
    subscribeTickBars: (provider, ticker) => {
      calls.push(['subscribeTickBars', provider, ticker]);
      return () => {};
    },
  });
  provider.setSymbols([symbol]);

  await provider.getBars('MT5:UK100', '1', { limit: 1 });
  await provider.getBars('MT5:UK100', 'T1', { from: 0, to: Date.now(), limit: 1 });
  await provider.getQuote('MT5:UK100');
  await provider.getSymbolInfo('MT5:UK100');
  provider.subscribe('MT5:UK100', 'T1', () => {})();

  assert.deepEqual(calls, [
    ['bars', 'UK100'],
    ['tickBars', 'mt5', 'UK100'],
    ['quote', 'UK100'],
    ['info', 'UK100'],
    ['subscribeTickBars', 'mt5', 'UK100'],
  ]);
});

test('aggregates MT5 ticks into the active timeframe candle without changing its spacing', () => {
  const start = Date.UTC(2026, 0, 1, 12);
  assert.deepEqual(updateMt5TimeframeBar(null, {
    time: start,
    bid: 10,
    ask: 10,
    last: 10,
    volume: 7,
    volumeReal: 0,
  }, '1', start), { time: start, open: 10, high: 10, low: 10, close: 10, volume: 7 });
  const current = { time: start, open: 10, high: 10, low: 10, close: 10, volume: 0 };
  const updated = updateMt5TimeframeBar(current, {
    time: start + 30_000,
    bid: 11,
    ask: 11,
    last: 11,
    volumeReal: 1,
  }, '1', start);
  assert.deepEqual(updated, { time: start, open: 10, high: 11, low: 10, close: 11, volume: 1 });
  assert.equal(mt5TimeframeBucketStart(start + 60_000, '1', start), start + 60_000);
  assert.deepEqual(updateMt5TimeframeBar(updated, {
    time: start + 60_000,
    bid: 9,
    ask: 9,
    last: 9,
    volumeReal: 2,
  }, '1', start), { time: start + 60_000, open: 9, high: 9, low: 9, close: 9, volume: 2 });
});

test('streams MT5 ticks into ordinary timeframe bars instead of polling candle history', async t => {
  const now = Date.now();
  const start = Math.floor(now / 60_000) * 60_000;
  let barsRequested = 0;
  let historyRequest;
  let ticksRequested = 0;
  const provider = new Mt5DataProvider({
    bars: async request => {
      barsRequested += 1;
      historyRequest = request;
      return [{ time: start, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
    },
    ticks: async () => {
      ticksRequested += 1;
      return [{ time: now, bid: 1.1, ask: 1.1, last: 1.1, volumeReal: 0, volume: 0, flags: 0 }];
    },
    quote: async () => ({ bid: 1, ask: 1 }),
    marketBook: async () => [],
    info: async () => undefined,
  });
  provider.setSymbols([{
    ticker: 'EURUSD',
    description: 'Euro vs US Dollar',
    path: 'Forex\\Majors',
    digits: 5,
    point: 0.00001,
    currencyBase: 'EUR',
    currencyProfit: 'USD',
  }]);
  const updates = [];
  const stop = provider.subscribe('EURUSD', '1', bar => updates.push(bar));
  await new Promise(resolve => setImmediate(resolve));
  stop();

  assert.equal(barsRequested, 1);
  assert.equal(historyRequest.timeframe, 'M1');
  assert.ok(ticksRequested > 0);
  assert.equal(updates.at(-1)?.close, 1.1);
  assert.equal(updates.at(-1)?.time, start);
});

test('disconnect clears MT5 symbols and prevents future chart history requests', async () => {
  let barsRequested = false;
  const provider = new Mt5DataProvider({
    bars: async () => {
      barsRequested = true;
      return [];
    },
    ticks: async () => [],
    quote: async () => ({ bid: 1, ask: 2 }),
    marketBook: async () => [],
    info: async () => undefined,
  });

  test('exposes only valid timestamped MT5 bid/ask quotes to the watchlist', async () => {
    const provider = new Mt5DataProvider({
      bars: async () => [],
      ticks: async () => [],
      quote: async () => ({ bid: 1.1, ask: 1.1002, timeMsc: Date.now() }),
      marketBook: async () => [],
      info: async () => undefined,
    });
    provider.setSymbols([{
      ticker: 'EURUSD', description: 'Euro vs US Dollar', path: 'Forex\\Majors',
      digits: 5, point: 0.00001, currencyBase: 'EUR', currencyProfit: 'USD',
    }]);

    const quote = await provider.getQuote('MT5:EURUSD');
    assert.equal(quote.bid, 1.1);
    assert.equal(quote.ask, 1.1002);
    assert.ok(Number.isFinite(quote.timeMsc));
  });
  provider.setSymbols([{
    ticker: 'EURUSD',
    description: 'Euro vs US Dollar',
    path: 'Forex\\Majors',
    digits: 5,
    point: 0.00001,
    currencyBase: 'EUR',
    currencyProfit: 'USD',
  }]);
  assert.equal((await provider.listSymbols()).length, 1);

  provider.disconnect();

  assert.deepEqual(await provider.listSymbols(), []);
  await assert.rejects(provider.getBars('EURUSD', '1', { limit: 10 }), /feed is disconnected/);
  assert.equal(barsRequested, false);
});

test('disconnects the MT5 chart provider when another feed starts', async t => {
  const harness = createFeedHarness(t, async () => ({
    company: 'Broker',
    terminal: 'Terminal',
    server: 'Demo',
    symbols: [{
      ticker: 'EURUSD',
      description: 'Euro vs US Dollar',
      path: 'Forex\\Majors',
      digits: 5,
      point: 0.00001,
      currencyBase: 'EUR',
      currencyProfit: 'USD',
    }],
  }));
  const connecting = harness.elements.get('mt5-feed-connect');
  connecting.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.registered.some(item => item.name === 'mt5'));
  assert.equal(harness.elements.has('mt5-symbol-search'), false);
  assert.equal(harness.elements.has('mt5-symbol-list'), false);
  assert.equal(harness.elements.get('mt5-feed-connection-status').dataset.state, 'success');

  harness.documentTarget.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'alpaca' }));

  assert.ok(harness.unregistered.includes('mt5'));
});

test('ignores an MT5 connection response superseded by another feed', async t => {
  const connection = createDeferred();
  const harness = createFeedHarness(t, () => connection.promise);
  harness.elements.get('mt5-feed-connect').dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));
  harness.documentTarget.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'ctrader' }));
  connection.resolve({
    company: 'Broker',
    terminal: 'Terminal',
    server: 'Demo',
    symbols: [harness.symbol],
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(harness.registered.some(item => item.name === 'mt5'), false);
});

test('shows an actionable error when connecting to MT5 fails', async t => {
  const harness = createFeedHarness(t, async () => {
    throw new Error('MetaTrader terminal is not running');
  });
  const connectButton = harness.elements.get('mt5-feed-connect');
  connectButton.dispatchEvent(new Event('click'));
  await new Promise(resolve => setImmediate(resolve));

  const status = harness.elements.get('mt5-feed-connection-status');
  assert.match(status.textContent, /Could not connect to MT5: MetaTrader terminal is not running/);
  assert.equal(status.dataset.state, 'error');
  assert.equal(connectButton.disabled, false);
});
