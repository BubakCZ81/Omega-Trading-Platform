import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBidAskQuote, isQuoteResponse, positionQuoteLabels, resolveBidAskDigits } from './bidAskLines.ts';

test('validates a positive, ordered bid/ask quote', () => {
  assert.equal(isQuoteResponse({ bid: 1.1, ask: 1.2 }), true);
  assert.equal(isQuoteResponse({ bid: 0, ask: 1 }), false);
  assert.equal(isQuoteResponse({ bid: 2, ask: 1 }), false);
  assert.equal(isQuoteResponse({ bid: Number.NaN, ask: 2 }), false);
});

test('reads MT5 bid/ask data through the current desktop bridge', async t => {
  const previousWindow = globalThis.window;
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  globalThis.window = { velaMt5: { quote: async ticker => {
    assert.equal(ticker, 'EURUSD');
    return { bid: 1.08, ask: 1.0802 };
  } } };

  assert.deepEqual(await fetchBidAskQuote('mt5', 'EURUSD', new AbortController().signal), {
    bid: 1.08,
    ask: 1.0802,
  });
});


test('reads both prices from the resolved chart provider and preserves their precision', async () => {
  const quote = { bid: 1.081234567, ask: 1.081234568, timeMsc: Date.now() };
  const source = {
    async getQuote(ticker) {
      assert.equal(ticker, '/NQ:XCME');
      return quote;
    },
  };
  const signal = new AbortController().signal;
  assert.deepEqual(await fetchBidAskQuote('quantower', '/NQ:XCME', signal, source), quote);
  quote.timeMsc -= 61_000;
  assert.equal(await fetchBidAskQuote('quantower', '/NQ:XCME', signal, source), null);
  assert.deepEqual(await fetchBidAskQuote('quantower', '/NQ:XCME', signal, source, true), quote);
});


test('Bid and Ask labels separate a tight spread and stay inside the right price axis', () => {
  assert.deepEqual(positionQuoteLabels(50, 51, 0, 100), [41.5, 59.5]);
  assert.deepEqual(positionQuoteLabels(-100, -99, 0, 100), [9, 27]);
  assert.deepEqual(positionQuoteLabels(105, 104, 0, 100), [91, 73]);
});

test('BID and ASK labels use the symbol precision for both prices', () => {
  const digits = resolveBidAskDigits('EURUSD', { digits: 5, minTick: 0.0001 });
  assert.equal((1.098141234).toFixed(digits), '1.09814');
  assert.equal((1.0982).toFixed(digits), '1.09820');
  assert.equal(resolveBidAskDigits('USDJPY', { digits: 2 }), 2);
  assert.equal(resolveBidAskDigits('USDJPY'), 3);
  assert.equal(resolveBidAskDigits('EURUSD.a'), 5);
  assert.equal(resolveBidAskDigits('/NQ:XCME', { mintick: 0.25 }), 2);
  assert.equal(resolveBidAskDigits('BTC-USD', { minTick: 1e-8 }), 8);
  assert.equal(resolveBidAskDigits('INDEX', { digits: 0 }), 0);
});
