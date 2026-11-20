import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveBacktestAssetSymbol } from './assetSelection.ts';

test('resolves an exchange-prefixed chart symbol to a connected feed asset', () => {
  const assets = [
    { symbol: 'ALPACA:AAPL' },
    { symbol: 'QUANTOWER:AAPL' },
  ];

  assert.equal(resolveBacktestAssetSymbol('NASDAQ:AAPL', assets), 'ALPACA:AAPL');
  assert.equal(resolveBacktestAssetSymbol('NASDAQ:AAPL', assets, 'quantower'), 'QUANTOWER:AAPL');
});

test('prefers exact provider-qualified symbols and leaves unknown symbols unresolved', () => {
  const assets = [{ symbol: 'MT5:EURUSD' }, { symbol: 'ALPACA:AAPL' }];

  assert.equal(resolveBacktestAssetSymbol('MT5:EURUSD', assets), 'MT5:EURUSD');
  assert.equal(resolveBacktestAssetSymbol('NASDAQ:MSFT', assets), undefined);
});
