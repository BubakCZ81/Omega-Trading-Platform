import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const stylesheet = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

test('top-panel buttons use larger labels without explicit control resizing', () => {
  const marker = '/* Increase top-panel label legibility';
  const start = stylesheet.lastIndexOf(marker);
  const nextUnrelatedRule = stylesheet.indexOf('/* Enlarge bottom panel button text', start);
  const rules = stylesheet.slice(start, nextUnrelatedRule === -1 ? undefined : nextUnrelatedRule);
  assert.match(rules, /font-size:\s*0\.875rem;/);
  assert.match(rules, /@media\s*\(max-width:\s*56\.25rem\)[\s\S]*font-size:\s*0\.84375rem;/);
  assert.doesNotMatch(rules, /(?:^|[;{])\s*(?:width|height|min-width|min-height|padding|gap)\s*:/);
});

test('chart P/L is centered close to the top edge and uses a larger readable font', () => {
  const pnlRules = stylesheet.match(/\.omega-chart-pnl\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(pnlRules, /top:\s*0\.25rem;/);
  assert.match(pnlRules, /left:\s*50%;/);
  assert.match(pnlRules, /transform:\s*translateX\(-50%\);/);
  assert.match(pnlRules, /font-size:\s*1\.125rem;/);
});

test('top toolbar has the requested three-times thicker visible border', () => {
  const marker = '/* Trading workspace hierarchy:';
  const start = stylesheet.lastIndexOf(marker);
  const toolbarRules = stylesheet.slice(start).match(/#top-toolbar\s*\{([^}]+)\}/)?.[1] ?? '';
  assert.match(toolbarRules, /border:\s*0\.1875rem solid var\(--omega-separator\);/);
});

test('dark toolbar hides decorative borders while preserving visible focus and action states', () => {
  assert.match(stylesheet, /html\[data-theme="dark"\] #top-toolbar,\s*html\[data-theme="dark"\] #top-toolbar \.toolbar-control-zone\s*\{[^}]*border-color:\s*transparent/);
  assert.match(stylesheet, /html\[data-theme="dark"\] #top-toolbar :is\(button, select, input\):not\(:hover\):not\(:focus-visible\):not\(\.selected\):not\(\[aria-pressed="true"\]\):not\(\[aria-expanded="true"\]\),\s*html\[data-theme="dark"\] #top-toolbar details:not\(\[open\]\) > summary:not\(:hover\):not\(:focus-visible\)\s*\{\s*border-color:\s*transparent/);
  assert.match(stylesheet, /#top-toolbar \.toolbar-control-zone :is\(button, select, input, summary\):focus-visible\s*\{\s*outline:\s*0\.125rem solid var\(--omega-accent\)/);
});

test('adjacent top-toolbar buttons have visible gaps instead of joined divider borders', () => {
  assert.doesNotMatch(stylesheet, /#top-toolbar \.dock-pill > :is\([^}]+\) \+ :is\([^}]+\)\s*\{\s*border-left:/);
  assert.match(stylesheet, /#top-toolbar \.toolbar-control-zone \.dock-pill\s*\{\s*gap:\s*calc\(0\.5rem \* var\(--omega-toolbar-scale, 1\)\) !important;/);
  assert.match(stylesheet, /#top-toolbar\[data-omega-auto-fit-toolbar="true"\] \.toolbar-control-zone \.dock-pill\s*\{\s*gap:\s*calc\(0\.5rem \* var\(--omega-toolbar-scale, 1\)\) !important;/);
  assert.match(stylesheet, /#top-toolbar > \.trading-account-actions\s*\{\s*gap:\s*calc\(0\.5rem \* var\(--omega-toolbar-scale, 1\)\) !important;/);
});

test('workspace name, Save/Load, and Theme/Settings/Tab View retain individual button borders', () => {
  assert.match(stylesheet, /#top-toolbar \.toolbar-control-zone \.dock-pill:has\(#workspace-profile-name\) #workspace-profile-name:not\(:hover\):not\(:focus-visible\),[\s\S]*#top-toolbar \.toolbar-control-zone \.dock-pill:has\(\.theme-menu\) > \.btn:not\(:hover\):not\(:focus-visible\)\s*\{\s*border-color:\s*var\(--omega-button-border\) !important;/);
  assert.match(stylesheet, /#top-toolbar \.omega-extra-features-label\s*\{\s*display:\s*none;/);
});

test('workspace separator and toolbar parent and pill strips are transparent', () => {
  assert.match(stylesheet, /#top-toolbar \.toolbar-control-zone \.dock-pill:has\(#workspace-profile-name\) #workspace-profile-name\s*\{\s*border-right:\s*0\.125rem solid var\(--omega-button-border\);/);
  assert.match(stylesheet, /#top-toolbar \.toolbar-control-zone \.dock-pill:has\(#workspace-profile-name\),\s*#top-toolbar \.toolbar-control-zone \.dock-pill:has\(\.theme-menu\),\s*#top-toolbar \.toolbar-control-zone \.dock-pill\.omega-extra-features\s*\{\s*background:\s*transparent !important;\s*border-color:\s*transparent !important;\s*box-shadow:\s*none !important;/);
  assert.match(stylesheet, /#top-toolbar \.toolbar-control-zone\s*\{\s*background:\s*transparent !important;\s*border-color:\s*transparent !important;\s*box-shadow:\s*none !important;/);
});

test('Data Feeds uses the standard themed toolbar button surface', () => {
  assert.match(stylesheet, /#top-toolbar > \.trading-account-actions #local-feeds-toggle\s*\{\s*background:\s*var\(--omega-elevated\) !important;\s*border-color:\s*var\(--omega-button-border\) !important;/);
  assert.match(stylesheet, /#top-toolbar > \.trading-account-actions #local-feeds-toggle:hover:not\(:disabled\)\s*\{\s*background:\s*color-mix\(in srgb, var\(--omega-button-accent\) 12%, var\(--omega-elevated\)\) !important;\s*border-color:\s*var\(--omega-button-accent\) !important;/);
});

test('bottom Watchlist, Trades, Trade History, Console, and Debug Console match topbar buttons', () => {
  const marker = '/* Keep the bottom dock tabs on the same standalone button treatment as the top bar. */';
  const start = stylesheet.lastIndexOf(marker);
  const rules = stylesheet.slice(start);
  assert.notEqual(start, -1);
  assert.match(rules, /#bottom-bar \.bottom-bar-tabs\s*\{\s*gap:\s*calc\(0\.5rem \* var\(--omega-toolbar-scale, 1\)\) !important;/);
  assert.match(rules, /#bottom-bar \.bottom-tab-btn\s*\{[^}]*color:\s*var\(--omega-text\) !important;[^}]*background:\s*var\(--omega-elevated\) !important;[^}]*border:\s*0\.0625rem solid var\(--omega-button-border\) !important;[^}]*box-shadow:\s*none !important;/);
  assert.match(rules, /#bottom-bar \.bottom-tab-btn:is\(\.active, \[aria-expanded="true"\]\)[\s\S]*color:\s*var\(--omega-button-accent\) !important;[\s\S]*border-color:\s*var\(--omega-button-accent\) !important;/);
  assert.match(rules, /#bottom-bar \.bottom-tab-btn:focus-visible\s*\{\s*outline:\s*0\.125rem solid var\(--omega-button-accent\)/);
});

test('toolbar and dock button treatments preserve distinct dark and light theme palettes', () => {
  const darkTheme = stylesheet.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  const lightTheme = stylesheet.match(/body\[data-theme="light"\]\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  for (const token of ['omega-elevated', 'omega-text', 'omega-button-accent', 'omega-button-border']) {
    assert.match(darkTheme, new RegExp(`--${token}:`));
    assert.match(lightTheme, new RegExp(`--${token}:`));
  }
  assert.match(darkTheme, /--omega-button-accent:\s*#52d1bd;/);
  assert.match(lightTheme, /--omega-button-accent:\s*#126b63;/);
  assert.match(darkTheme, /--omega-button-border:\s*#2b3b49;/);
  assert.match(lightTheme, /--omega-button-border:\s*#c5d0dc;/);

  const deltaStyles = stylesheet.slice(stylesheet.lastIndexOf('/* DELTA-style independent controls for the chart'));
  const dockStyles = stylesheet.slice(stylesheet.lastIndexOf('/* Keep the bottom dock tabs on the same standalone button treatment as the top bar. */'));
  assert.match(deltaStyles, /\.vela-widget-topbar :is\([\s\S]*background:\s*var\(--omega-elevated\) !important;/);
  assert.match(deltaStyles, /\.vela-widget-topbar :is\([\s\S]*border:\s*0\.0625rem solid var\(--omega-button-border\) !important;/);
  assert.match(dockStyles, /#bottom-bar \.bottom-tab-btn\s*\{[^}]*background:\s*var\(--omega-elevated\) !important;[^}]*border:\s*0\.0625rem solid var\(--omega-button-border\) !important;/);
  assert.match(stylesheet, /#top-toolbar > \.trading-account-actions #local-feeds-toggle\s*\{\s*background:\s*var\(--omega-elevated\) !important;\s*border-color:\s*var\(--omega-button-border\) !important;/);
  assert.match(stylesheet, /#chart-paper-trade-controls #paper-trade-settings-btn\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--omega-elevated\)[^}]*color:\s*var\(--omega-text\)/);
});

test('chart symbol, Indicators, favorite, and Pine Editor controls use separate themed buttons', () => {
  const marker = '/* DELTA-style independent controls for the chart';
  const start = stylesheet.lastIndexOf(marker);
  const rules = stylesheet.slice(start);
  assert.notEqual(start, -1);
  assert.match(rules, /\.vela-workspace \.vela-widget-topbar\s*\{[^}]*background:\s*transparent !important;[^}]*border-color:\s*transparent !important;[^}]*box-shadow:\s*none !important;/);
  assert.match(rules, /\.vela-widget-panels,\s*\.vela-widget-panels > \*,\s*\.vela-topbar-right/);
  assert.match(rules, /\.vela-widget-topbar :is\(\.vela-widget-symbol, \.vela-widget-indicators, \.vela-widget-action-left, \.vela-widget-tool\)\s*\{[^}]*background:\s*var\(--omega-elevated\) !important;[^}]*border:\s*0\.0625rem solid var\(--omega-button-border\) !important;/);
  assert.match(rules, /\.vela-widget-topbar :is\(\.vela-widget-symbol, \.vela-widget-indicators, \.vela-widget-action-left, \.vela-widget-tool\):is\(\[aria-pressed="true"\], \[aria-expanded="true"\], \[data-active="1"\]\)/);
  assert.match(rules, /\.vela-widget-topbar :is\(\.vela-widget-symbol, \.vela-widget-indicators, \.vela-widget-action-left, \.vela-widget-tool\):focus-visible\s*\{\s*outline:\s*0\.125rem solid var\(--omega-button-accent\) !important;/);
});

test('Trading Panel and Alerts use matching themed surfaces, heights, and focus states', () => {
  const marker = '/* DELTA-style independent controls for the chart';
  const start = stylesheet.lastIndexOf(marker);
  const rules = stylesheet.slice(start);
  assert.match(rules, /\.vela-widget-actions \.vela-widget-action,[\s\S]*button\[id\*="omega-trading-panel"\],[\s\S]*button\[id="vela-tool-vela-widget-alerts"\][\s\S]*height:\s*2\.125rem !important;[\s\S]*background:\s*var\(--omega-elevated\) !important;[\s\S]*border:\s*0\.0625rem solid var\(--omega-button-border\) !important;/);
  assert.match(rules, /button\[id="vela-tool-vela-widget-alerts"\]\s*\):hover:not\(:disabled\)/);
  assert.match(rules, /button\[id="vela-tool-vela-widget-alerts"\]\s*\):focus-visible\s*\{\s*outline:\s*0\.125rem solid var\(--omega-button-accent\) !important;/);
  assert.match(rules, /button\[id="vela-tool-vela-widget-alerts"\]\s*\):is\(\[aria-pressed="true"\], \[aria-expanded="true"\], \[data-active="1"\]\)/);
});

test('moved Object Tree, Time & Sales, and Depth controls match themed toolbar button geometry and states', () => {
  const movedButtons = stylesheet.slice(stylesheet.lastIndexOf('/* These panel buttons move from the left rail'));
  assert.match(movedButtons, /button\[id="vela-tool-vela-widget-panel-objects"\][\s\S]*button\[id="vela-tool-vela-widget-panel-omega-time-sales"\][\s\S]*button\[id="vela-tool-vela-widget-panel-omega-dom"\]/);
  assert.match(movedButtons, /gap:\s*0\.4375rem !important;[\s\S]*width:\s*auto !important;[\s\S]*height:\s*2\.125rem !important;[\s\S]*padding:\s*0 0\.625rem !important;[\s\S]*background:\s*var\(--omega-elevated\) !important;[\s\S]*border:\s*0\.0625rem solid var\(--omega-button-border\) !important;/);
  assert.match(movedButtons, /button\[id="vela-tool-vela-widget-panel-objects"\]::after,[\s\S]*button\[id="vela-tool-vela-widget-panel-omega-time-sales"\]::after,[\s\S]*button\[id="vela-tool-vela-widget-panel-omega-dom"\]::after\s*\{[^}]*content:\s*"Object Tree"/);
  assert.match(movedButtons, /button\[id="vela-tool-vela-widget-panel-omega-time-sales"\]::after\s*\{\s*content:\s*"Time & Sales"/);
  assert.match(movedButtons, /button\[id="vela-tool-vela-widget-panel-omega-dom"\]::after\s*\{\s*content:\s*"Depth of Market"/);
  assert.match(movedButtons, /@media \(max-width:\s*56\.25rem\)[\s\S]*\.vela-topbar-right\s*\{[^}]*overflow-x:\s*auto !important;[\s\S]*content:\s*"Obj"[\s\S]*content:\s*"T&S"[\s\S]*content:\s*"DOM"/);
  assert.match(movedButtons, /:hover:not\(:disabled\)[\s\S]*border-color:\s*var\(--omega-button-accent\) !important/);
  assert.match(movedButtons, /:is\(\[aria-pressed="true"\], \[aria-expanded="true"\], \[data-active="1"\]\)[\s\S]*color:\s*var\(--omega-button-accent\) !important/);
  assert.match(movedButtons, /:focus-visible\s*\{[^}]*outline:\s*0\.125rem solid var\(--omega-button-accent\) !important/);
});

test('all main-app button labels use a consistent bold weight', () => {
  assert.match(stylesheet, /body :is\(button, input\[type="button"\], input\[type="submit"\], input\[type="reset"\], \[role="button"\]\)\s*\{\s*font-weight:\s*600 !important;/);
});

test('institutional toolbar refinement keeps compact layouts usable and colors semantic', () => {
  const marker = '/* OMEGA institutional workstation refinement.';
  const start = stylesheet.lastIndexOf(marker);
  const rules = stylesheet.slice(start);
  assert.notEqual(start, -1);
  assert.match(rules, /#top-toolbar \.toolbar-control-zone\s*\{[^}]*overflow-x:\s*auto/);
  assert.match(rules, /@media \(max-width:\s*68rem\)[\s\S]*#top-toolbar > #trading-account-status/);
  assert.match(rules, /#bottom-bar \.bottom-tab-btn\.active[\s\S]*color:\s*var\(--omega-accent\)/);
  assert.match(rules, /\.watchlist-table tbody tr:hover/);
  assert.doesNotMatch(rules, /#ffd166/);
});

test('professional finish keeps control geometry consistent and financial values aligned', () => {
  const marker = '/* Professional finish: align control geometry and financial readouts. */';
  const start = stylesheet.lastIndexOf(marker);
  const rules = stylesheet.slice(start);
  assert.notEqual(start, -1);
  assert.match(rules, /--omega-control-radius:\s*0\.375rem;/);
  assert.match(rules, /\.btn,[\s\S]*\.script-select,[\s\S]*\.bars-select\s*\{\s*border-radius:\s*var\(--omega-control-radius\);/);
  assert.match(rules, /#top-toolbar \.toolbar-control-zone :is\([\s\S]*#bottom-bar \.bottom-tab-btn,[\s\S]*border-radius:\s*var\(--omega-control-radius\) !important;/);
  assert.match(rules, /#bottom-bar,[\s\S]*#trading-account-status,[\s\S]*\.watchlist-table,[\s\S]*\.vela-workspace \.vela-statusline,[\s\S]*\.vela-workspace \.vela-widget-bottombar\s*\{\s*font-variant-numeric:\s*tabular-nums;/);
});
