import type { OHLCV, SymbolInfo, VelaWorkspace } from './platform';
import { timeframeToMs } from './platform/index.ts';
import type { BarRange, MarketQuote, SymbolDescriptor } from './platform/marketData';
import { reportCaughtError } from './diagnostics.ts';
import { desktopHistory } from './marketDataProcess.ts';

interface QuantowerSymbol { ticker: string; description: string; path?: string; type?: string; digits?: number; point?: number; currency?: string; }
interface QuantowerAccount { id: string; label: string; connectionId: string; connection: string; }
interface QuantowerBridge {
  start(): Promise<{ started: boolean; alreadyRunning?: boolean; executable?: string }>;
  health(): Promise<{ connected: boolean; symbols: number }>;
  symbols(): Promise<QuantowerSymbol[]>;
  accounts(): Promise<QuantowerAccount[]>;
  placeOrder(request: { accountId: string; symbol: string; side: 'BUY' | 'SELL'; quantity: number }): Promise<{ status: string; orderId?: string; positionId?: string; requestId?: number; message?: string }>;
  closePosition(request: { accountId: string; positionId: string; quantity: number }): Promise<{ status: string; positionId?: string; requestId?: number; message?: string }>;
  bars(request: { symbol: string; timeframe: string; limit: number }): Promise<OHLCV[]>;
  quote(symbol: string): Promise<{ ticker: string; bid: number; ask: number; last: number; volume?: number; time: string }>;
  trades(request: { symbol: string; after?: number; limit?: number }): Promise<Array<{ sequence: number; time: number; price: number; volume: number; side: 'BUY' | 'SELL' | 'FLAT' }>>;
  marketBook(symbol: string): Promise<Array<{ side: string; price: number; volume: number }>>;
}
declare global { interface Window { velaQuantower?: QuantowerBridge; } }

