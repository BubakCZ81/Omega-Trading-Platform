import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPickerSymbols } from './symbolPickerData.ts';

test('loads complete provider inventories rather than the chart index snapshot', async () => {
  const indexed = [{ ticker: 'BTCUSD', group: 'Crypto' }];
  const catalog = Array.from({ length: 1_722 }, (_, index) => ({
    ticker: `SYMBOL${index}`,
    group: index < 53 ? 'Crypto' : 'Other',
  }));
  const loaded = await loadPickerSymbols({
    symbols: () => indexed,
    providerInstance: name => name === 'mt5' ? { listSymbols: async () => catalog } : undefined,
  }, ['mt5']);

  assert.equal(loaded.symbols.get('mt5')?.length, 1_722);
  assert.equal(loaded.symbols.get('mt5')?.filter(symbol => symbol.group === 'Crypto').length, 53);
  assert.equal(loaded.symbols.get('mt5')?.[0].provider, 'mt5');
  assert.deepEqual([...loaded.errors], []);
});

test('falls back to indexed symbols only for providers without enumeration', async () => {
  const indexed = [{ ticker: 'EURUSD', group: 'Forex' }];
  const loaded = await loadPickerSymbols({
    symbols: provider => provider === 'legacy' ? indexed : [],
    providerInstance: () => undefined,
  }, ['legacy']);

  assert.deepEqual(loaded.symbols.get('legacy'), [{ ...indexed[0], provider: 'legacy' }]);
  assert.deepEqual([...loaded.errors], []);
});

test('surfaces provider enumeration errors without hiding other feeds', async () => {
  const loaded = await loadPickerSymbols({
    symbols: () => [],
    providerInstance: provider => provider === 'broken'
      ? { listSymbols: async () => { throw new Error('symbol service unavailable'); } }
      : { listSymbols: async () => [{ ticker: 'EURUSD', group: 'Forex' }] },
  }, ['broken', 'healthy']);

  assert.equal(loaded.symbols.has('broken'), false);
  assert.deepEqual(loaded.symbols.get('healthy'), [{ ticker: 'EURUSD', group: 'Forex', provider: 'healthy' }]);
  assert.equal(loaded.errors.get('broken'), 'symbol service unavailable');
});
