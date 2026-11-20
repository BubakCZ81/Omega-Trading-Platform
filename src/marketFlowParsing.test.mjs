import assert from 'node:assert/strict';
import test from 'node:test';
import { isMarketFlowFeedActive, marketFlowProviderForAccountId } from './marketFlowParsing.ts';

test('market-flow requires an active Omega connection and the selected provider account', () => {
  const connectedProviders = new Set(['quantower']);
  assert.equal(isMarketFlowFeedActive('quantower', 'quantower:account-1', connectedProviders), true);
  assert.equal(isMarketFlowFeedActive('quantower', 'local-demo', connectedProviders), false);
  assert.equal(isMarketFlowFeedActive('quantower', 'quantower:account-1', new Set()), false);
  assert.equal(isMarketFlowFeedActive('mt5', 'quantower:account-1', connectedProviders), false);
  assert.equal(isMarketFlowFeedActive('alpaca', 'alpaca:account-1', new Set(['alpaca'])), false);
});

test('market-flow account provider comes from the current account id, not saved preferences', () => {
  assert.equal(marketFlowProviderForAccountId('local-demo'), '');
  assert.equal(marketFlowProviderForAccountId('quantower:local'), 'quantower');
  assert.equal(marketFlowProviderForAccountId('MT5:demo'), 'mt5');
});
