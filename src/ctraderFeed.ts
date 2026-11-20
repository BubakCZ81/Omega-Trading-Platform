import type { OHLCV, SymbolInfo, VelaWorkspace } from './platform/index.ts';
import type { BarRange, MarketDataProvider, MarketQuote, SymbolDescriptor } from './platform/marketData.ts';
import { reportCaughtError } from './diagnostics.ts';
import { desktopHistory, nextHistoryConnection } from './marketDataProcess.ts';
import {
  averageTrueRange,
  isAtrRenkoTimeframe,
  renkoPipsForTimeframe,
  rangePipsForTimeframe,
  resolveInstrumentPipSize,
  buildRenkoBars,
  buildRangeBars,
} from './renkoRangeBars.ts';

export type CTraderMarketDataTool = 'get_symbols' | 'get_symbol_details' | 'get_spot_prices' | 'get_trendbars';
export interface CTraderToolSummary { name: string; description: string; inputSchema: Record<string, unknown>; }
export interface CTraderMcpStatus { connected: boolean; endpoint: string; server: { name: string; version: string } | null; tools: CTraderToolSummary[]; }
export interface CTraderOrderRequest { symbolName: string; side: 'buy' | 'sell'; volume: number; volumeType: 'lots'; stopLossPips?: number; takeProfitPips?: number; }
export interface CTraderMcpBridge {
  connect(): Promise<CTraderMcpStatus>;
  status(): Promise<CTraderMcpStatus>;
  marketData(toolName: CTraderMarketDataTool, argumentsObject: Record<string, unknown>): Promise<unknown>;
  placeMarketOrder(request: CTraderOrderRequest): Promise<unknown>;
  disconnect(): Promise<boolean>;
}

export interface CTraderSymbolDetails { symbolName: string; digits: number; pipSize: number; lotSize: number; minVolume: number; maxVolume: number; volumeStep: number; }
export interface CTraderSpot { symbolName?: string; bid: number; ask: number; }
interface ChartTimeframe { intervalMs: number; sourceTimeframe: string; }

const directTimeframes = [
  { key: 'm1', intervalMs: 60_000, aliases: ['1', '1m', 'm1', '1min'] },
  { key: 'm5', intervalMs: 5 * 60_000, aliases: ['5', '5m', 'm5', '5min'] },
  { key: 'm15', intervalMs: 15 * 60_000, aliases: ['15', '15m', 'm15', '15min'] },
  { key: 'm30', intervalMs: 30 * 60_000, aliases: ['30', '30m', 'm30', '30min'] },
  { key: 'h1', intervalMs: 60 * 60_000, aliases: ['60', '1h', 'h1', '60m'] },
  { key: 'h4', intervalMs: 4 * 60 * 60_000, aliases: ['240', '4h', 'h4', '240m'] },
  { key: 'd1', intervalMs: 24 * 60 * 60_000, aliases: ['d', '1d', 'd1', 'day', '1day'] },
  { key: 'w1', intervalMs: 7 * 24 * 60 * 60_000, aliases: ['w', '1w', 'w1', 'week', '1week'] },
  { key: 'month1', intervalMs: 31 * 24 * 60 * 60_000, aliases: ['month1'] },
];
const MAX_TRENDBARS = 1_000;
const MAX_CHART_BARS = 1_000;
const POLL_INTERVAL_MS = 1_000;
const DETAIL_CACHE_MS = 30_000;

declare global { interface Window { velaCtrader?: CTraderMcpBridge; } }

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function finiteNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' && typeof value !== 'string') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}
function normalizeSymbol(value: string): string { return value.replace(/^ctrader:/i, '').trim(); }

