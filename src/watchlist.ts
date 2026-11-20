import type { DataProvider, OHLCV, SymbolDescriptor, VelaWorkspace } from './platform/index.ts';
import type { MarketQuote } from './platform/marketData.ts';
import { reportCaughtError } from './diagnostics.ts';

const STORAGE_KEY = 'omega.watchlist.custom-symbols.v1';
const MAX_WATCHLIST_SYMBOLS = 100;
export const DEFAULT_MARKET_SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD', 'US500', 'NAS100',
  'BTCUSD', 'ETHUSD', 'BTCUSDT', 'ETHUSDT', 'BTC-USD', 'ETH-USD',
];
const QUOTE_MAX_AGE_MS = 30_000;

export function parseWatchlistSymbols(raw: string | null): string[] {
  if (raw === null) return [];
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error('Saved watchlist data is not valid JSON.'); }
  if (!Array.isArray(value) || value.length > MAX_WATCHLIST_SYMBOLS
    || value.some(item => typeof item !== 'string' || !item.trim() || item.length > 200)) {
    throw new Error('Saved watchlist data has an invalid shape.');
  }
  return [...new Set(value.map(item => item.trim()))];
}

export function dailyMovePercent(bar: Pick<OHLCV, 'open' | 'close'> | undefined): number | null {
  if (!bar || !Number.isFinite(bar.open) || bar.open <= 0 || !Number.isFinite(bar.close) || bar.close <= 0) return null;
  return ((bar.close - bar.open) / bar.open) * 100;
}

export function quoteSpread(quote: MarketQuote | null, now = Date.now()): number | null {
  if (!quote || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) return null;
  if (quote.timeMsc !== undefined
    && (!Number.isFinite(quote.timeMsc) || quote.timeMsc <= 0 || Math.abs(now - quote.timeMsc) > QUOTE_MAX_AGE_MS)) return null;
  return quote.ask - quote.bid;
}

function symbolTarget(chart: VelaWorkspace['chart'], symbol: SymbolDescriptor): string {
  const owner = symbol.provider ?? symbol.prefix;
  const candidate = owner ? `${owner}:${symbol.ticker}` : symbol.ticker;
  return chart.data.canonicalSymbol(candidate) ?? chart.data.canonicalSymbol(symbol.ticker) ?? candidate;
}

function activeCell(workspace: VelaWorkspace) {
  return workspace.active ?? workspace.cells()[0];
}

function formatSpread(value: number | null, digits: number | undefined): string {
  if (value === null) return '—';
  return value.toFixed(Math.max(0, Math.min(10, digits ?? 5)));
}

interface WatchlistDataProvider extends DataProvider {
  getQuote?(ticker: string): Promise<MarketQuote>;
}

