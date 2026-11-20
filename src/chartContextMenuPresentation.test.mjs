import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { getContextMenuSeparatorTargets } from './chartContextMenuPresentation.ts';

test('body menu separators divide trading, chart view, tools, and replay groups', () => {
  const targets = getContextMenuSeparatorTargets([
    'action:omega-context-copy-price',
    'action:omega-context-add-pending-paper-order',
    'action:omega-quicktrade-toggle',
    'action:omega-context-reset-view',
    'reset-view',
    'remove-drawings',
    'remove-indicators',
    'action:omega-context-background',
    'action:omega-context-pine-window',
    'action:omega-context-start-replay',
    'action:omega-context-open-replay',
    'settings:Canvas',
  ]);
  assert.deepEqual(targets, [
    'action:omega-context-add-pending-paper-order',
    'action:omega-context-reset-view',
    'action:omega-context-background',
    'action:omega-context-start-replay',
  ]);
});

test('menu separators do not duplicate a native separator or create a leading separator', () => {
  assert.deepEqual(getContextMenuSeparatorTargets([
    'separator',
    'action:omega-quicktrade-toggle',
    'separator',
    'action:omega-context-reset-view',
    'action:omega-context-background',
  ]), ['action:omega-context-background']);
});

test('Vela context menus stack above the Quick Trade overlay', async () => {
  const stylesheet = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const quickTrade = /#chart-paper-trade-controls\s*\{[^}]*z-index:\s*(\d+)/s.exec(stylesheet);
  const menu = /\.vela-workspace \.vela-ui-layer \.vela-menu\[role="menu"\]\s*\{[^}]*z-index:\s*(\d+)/s.exec(stylesheet);
  assert.ok(quickTrade, 'Quick Trade z-index is defined');
  assert.ok(menu, 'Vela menu z-index is defined');
  assert.ok(Number(menu[1]) > Number(quickTrade[1]));
});