function resolveChartTimeframe(value: string): ChartTimeframe {
  const text = value.trim();
  if (['M', '1M', 'month1', '1month'].includes(text) || ['month1', '1month'].includes(text.toLowerCase())) {
    return { intervalMs: 31 * 24 * 60 * 60_000, sourceTimeframe: 'month1' };
  }
  const normalized = text.toLowerCase();
  const direct = directTimeframes.find(item => item.aliases.includes(normalized));
  if (direct) return { intervalMs: direct.intervalMs, sourceTimeframe: direct.key };
  const duration = normalized.match(/^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/);
  const numericMinutes = normalized.match(/^\d+$/);
  let intervalMs: number;
  if (numericMinutes) intervalMs = Number(normalized) * 60_000;
  else if (duration) {
    const count = Number(duration[1]);
    const unit = duration[2];
    intervalMs = count * (unit.startsWith('m') ? 60_000 : unit.startsWith('h') ? 60 * 60_000 : 24 * 60 * 60_000);
  } else throw new Error(`cTrader cannot map chart timeframe "${value}" to supported trend bars.`);
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 60_000) throw new Error(`cTrader cannot map chart timeframe "${value}" to supported trend bars.`);
  const source = directTimeframes.filter(item => item.intervalMs <= intervalMs && intervalMs % item.intervalMs === 0).at(-1);
  if (!source) throw new Error(`cTrader cannot aggregate chart timeframe "${value}" from supported trend bars.`);
  return { intervalMs, sourceTimeframe: source.key };
}

function timestampMilliseconds(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 100_000_000_000 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric < 100_000_000_000 ? numeric * 1000 : numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseCTraderSymbols(value: unknown): SymbolDescriptor[] {
  const symbols = isRecord(value) && Array.isArray(value.symbols) ? value.symbols : null;
  if (!symbols) throw new Error('cTrader get_symbols returned an invalid symbol list.');
  return symbols.flatMap(item => {
    if (!isRecord(item) || typeof item.name !== 'string' || !item.name.trim()) return [];
    return [{ ticker: item.name.trim(), description: typeof item.description === 'string' && item.description.trim() ? item.description.trim() : item.name.trim(),
      type: typeof item.assetClass === 'string' ? item.assetClass : 'market',
      group: typeof item.category === 'string' && item.category.trim() ? item.category.trim() : 'cTrader', prefix: 'cTrader', provider: 'ctrader' }];
  });
}

export function parseCTraderBars(value: unknown): OHLCV[] {
  const items = isRecord(value) && Array.isArray(value.bars) ? value.bars : null;
  if (!items) throw new Error('cTrader get_trendbars returned an invalid bar list.');
  return items.flatMap(item => {
    if (!isRecord(item)) return [];
    const time = timestampMilliseconds(item.timestamp ?? item.time);
    const open = finiteNumber(item.open); const high = finiteNumber(item.high);
    const low = finiteNumber(item.low); const close = finiteNumber(item.close); const volume = finiteNumber(item.volume);
    if (time === undefined || open === undefined || high === undefined || low === undefined || close === undefined
      || time <= 0 || open <= 0 || high <= 0 || low <= 0 || close <= 0 || high < low) return [];
    return [{ time, open, high, low, close, ...(volume === undefined ? {} : { volume: Math.max(0, volume) }) }];
  }).sort((left, right) => left.time - right.time);
}

export function parseCTraderSpot(value: unknown): CTraderSpot {
  if (!isRecord(value)) throw new Error('cTrader get_spot_prices returned an invalid quote.');
  const bid = finiteNumber(value.bid); const ask = finiteNumber(value.ask);
  if (bid === undefined || ask === undefined || bid === 0 || ask === 0 || ask < bid) throw new Error('cTrader get_spot_prices returned an invalid bid/ask quote.');
  return { symbolName: typeof value.symbolName === 'string' ? value.symbolName : undefined, bid, ask };
}

export async function fetchCTraderSpot(
  bridge: Pick<CTraderMcpBridge, 'marketData'>,
  symbolName: string,
): Promise<CTraderSpot> {
  let response: unknown;
  try {
    response = await bridge.marketData('get_spot_prices', { symbolName });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no live quote|unsubscribed|market data unavailable/i.test(message)) {
      throw new Error(
        `cTrader has no live quote for ${symbolName}. Its MCP gateway reports that this symbol is unsubscribed or market data is unavailable. Open ${symbolName} in cTrader and confirm its bid/ask is updating, then retry. No order was sent.`,
      );
    }
    throw error;
  }
  const quote = parseCTraderSpot(response);
  if (quote.symbolName && quote.symbolName.toLowerCase() !== symbolName.toLowerCase()) {
    throw new Error(`cTrader returned a quote for ${quote.symbolName}, not ${symbolName}.`);
  }
  return quote;
}

