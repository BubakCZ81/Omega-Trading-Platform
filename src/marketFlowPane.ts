import { reportCaughtError } from './diagnostics.ts';
import { registerIcon, registerSidePanel, type SidePanelHandle, type Vela } from './platform';
import {
  isRecentMt5Tick,
  mt5SymbolForChart,
  parseMt5Book,
  parseMt5Ticks,
  quantowerSymbolForChart,
  type DepthLevel,
  type MarketDepth,
  type MarketTrade,
} from './marketFlowParsing';

// The panel module stays the public entry point for these helpers, so existing callers
// keep importing them from here.
export {
  isRecentMt5Tick,
  mt5SymbolForChart,
  parseMt5Book,
  parseMt5Ticks,
  quantowerSymbolForChart,
} from './marketFlowParsing';
export type { DepthLevel, MarketDepth, MarketTrade } from './marketFlowParsing';
import { panelStyles } from './marketFlowStyles';
import { inferPipSize } from './pipSize';

type MarketFlowView = 'time-sales' | 'dom';
type TimeSalesColumn = 'time' | 'price' | 'size' | 'side';

const timeSalesColumnNames: TimeSalesColumn[] = ['time', 'price', 'size', 'side'];
const defaultTimeSalesColumnWidths = [28, 28, 24, 20];
const minTimeSalesColumnWidth = 12;

export interface MarketFlowStyle {
  fontSize: number;
  background: string;
  text: string;
  buy: string;
  sell: string;
  grid: string;
}

type MarketFlowStyleKey = keyof MarketFlowStyle;

const marketFlowStyleDefaults: Record<MarketFlowView, MarketFlowStyle> = {
  'time-sales': { fontSize: 14, background: '#131722', text: '#d1d4dc', buy: '#00b8c8', sell: '#ff4b00', grid: '#2a2e39' },
  dom: { fontSize: 14, background: '#131722', text: '#d1d4dc', buy: '#22c55e', sell: '#ef5350', grid: '#2a2e39' },
};
const marketFlowLightStyleDefaults: Record<MarketFlowView, MarketFlowStyle> = {
  'time-sales': { fontSize: 14, background: '#ffffff', text: '#111827', buy: '#008fa3', sell: '#d83b00', grid: '#cbd5e1' },
  dom: { fontSize: 14, background: '#ffffff', text: '#111827', buy: '#15803d', sell: '#b91c1c', grid: '#cbd5e1' },
};
const marketFlowSolarizedDarkStyleDefaults: Record<MarketFlowView, MarketFlowStyle> = {
  'time-sales': { fontSize: 14, background: '#073642', text: '#eee8d5', buy: '#859900', sell: '#ff6577', grid: '#586e75' },
  dom: { fontSize: 14, background: '#073642', text: '#eee8d5', buy: '#859900', sell: '#ff6577', grid: '#586e75' },
};
const marketFlowSolarizedLightStyleDefaults: Record<MarketFlowView, MarketFlowStyle> = {
  'time-sales': { fontSize: 14, background: '#eee8d5', text: '#073642', buy: '#586e00', sell: '#b42336', grid: '#93a1a1' },
  dom: { fontSize: 14, background: '#eee8d5', text: '#073642', buy: '#586e00', sell: '#b42336', grid: '#93a1a1' },
};
const marketFlowStyleKeys: MarketFlowStyleKey[] = ['fontSize', 'background', 'text', 'buy', 'sell', 'grid'];

export function normalizeTimeSalesColumnWidths(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== timeSalesColumnNames.length) return [...defaultTimeSalesColumnWidths];
  const widths = value.map(Number);
  if (widths.some(width => !Number.isFinite(width) || width < minTimeSalesColumnWidth)) return [...defaultTimeSalesColumnWidths];
  const total = widths.reduce((sum, width) => sum + width, 0);
  return widths.map(width => width / total * 100);
}

export function resizeTimeSalesColumn(widths: readonly number[], index: number, delta: number): number[] {
  if (index < 0 || index >= widths.length - 1 || !Number.isFinite(delta)) return [...widths];
  const result = [...widths];
  const left = result[index] + delta;
  const right = result[index + 1] - delta;
  if (left < minTimeSalesColumnWidth || right < minTimeSalesColumnWidth) return result;
  result[index] = left;
  result[index + 1] = right;
  return result;
}

function loadTimeSalesColumnWidths(): number[] {
  const stored = localStorage.getItem('omega-market-flow-time-sales-columns');
  if (!stored) return [...defaultTimeSalesColumnWidths];
  try {
    return normalizeTimeSalesColumnWidths(JSON.parse(stored));
  } catch (error) {
    reportCaughtError('market-flow:column-widths', error, 'Saved Time & Sales column widths could not be read; defaults used.');
    return [...defaultTimeSalesColumnWidths];
  }
}

export function getMarketFlowStyle(view: MarketFlowView): MarketFlowStyle {
  const variant = typeof document === 'undefined' ? '' : document.body?.dataset.themeVariant;
  const defaults = variant === 'solarized-dark'
    ? marketFlowSolarizedDarkStyleDefaults
    : variant === 'solarized-light'
      ? marketFlowSolarizedLightStyleDefaults
      : typeof document !== 'undefined' && document.body?.dataset.theme === 'light'
        ? marketFlowLightStyleDefaults
        : marketFlowStyleDefaults;
  const style = { ...defaults[view] };
  // Older builds stored yellow buy/sell colours for this panel. Clear those
  // legacy overrides once so the Quantower-style palette below can take effect;
  // later user customizations remain persistent as before.
  const colorVersionKey = 'omega-market-flow-colors-version';
  if (localStorage.getItem(colorVersionKey) !== 'quantower-v1') {
    localStorage.removeItem(`omega-market-flow-${view}-buy`);
    localStorage.removeItem(`omega-market-flow-${view}-sell`);
    localStorage.setItem(colorVersionKey, 'quantower-v1');
  }
  for (const key of marketFlowStyleKeys) {
    const stored = localStorage.getItem(`omega-market-flow-${view}-${key}`);
    if (stored === null) continue;
    if (key === 'fontSize') {
      const fontSize = Number(stored);
      if ([10, 11, 12, 13, 14, 16, 18].includes(fontSize)) style.fontSize = fontSize;
    } else if ((key === 'buy' || key === 'sell')) {
      // Keep the tape palette aligned with Quantower. Legacy/custom yellow
      // values are intentionally ignored for this market-data panel.
      style[key] = defaults[view][key];
    } else if (/^#[\da-f]{6}$/i.test(stored)) {
      style[key] = stored;
    }
  }
  return style;
}

