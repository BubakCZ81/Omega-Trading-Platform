import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MARKET_SYMBOLS, dailyMovePercent, parseWatchlistSymbols, quoteSpread } from './watchlist.ts';

test('default watchlist includes BTC and ETH for Binance and Coinbase public feeds', () => {
  for (const symbol of ['BTCUSDT', 'ETHUSDT', 'BTC-USD', 'ETH-USD']) {
    assert.ok(DEFAULT_MARKET_SYMBOLS.includes(symbol), `${symbol} should appear on a supported public crypto feed`);
  }
});

test('parses saved custom symbols, removing duplicates without changing order', () => {
  assert.deepEqual(parseWatchlistSymbols(null), []);
  assert.deepEqual(parseWatchlistSymbols('["MT5:EURUSD","MT5:EURUSD","XAUUSD"]'), ['MT5:EURUSD', 'XAUUSD']);
});

test('rejects malformed or oversized watchlist data instead of overwriting it', () => {
  assert.throws(() => parseWatchlistSymbols('{bad'), /not valid JSON/);
  assert.throws(() => parseWatchlistSymbols('[1]'), /invalid shape/);
  assert.throws(() => parseWatchlistSymbols(JSON.stringify(Array.from({ length: 101 }, (_, index) => `SYM${index}`))), /invalid shape/);
});

test('computes daily movement from open to current daily close', () => {
  assert.equal(dailyMovePercent({ open: 100, close: 102.5 }), 2.5);
  assert.equal(dailyMovePercent({ open: 100, close: 97.5 }), -2.5);
  assert.equal(dailyMovePercent({ open: 0, close: 100 }), null);
});

test('returns a spread only for valid and fresh bid/ask quotes', () => {
  assert.ok(Math.abs(quoteSpread({ bid: 1.1, ask: 1.1002 }, 1000) - 0.0002) < 1e-12);
  assert.ok(Math.abs(quoteSpread({ bid: 1.1, ask: 1.1002, timeMsc: 1000 }, 1000) - 0.0002) < 1e-12);
  assert.equal(quoteSpread({ bid: 1.1, ask: 1.1002, timeMsc: 1 }, 100_000), null);
  assert.equal(quoteSpread({ bid: 1.2, ask: 1.1 }), null);
});
