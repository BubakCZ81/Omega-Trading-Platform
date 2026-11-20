import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Quick Trade stays pinned, starts visible, and is controlled from the Vela context menu', async () => {
  const [html, toggle, main] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('./quickTradeToggle.ts', import.meta.url), 'utf8'),
    readFile(new URL('./main.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="chart-paper-trade-controls"[^>]*aria-hidden="false"/);
  assert.doesNotMatch(html, /id="chart-paper-trade-controls"[^>]*\shidden(?:\s|>)/);
  assert.match(toggle, /let enabled = true;/);
  assert.match(toggle, /export function initializeQuickTradeToggle\(\): void \{\s*setQuickTradeEnabled\(true\);/);
  assert.doesNotMatch(toggle, /localStorage/);
  assert.match(toggle, /label: `\$\{enabled \? 'Disable' : 'Enable'\} Chart Quick Trade \(MT5\)`/);
  assert.match(toggle, /target: 'context:body'/);
  assert.match(toggle, /pinQuickTradeInTopbar\(\)/);
  assert.doesNotMatch(toggle, /registerSidePanel/);
  assert.doesNotMatch(main, /initializePaperTradeDrag/);
  assert.doesNotMatch(html, /paper-trade-(?:lock-btn|drag-handle)/);
});

test('empty chart reports data-feed status in the status bar', async () => {
  const [html, loadedBars, styles] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('./loadedBars.ts', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(loadedBars, /chart\?\.data\.providers\(\)\.length/);
  assert.match(loadedBars, /No feed connected/);
  assert.match(loadedBars, /Feed connected · waiting for data/);
  assert.match(html, /id="terminal-connection-label">No feed connected<\/span>/);
  assert.match(styles, /#terminal-connection-status\[data-state="disconnected"\]\s*\{[^}]*color:\s*var\(--omega-muted\)/);
  assert.match(styles, /#terminal-connection-status\[data-state="waiting"\]/);
});

test('Quick Trade stays pinned in the centered gap of the upper chart toolbar', async () => {
  const [styles, toggle, main] = await Promise.all([
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    readFile(new URL('./quickTradeToggle.ts', import.meta.url), 'utf8'),
    readFile(new URL('./main.ts', import.meta.url), 'utf8'),
  ]);
  const pinnedControlsRule = styles.match(/\/\* Keep Quick Trade pinned in the toolbar gap[\s\S]*?#chart-paper-trade-controls\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.match(pinnedControlsRule, /position:\s*fixed/);
  assert.match(pinnedControlsRule, /left:\s*var\(--omega-quick-trade-center-x/);
  assert.match(pinnedControlsRule, /top:\s*var\(--omega-quick-trade-center-y/);
  assert.match(pinnedControlsRule, /transform:\s*translate\(-50%,\s*-50%\)/);
  assert.match(pinnedControlsRule, /z-index:\s*1100/);
  assert.match(toggle, /function pinQuickTradeInTopbar\(\)/);
  assert.match(toggle, /'\.vela-cell\[data-omega-tab-active="true"\] \.vela-widget-topbar'/);
  assert.match(toggle, /availableGap >= panelWidth \+ 16/);
  assert.match(toggle, /let centerX = fitsInTopbar/);
  assert.match(toggle, /const centerY = fitsInTopbar/);
  assert.match(toggle, /new ResizeObserver\(updatePosition\)/);
  assert.match(toggle, /window\.addEventListener\('resize', updatePosition\)/);
  assert.match(toggle, /window\.addEventListener\('scroll', updatePosition, true\)/);
  assert.doesNotMatch(main, /initializePaperTradeDrag/);
});

test('Quick Trade Volume label aligns horizontally with the active chart P/L readout', async () => {
  const toggle = await readFile(new URL('./quickTradeToggle.ts', import.meta.url), 'utf8');
  assert.match(toggle, /'\.vela-cell\[data-omega-tab-active="true"\] \.omega-chart-pnl'/);
  assert.match(toggle, /label\[for="paper-trade-lots"\]/);
  assert.match(toggle, /observe\(activePnl\)/);
  assert.match(toggle, /pnlRect\.left \+ pnlRect\.width \/ 2 - \(volumeCenterX - panelCenterX\)/);
  assert.match(toggle, /attributeFilter:\s*\['data-omega-tab-active'\]/);
});

test('Safeguards explains that chart Quick Trade requires a confirmed MT5 or IBKR order', async () => {
  const [html, safeguards] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('./safeguardsPanel.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="safeguards-quick-trade-enabled" type="checkbox" checked/);
  assert.match(html, /Enable chart Quick Trade/);
  assert.match(html, /selected, connected MT5 or IBKR account/);
  assert.match(html, /local demo account cannot place chart orders/);
  assert.match(html, /On by default/);
  assert.match(safeguards, /setQuickTradeEnabled\(quickTradeEnabled\.checked\)/);
  assert.match(safeguards, /omega:quick-trade-state-changed/);
});

test('floating chart Buy and Sell controls route to the selected live broker after paper-trading startup', async () => {
  const [bottomPanel, main, chartTrading] = await Promise.all([
    readFile(new URL('./bottomPanel.ts', import.meta.url), 'utf8'),
    readFile(new URL('./main.ts', import.meta.url), 'utf8'),
    readFile(new URL('./chartPaperTrading.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(bottomPanel, /onChartLiveTrade\(side\)/);
  assert.match(main, /onChartLiveTrade: async side => \{\s*await ensurePaperTrading\(\);\s*document\.dispatchEvent\(new CustomEvent\(`omega:chart-live-trade:\$\{side\}`\)\);/);
  assert.match(chartTrading, /omega:chart-live-trade:buy[\s\S]*?openTrade\(state, 'buy', 'live'\)/);
  assert.match(chartTrading, /omega:chart-live-trade:sell[\s\S]*?openTrade\(state, 'sell', 'live'\)/);
  assert.match(chartTrading, /bridge\.placeOrder\(\{[\s\S]*?stopLoss: trade\.stopLoss,[\s\S]*?takeProfit: trade\.takeProfit/);
});

test('trade preview stays in the chart host so SL and TP levels remain draggable', async () => {
  const [chartTrading, styles] = await Promise.all([
    readFile(new URL('./chartPaperTrading.ts', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(chartTrading, /state\.host\.appendChild\(card\)/);
  assert.match(chartTrading, /const hostRect = state\.host\.getBoundingClientRect\(\)/);
  assert.match(chartTrading, /readonly: role === 'entry'/);
  assert.match(chartTrading, /confirmBtn\.addEventListener\('click'/);
  assert.match(chartTrading, /cancelBtn\.addEventListener\('click'/);
  assert.doesNotMatch(chartTrading, /card\.showModal\(\)|document\.body\.appendChild\(card\)/);
  assert.match(styles, /\.omega-order-preview-card\s*\{[^}]*position:\s*absolute/s);
});
