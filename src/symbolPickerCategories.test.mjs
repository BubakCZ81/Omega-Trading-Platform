import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterSymbolsByCategory,
  SYMBOL_PICKER_CATEGORIES,
  symbolPickerCategory,
} from './symbolPickerCategories.ts';

test('symbol-picker category tabs remain available without loaded symbols', () => {
  assert.deepEqual(SYMBOL_PICKER_CATEGORIES, [
    'Forex',
    'Indices',
    'Stocks',
    'Crypto',
    'Futures & Commodities',
    'Other',
  ]);
});

test('symbols are categorized using instrument metadata and ticker fallbacks', () => {
  assert.equal(symbolPickerCategory({ ticker: 'EURUSD' }), 'Forex');
  assert.equal(symbolPickerCategory({ ticker: 'NAS100', type: 'Index' }), 'Indices');
  assert.equal(symbolPickerCategory({ ticker: 'NVDA', type: 'Stock' }), 'Stocks');
  assert.equal(symbolPickerCategory({ ticker: 'ETHUSD', type: 'Crypto' }), 'Crypto');
  assert.equal(symbolPickerCategory({ ticker: 'PEPEUSD', group: 'Cryptocurrency CFDs' }), 'Crypto');
  assert.equal(symbolPickerCategory({ ticker: 'ETHUSD' }), 'Crypto');
  assert.equal(symbolPickerCategory({ ticker: 'XAUUSD', description: 'Gold' }), 'Futures & Commodities');
  assert.equal(symbolPickerCategory({ ticker: 'XAUUSD' }), 'Futures & Commodities');
  assert.equal(symbolPickerCategory({ ticker: 'OMEGA' }), 'Other');
});

test('search filters symbols without changing the selected category tabs', () => {
  const symbols = [
    { ticker: 'EURUSD', description: 'Euro / US Dollar' },
    { ticker: 'ETHUSD', description: 'Ethereum', type: 'Crypto' },
    { ticker: 'PEPEUSD', group: 'Cryptocurrency CFDs' },
  ];

  assert.deepEqual(filterSymbolsByCategory(symbols, 'eth', 'All'), [symbols[1]]);
  assert.deepEqual(filterSymbolsByCategory(symbols, 'crypto', 'All'), [symbols[1], symbols[2]]);
  assert.deepEqual(filterSymbolsByCategory(symbols, '', 'Crypto'), [symbols[1], symbols[2]]);
  assert.deepEqual(filterSymbolsByCategory(symbols, '', 'Forex'), [symbols[0]]);
  assert.deepEqual(filterSymbolsByCategory(symbols, 'eth', 'Forex'), []);
});