export function setMarketFlowStyle(view: MarketFlowView, key: MarketFlowStyleKey, value: string | number): void {
  if (key === 'fontSize') {
    const fontSize = Number(value);
    if (![10, 11, 12, 13, 14, 16, 18].includes(fontSize)) throw new Error('Choose a supported market panel font size.');
    localStorage.setItem(`omega-market-flow-${view}-${key}`, String(fontSize));
  } else {
    if (typeof value !== 'string' || !/^#[\da-f]{6}$/i.test(value)) throw new Error('Choose a valid six-digit panel color.');
    localStorage.setItem(`omega-market-flow-${view}-${key}`, value);
  }
  applyMarketFlowStyle(view);
}

function applyMarketFlowStyle(view: MarketFlowView): void {
  if (typeof document === 'undefined') return;
  const style = getMarketFlowStyle(view);
  for (const root of document.querySelectorAll<HTMLElement>(`.vela-panel-omega-${view} .omega-market-flow`)) {
    root.style.setProperty('--omega-market-font-size', `${style.fontSize}px`);
    root.style.setProperty('--omega-market-bg', style.background);
    root.style.setProperty('--omega-market-text', style.text);
    root.style.setProperty('--omega-market-buy', style.buy);
    root.style.setProperty('--omega-market-sell', style.sell);
    root.style.setProperty('--omega-market-grid', style.grid);
  }
}

export function refreshMarketFlowStyles(): void {
  applyMarketFlowStyle('time-sales');
  applyMarketFlowStyle('dom');
}
let panelStylesInstalled = false;

function createCell(tag: 'td' | 'th', text: string, className = ''): HTMLTableCellElement {
  const cell = document.createElement(tag);
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

function formatPrice(price: number): string {
  return price.toLocaleString(undefined, { maximumFractionDigits: 10 });
}

export function formatTradeSize(quantity: number): string {
  if (!Number.isFinite(quantity) || quantity <= 0) return '—';
  if (quantity < 0.01) {
    const maximumFractionDigits = Math.min(12, Math.max(2, 1 - Math.floor(Math.log10(quantity))));
    return quantity.toLocaleString(undefined, { maximumFractionDigits });
  }
  return quantity.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function formatTradeTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return '—';
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function renderTrades(tableBody: HTMLTableSectionElement, trades: readonly MarketTrade[]): void {
  tableBody.replaceChildren();
  for (const trade of trades) {
    const row = document.createElement('tr');
    const sideClass = trade.side === 'BUY' ? 'omega-market-flow-buy' : trade.side === 'SELL' ? 'omega-market-flow-sell' : '';
    const cells = [
      createCell('td', formatTradeTime(trade.time), `omega-market-flow-time ${sideClass}`.trim()),
      createCell('td', formatPrice(trade.price), `omega-market-flow-price ${sideClass}`.trim()),
      createCell('td', formatTradeSize(trade.quantity), `omega-market-flow-size ${sideClass}`.trim()),
      createCell('td', trade.side, sideClass),
    ];
    cells.slice(0, -1).forEach(cell => cell.classList.add('omega-market-flow-column-boundary'));
    row.append(...cells);
    tableBody.append(row);
  }
}

/**
 * Quantower's aggregated tape combines executions only when they have the
 * same price, aggressor direction and one-second time bucket.  Keeping the
 * side in the key is essential: a buy and a sell at the same price must not
 * cancel or masquerade as one another.
 */
function quantowerAggregationKey(trade: MarketTrade): string {
  return `${Math.floor(trade.time / 1_000)}:${trade.price}:${trade.side}`;
}

function appendQuantowerTrades(target: MarketTrade[], incoming: readonly MarketTrade[]): void {
  for (const trade of incoming) {
    const existing = target.find(item => quantowerAggregationKey(item) === quantowerAggregationKey(trade));
    if (existing) {
      existing.quantity += trade.quantity;
      existing.time = Math.max(existing.time, trade.time);
      continue;
    }
    target.unshift(trade);
  }
  target.sort((left, right) => right.time - left.time);
  if (target.length > 100) target.length = 100;
}

function installTimeSalesColumnResizers(table: HTMLTableElement, heading: HTMLTableRowElement): void {
  const colGroup = document.createElement('colgroup');
  const columns = timeSalesColumnNames.map(() => document.createElement('col'));
  const widths = loadTimeSalesColumnWidths();
  const applyWidths = () => {
    columns.forEach((column, index) => { column.style.width = `${widths[index]}%`; });
  };
  columns.forEach(column => colGroup.append(column));
  table.prepend(colGroup);
  table.classList.add('omega-market-flow-table-resizable');
  applyWidths();

  heading.querySelectorAll<HTMLTableCellElement>('th').forEach((cell, index) => {
    if (index >= columns.length - 1) return;
    const resizer = document.createElement('button');
    resizer.type = 'button';
    resizer.className = 'omega-market-flow-column-resizer';
    resizer.setAttribute('aria-label', `Resize ${timeSalesColumnNames[index]} and ${timeSalesColumnNames[index + 1]} columns`);
    resizer.title = 'Drag to resize columns';
    resizer.addEventListener('pointerdown', event => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = table.getBoundingClientRect().width;
      if (startWidth <= 0) return;
      const startingWidths = [...widths];
      const move = (moveEvent: PointerEvent) => {
        const next = resizeTimeSalesColumn(startingWidths, index, (moveEvent.clientX - startX) / startWidth * 100);
        widths.splice(0, widths.length, ...next);
        applyWidths();
      };
      const finish = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', finish);
        window.removeEventListener('pointercancel', finish);
        localStorage.setItem('omega-market-flow-time-sales-columns', JSON.stringify(widths));
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', finish, { once: true });
      window.addEventListener('pointercancel', finish, { once: true });
    });
    cell.append(resizer);
  });
}

function renderDepth(
  tableBody: HTMLTableSectionElement,
  spread: HTMLElement,
  depth: MarketDepth | null,
): void {
  tableBody.replaceChildren();
  if (!depth) {
    spread.textContent = 'Waiting for live order book…';
    return;
  }
  const maxQuantity = Math.max(1, ...depth.bids.map(level => level.quantity), ...depth.asks.map(level => level.quantity));
  const appendLevel = (level: DepthLevel, side: 'bid' | 'ask') => {
    const row = document.createElement('tr');
    const sizeCell = createCell('td', '');
    sizeCell.className = 'omega-market-flow-depth-cell';
    const bar = document.createElement('span');
    bar.className = `omega-market-flow-depth-bar ${side}`;
    bar.style.width = `${Math.max(1, level.quantity / maxQuantity * 100)}%`;
    const size = document.createElement('span');
    size.className = 'omega-market-flow-depth-value';
    size.textContent = level.quantity.toLocaleString(undefined, { maximumFractionDigits: 8 });
    sizeCell.append(bar, size);
    row.append(sizeCell, createCell('td', formatPrice(level.price), side === 'bid' ? 'omega-market-flow-buy' : 'omega-market-flow-sell'));
    tableBody.append(row);
  };

  for (const ask of [...depth.asks].reverse()) appendLevel(ask, 'ask');
  const bestBid = depth.bids[0]?.price;
  const bestAsk = depth.asks[0]?.price;
  spread.textContent = bestBid !== undefined && bestAsk !== undefined
    ? `SPREAD  ${formatPrice(bestAsk - bestBid)}`
    : 'Spread unavailable';
  for (const bid of depth.bids) appendLevel(bid, 'bid');
}

interface TickFlowLevel { price: number; upPips: number; downPips: number; upTicks: number; downTicks: number }

const defaultDomTickWindowSize = 100;
const maxDomTickWindowSize = 1_000;
const domTickWindowSizeStorageKey = 'omega-market-flow-dom-window-size';

function readDomTickWindowSize(): number {
  try {
    const stored = Number(localStorage.getItem(domTickWindowSizeStorageKey));
    return Number.isInteger(stored) && stored >= 1 && stored <= maxDomTickWindowSize
      ? stored
      : defaultDomTickWindowSize;
  } catch {
    return defaultDomTickWindowSize;
  }
}

function appendTickFlow(target: Map<number, TickFlowLevel>, trades: readonly MarketTrade[], previousPrice: { value: number; direction: -1 | 0 | 1 }, pipSize: number | null, maxLevels: number): void {
  for (const trade of trades) {
    const price = Number(trade.price.toPrecision(12));
    const priorPrice = previousPrice.value;
    const tradeDirection = trade.side === 'BUY' ? 1 : trade.side === 'SELL' ? -1 : 0;
    const direction: -1 | 0 | 1 = priorPrice === 0
      ? tradeDirection
      : price > priorPrice ? 1
        : price < priorPrice ? -1
          : previousPrice.direction || tradeDirection;
    if (direction !== 0) {
      const row = target.get(price) ?? { price, upPips: 0, downPips: 0, upTicks: 0, downTicks: 0 };
      if (direction > 0) {
        row.upTicks += 1;
        if (priorPrice > 0 && pipSize) row.upPips += Math.abs(price - priorPrice) / pipSize;
      } else {
        row.downTicks += 1;
        if (priorPrice > 0 && pipSize) row.downPips += Math.abs(price - priorPrice) / pipSize;
      }
      target.delete(price);
      target.set(price, row);
    }
    previousPrice.value = price;
    if (priorPrice === 0 || price !== priorPrice) previousPrice.direction = direction;
  }
  while (target.size > maxLevels) target.delete(target.keys().next().value!);
}

function renderTickFlow(
  tableWrap: HTMLElement,
  tableBody: HTMLTableSectionElement,
  summary: HTMLElement,
  levels: Map<number, TickFlowLevel>,
  mode: 'tick-count' | 'tick-pips',
  rowHeight: number,
): number {
  const rows = [...levels.values()].sort((left, right) => right.price - left.price);
  const amountFor = (row: TickFlowLevel, side: 'up' | 'down') => mode === 'tick-count'
    ? side === 'up' ? row.upTicks : row.downTicks
    : side === 'up' ? row.upPips : row.downPips;
  let max = 1;
  let downTotal = 0;
  let upTotal = 0;
  for (const row of rows) {
    const down = amountFor(row, 'down');
    const up = amountFor(row, 'up');
    max = Math.max(max, down + up);
    downTotal += down;
    upTotal += up;
  }

  const overscan = 12;
  const firstVisible = Math.floor(tableWrap.scrollTop / rowHeight);
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(rows.length, Math.ceil((tableWrap.scrollTop + (tableWrap.clientHeight || rowHeight * 20)) / rowHeight) + overscan);
  const fragment = document.createDocumentFragment();
  const appendSpacer = (height: number) => {
    if (height <= 0) return;
    const row = document.createElement('tr');
    row.setAttribute('aria-hidden', 'true');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.style.cssText = `height:${height}px;padding:0;border:0;font-size:0;line-height:0`;
    row.append(cell);
    fragment.append(row);
  };
  appendSpacer(start * rowHeight);
  for (const level of rows.slice(start, end)) {
    const row = document.createElement('tr');
    row.className = 'omega-market-flow-tick-row';
    row.dataset.tickFlowRow = 'true';
    const down = createCell('td', '');
    const up = createCell('td', '');
    for (const [cell, side, amount] of [[down, 'down', amountFor(level, 'down')], [up, 'up', amountFor(level, 'up')]] as const) {
      cell.className = `omega-market-flow-tick-cell ${side}`;
      const track = document.createElement('span');
      track.className = `omega-market-flow-tick-track ${side}`;
      const bar = document.createElement('span');
      bar.className = `omega-market-flow-tick-bar ${side}`;
      bar.style.width = `${amount > 0 ? Math.max(2, amount / max * 100) : 0}%`;
      track.append(bar);
      if (amount > 0) {
        const value = document.createElement('span');
        value.className = `omega-market-flow-tick-value ${side}`;
        value.textContent = mode === 'tick-count' ? amount.toLocaleString() : `${amount.toFixed(2)} p`;
        track.append(value);
      }
      cell.append(track);
    }
    row.append(down, up, createCell('td', formatPrice(level.price), 'omega-market-flow-tick-price'));
    fragment.append(row);
  }
  appendSpacer((rows.length - end) * rowHeight);
  tableBody.replaceChildren(fragment);
  const measuredRowHeight = tableBody.querySelector<HTMLElement>('[data-tick-flow-row]')?.getBoundingClientRect().height;

  summary.replaceChildren();
  const downLabel = document.createElement('span');
  downLabel.className = 'omega-market-flow-tick-total down';
  downLabel.textContent = `${mode === 'tick-count' ? 'Down ticks' : 'Down pips'} · ${mode === 'tick-count' ? downTotal.toLocaleString() : `${downTotal.toFixed(2)} p`}`;
  const upLabel = document.createElement('span');
  upLabel.className = 'omega-market-flow-tick-total up';
  upLabel.textContent = `${mode === 'tick-count' ? 'Up ticks' : 'Up pips'} · ${mode === 'tick-count' ? upTotal.toLocaleString() : `${upTotal.toFixed(2)} p`}`;
  if (mode === 'tick-pips' && downTotal !== upTotal) {
    const color = downTotal > upTotal ? 'var(--omega-market-sell,#ef5350)' : 'var(--omega-market-buy,#22c55e)';
    downLabel.style.color = color;
    upLabel.style.color = color;
  }
  summary.append(downLabel, upLabel);
  return measuredRowHeight && measuredRowHeight > 0 ? measuredRowHeight : rowHeight;
}

async function resolveChartPipSize(chart: Vela, symbol: string): Promise<number | null> {
  let metadata: Record<string, unknown> | undefined;
  try {
    const info = await chart.data.symbolInfo(symbol);
    if (info && typeof info === 'object' && !Array.isArray(info)) metadata = info as Record<string, unknown>;
  } catch { /* Use symbol inference where supported; otherwise report unavailable. */ }
  for (const key of ['pipSize', 'pip_size', 'pointSize', 'point_size']) {
    const value = Number(metadata?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  const inferred = inferPipSize(chart.data.resolve(symbol)?.ticker ?? symbol);
  if (inferred) return inferred;
  for (const key of ['minTick', 'mintick']) {
    const value = Number(metadata?.[key]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function installPanelStyles(): void {
  if (panelStylesInstalled) return;
  const style = document.createElement('style');
  style.dataset.omegaMarketFlowStyles = 'true';
  style.textContent = panelStyles;
  document.head.append(style);
  panelStylesInstalled = true;
}

function createMarketFlowPanel(view: MarketFlowView, body: HTMLElement): SidePanelHandle {
  const isTimeSales = view === 'time-sales';
  let volumeMode: 'book' | 'tick-count' | 'tick-pips' = 'book';
  if (!isTimeSales) {
    try {
      const savedMode = localStorage.getItem('omega-market-flow-dom-mode');
      volumeMode = savedMode === 'ticks' || savedMode === 'tick-volume' || savedMode === 'tick-pips'
        ? 'tick-pips'
        : savedMode === 'tick-count' ? 'tick-count' : 'book';
    } catch { /* default to order-book mode */ }
  }
  const isTradeView = () => isTimeSales || volumeMode !== 'book';
  const root = document.createElement('section');
  root.className = 'omega-market-flow';
  const status = document.createElement('div');
  status.className = 'omega-market-flow-status';
  status.setAttribute('role', 'status');
  status.textContent = 'Select a live chart to load market data.';

  const tableWrap = document.createElement('div');
  tableWrap.className = 'omega-market-flow-table-wrap';
  const table = document.createElement('table');
  table.className = 'omega-market-flow-table';
  const head = document.createElement('thead');
  const heading = document.createElement('tr');
  const labels = isTimeSales ? ['Time', 'Price', 'Size', 'Side'] : ['Size', 'Price'];
  for (const [index, label] of labels.entries()) {
    const cell = createCell('th', label, isTimeSales && index === 1 ? 'omega-market-flow-price' : '');
    if (isTimeSales && index < labels.length - 1) cell.classList.add('omega-market-flow-column-boundary');
    heading.append(cell);
  }
  head.append(heading);
  const tableBody = document.createElement('tbody');
  table.append(head, tableBody);
  if (isTimeSales) installTimeSalesColumnResizers(table, heading);
  tableWrap.append(table);
  const spread = document.createElement('div');
  spread.className = 'omega-market-flow-spread';
  const modeControls = document.createElement('div');
  modeControls.className = 'omega-market-flow-mode';
  const modeLabel = document.createElement('label');
  modeLabel.className = 'omega-market-flow-mode-label';
  modeLabel.textContent = 'Volume mode';
  modeLabel.htmlFor = 'omega-market-flow-volume-mode';
  const modeSelect = document.createElement('select');
  modeSelect.id = 'omega-market-flow-volume-mode';
  modeSelect.className = 'omega-market-flow-mode-select';
  modeSelect.setAttribute('aria-label', 'Select order-book volume, tick count, or tick volume');
  for (const [value, label] of [
    ['book', 'Order-book volume'],
    ['tick-count', 'Tick count · upticks/downticks'],
    ['tick-pips', 'Tick volume · pips moved'],
  ] as const) modeSelect.add(new Option(label, value));
  const windowSizeLabel = document.createElement('label');
  windowSizeLabel.className = 'omega-market-flow-window-label';
  windowSizeLabel.htmlFor = 'omega-market-flow-window-size';
  windowSizeLabel.textContent = 'Rows';
  const windowSizeInput = document.createElement('input');
  windowSizeInput.id = 'omega-market-flow-window-size';
  windowSizeInput.className = 'omega-market-flow-window-size';
  windowSizeInput.type = 'number';
  windowSizeInput.min = '1';
  windowSizeInput.max = String(maxDomTickWindowSize);
  windowSizeInput.step = '1';
  windowSizeInput.value = String(readDomTickWindowSize());
  windowSizeInput.setAttribute('aria-label', 'Maximum rolling price rows');
  let tickWindowSize = Number(windowSizeInput.value);
  const tickTotals = document.createElement('div');
  tickTotals.className = 'omega-market-flow-tick-totals';
  const renderMode = () => {
    modeSelect.value = volumeMode;
    const labels = isTradeView() ? [volumeMode === 'tick-count' ? 'Down ticks' : 'Down pips', volumeMode === 'tick-count' ? 'Up ticks' : 'Up pips', 'Price'] : ['Size', 'Price'];
    heading.replaceChildren(...labels.map((label, index) => createCell('th', label, isTradeView() && index < 2 ? `omega-market-flow-tick-${index === 0 ? 'down' : 'up'}` : '')));
    spread.hidden = volumeMode !== 'book';
    tickTotals.hidden = volumeMode === 'book';
    windowSizeLabel.hidden = volumeMode === 'book';
    windowSizeInput.hidden = volumeMode === 'book';
  };
  const chooseVolumeMode = (mode: 'book' | 'tick-count' | 'tick-pips') => {
    if (volumeMode === mode) return;
    volumeMode = mode;
    try { localStorage.setItem('omega-market-flow-dom-mode', volumeMode); } catch { /* keep the selection for this panel session */ }
    renderMode();
    void connect();
  };
  modeSelect.addEventListener('change', () => {
    if (modeSelect.value === 'book' || modeSelect.value === 'tick-count' || modeSelect.value === 'tick-pips') chooseVolumeMode(modeSelect.value);
  });
  windowSizeInput.addEventListener('change', () => {
    const nextSize = windowSizeInput.valueAsNumber;
    if (!Number.isInteger(nextSize) || nextSize < 1 || nextSize > maxDomTickWindowSize) {
      windowSizeInput.value = String(tickWindowSize);
      status.dataset.state = 'error';
      status.textContent = `Enter a price-row count from 1 to ${maxDomTickWindowSize}.`;
      return;
    }
    tickWindowSize = nextSize;
    try {
      localStorage.setItem(domTickWindowSizeStorageKey, String(tickWindowSize));
    } catch (error) {
      reportCaughtError('market-flow:save-dom-window-size', error, 'The DOM row limit could not be saved; it will apply for this session only.');
    }
    while (tickFlow.size > tickWindowSize) tickFlow.delete(tickFlow.keys().next().value!);
    scheduleTickFlowRender();
  });
  modeControls.append(modeLabel, modeSelect, windowSizeLabel, windowSizeInput);

  if (isTimeSales) {
    const note = document.createElement('div');
    note.className = 'omega-market-flow-note';
    note.textContent = 'Live trade or quote ticks; source depends on the connected feed.';
    root.append(status, note, tableWrap);
  } else {
    const note = document.createElement('div');
    note.className = 'omega-market-flow-note';
    note.textContent = 'Tick-count and pip-movement accumulate live data for the active candle only and reset at the next candle. Order-book mode stays live; no historical ticks are loaded.';
    root.append(status, note, modeControls, spread, tickTotals, tableWrap);
    renderMode();
  }

  let chart: Vela | null = null;
  let open = false;
  let generation = 0;
  let pollTimer: number | undefined;
  let feedHealthTimer: number | undefined;
  let unsubscribeMarket: (() => void) | null = null;
  let unsubscribeBar: (() => void) | null = null;
  let unsubscribeTicks: (() => void) | null = null;
  let tickRenderTimer: number | undefined;
  let tickRenderFrame: number | null = null;
  let tickFlowRowHeight = 24;
  const trades: MarketTrade[] = [];
  const tickFlow = new Map<number, TickFlowLevel>();
  const previousFlowPrice = { value: 0, direction: 0 as -1 | 0 | 1 };
  let activePipSize: number | null = null;
  const renderAccumulatedTickFlow = () => {
    tickRenderFrame = null;
    if (!open || isTimeSales || volumeMode === 'book') return;
    tickFlowRowHeight = renderTickFlow(
      tableWrap,
      tableBody,
      tickTotals,
      tickFlow,
      volumeMode === 'tick-count' ? 'tick-count' : 'tick-pips',
      tickFlowRowHeight,
    );
  };
  const scheduleTickFlowRender = () => {
    if (tickRenderTimer !== undefined || tickRenderFrame !== null || !open) return;
    tickRenderTimer = window.setTimeout(() => {
      tickRenderTimer = undefined;
      if (tickRenderFrame === null && open) {
        tickRenderFrame = window.requestAnimationFrame(renderAccumulatedTickFlow);
      }
    }, 100);
  };
  tableWrap.addEventListener('scroll', scheduleTickFlowRender, { passive: true });
  const showTrades = (incoming: readonly MarketTrade[]) => {
    if (isTimeSales) {
      if (incoming.length) {
        trades.unshift(...incoming);
        trades.sort((left, right) => right.time - left.time);
        if (trades.length > 100) trades.length = 100;
      }
      renderTrades(tableBody, trades);
      return;
    }
    appendTickFlow(tickFlow, incoming, previousFlowPrice, activePipSize, tickWindowSize);
    scheduleTickFlowRender();
  };
  const clearPanelData = () => {
    trades.length = 0;
    tickFlow.clear();
    previousFlowPrice.value = 0;
    previousFlowPrice.direction = 0;
    tableBody.replaceChildren();
    tickTotals.replaceChildren();
  };
  let activeCandleTime: number | null = null;
  const resetTickFlowForCandle = (bar: { time: number; open?: number }) => {
    const candleTime = Number(bar.time);
    if (!Number.isFinite(candleTime) || candleTime === activeCandleTime) return;
    activeCandleTime = candleTime;
    if (isTimeSales || volumeMode === 'book') return;
    tickFlow.clear();
    const openPrice = Number(bar.open);
    previousFlowPrice.value = Number.isFinite(openPrice) && openPrice > 0
      ? Number(openPrice.toPrecision(12))
      : 0;
    previousFlowPrice.direction = 0;
    tableWrap.scrollTop = 0;
    scheduleTickFlowRender();
  };
  let visibilityObserver: MutationObserver | null = null;

  const stopPolling = () => {
    window.clearTimeout(pollTimer);
    pollTimer = undefined;
    window.clearTimeout(feedHealthTimer);
    feedHealthTimer = undefined;
    window.clearTimeout(tickRenderTimer);
    tickRenderTimer = undefined;
    unsubscribeTicks?.();
    unsubscribeTicks = null;
    if (tickRenderFrame !== null) {
      window.cancelAnimationFrame(tickRenderFrame);
      tickRenderFrame = null;
    }
  };

  const streamMt5 = async (ticker: string, activeChart: Vela, request: number) => {
    const bridge = window.velaMt5;
    if (!bridge) {
      status.dataset.state = 'error';
      status.textContent = 'MT5 tick data is available only in the connected Omega desktop app.';
      return;
    }
    status.dataset.state = 'connecting';
    status.textContent = `Checking the MT5 connection for ${ticker}…`;
    try {
      const feedStatus = await bridge.tradingStatus();
      if (request !== generation || chart !== activeChart || !open) return;
      if (!feedStatus.connected) {
        clearPanelData();
        status.dataset.state = 'error';
        status.textContent = `MT5 is disconnected. Connect the MT5 feed to start ${isTradeView() ? 'time and sales' : 'market depth'} for ${ticker}.`;
        return;
      }
    } catch (error) {
      if (request !== generation || chart !== activeChart || !open) return;
      clearPanelData();
      status.dataset.state = 'error';
      status.textContent = `Could not verify the MT5 feed for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    status.textContent = `Connecting to MT5 ${isTradeView() ? 'ticks' : 'market depth'} for ${ticker}…`;
    const monitorConnection = async () => {
      if (request !== generation || chart !== activeChart || !open) return;
      try {
        const feedStatus = await bridge.tradingStatus();
        if (!feedStatus.connected) {
          clearPanelData();
          status.dataset.state = 'error';
          status.textContent = `MT5 disconnected. Live ${isTradeView() ? 'tick flow' : 'market depth'} stopped for ${ticker}.`;
          stopPolling();
          return;
        }
      } catch (error) {
        clearPanelData();
        status.dataset.state = 'error';
        status.textContent = `MT5 connection check failed for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
        stopPolling();
        return;
      }
      if (request === generation && chart === activeChart && open) {
        feedHealthTimer = window.setTimeout(() => { void monitorConnection(); }, 3000);
      }
    };
    feedHealthTimer = window.setTimeout(() => { void monitorConnection(); }, 3000);
    if (!isTradeView()) {
      const pollBook = async () => {
        try {
          const depth = parseMt5Book(await bridge.marketBook(ticker));
          if (request !== generation || chart !== activeChart || !open) return;
          if (!depth) {
            status.dataset.state = 'error';
            status.textContent = `MT5 has no market depth for ${ticker}; switching to tick volume in pips.`;
            chooseVolumeMode('tick-pips');
            return;
          }
          status.dataset.state = 'live';
          status.textContent = `Live MT5 market depth · ${ticker}`;
          renderDepth(tableBody, spread, depth);
          pollTimer = window.setTimeout(() => { void pollBook(); }, 500);
        } catch (error) {
          if (request !== generation || chart !== activeChart || !open) return;
          const message = error instanceof Error ? error.message : String(error);
          if (/does not provide market depth|market depth unavailable/i.test(message)) {
            status.dataset.state = 'connecting';
            status.textContent = `MT5 has no market depth for ${ticker}; switching to tick volume in pips.`;
            chooseVolumeMode('tick-pips');
            return;
          }
          status.dataset.state = 'error';
          status.textContent = `MT5 market depth unavailable for ${ticker}: ${message}`;
        }
      };
      void pollBook();
      return;
    }

    const streamStartedAt = Date.now();
    let lastLiveTickAt = 0;
    let tickCursor = 0;
    let seenAtCursor = new Map<string, number>();
    // Use one current quote as the comparison point for live-only flow. This is
    // not DOM history: it lets the first streamed price change register instead
    // of silently treating that tick as a zeroed baseline.
    if (!isTimeSales) {
      void bridge.quote(ticker).then(quote => {
        if (request !== generation || chart !== activeChart || !open || previousFlowPrice.value !== 0) return;
        const bid = Number(quote.bid);
        const ask = Number(quote.ask);
        const referencePrice = bid > 0 && ask >= bid ? (bid + ask) / 2 : bid > 0 ? bid : ask;
        if (Number.isFinite(referencePrice) && referencePrice > 0) {
          previousFlowPrice.value = Number(referencePrice.toPrecision(12));
        }
      }).catch(() => { /* The tick stream still works if the quote snapshot is unavailable. */ });
    }
    const handleTickBatch = (batch: unknown) => {
      if (request !== generation || chart !== activeChart || !open || !Array.isArray(batch)) return;
      const fresh: MarketTrade[] = [];
      const occurrences = new Map<string, number>();
      for (const value of batch) {
        if (!value || typeof value !== 'object') continue;
        const tick = value as Record<string, unknown>;
        const time = Number(tick.time);
        if (!Number.isFinite(time) || time <= 0 || time < tickCursor) continue;
        const bid = Number(tick.bid);
        const ask = Number(tick.ask);
        const last = Number(tick.last);
        if (time > tickCursor) {
          tickCursor = time;
          seenAtCursor = new Map();
        }
        const key = `${time}:${bid}:${ask}:${last}:${String(tick.volume ?? '')}:${String(tick.volumeReal ?? '')}:${String(tick.flags ?? '')}`;
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        if (occurrence <= (seenAtCursor.get(key) ?? 0)) continue;
        seenAtCursor.set(key, occurrence);
        const price = last > 0 ? last : bid > 0 && ask >= bid ? (bid + ask) / 2 : bid > 0 ? bid : ask;
        if (!Number.isFinite(time) || !Number.isFinite(price) || price <= 0) continue;
        fresh.push({
          time,
          price,
          quantity: Math.max(0, Number(tick.volumeReal ?? tick.volume) || 0),
          side: 'FLAT',
          key: `${time}:${bid}:${ask}:${last}:${String(tick.flags ?? '')}`,
        });
      }
      if (!fresh.length) return;
      showTrades(fresh);
      lastLiveTickAt = Date.now();
      status.dataset.state = 'live';
      status.textContent = `Live MT5 ticks · ${ticker}`;
    };
    if (bridge.subscribeTicks) {
      status.dataset.state = 'connecting';
      status.textContent = `Subscribing to every live MT5 tick · ${ticker}…`;
      try {
        unsubscribeTicks = bridge.subscribeTicks(ticker, handleTickBatch);
        status.dataset.state = 'live';
        status.textContent = `Live MT5 tick stream · ${ticker}`;
      } catch (error) {
        status.dataset.state = 'error';
        status.textContent = `Could not subscribe to MT5 ticks for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
      }
      return;
    }

    let cursor = Date.now() - 2_000;
    let previousPrice = 0;
    const seen = new Set<string>();
    const pollTicks = async () => {
      try {
        const batch = await bridge.ticks({ ticker, fromMsc: Math.max(0, cursor - 1_000), limit: 2_000 });
        if (request !== generation || chart !== activeChart || !open) return;
        const parsed = parseMt5Ticks(batch, previousPrice);
        if (parsed.cursor) cursor = Math.max(cursor, parsed.cursor);
        const fresh = parsed.ticks.filter(tick => tick.time >= streamStartedAt && isRecentMt5Tick(tick.time)).filter(tick => {
          const id = tick.key ?? `${tick.time}:${tick.price}:${tick.quantity}:${tick.side}`;
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        });
        while (seen.size > 5_000) seen.delete(seen.values().next().value!);
        if (fresh.length) {
          previousPrice = fresh[fresh.length - 1].price;
          showTrades(fresh);
          lastLiveTickAt = Date.now();
          status.dataset.state = 'live';
          status.textContent = `Live MT5 ticks · ${ticker}`;
        } else if (Date.now() - lastLiveTickAt > 10_000) {
          status.dataset.state = 'connecting';
          status.textContent = `Connected to MT5 · waiting for live ticks · ${ticker}`;
        }
      } catch (error) {
        if (request !== generation || chart !== activeChart || !open) return;
        status.dataset.state = 'error';
        status.textContent = `MT5 tick stream unavailable for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (request === generation && chart === activeChart && open && status.dataset.state !== 'error') {
          pollTimer = window.setTimeout(() => { void pollTicks(); }, 100);
        }
      }
    };
    void pollTicks();
  };

  const streamQuantower = async (ticker: string, activeChart: Vela, request: number) => {
    const bridge = window.velaQuantower;
    if (!bridge) {
      status.dataset.state = 'error';
      status.textContent = 'Quantower live data is available only in the connected Omega desktop app.';
      return;
    }
    status.dataset.state = 'connecting';
    status.textContent = `Checking the Quantower connection for ${ticker}…`;
    try {
      const health = await bridge.health();
      if (request !== generation || chart !== activeChart || !open) return;
      if (!health.connected) {
        clearPanelData();
        status.dataset.state = 'error';
        status.textContent = `Quantower is disconnected. Connect the feed to start live market flow for ${ticker}.`;
        return;
      }
    } catch (error) {
      if (request !== generation || chart !== activeChart || !open) return;
      clearPanelData();
      status.dataset.state = 'error';
      status.textContent = `Could not verify the Quantower feed for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
      return;
    }
    const monitorConnection = async () => {
      if (request !== generation || chart !== activeChart || !open) return;
      try {
        const health = await bridge.health();
        if (!health.connected) {
          clearPanelData();
          status.dataset.state = 'error';
          status.textContent = `Quantower disconnected. Live market flow stopped for ${ticker}.`;
          stopPolling();
          return;
        }
      } catch (error) {
        clearPanelData();
        status.dataset.state = 'error';
        status.textContent = `Quantower connection check failed for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
        stopPolling();
        return;
      }
      if (request === generation && chart === activeChart && open) {
        feedHealthTimer = window.setTimeout(() => { void monitorConnection(); }, 3000);
      }
    };
    feedHealthTimer = window.setTimeout(() => { void monitorConnection(); }, 3000);
    if (!isTradeView()) {
      status.dataset.state = 'connecting';
      status.textContent = `Connecting to Quantower market depth for ${ticker}…`;
      let emptyBookSince = 0;
      const pollBook = async () => {
        try {
          const depth = parseMt5Book(await bridge.marketBook(ticker));
          if (request !== generation || chart !== activeChart || !open) return;
          if (!depth) {
            emptyBookSince ||= Date.now();
            if (Date.now() - emptyBookSince >= 3000) {
              status.dataset.state = 'connecting';
              status.textContent = `Quantower has no market depth for ${ticker}; switching to live tick volume in pips.`;
              chooseVolumeMode('tick-pips');
            } else {
              status.dataset.state = 'connecting';
              status.textContent = `Waiting for Quantower market depth for ${ticker}…`;
            }
            return;
          }
          emptyBookSince = 0;
          status.dataset.state = 'live';
          status.textContent = `Live Quantower market depth · ${ticker}`;
          renderDepth(tableBody, spread, depth);
        } catch (error) {
          if (request !== generation || chart !== activeChart || !open) return;
          status.dataset.state = 'error';
          const message = error instanceof Error ? error.message : String(error);
          if (/unknown endpoint|does not provide market depth|market depth unavailable/i.test(message)) {
            status.dataset.state = 'connecting';
            status.textContent = `Quantower market depth is unavailable for ${ticker}; switching to live tick volume in pips.`;
            chooseVolumeMode('tick-pips');
            return;
          }
          status.dataset.state = 'error';
          status.textContent = `Quantower market depth unavailable for ${ticker}: ${message}`;
        } finally {
          if (request === generation && chart === activeChart && open && status.dataset.state !== 'error') {
            pollTimer = window.setTimeout(() => { void pollBook(); }, 250);
          }
        }
      };
      void pollBook();
      return;
    }
    status.dataset.state = 'connecting';
    status.textContent = `Connecting to Quantower trades for ${ticker}…`;
    let cursor: number | null = null;
    const seen = new Set<number>();
    let receivedLiveTrade = false;
    const pollTrades = async () => {
      try {
        const batch = await bridge.trades({ symbol: ticker, after: cursor ?? 0, limit: cursor === null ? 1 : 1_000 });
        if (request !== generation || chart !== activeChart || !open) return;
        if (cursor === null) {
          cursor = Math.max(0, ...batch.map(item => Number.isSafeInteger(item.sequence) ? item.sequence : 0));
          status.dataset.state = 'connecting';
          status.textContent = `Connected to Quantower · waiting for live trades on ${ticker}…`;
          return;
        }
        const cursorAtStart = cursor;
        const fresh = batch.filter(item => Number.isSafeInteger(item.sequence) && item.sequence > cursorAtStart && !seen.has(item.sequence));
        if (fresh.length) {
          cursor = Math.max(cursorAtStart, ...fresh.map(item => item.sequence));
          for (const item of fresh) seen.add(item.sequence);
          while (seen.size > 5_000) seen.delete(seen.values().next().value!);
          const parsed = fresh.map(item => ({
            time: Number(item.time) || Date.now(),
            price: Number(item.price),
            quantity: Number(item.volume),
            side: item.side,
            key: String(item.sequence),
          })).filter(item => Number.isFinite(item.price) && item.price > 0 && Number.isFinite(item.quantity) && item.quantity > 0);
          if (isTimeSales) {
            appendQuantowerTrades(trades, parsed);
            renderTrades(tableBody, trades);
          } else showTrades(parsed);
          receivedLiveTrade = true;
        }
        status.dataset.state = receivedLiveTrade ? 'live' : 'connecting';
        status.textContent = receivedLiveTrade
          ? `Live Quantower trades · ${ticker}`
          : `Connected to Quantower · waiting for live trades on ${ticker}…`;
      } catch (error) {
        if (request !== generation || chart !== activeChart || !open) return;
        status.dataset.state = 'error';
        status.textContent = `Quantower trades unavailable for ${ticker}: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (request === generation && chart === activeChart && open && status.dataset.state !== 'error') pollTimer = window.setTimeout(() => { void pollTrades(); }, 50);
      }
    };
    void pollTrades();
  };

  const connect = async () => {
    const request = ++generation;
    stopPolling();
    tableBody.replaceChildren();
    trades.length = 0;
    tickFlow.clear();
    previousFlowPrice.value = 0;
    previousFlowPrice.direction = 0;
    tickTotals.replaceChildren();
    if (!open || !chart) return;

    const activeChart = chart;
    const chartSymbol = activeChart.market.symbol?.trim();
    if (!chartSymbol) {
      status.dataset.state = 'error';
      status.textContent = 'Select a chart symbol to load live market data.';
      return;
    }
    let resolved = activeChart.data.resolve(chartSymbol);
    if (!resolved) {
      status.dataset.state = 'connecting';
      status.textContent = `Resolving the active feed for ${chartSymbol}…`;
      try {
        await activeChart.data.ready();
      } catch (error) {
        if (request !== generation) return;
        status.dataset.state = 'error';
        status.textContent = `Could not resolve the active data feed: ${error instanceof Error ? error.message : String(error)}`;
        return;
      }
      if (request !== generation || chart !== activeChart || !open) return;
      resolved = activeChart.data.resolve(chartSymbol);
    }
    activePipSize = null;
    if (!isTimeSales && volumeMode === 'tick-pips') {
      status.dataset.state = 'connecting';
      status.textContent = `Reading ${chartSymbol} pip size from the active feed…`;
      activePipSize = await resolveChartPipSize(activeChart, chartSymbol);
      if (request !== generation || chart !== activeChart || !open) return;
      if (!activePipSize) {
        status.dataset.state = 'error';
        status.textContent = `The active feed did not provide a pip or minimum price increment for ${chartSymbol}; tick volume in pips is unavailable.`;
        return;
      }
    }
    const mt5Ticker = mt5SymbolForChart(activeChart);
    if (mt5Ticker) {
      streamMt5(mt5Ticker, activeChart, request);
      return;
    }
    const quantowerTicker = quantowerSymbolForChart(activeChart);
    if (quantowerTicker) {
      streamQuantower(quantowerTicker, activeChart, request);
      return;
    }
    status.dataset.state = 'warning';
    status.textContent = 'No active datafeed available.';
  };

  const refreshForFeedChange = () => { if (open) void connect(); };
  document.addEventListener('omega:trading-broker-connecting', refreshForFeedChange);
  document.addEventListener('omega:trading-broker-connected', refreshForFeedChange);
  document.addEventListener('omega:trading-broker-disconnected', refreshForFeedChange);
  document.addEventListener('omega:trading-broker-exclusive', refreshForFeedChange);
  document.addEventListener('omega:trading-account-selected', refreshForFeedChange);

  const bindChart = (nextChart: Vela) => {
    unsubscribeMarket?.();
    unsubscribeBar?.();
    chart = nextChart;
    activeCandleTime = null;
    unsubscribeMarket = nextChart.on('market:changed', () => {
      activeCandleTime = null;
      void connect();
    });
    unsubscribeBar = nextChart.on('bar', bar => resetTickFlowForCandle(bar));
    void connect();
  };

  installPanelStyles();
  const panelRoot = body.parentElement;
  if (panelRoot) {
    visibilityObserver = new MutationObserver(() => {
      if (panelRoot.hidden) {
        open = false;
        generation += 1;
        stopPolling();
        clearPanelData();
      } else if (!open) {
        open = true;
        void connect();
      }
    });
    visibilityObserver.observe(panelRoot, { attributes: true, attributeFilter: ['hidden'] });
  }
  body.replaceChildren(root);
  applyMarketFlowStyle(view);
  return {
    onChart: bindChart,
    onOpen() {
      open = true;
      clearPanelData();
      void connect();
    },
    destroy() {
      open = false;
      generation += 1;
      stopPolling();
      unsubscribeMarket?.();
      unsubscribeBar?.();
      visibilityObserver?.disconnect();
      document.removeEventListener('omega:trading-broker-connecting', refreshForFeedChange);
      document.removeEventListener('omega:trading-broker-connected', refreshForFeedChange);
      document.removeEventListener('omega:trading-broker-disconnected', refreshForFeedChange);
      document.removeEventListener('omega:trading-broker-exclusive', refreshForFeedChange);
      document.removeEventListener('omega:trading-account-selected', refreshForFeedChange);
      root.remove();
    },
  };
}

function registerMarketFlowPanel(id: MarketFlowView, title: string, icon: string, view: MarketFlowView): void {
  registerSidePanel({
    id: `omega-${id}`,
    title,
    icon,
    order: id === 'time-sales' ? 11 : 12,
    width: 340,
    resizable: true,
    minWidth: 260,
    maxWidth: 520,
    mount(_context, body) {
      return createMarketFlowPanel(view, body);
    },
  });
}

registerIcon(
  'omega-time-sales',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5h16M4 10h10M4 15h16M4 20h10"/><path d="m17 8 3 2-3 2M7 13l-3 2 3 2"/></svg>',
);
registerIcon(
  'omega-dom',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v6H4zM4 14h16v6H4z"/><path d="M7 7h5M7 17h9"/></svg>',
);
registerMarketFlowPanel('time-sales', 'Time & Sales', 'omega-time-sales', 'time-sales');
registerMarketFlowPanel('dom', 'Depth of Market', 'omega-dom', 'dom');