export class QuantowerDataProvider {
  private connected = false;
  private descriptors: SymbolDescriptor[] = [];
  private symbolInfoByTicker = new Map<string, QuantowerSymbol>();
  private readonly bridge: QuantowerBridge;
  constructor(bridge: QuantowerBridge) { this.bridge = bridge; }
  info() { return { name: 'quantower', displayName: 'Quantower (local)', capabilities: { enumerate: true, stream: true, symbolInfo: true } }; }
  setSymbols(symbols: QuantowerSymbol[]) {
    this.symbolInfoByTicker = new Map(symbols.map(symbol => [symbol.ticker.toLowerCase(), symbol]));
    this.descriptors = symbols.map(symbol => ({ ticker: symbol.ticker, description: symbol.description || symbol.ticker, type: symbol.type || 'market', group: quantowerSymbolGroup(symbol), prefix: 'Quantower' }));
    this.connected = this.descriptors.length > 0;
  }
  disconnect() { this.connected = false; this.descriptors = []; this.symbolInfoByTicker.clear(); }
  async listSymbols() { return this.descriptors; }
  async getQuote(ticker: string): Promise<MarketQuote> {
    if (!this.connected) throw new Error('Quantower feed is disconnected.');
    const symbol = ticker.replace(/^QUANTOWER:/i, '');
    const quote = await this.bridge.quote(symbol);
    if (quote.ticker.toLowerCase() !== symbol.toLowerCase()
      || !Number.isFinite(quote.bid) || !Number.isFinite(quote.ask)
      || quote.bid === 0 || quote.ask === 0 || quote.ask < quote.bid) {
      throw new Error(`Quantower returned an invalid or mismatched quote for ${symbol}.`);
    }
    const timeMsc = Date.parse(quote.time);
    if (!Number.isFinite(timeMsc) || timeMsc <= 0) throw new Error(`Quantower returned an invalid quote timestamp for ${symbol}.`);
    return { bid: quote.bid, ask: quote.ask, timeMsc };
  }
  async getBars(ticker: string, timeframe: string, range: BarRange) {
    if (!this.connected) throw new Error('Quantower feed is disconnected.');
    const history = desktopHistory();
    if (history) return (await history.load({ provider: 'quantower', ticker, timeframe, range })).bars;
    const symbol = ticker.replace(/^QUANTOWER:/i, '');
    const limit = Math.max(1, Math.min(5000, Math.floor(range.limit ?? 500)));
    // The bridge only exposes a tail, so ask for its full window when paging backward.
    const nativeLimit = range.to === undefined ? limit : 5000;
    let bars = await this.bridge.bars({ symbol, timeframe, limit: nativeLimit });
    // The bridge derives its lookback from the count. A narrow window can return nothing
    // across a session gap even when a wider request has usable intraday history.
    if (bars.length < Math.min(2, limit) && nativeLimit < 5000) {
      const wider = await this.bridge.bars({ symbol, timeframe, limit: Math.min(5000, Math.max(1000, nativeLimit * 2)) });
      const byTime = new Map(bars.map(bar => [bar.time, bar]));
      for (const bar of wider) byTime.set(bar.time, bar);
      bars = [...byTime.values()].sort((left, right) => left.time - right.time);
    }
    return bars.filter(bar => (range.from === undefined || bar.time >= range.from)
      && (range.to === undefined || bar.time <= range.to)).slice(-limit);
  }
  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    const symbol = this.symbolInfoByTicker.get(ticker.toLowerCase());
    if (!symbol) return undefined;
    return { ticker: symbol.ticker, name: symbol.ticker, description: symbol.description, exchange: symbol.path, digits: symbol.digits, minTick: symbol.point };
  }
  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor: number | null = null;
    let currentBar: OHLCV | undefined;
    const interval = Math.max(1, timeframeToMs(timeframe));
    const poll = async () => {
      if (stopped) return;
      try {
        const symbol = ticker.replace(/^QUANTOWER:/i, '');
        if (cursor === null) {
          const bars = await this.getBars(ticker, timeframe, { limit: 1 });
          if (stopped) return;
          currentBar = bars.at(-1) ? { ...bars.at(-1)! } : undefined;
          const latest = await this.bridge.trades({ symbol, after: 0, limit: 1 });
          if (stopped) return;
          cursor = Math.max(0, ...latest.map(trade => Number.isSafeInteger(trade.sequence) ? trade.sequence : 0));
          return;
        }

        const batch = await this.bridge.trades({ symbol, after: cursor, limit: 1_000 });
        if (stopped) return;
        const fresh = batch
          .filter(trade => Number.isSafeInteger(trade.sequence) && trade.sequence > cursor!)
          .sort((left, right) => left.sequence - right.sequence);
        for (const trade of fresh) {
          cursor = Math.max(cursor, trade.sequence);
          const time = Number(trade.time);
          const price = Number(trade.price);
          if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(price) || price <= 0) continue;
          const barTime = Math.floor(time / interval) * interval;
          if (currentBar && barTime < currentBar.time) continue;
          if (!currentBar || barTime > currentBar.time) {
            currentBar = { time: barTime, open: price, high: price, low: price, close: price, volume: Math.max(0, Number(trade.volume) || 0) };
          } else {
            currentBar.high = Math.max(currentBar.high, price);
            currentBar.low = Math.min(currentBar.low, price);
            currentBar.close = price;
            currentBar.volume = (currentBar.volume ?? 0) + Math.max(0, Number(trade.volume) || 0);
          }
          onBar({ ...currentBar });
        }
      } catch (error) {
        reportCaughtError('quantower:tick-stream', error, `Live trade polling failed for ${ticker}.`);
      }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 250); }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }
}

