import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Trades opens as a resizable bottom pane that preserves the chart and can close', async () => {
  const [html, source, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('./chartPaperTrading.ts', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="paper-open-trades-resize"[^>]*role="separator"[^>]*aria-orientation="horizontal"/);
  assert.match(html, /id="paper-open-trades-close"/);
  assert.match(source, /chartStage\.insertAdjacentElement\('afterend', openTradesModal\)/);
  assert.match(source, /openTradesResize\?\.addEventListener\('pointermove'/);
  assert.match(source, /openTradesClose\?\.addEventListener\('click', closeOpenTrades\)/);
  assert.match(html, /id="paper-open-trades-fee-per-lot"/);
  assert.match(source, /Date \/ time.*Symbol.*Type.*Volume.*Price.*SL.*TP.*Current price.*Fees.*Profit/);
  assert.match(css, /#paper-open-trades-modal\.omega-open-trades-pane\s*\{[^}]*position:\s*relative/);
  assert.match(css, /\.omega-open-trades-resize\s*\{[^}]*cursor:\s*row-resize/);
});

test('Watchlist is a chart-side pane with feed-supported symbol search', async () => {
  const [html, source, css] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('./watchlist.ts', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="watchlist-toggle"[^>]*aria-controls="watchlist-panel"/);
  assert.match(html, /id="watchlist-search"/);
  assert.match(html, /id="watchlist-list"/);
  assert.match(source, /chart\.data\.symbols\(\)/);
  assert.match(source, /chart\.data\.providerInstance\(resolved\.provider\)/);
  assert.match(source, /localStorage\.setItem\(STORAGE_KEY/);
  assert.match(css, /\.omega-watchlist\s*\{[^}]*flex-direction:\s*column/);
});
