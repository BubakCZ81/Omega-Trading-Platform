import { appAssetUrl } from './appPaths';
import { applyThemeUi, isOmegaTheme } from './themeControls';
import { normalizeIndicatorCategory, standardIndicatorCategories } from './indicatorCategories';
import type { IndicatorBrowserEntry as Entry } from './indicatorBrowser';

declare global {
  interface Window {
    velaIndicatorBrowser?: {
      open(): Promise<boolean>;
      add(entry: Entry): void;
      close(): void;
      onAdd(callback: (entry: Entry) => void): () => void;
    };
  }
}

const indicatorDescriptions: Record<string, string> = {
  'Exponential Moving Average': 'Smooths price using exponentially decreasing weights, giving recent values more influence.',
  'Simple Moving Average': 'Shows the arithmetic average of a selected price source over a configurable lookback.',
  'Weighted Moving Average': 'Smooths price with linearly weighted values, giving more recent observations greater weight.',
  'Relative Strength Index': 'Measures the magnitude of recent gains versus losses on a bounded momentum scale.',
  'MACD': 'Compares fast and slow moving averages and plots their difference with a signal line.',
  'Bollinger Bands': 'Plots a moving average with upper and lower bands based on standard deviation.',
  'Supertrend': 'Uses an ATR-based band to follow price and indicate current trend direction.',
  'Average True Range': 'Measures average price range, including gaps, as an indicator of volatility.',
  'Stochastic': 'Compares the closing price with its recent high-low range to track momentum.',
  'Dual EMA Crossover Strategy': 'Fast and Slow EMA crossover strategy with ATR-based dynamic stop-loss and take-profit targets.',
  'RSI + Bollinger Mean Reversion': 'Mean reversion strategy that buys at lower Bollinger Band with oversold RSI and sells at upper band with overbought RSI.',
  'Supertrend Trend-Following Strategy': 'Trend-following strategy utilizing ATR volatility trailing bands to capture persistent price trends.',
  'MACD Breakout Strategy': 'Trend breakout system based on MACD histogram expansion and optional 200 EMA trend filtering.',
  'Donchian Channel Turtle Breakout': 'Classic Turtle trading rule: buys on 20-period highs and exits on 10-period lows.',
};

const style = document.createElement('style');
style.textContent = `
  :root {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color-scheme: dark;
    --omega-bg: #0d1420;
    --omega-surface: #151f2c;
    --omega-elevated: #202d3c;
    --omega-border: #37475a;
    --omega-text: #e6edf5;
    --omega-muted: #a7b5c5;
    --omega-accent: #55a6ff;
    --omega-button-accent: #52d1bd;
    --omega-button-accent-contrast: #0d1420;
    --bg: var(--omega-chart-bg, var(--omega-bg));
    --surface: var(--omega-surface);
    --elevated: var(--omega-elevated);
    --border: var(--omega-border);
    --text: var(--omega-text);
    --muted: var(--omega-muted);
    --accent: var(--omega-accent);
  }
  :root[data-theme="light"] {
    color-scheme: light;
    --omega-bg: #e8edf3;
    --omega-surface: #f7f9fc;
    --omega-elevated: #ffffff;
    --omega-border: #c5d0dc;
    --omega-text: #1d2938;
    --omega-muted: #526174;
    --omega-accent: #176bc1;
    --omega-button-accent: #126b63;
    --omega-button-accent-contrast: #ffffff;
  }
  :root[data-theme="dark"][data-theme-variant="solarized-dark"] {
    color-scheme: dark;
    --omega-bg: #002b36;
    --omega-surface: #073642;
    --omega-elevated: #174853;
    --omega-border: #586e75;
    --omega-text: #eee8d5;
    --omega-muted: #93a1a1;
    --omega-accent: #268bd2;
    --omega-button-accent: #859900;
    --omega-button-accent-contrast: #002b36;
  }
  :root[data-theme="light"][data-theme-variant="solarized-light"] {
    color-scheme: light;
    --omega-bg: #fdf6e3;
    --omega-surface: #eee8d5;
    --omega-elevated: #fffaed;
    --omega-border: #93a1a1;
    --omega-text: #073642;
    --omega-muted: #586e75;
    --omega-accent: #268bd2;
    --omega-button-accent: #586e00;
    --omega-button-accent-contrast: #fdf6e3;
  }
  body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    overflow: hidden;
  }
  main {
    display: grid;
    grid-template-rows: 2.875rem 2.625rem 1fr;
    height: 100vh;
  }
  header {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding: 0 1rem;
    background: var(--surface);
    border-bottom: 0.0625rem solid var(--border);
    -webkit-app-region: drag;
  }
  header strong {
    font-size: 0.875rem;
    letter-spacing: .05em;
    color: var(--accent);
    white-space: nowrap;
  }
  header input {
    flex: 1;
    -webkit-app-region: no-drag;
  }
  button, input {
    color: inherit;
    background: var(--elevated);
    border: 0.0625rem solid var(--border);
    border-radius: 0.3125rem;
    padding: 0.375rem 0.75rem;
    font-size: 0.75rem;
    -webkit-app-region: no-drag;
  }
  button {
    cursor: pointer;
    font-weight: 600;
  }
  button:hover:not(:disabled) {
    border-color: var(--accent);
  }
  #create-script { background: var(--accent); color: var(--omega-button-accent-contrast); }
  button:focus-visible, input:focus-visible {
    outline: 0.125rem solid var(--accent);
    outline-offset: 0.125rem;
  }
  nav {
    display: flex;
    gap: 0.375rem;
    overflow-x: auto;
    padding: 0.375rem 1rem;
    background: var(--surface);
    border-bottom: 0.0625rem solid var(--border);
    scrollbar-width: thin;
  }
  nav button {
    background: transparent;
    border: none;
    border-radius: 0.25rem;
    padding: 0.3125rem 0.75rem;
    color: var(--muted);
    font-weight: 600;
    white-space: nowrap;
  }
  nav button:hover {
    color: var(--text);
    background: var(--elevated);
  }
  nav button.active {
    background: var(--accent);
    color: var(--omega-button-accent-contrast);
  }
  #results {
    overflow: auto;
    padding: 1rem;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(16.25rem, 1fr));
    gap: 0.75rem;
    align-content: start;
    scrollbar-width: thin;
  }
  .card {
    text-align: left;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    padding: 0.75rem 0.875rem;
    border-radius: 0.375rem;
    background: var(--surface);
    border: 0.0625rem solid var(--border);
    transition: all 0.15s ease;
  }
  .card:hover {
    border-color: var(--accent);
    background: var(--elevated);
  }
  .card strong {
    font-size: 0.8125rem;
    color: var(--text);
  }
  .card .category-badge {
    font-size: 0.75rem;
    font-weight: 600;
    color: color-mix(in srgb, var(--text) 88%, #000);
    text-transform: uppercase;
    letter-spacing: .04em;
  }
  .card .desc {
    margin: 0.25rem 0 0;
    font-size: 0.6875rem;
    color: var(--muted);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    overflow: hidden;
  }
  .empty-msg {
    grid-column: 1 / -1;
    text-align: center;
    color: var(--muted);
    padding: 2.5rem;
    font-size: 0.8125rem;
    font-style: italic;
  }
`;
document.head.append(style);

