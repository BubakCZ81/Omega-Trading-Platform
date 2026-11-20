import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(path, import.meta.url), 'utf8');

const [mainStyles, pineHtml, pineStyles, pineEditor, backtestStyles, backtestEntry, indicatorWindow] = await Promise.all([
  read('./styles.css'),
  read('../pine-editor.html'),
  read('./pineEditorStandalone.css'),
  read('./pineEditorStandalone.ts'),
  read('./backtester/backtester.css'),
  read('./backtester/omegaBacktester.tsx'),
  read('./indicatorBrowserWindow.ts'),
]);

test('standalone windows keep the main Omega dark and light palette', () => {
  for (const [token, dark, light] of [
    ['--omega-bg', '#0d1420', '#e8edf3'],
    ['--omega-text', '#e6edf5', '#1d2938'],
    ['--omega-muted', '#a7b5c5', '#526174'],
    ['--omega-border', '#37475a', '#c5d0dc'],
    ['--omega-accent', '#55a6ff', '#176bc1'],
  ]) {
    assert.match(mainStyles, new RegExp(`${token}:\\s*${dark}`));
    assert.match(backtestStyles, new RegExp(`${token}:\\s*${dark}`));
    assert.match(backtestStyles, new RegExp(`${token}:\\s*${light}`));
    assert.match(indicatorWindow, new RegExp(`${token}:\\s*${dark}`));
    assert.match(indicatorWindow, new RegExp(`${token}:\\s*${light}`));
  }
  assert.match(mainStyles, /--omega-surface:\s*var\(--panel-top-high-bg\)/);
  assert.match(mainStyles, /--panel-top-high-bg:\s*#151f2c/);
  assert.match(mainStyles, /--panel-top-high-bg:\s*#f7f9fc/);
  assert.match(mainStyles, /--omega-elevated:\s*var\(--panel-raised-bg\)/);
  assert.match(mainStyles, /--panel-raised-bg:\s*#202d3c/);
  assert.match(mainStyles, /--panel-raised-bg:\s*#ffffff/);
  for (const [token, dark, light] of [
    ['--omega-surface', '#151f2c', '#f7f9fc'],
    ['--omega-elevated', '#202d3c', '#ffffff'],
  ]) {
    assert.match(backtestStyles, new RegExp(`${token}:\\s*${dark}`));
    assert.match(backtestStyles, new RegExp(`${token}:\\s*${light}`));
    assert.match(indicatorWindow, new RegExp(`${token}:\\s*${dark}`));
    assert.match(indicatorWindow, new RegExp(`${token}:\\s*${light}`));
  }
});

test('Pine Editor loader and controls use theme-aware tokens', () => {
  assert.match(pineHtml, /localStorage\.getItem\('omega:theme'\)/);
  assert.match(pineHtml, /html\[data-theme="light"\] #pine-editor-loading/);
  assert.match(pineHtml, /var\(--omega-bg/);
  assert.match(pineStyles, /var\(--omega-button-accent\)/);
  assert.doesNotMatch(pineStyles, /color:\s*#000\s*!important/);
  assert.match(pineEditor, /event\.key !== 'omega:theme'/);
  assert.match(mainStyles, /body :is\(button, input\[type="button"\], input\[type="submit"\], input\[type="reset"\], \[role="button"\]\)\s*\{\s*font-weight:\s*600 !important;/);
});

test('Backtester and Indicator Browser follow theme changes in their own windows', () => {
  assert.match(backtestEntry, /applyThemeUi\(isOmegaTheme\(theme\) \? theme : 'dark'\)/);
  assert.match(backtestEntry, /event\.key === 'omega:theme'/);
  assert.match(backtestStyles, /#visual-backtest-app input:not\(\[type="checkbox"\]\):not\(\[type="range"\]\)/);
  assert.match(indicatorWindow, /event\.key === 'omega:theme' && isOmegaTheme\(event\.newValue\)/);
  assert.match(indicatorWindow, /:root\[data-theme="light"\]/);
  assert.match(backtestStyles, /body :is\(button, input\[type="button"\], input\[type="submit"\], input\[type="reset"\], \[role="button"\]\)\s*\{\s*font-weight:\s*600 !important;/);
  assert.match(indicatorWindow, /button\s*\{[\s\S]*?font-weight:\s*600;/);
});
