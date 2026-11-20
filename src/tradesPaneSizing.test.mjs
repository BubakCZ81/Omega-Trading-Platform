import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampTradesPaneHeight,
  DEFAULT_TRADES_PANE_HEIGHT,
  maxTradesPaneHeight,
  MIN_TRADES_PANE_HEIGHT,
} from './tradesPaneSizing.ts';

test('Trades pane keeps a usable minimum and leaves chart room at common sizes', () => {
  for (const [viewportHeight, wrapperHeight, toolbarHeight] of [
    [1080, 900, 36],
    [768, 620, 36],
    [768, 620, 36],
  ]) {
    const maximum = maxTradesPaneHeight(viewportHeight, wrapperHeight, toolbarHeight);
    assert.ok(maximum >= MIN_TRADES_PANE_HEIGHT);
    assert.ok(wrapperHeight - toolbarHeight - maximum >= 120);
    assert.equal(clampTradesPaneHeight(DEFAULT_TRADES_PANE_HEIGHT, maximum), Math.min(DEFAULT_TRADES_PANE_HEIGHT, maximum));
  }
});

test('Trades pane resize requests clamp at both ends and reject invalid sizes', () => {
  assert.equal(clampTradesPaneHeight(50, 400), MIN_TRADES_PANE_HEIGHT);
  assert.equal(clampTradesPaneHeight(900, 400), 400);
  assert.equal(clampTradesPaneHeight(Number.NaN, 400), MIN_TRADES_PANE_HEIGHT);
});