const saved = localStorage.getItem('omega:theme');
if (isOmegaTheme(saved)) applyThemeUi(saved);
const chartBg = localStorage.getItem('omega:chart-background');
if (chartBg) document.documentElement.style.setProperty('--omega-chart-bg', chartBg);

window.addEventListener('storage', event => {
  if (event.key === 'omega:theme' && isOmegaTheme(event.newValue)) applyThemeUi(event.newValue);
  if (event.key === 'omega:chart-background' && event.newValue) {
    document.documentElement.style.setProperty('--omega-chart-bg', event.newValue);
  }
});

const results = document.getElementById('results')!;
const search = document.getElementById('search') as HTMLInputElement;
const categories = document.getElementById('categories')!;
document.getElementById('create-script')?.addEventListener('click', async () => {
  try {
    if (window.velaPineEditorWindow) {
      const opened = await window.velaPineEditorWindow.createNewScript();
      if (!opened) throw new Error('The Pine Editor window could not be opened.');
    } else {
      const url = new URL(appAssetUrl('/pine-editor.html'), window.location.href);
      url.searchParams.set('newScript', '1');
      if (!window.open(url.href, 'omega-pine-editor-window', 'popup=yes,width=1280,height=820')) {
        throw new Error('The Pine Editor popup was blocked by the browser.');
      }
    }
  } catch (error) {
    results.textContent = `Could not open the Pine Editor: ${error instanceof Error ? error.message : String(error)}`;
  }
});

let entries: Entry[] = [];
let active = 'Discover';

function describeEntry(entry: Entry): string {
  return indicatorDescriptions[entry.name] ?? entry.description ?? `Standard ${normalizeIndicatorCategory(entry.category)} indicator calculation.`;
}

function render() {
  const term = search.value.trim().toLowerCase();
  results.replaceChildren();

  const filtered = entries.filter(item => {
    const category = normalizeIndicatorCategory(item.category);
    // `enabled` controls auto-add behavior, not whether an item is available
    // in the browser. Collections let a verified Pine script appear in the
    // curated Built-in tab while retaining its functional category.
    const matchesCategory = active === 'Discover' || category === active || item.collections?.includes(active);
    const matchesSearch = !term || `${item.name} ${category} ${describeEntry(item)}`.toLowerCase().includes(term);
    return matchesCategory && matchesSearch;
  });

  for (const entry of filtered) {
    const category = normalizeIndicatorCategory(entry.category);
    const button = document.createElement('button');
    button.className = 'card';
    button.innerHTML = `
      <strong>${entry.name}</strong>
      <span class="category-badge">${category}</span>
      <p class="desc">${describeEntry(entry)}</p>
    `;
    button.addEventListener('click', () => {
      if (entry.referenceOnly) {
        if (entry.sourceUrl) window.open(entry.sourceUrl, '_blank', 'noopener,noreferrer');
        return;
      }
      window.velaIndicatorBrowser?.add(entry);
    });
    results.append(button);
  }

  if (!results.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'empty-msg';
    empty.textContent = active === 'Strategies' ? 'No strategies found.' : 'No matching indicators found.';
    results.append(empty);
  }
}

function renderCategories() {
  categories.replaceChildren();
  const availableCategories = ['Discover', ...standardIndicatorCategories.filter(c => c !== 'Discover' && c !== 'Favorites' && c !== 'My Scripts')];

  for (const category of availableCategories) {
    const button = document.createElement('button');
    button.textContent = category;
    button.classList.toggle('active', active === category);
    button.addEventListener('click', () => {
      active = category;
      renderCategories();
      render();
    });
    categories.append(button);
  }
}

fetch(appAssetUrl('/indicators/catalog.json'))
  .then(response => response.json())
  .then((value: Entry[]) => {
    entries = value;
    renderCategories();
    render();
  })
  .catch(error => {
    results.textContent = error instanceof Error ? error.message : String(error);
  });

search.addEventListener('input', render);
document.getElementById('close')?.addEventListener('click', () => window.velaIndicatorBrowser?.close());