export function parseCTraderDetails(value: unknown, ticker: string): CTraderSymbolDetails {
  if (!isRecord(value)) throw new Error(`cTrader returned invalid symbol details for ${ticker}.`);
  const symbolName = typeof value.symbolName === 'string' ? value.symbolName : typeof value.name === 'string' ? value.name : ticker;
  const digits = finiteNumber(value.digits); const pipSize = finiteNumber(value.pipSize); const lotSize = finiteNumber(value.lotSize);
  const minVolume = finiteNumber(value.minVolume); const maxVolume = finiteNumber(value.maxVolume); const volumeStep = finiteNumber(value.volumeStep);
  if (!Number.isInteger(digits) || digits! < 0 || digits! > 12 || !pipSize || pipSize <= 0 || !lotSize || lotSize <= 0
    || !minVolume || minVolume <= 0 || !maxVolume || maxVolume < minVolume || !volumeStep || volumeStep <= 0) {
    throw new Error(`cTrader returned incomplete or invalid trading constraints for ${ticker}.`);
  }
  if (symbolName.toLowerCase() !== ticker.toLowerCase()) throw new Error(`cTrader returned details for ${symbolName}, not ${ticker}.`);
  return { symbolName, digits: digits!, pipSize, lotSize, minVolume, maxVolume, volumeStep };
}

function aggregateBars(bars: OHLCV[], intervalMs: number): OHLCV[] {
  const result = new Map<number, OHLCV>();
  for (const bar of bars) {
    const time = Math.floor(bar.time / intervalMs) * intervalMs;
    const current = result.get(time);
    if (!current) { result.set(time, { ...bar, time }); continue; }
    current.high = Math.max(current.high, bar.high); current.low = Math.min(current.low, bar.low);
    current.close = bar.close; current.volume = (current.volume ?? 0) + (bar.volume ?? 0);
  }
  return [...result.values()].sort((left, right) => left.time - right.time);
}