function quantowerSymbolGroup(symbol: QuantowerSymbol): string {
  const text = `${symbol.path ?? ''} ${symbol.type ?? ''} ${symbol.description ?? ''} ${symbol.ticker}`.toUpperCase();
  if (/\b(EUREX|XEUR)\b/.test(text) && /\b(FUTURE|FUTURES)\b/.test(text)) return 'Eurex Futures';
  if (/\b(CME|CBOT|COMEX|NYMEX|XCME|XCBT|XCEC|XNYM)\b/.test(text) && /\b(FUTURE|FUTURES)\b/.test(text)) return 'US Futures';
  if (/\b(FOREX|FX|CURRENC|EURUSD|GBPUSD|USDJPY)\b/.test(text)) return 'Forex';
  if (/\b(CRYPTO|BTC|ETH|SOL|XRP|USDT|USDC)\b/.test(text)) return 'Crypto';
  if (/\b(INDEX|INDICES|US30|NAS100|USTEC|SPX|SP500|GER40|DE40|UK100|JP225|AUS200|FRA40)\b/.test(text)) return 'Indices';
  if (/\b(FUTURE|FUTURES)\b/.test(text)) return 'Futures';
  if (/\b(STOCK|EQUITY|ETF|NYSE|NASDAQ|AMEX)\b/.test(text)) return 'Stocks';
  return 'Other';
}

export function initializeQuantowerFeed(getWorkspace: () => VelaWorkspace): QuantowerDataProvider | null {
  const bridge = window.velaQuantower;
  if (!bridge) return null;
  const provider = new QuantowerDataProvider(bridge);
  const workspace = getWorkspace();
  const watchers = new Map<string, { refresh(): void; dispose(): void }>();
  const register = (cellId: string) => {
    const chart = workspace.cell(cellId)?.chart;
    if (!chart) return;
    chart.data.registerProvider('quantower', provider);
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      const { symbol, timeframe, offline } = chart.market;
      if (offline || !symbol?.toLowerCase().startsWith('quantower:') || !timeframe || chart.replay.bounds) return;
      const isCurrent = () => request === revision && workspace.cell(cellId)?.chart === chart
        && chart.market.symbol === symbol && chart.market.timeframe === timeframe;
      void findQuantowerFallback(provider, symbol, timeframe, isCurrent).then(async fallback => {
        if (!fallback || !isCurrent() || chart.replay.bounds) return;
        await chart.setMarket({ timeframe: fallback });
        if (workspace.cell(cellId)?.chart === chart && chart.market.symbol === symbol && chart.market.timeframe === fallback) {
          workspace.toast(`Quantower has no ${timeframe} history for ${symbol.slice('quantower:'.length)}. Switched to ${fallback === 'D' ? 'daily' : fallback + ' minutes'}.`);
        }
      }).catch(error => {
        if (isCurrent()) reportCaughtError('quantower:chart-history', error, `Could not check chart history for ${symbol}.`);
      });
    };
    const off = chart.on('market:changed', refresh);
    watchers.set(cellId, { refresh, dispose: () => { revision += 1; off(); } });
  };
  for (const cell of workspace.cells()) register(cell.id);
  workspace.on('cell:created', event => register(event.id));
  workspace.on('cell:destroyed', event => {
    watchers.get(event.id)?.dispose();
    watchers.delete(event.id);
  });
  document.addEventListener('omega:trading-broker-connected', event => {
    if ((event as CustomEvent<string>).detail === 'quantower') for (const watcher of watchers.values()) watcher.refresh();
  });
  document.addEventListener('omega:trading-broker-connecting', event => { if ((event as CustomEvent<string>).detail !== 'quantower') { provider.disconnect(); for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('quantower'); } });
  return provider;
}

export async function findQuantowerFallback(
  provider: Pick<QuantowerDataProvider, 'getBars'>,
  symbol: string,
  timeframe: string,
  isCurrent: () => boolean,
): Promise<string | undefined> {
  for (const period of new Set([timeframe, '5', 'D'])) {
    if (!isCurrent()) return;
    // A meaningful lookback is needed even though we only need to confirm data exists.
    try {
      const bars = await provider.getBars(symbol, period, { limit: 500 });
      if (bars.length > 0) return period === timeframe ? undefined : period;
    } catch (error) {
      if (!/unsupported timeframe/i.test(error instanceof Error ? error.message : String(error))) throw error;
    }
  }
}