export function initializeWatchlist(workspace: VelaWorkspace): () => void {
  const panel = document.getElementById('watchlist-panel') as HTMLElement | null;
  const toggle = document.getElementById('watchlist-toggle') as HTMLButtonElement | null;
  const close = document.getElementById('watchlist-close') as HTMLButtonElement | null;
  const addToggle = document.getElementById('watchlist-add-toggle') as HTMLButtonElement | null;
  const addForm = document.getElementById('watchlist-add-form') as HTMLElement | null;
  const search = document.getElementById('watchlist-search') as HTMLInputElement | null;
  const searchResults = document.getElementById('watchlist-search-results') as HTMLElement | null;
  const list = document.getElementById('watchlist-list') as HTMLElement | null;
  const status = document.getElementById('watchlist-status') as HTMLElement | null;
  if (!panel || !toggle || !close || !addToggle || !addForm || !search || !searchResults || !list || !status) return () => {};

  let customSymbols: string[] = [];
  try { customSymbols = parseWatchlistSymbols(localStorage.getItem(STORAGE_KEY)); }
  catch (error) {
    reportCaughtError('watchlist:load', error, 'The saved watchlist could not be loaded. Its stored data was left unchanged.');
    status.textContent = 'Saved watchlist data could not be read; it was preserved.';
  }
  let renderRevision = 0;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  const supportedSymbols = (chart: VelaWorkspace['chart']): SymbolDescriptor[] => chart.data.symbols();
  const getDefaults = (chart: VelaWorkspace['chart'], symbols: SymbolDescriptor[]): string[] => {
    const byTicker = new Map(symbols.map(item => [item.ticker.toUpperCase(), item]));
    const preferred = DEFAULT_MARKET_SYMBOLS.flatMap(ticker => {
      const item = byTicker.get(ticker);
      return item ? [symbolTarget(chart, item)] : [];
    });
    if (preferred.length) return preferred;
    return symbols.slice(0, 8).map(item => symbolTarget(chart, item));
  };

  const renderSearchResults = (chart: VelaWorkspace['chart'], symbols: SymbolDescriptor[]): void => {
    searchResults.replaceChildren();
    const query = search.value.trim().toUpperCase();
    if (!query) return;
    const alreadyAdded = new Set([...customSymbols, ...getDefaults(chart, symbols)].map(item => item.toLowerCase()));
    const matches = symbols
      .filter(item => item.ticker.toUpperCase().includes(query)
        || item.description?.toUpperCase().includes(query)
        || item.group?.toUpperCase().includes(query))
      .slice(0, 20);
    for (const item of matches) {
      const target = symbolTarget(chart, item);
      if (alreadyAdded.has(target.toLowerCase())) continue;
      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'watchlist-search-result';
      result.textContent = `${item.ticker} · ${item.description ?? item.group ?? item.provider ?? ''}`;
      result.addEventListener('click', () => {
        if (customSymbols.length >= MAX_WATCHLIST_SYMBOLS) {
          status.textContent = `A custom watchlist can contain up to ${MAX_WATCHLIST_SYMBOLS} symbols.`;
          return;
        }
        customSymbols = [...customSymbols, target];
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(customSymbols));
          search.value = '';
          searchResults.replaceChildren();
          render();
        } catch (error) {
          customSymbols = customSymbols.filter(symbol => symbol.toLowerCase() !== target.toLowerCase());
          reportCaughtError('watchlist:save', error, 'Could not save this symbol to the watchlist.');
          status.textContent = 'Could not save the symbol. Check local storage availability.';
        }
      });
      searchResults.append(result);
    }
    if (!searchResults.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'watchlist-empty';
      empty.textContent = matches.length ? 'These symbols are already in your watchlist.' : 'No supported symbols match this search.';
      searchResults.append(empty);
    }
  };

  const render = (): void => {
    const revision = ++renderRevision;
    const cell = activeCell(workspace);
    list.replaceChildren();
    if (!cell) {
      status.textContent = 'Open a connected data feed to populate the watchlist.';
      return;
    }
    const symbols = supportedSymbols(cell.chart);
    renderSearchResults(cell.chart, symbols);
    if (!symbols.length) {
      status.textContent = 'No symbols are available. Connect a data feed, then reopen or refresh the watchlist.';
      return;
    }

    const availableByTarget = new Map(symbols.map(item => [symbolTarget(cell.chart, item).toLowerCase(), item]));
    const defaults = getDefaults(cell.chart, symbols);
    const targets = [...new Set([...defaults, ...customSymbols])];
    const rows = targets.flatMap(target => {
      const item = availableByTarget.get(target.toLowerCase());
      return item ? [{ target, item }] : [];
    });
    const unavailableCount = targets.length - rows.length;
    status.textContent = unavailableCount
      ? `${rows.length} symbols on this feed · ${unavailableCount} saved symbol${unavailableCount === 1 ? '' : 's'} unavailable on the active feed.`
      : `${rows.length} symbols supported by the active feed.`;
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'watchlist-empty';
      empty.textContent = 'No common market symbols are available on this feed yet. Add a supported symbol to build your watchlist.';
      list.append(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'watchlist-table';
    table.innerHTML = '<thead><tr><th>Symbol</th><th title="Current ask minus bid">Spread</th><th title="Latest daily bar close versus its open">Day %</th><th></th></tr></thead>';
    const body = document.createElement('tbody');
    const rowMetrics: Array<{ target: string; row: HTMLTableRowElement; item: SymbolDescriptor }> = [];
    for (const { target, item } of rows) {
      const row = document.createElement('tr');
      row.dataset.symbol = target;
      const nameCell = document.createElement('td');
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'watchlist-symbol';
      select.textContent = item.ticker;
      select.title = `Show ${item.description ?? item.ticker} on the active chart`;
      select.addEventListener('click', () => {
        const selectedCell = activeCell(workspace);
        if (!selectedCell) return;
        workspace.setActiveCell(selectedCell.id);
        void selectedCell.chart.setMarket({ symbol: target }).catch(error => {
          reportCaughtError('watchlist:select-symbol', error, `Could not open ${target} on the chart.`);
          status.textContent = `Could not open ${item.ticker} on the chart.`;
        });
      });
      nameCell.append(select);
      const spread = document.createElement('td');
      spread.className = 'watchlist-spread';
      spread.textContent = '—';
      const day = document.createElement('td');
      day.className = 'watchlist-day';
      day.textContent = '—';
      const actionCell = document.createElement('td');
      if (customSymbols.some(saved => saved.toLowerCase() === target.toLowerCase())) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'watchlist-remove';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${item.ticker} from watchlist`);
        remove.addEventListener('click', () => {
          const previous = customSymbols;
          customSymbols = customSymbols.filter(saved => saved.toLowerCase() !== target.toLowerCase());
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(customSymbols));
            render();
          } catch (error) {
            customSymbols = previous;
            reportCaughtError('watchlist:save', error, 'Could not remove the symbol from the watchlist.');
            status.textContent = 'Could not update the watchlist.';
          }
        });
        actionCell.append(remove);
      }
      row.append(nameCell, spread, day, actionCell);
      body.append(row);
      rowMetrics.push({ target, row, item });
    }
    table.append(body);
    list.append(table);

    void (async () => {
      for (let index = 0; index < rowMetrics.length; index += 4) {
        const batch = rowMetrics.slice(index, index + 4);
        await Promise.all(batch.map(async ({ target, row }) => {
          const resolved = cell.chart.data.resolve(target);
          if (!resolved) return;
          const provider = cell.chart.data.providerInstance(resolved.provider) as WatchlistDataProvider | undefined;
          if (!provider) return;
          const quotePromise = provider.getQuote?.(resolved.ticker).catch(error => {
            reportCaughtError('watchlist:quote', error, `Could not load a quote for ${target}.`);
            return null;
          }) ?? Promise.resolve(null);
          const barsPromise = provider.getBars(resolved.ticker, 'D', { limit: 1 }).catch(error => {
            reportCaughtError('watchlist:daily-bars', error, `Could not load daily movement for ${target}.`);
            return [];
          });
          const [quote, bars] = await Promise.all([quotePromise, barsPromise]);
          if (revision !== renderRevision || !row.isConnected) return;
          const spread = quoteSpread(quote);
          const info = await cell.chart.data.symbolInfo(target).catch(error => {
            reportCaughtError('watchlist:symbol-info', error, `Could not load price precision for ${target}.`);
            return undefined;
          });
          if (revision !== renderRevision || !row.isConnected) return;
          const spreadCell = row.querySelector('.watchlist-spread');
          const dayCell = row.querySelector('.watchlist-day');
          if (spreadCell) {
            const digits = typeof info?.digits === 'number' ? info.digits : undefined;
            spreadCell.textContent = formatSpread(spread, digits);
            spreadCell.setAttribute('title', quote?.timeMsc === undefined && quote
              ? 'Spread from the provider quote; the source does not include a quote timestamp.'
              : spread === null ? 'A valid, fresh bid/ask quote is not available.' : 'Current ask minus bid.');
          }
          const movement = dailyMovePercent(bars.at(-1));
          if (dayCell) {
            dayCell.textContent = movement === null ? '—' : `${movement >= 0 ? '+' : ''}${movement.toFixed(2)}%`;
            dayCell.classList.toggle('positive', movement !== null && movement >= 0);
            dayCell.classList.toggle('negative', movement !== null && movement < 0);
          }
        }));
      }
    })();
  };

  const stopMetricRefresh = (): void => {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = undefined;
  };
  const open = (): void => {
    panel.hidden = false;
    panel.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-expanded', 'true');
    document.getElementById('chart-stage')?.classList.add('watchlist-open');
    toggle.classList.add('active');
    render();
    stopMetricRefresh();
    refreshTimer = setInterval(() => { if (!panel.hidden) render(); }, 15_000);
  };
  const hide = (): void => {
    panel.hidden = true;
    panel.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    document.getElementById('chart-stage')?.classList.remove('watchlist-open');
    toggle.classList.remove('active');
    stopMetricRefresh();
  };
  const activeCellUnsubscribe = workspace.on('cell:active', () => { if (!panel.hidden) render(); });
  const feedChange = (): void => { if (!panel.hidden) render(); };
  const onToggle = (): void => { panel.hidden ? open() : hide(); };
  const onAddToggle = (): void => {
    addForm.hidden = !addForm.hidden;
    if (!addForm.hidden) search.focus();
    else { search.value = ''; searchResults.replaceChildren(); }
  };
  const onSearchInput = (): void => {
    const cell = activeCell(workspace);
    if (cell) renderSearchResults(cell.chart, supportedSymbols(cell.chart));
  };
  document.addEventListener('omega:trading-broker-connected', feedChange);
  document.addEventListener('omega:trading-broker-disconnected', feedChange);
  addToggle.addEventListener('click', onAddToggle);
  search.addEventListener('input', onSearchInput);
  toggle.addEventListener('click', onToggle);
  close.addEventListener('click', hide);

  const stage = document.getElementById('chart-stage');
  if (stage) stage.insertBefore(panel, stage.firstChild);
  return () => {
    stopMetricRefresh();
    activeCellUnsubscribe();
    document.removeEventListener('omega:trading-broker-connected', feedChange);
    document.removeEventListener('omega:trading-broker-disconnected', feedChange);
    toggle.removeEventListener('click', onToggle);
    close.removeEventListener('click', hide);
    addToggle.removeEventListener('click', onAddToggle);
    search.removeEventListener('input', onSearchInput);
  };
}
