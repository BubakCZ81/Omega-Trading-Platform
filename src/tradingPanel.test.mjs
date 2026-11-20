import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [panelSource, tradingSource, styles, defaultWorkspace] = await Promise.all([
  readFile(new URL('./tradingPanel.ts', import.meta.url), 'utf8'),
  readFile(new URL('./chartPaperTrading.ts', import.meta.url), 'utf8'),
  readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../User_Workspaces/default.json', import.meta.url), 'utf8').then(text => JSON.parse(text)),
]);

test('Trading Panel is registered as a non-overlay Vela dock panel', () => {
  assert.match(panelSource, /id:\s*'omega-trading-panel'/);
  assert.match(panelSource, /overlay:\s*false/);
  assert.match(panelSource, /header:\s*'none'/);
  assert.match(panelSource, /body\.replaceChildren\(pane\)/);
  assert.match(panelSource, /header\.close\(\)/);
});

test('Trading Panel form fills the dock instead of sliding over the chart', () => {
  const paneStyles = styles.match(/(^#omega-trading-pane\s*\{\s*position:\s*relative;[^}]+\})/m)?.[1];
  assert.ok(paneStyles);
  assert.match(paneStyles, /position:\s*relative/);
  assert.match(paneStyles, /transform:\s*none/);
  assert.doesNotMatch(paneStyles, /position:\s*absolute/);
  assert.doesNotMatch(styles, /#omega-trading-pane\.open\s*\{[^}]*translateX/s);
});

test('docked panel lifecycle initializes the existing paper-trading controls', () => {
  assert.match(panelSource, /omega:trading-panel-mounted/);
  assert.match(panelSource, /omega:trading-panel-open/);
  assert.match(tradingSource, /omega:trading-panel-mounted/);
  assert.match(tradingSource, /omega:trading-panel-open/);
  assert.doesNotMatch(tradingSource, /omega:paper-trading:toggle-right-panel/);
  assert.doesNotMatch(tradingSource, /localStorage\.setItem\('omega:trading-panel-open'/);
});

test('bundled default workspace opens the Trading Panel at its initial dock width', () => {
  const state = defaultWorkspace;
  assert.equal(state.panels?.open, 'omega-trading-panel');
  assert.equal(state.panels?.widths?.['omega-trading-panel'], 340);
});