export class CTraderDataProvider implements MarketDataProvider {
  private connected = false;
  private descriptors: SymbolDescriptor[] = [];
  private readonly bridge: CTraderMcpBridge;
  private readonly detailCache = new Map<string, { expiresAt: number; details: CTraderSymbolDetails }>();
  private readonly atrRenkoPips = new Map<string, number>();
  private historyConnection = nextHistoryConnection();
  constructor(bridge: CTraderMcpBridge) { this.bridge = bridge; }
  info() {
    return { name: 'ctrader', displayName: 'cTrader (MCP gateway)', supportedTimeframes: ['1', '5', '15', '30', '60', '240', 'D', 'W', 'M'],
      capabilities: { enumerate: true, stream: true, symbolInfo: true } };
  }
  async refreshSymbols(): Promise<SymbolDescriptor[]> { return parseCTraderSymbols(await this.bridge.marketData('get_symbols', {})); }
  setSymbols(symbols: SymbolDescriptor[]): void { this.descriptors = symbols; this.connected = symbols.length > 0; }
  disconnect(): void {
    this.connected = false;
    this.descriptors = [];
    this.detailCache.clear();
    this.atrRenkoPips.clear();
    this.historyConnection = nextHistoryConnection();
  }
  async listSymbols(): Promise<SymbolDescriptor[]> {
    if (!this.connected) throw new Error('cTrader MCP market data is disconnected.');
    return this.descriptors;
  }
  async getQuote(ticker: string): Promise<MarketQuote> {
    if (!this.connected) throw new Error('cTrader MCP market data is disconnected.');
    const symbolName = normalizeSymbol(ticker);
    const quote = await fetchCTraderSpot(this.bridge, symbolName);
    return { bid: quote.bid, ask: quote.ask };
  }
  async getBars(ticker: string, timeframe: string, range: BarRange, knownSymbol?: SymbolDescriptor): Promise<OHLCV[]> {
    if (!this.connected) throw new Error('Connect cTrader through the Data Feeds panel to load chart data.');
    const history = desktopHistory();
    if (history) {
      const symbol = this.descriptors.find(item => item.ticker.toLowerCase() === normalizeSymbol(ticker).toLowerCase());
      return (await history.load({ provider: 'ctrader', ticker, timeframe, range, connection: this.historyConnection, symbol })).bars;
    }
    const atrRenko = isAtrRenkoTimeframe(timeframe);
    const renkoPips = renkoPipsForTimeframe(timeframe);
    const rangePips = rangePipsForTimeframe(timeframe);
    if (atrRenko || renkoPips !== null || rangePips !== null) {
      const limit = Math.max(1, Math.min(MAX_CHART_BARS, Math.floor(range.limit ?? 500)));
      const sourceBars = await this.getBars(ticker, '1', { ...range, limit: Math.min(MAX_CHART_BARS, Math.max(600, limit * 4)) });
      const symbolInfo = await this.getSymbolInfo(ticker, knownSymbol);
      const pipSize = typeof symbolInfo?.pipSize === 'number' && symbolInfo.pipSize > 0
        ? symbolInfo.pipSize
        : resolveInstrumentPipSize(ticker, symbolInfo?.minTick, symbolInfo?.digits);
      if (atrRenko) {
        const key = normalizeSymbol(ticker).toUpperCase();
        let lockedPips = this.atrRenkoPips.get(key);
        if (!lockedPips) {
          const atr = averageTrueRange(sourceBars, 600);
          if (!atr) throw new Error('ATR Renko requires 600 valid one-minute bars.');
          lockedPips = atr / pipSize;
          this.atrRenkoPips.set(key, lockedPips);
        }
        return buildRenkoBars(sourceBars, lockedPips, pipSize).slice(-limit);
      }
      if (renkoPips !== null) {
        const renko = buildRenkoBars(sourceBars, renkoPips, pipSize);
        return renko.slice(-limit);
      }
      if (rangePips !== null) {
        const rangeBars = buildRangeBars(sourceBars, rangePips, pipSize);
        return rangeBars.slice(-limit);
      }
    }
    const target = resolveChartTimeframe(timeframe);
    const limit = Math.max(1, Math.min(MAX_CHART_BARS, Math.floor(range.limit ?? 500)));
    const to = range.to ?? Date.now(); const from = range.from ?? to - target.intervalMs * limit;
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) throw new Error('cTrader chart history requires a valid time range.');
    const source = directTimeframes.find(item => item.key === target.sourceTimeframe)!;
    const sourceLimit = Math.min(MAX_TRENDBARS, Math.max(1, Math.ceil((to - from) / source.intervalMs) + 2));
    const response = await this.bridge.marketData('get_trendbars', { symbolName: normalizeSymbol(ticker), timeframe: target.sourceTimeframe,
      from: new Date(from).toISOString(), to: new Date(to).toISOString(), limit: sourceLimit });
    const bars = parseCTraderBars(response);
    const aligned = source.intervalMs === target.intervalMs ? bars : aggregateBars(bars, target.intervalMs);
    return aligned.filter(bar => bar.time <= to).slice(-limit);
  }
  async getSymbolInfo(ticker: string, knownSymbol?: SymbolDescriptor): Promise<SymbolInfo | undefined> {
    if (!this.connected) throw new Error('Connect cTrader through the Data Feeds panel to load symbol details.');
    const normalized = normalizeSymbol(ticker);
    const cacheKey = normalized.toLowerCase(); let cached = this.detailCache.get(cacheKey);
    const descriptor = knownSymbol ?? this.descriptors.find(symbol => symbol.ticker.toLowerCase() === cacheKey);
    if (!descriptor) return undefined;
    if (!cached || cached.expiresAt <= Date.now()) {
      const details = parseCTraderDetails(await this.bridge.marketData('get_symbol_details', { symbolName: normalized }), normalized);
      cached = { details, expiresAt: Date.now() + DETAIL_CACHE_MS }; this.detailCache.set(cacheKey, cached);
    }
    return { ticker: normalized, name: normalized, description: descriptor.description,
      digits: cached.details.digits, minTick: Number((10 ** -cached.details.digits).toFixed(cached.details.digits)),
      pipSize: cached.details.pipSize, contractSize: cached.details.lotSize };
  }
  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    if (!this.connected) return () => {};
    const atrRenko = isAtrRenkoTimeframe(timeframe);
    const renkoPips = renkoPipsForTimeframe(timeframe);
    const rangePips = rangePipsForTimeframe(timeframe);
    if (atrRenko || renkoPips !== null || rangePips !== null) {
      let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined;
      const poll = async () => {
        if (stopped || !this.connected) return;
        try {
          const bars = await this.getBars(ticker, timeframe, { limit: 2 });
          const latest = bars.at(-1);
          if (latest) onBar(latest);
        } catch (error) {
          if (!stopped) reportCaughtError('ctrader:renko-poll', error, `Live cTrader Renko polling failed for ${ticker}.`);
        } finally {
          if (!stopped && this.connected) timer = setTimeout(() => void poll(), 1000);
        }
      };
      void poll();
      return () => { stopped = true; if (timer) clearTimeout(timer); };
    }
    let target: ChartTimeframe;
    try { target = resolveChartTimeframe(timeframe); }
    catch (error) { reportCaughtError('ctrader:timeframe', error, `Could not subscribe to cTrader ${ticker} ${timeframe}.`); return () => {}; }
    let stopped = false; let timer: ReturnType<typeof setTimeout> | undefined; let currentBar: OHLCV | undefined;
    const symbolName = normalizeSymbol(ticker);
    const poll = async () => {
      if (stopped || !this.connected) return;
      try {
        if (!currentBar) currentBar = (await this.getBars(ticker, timeframe, { limit: 2 })).at(-1);
        if (stopped || !this.connected) return;
        const quote = await fetchCTraderSpot(this.bridge, symbolName);
        const time = Date.now(); const barTime = Math.floor(time / target.intervalMs) * target.intervalMs;
        if (currentBar && barTime < currentBar.time) return;
        if (!currentBar || barTime > currentBar.time) currentBar = { time: barTime, open: quote.bid, high: quote.bid, low: quote.bid, close: quote.bid };
        else { currentBar.high = Math.max(currentBar.high, quote.bid); currentBar.low = Math.min(currentBar.low, quote.bid); currentBar.close = quote.bid; }
        onBar({ ...currentBar });
      } catch (error) {
        if (!stopped) reportCaughtError('ctrader:spot-poll', error, `Live cTrader quote polling failed for ${symbolName}.`);
      } finally { if (!stopped && this.connected) timer = setTimeout(() => void poll(), POLL_INTERVAL_MS); }
    };
    void poll();
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }
}

