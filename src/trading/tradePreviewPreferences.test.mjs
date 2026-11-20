import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveTradePreviewPreferences, shouldPreviewTrade } from './tradePreviewPreferences.ts';

test('re-enabling preview overrides a persisted dont-ask-again preference', () => {
  const persisted = JSON.parse('{"previewTrade":true,"dontAskAgain":true}');
  const preferences = resolveTradePreviewPreferences(persisted);

  assert.deepEqual(preferences, { previewTrade: true, dontAskAgain: false });
  assert.equal(shouldPreviewTrade(preferences), true);
});

test('dont-ask-again continues to suppress previews until preview is re-enabled', () => {
  const preferences = resolveTradePreviewPreferences({
    previewTrade: false,
    dontAskAgain: true,
  });

  assert.deepEqual(preferences, { previewTrade: false, dontAskAgain: true });
  assert.equal(shouldPreviewTrade(preferences), false);
  assert.deepEqual(resolveTradePreviewPreferences({
    ...preferences,
    previewTrade: true,
  }), { previewTrade: true, dontAskAgain: false });
});