export function initializeCTraderFeed(getWorkspace: () => VelaWorkspace): CTraderDataProvider | null {
  const bridge = window.velaCtrader;
  const modal = document.getElementById('ctrader-feed-modal'); const openButton = document.getElementById('ctrader-feed-toggle');
  const closeButton = document.getElementById('ctrader-feed-close');
  const connectButton = document.getElementById('ctrader-feed-connect') as HTMLButtonElement | null;
  const disconnectButton = document.getElementById('ctrader-feed-disconnect') as HTMLButtonElement | null;
  const statusElement = document.getElementById('ctrader-feed-status'); const toolList = document.getElementById('ctrader-tool-list');
  if (!bridge || !modal || !openButton || !closeButton || !connectButton || !disconnectButton || !statusElement || !toolList) return null;
  const provider = new CTraderDataProvider(bridge);
  const requiredMarketTools: CTraderMarketDataTool[] = ['get_symbols', 'get_symbol_details', 'get_spot_prices', 'get_trendbars'];
  let connected = false; let connectionRevision = 0;
  const register = async (chart: VelaWorkspace['chart']): Promise<void> => { chart.data.registerProvider('ctrader', provider); await chart.data.ready(); };
  const unregisterProvider = (): void => { for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('ctrader'); };
  const renderTools = (tools: CTraderToolSummary[]): void => {
    toolList.replaceChildren();
    if (!tools.length) { const empty = document.createElement('p'); empty.textContent = 'The cTrader gateway did not advertise any tools.'; toolList.append(empty); return; }
    const integrated = new Set([...requiredMarketTools, 'place_market_order']);
    for (const tool of tools) {
      const row = document.createElement('div'); row.className = 'local-feed-tool';
      const name = document.createElement('strong'); name.textContent = `${tool.name}${integrated.has(tool.name) ? ' · integrated' : ' · catalog only'}`;
      const description = document.createElement('span'); description.textContent = tool.description; row.append(name, description); toolList.append(row);
    }
  };
  const setStatus = (message: string, error = false): void => { statusElement.textContent = message; statusElement.dataset.state = error ? 'error' : 'info'; };
  const closeModal = (): void => { modal.hidden = true; modal.setAttribute('aria-hidden', 'true'); };
  const unregisterAccount = (): void => { document.dispatchEvent(new CustomEvent('omega:trading-account-unavailable', { detail: 'ctrader:mcp' })); };
  const disconnect = async (notify = true): Promise<void> => {
    connectionRevision += 1;
    if (!connected) { provider.disconnect(); unregisterProvider(); await bridge.disconnect(); return; }
    connected = false; provider.disconnect(); unregisterProvider(); await bridge.disconnect(); unregisterAccount();
    connectButton.hidden = false; disconnectButton.hidden = true; toolList.replaceChildren(); setStatus('Disconnected.');
    if (notify) document.dispatchEvent(new CustomEvent('omega:trading-broker-disconnected', { detail: 'ctrader' }));
  };
  getWorkspace().on('cell:created', event => {
    const cell = getWorkspace().cell(event.id);
    if (connected && cell) void register(cell.chart).catch(error => reportCaughtError('ctrader:provider-register', error, 'Could not register cTrader data on a new chart.'));
  });
  openButton.addEventListener('click', () => { modal.hidden = false; modal.setAttribute('aria-hidden', 'false'); });
  closeButton.addEventListener('click', closeModal);
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  connectButton.addEventListener('click', async () => {
    const revision = ++connectionRevision; connectButton.disabled = true;
    setStatus('Connecting to cTrader MCP and validating chart-data tools…');
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'ctrader' }));
    try {
      const status = await bridge.connect();
      if (!status.connected) throw new Error('cTrader MCP did not establish a session.');
      const available = new Set(status.tools.map(tool => tool.name));
      const missing = requiredMarketTools.filter(name => !available.has(name));
      if (missing.length) throw new Error(`cTrader MCP is missing required chart-data tools: ${missing.join(', ')}.`);
      const symbols = await provider.refreshSymbols();
      if (revision !== connectionRevision) throw new Error('cTrader connection was superseded by another provider selection.');
      if (!symbols.length) throw new Error('cTrader MCP returned no symbols; chart data was not connected.');
      provider.setSymbols(symbols);
      const registrations = await Promise.allSettled(getWorkspace().cells().map(cell => register(cell.chart)));
      const registrationError = registrations.find((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (registrationError) throw registrationError.reason;
      if (revision !== connectionRevision) throw new Error('cTrader connection was superseded by another provider selection.');
      connected = true;
      renderTools(status.tools);
      const orderToolStatus = available.has('place_market_order')
        ? 'Confirmed chart orders are available after volume and quote validation.'
        : 'Chart order tool is unavailable; market data only.';
      setStatus(`Connected to ${status.server?.name ?? 'cTrader MCP'} ${status.server?.version ?? ''}; ${symbols.length} symbols. Quotes are polled through MCP; feed latency depends on the gateway. ${orderToolStatus} No order has been sent.`);
      document.dispatchEvent(new CustomEvent('omega:trading-account-available', {
        detail: { id: 'ctrader:mcp', label: 'cTrader · MCP Gateway', mode: 'CONNECTED', detail: `${symbols.length} symbols; MCP tools validated` },
      }));
      document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'ctrader' }));
      connectButton.hidden = true;
      disconnectButton.hidden = false;
    } catch (error) {
      provider.disconnect();
      unregisterProvider();
      await bridge.disconnect().catch(disconnectError => {
        reportCaughtError('ctrader:disconnect', disconnectError, 'Could not close the failed cTrader MCP session.');
      });
      if (revision === connectionRevision) setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      if (revision === connectionRevision) connectButton.disabled = false;
    }
  });
  disconnectButton.addEventListener('click', () => {
    void disconnect().catch(error => setStatus(error instanceof Error ? error.message : String(error), true));
  });
  document.addEventListener('omega:trading-broker-connecting', event => {
    if ((event as CustomEvent<string>).detail !== 'ctrader') void disconnect(false).catch(error => {
      reportCaughtError('ctrader:disconnect', error, 'Could not close the cTrader MCP session after switching providers.');
    });
  });
  document.addEventListener('omega:trading-broker-exclusive', event => {
    if ((event as CustomEvent<string>).detail !== 'ctrader') void disconnect(false).catch(error => {
      reportCaughtError('ctrader:disconnect', error, 'Could not close the cTrader MCP session after selecting another feed.');
    });
  });
  return provider;
}
