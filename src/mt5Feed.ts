import type { DataProvider, OHLCV, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { MarketDataProvider, MarketQuote } from './platform/marketData';
import { desktopHistory, nextHistoryConnection } from './marketDataProcess.ts';
// The .ts extension is required: this module is imported directly by the Node test runner,
// which resolves specifiers literally and does not guess extensions.
import { reportCaughtError } from './diagnostics.ts';
import { assertSelectedMt5Account } from './chartMt5Orders.ts';
import {
  armPineMt5AutoTrading,
  getPineMt5AutoTradingAccountId,
} from './pineStrategyAutoTrading.ts';
import {
  averageTrueRange,
  renkoPipsForTimeframe,
  rangePipsForTimeframe,
  isAtrRenkoTimeframe,
  resolveInstrumentPipSize,
  buildRenkoBars,
  buildRangeBars,
} from './renkoRangeBars.ts';

export { renkoPipsForTimeframe, rangePipsForTimeframe };

interface Mt5Symbol {
  ticker: string;
  description: string;
  path: string;
  digits: number;
  point: number;
  tradeTickSize?: number;
  currencyBase: string;
  currencyProfit: string;
  tradeContractSize?: number;
  tickValue?: number;
}

interface Mt5Connection {
  company: string;
  terminal: string;
  accountLogin: string;
  server: string;
  accountMode: 'demo' | 'contest' | 'real' | 'unknown';
  tradingAllowed: boolean;
  symbols: Mt5Symbol[];
}

interface Mt5TradingStatus {
  connected: boolean;
  tradingAllowed: boolean;
  terminalTradingAllowed: boolean;
  accountTradingAllowed: boolean;
  accountMode: 'demo' | 'contest' | 'real' | 'unknown';
  accountLogin: string;
  server: string;
  currency: string;
  equity: number;
  armed?: boolean;
  liveOrderLimits?: { maxVolume: number; source: 'default' | 'environment' | 'stored' };
}

interface Mt5OrderRequest {
  confirmedAccountId?: string;
  intentId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  volume: number;
  stopLoss?: number;
  takeProfit?: number;
}

interface Mt5OrderJournalEntry {
  id: string;
  at: string;
  updatedAt: string;
  status: string;
  data: Record<string, unknown>;
  details?: Record<string, unknown>;
}

interface Mt5Bridge {
  connect(pythonExecutable?: string): Promise<Mt5Connection>;
  tradingStatus(): Promise<Mt5TradingStatus>;
  armLiveTrading(armed: boolean): Promise<{ armed: boolean; accountMode?: string; accountLogin?: string; server?: string }>;
  placeOrder(request: Mt5OrderRequest): Promise<{ id: string; status: string; result: Record<string, unknown> }>;
  closePosition(request: { positionTicket: string; symbol: string; side: 'BUY' | 'SELL'; volume: number }): Promise<Record<string, unknown>>;
  orderJournal(): Promise<{
    available: boolean;
    entries: Mt5OrderJournalEntry[];
    open: Mt5OrderJournalEntry[];
    integrity: { ok: boolean };
  }>;
  resolveOrderIntent(request: { id: string; note: string }): Promise<{ id: string; status: string }>;
  symbols(): Promise<Mt5Symbol[]>;
  bars(request: { ticker: string; timeframe: string; range: { from?: number; to?: number; limit: number } }): Promise<OHLCV[]>;
  quote(ticker: string): Promise<{ bid: number; ask: number; timeMsc: number }>;
  ticks(request: { ticker: string; fromMsc: number; limit: number }): Promise<Mt5Tick[]>;
  tickBars(request: { provider: string; ticker: string; ticksPerBar: number; from?: number; to?: number; limit?: number }): Promise<OHLCV[]>;
  subscribeTickBars(provider: string, ticker: string, ticksPerBar: number, onBar: (bar: OHLCV) => void): () => void;
  footprintProfiles?(request: {
    ticker: string;
    pipSize?: number;
    profileType?: 'footprint' | 'tap';
    bars: Array<Pick<OHLCV, 'time' | 'open' | 'high' | 'low' | 'close'>>;
    nextBarTime?: number;
  }): Promise<Array<{
    time: number;
    high: number;
    low: number;
    levels: Array<{ price: number; downPips?: number; upPips?: number; durationMs?: number }>;
    lastPrice?: number;
    lastTickTime?: number;
  }>>;
  footprintLiveProfile?(request: {
    ticker: string;
    pipSize: number;
    bar: Pick<OHLCV, 'time' | 'open' | 'high' | 'low' | 'close'>;
    ticks: Mt5Tick[];
  }): Promise<{
    time: number;
    high: number;
    low: number;
    levels: Array<{ price: number; downPips: number; upPips: number }>;
    lastPrice?: number;
    lastTickTime?: number;
  }>;
  subscribeTicks?(ticker: string, onTicks: (ticks: Mt5Tick[]) => void): () => void;
  marketBook(ticker: string): Promise<Mt5BookEntry[]>;
  info(ticker: string): Promise<Mt5Symbol | undefined>;
  disconnect(): Promise<boolean>;
}

interface Mt5Tick {
  time: number;
  bid: number;
  ask: number;
  last: number;
  volume: number;
  volumeReal: number;
  flags: number;
}

interface Mt5BookEntry {
  type: number;
  price: number;
  volume: number;
}

declare global {
  interface Window {
    velaMt5?: Mt5Bridge;
  }
}

const directTimeframes: Record<number, string> = {
  1: 'M1', 2: 'M2', 3: 'M3', 4: 'M4', 5: 'M5', 6: 'M6', 10: 'M10', 12: 'M12',
  15: 'M15', 20: 'M20', 30: 'M30', 60: 'H1', 120: 'H2', 180: 'H3', 240: 'H4',
  360: 'H6', 480: 'H8', 720: 'H12', 1440: 'D1', 10080: 'W1',
};
const minuteFrames = Object.entries(directTimeframes)
  .map(([minutes, timeframe]) => ({ minutes: Number(minutes), timeframe }))
  .sort((left, right) => right.minutes - left.minutes);

// Browser/test fall-back when the desktop bridge cannot expose its push stream.
const MT5_TICK_POLL_INTERVAL_MS = 100;

function normalizeMt5Ticker(ticker: string): string {
  return ticker.trim().replace(/^MT5:/i, '');
}

export function resolveMt5Timeframe(value: string): {
  timeframe: string;
  bucketMs: number;
  sourceMinutes: number;
  targetMinutes: number;
} {
  const normalized = value.trim().toUpperCase();
  if (normalized === 'D' || normalized === '1D') {
    return { timeframe: 'D1', bucketMs: 0, sourceMinutes: 1440, targetMinutes: 1440 };
  }
  if (normalized === 'W' || normalized === '1W') {
    return { timeframe: 'W1', bucketMs: 0, sourceMinutes: 10080, targetMinutes: 10080 };
  }
  if (normalized === 'M' || normalized === '1M' || normalized === 'MN1') {
    return { timeframe: 'MN1', bucketMs: 0, sourceMinutes: 0, targetMinutes: 0 };
  }

  const minutes = Number(normalized);
  if (!Number.isInteger(minutes) || minutes < 1) throw new Error(`Unsupported MetaTrader timeframe: ${value}`);
  if (minutes === 43_200) return { timeframe: 'MN1', bucketMs: 0, sourceMinutes: 0, targetMinutes: 0 };
  const base = minuteFrames.find(frame => minutes % frame.minutes === 0);
  if (!base) throw new Error(`Unsupported MetaTrader timeframe: ${value}`);
  return {
    timeframe: base.timeframe,
    bucketMs: minutes === base.minutes ? 0 : minutes * 60_000,
    sourceMinutes: base.minutes,
    targetMinutes: minutes,
  };
}

export function aggregateMt5Bars(bars: readonly OHLCV[], bucketMs: number): OHLCV[] {
  if (bucketMs === 0) return [...bars];
  const buckets = new Map<number, OHLCV>();
  for (const bar of bars) {
    const time = Math.floor(bar.time / bucketMs) * bucketMs;
    const bucket = buckets.get(time);
    if (!bucket) {
      buckets.set(time, { ...bar, time });
      continue;
    }
    bucket.high = Math.max(bucket.high, bar.high);
    bucket.low = Math.min(bucket.low, bar.low);
    bucket.close = bar.close;
    bucket.volume = (bucket.volume ?? 0) + (bar.volume ?? 0);
  }
  return [...buckets.values()].sort((left, right) => left.time - right.time);
}

export function mt5TickCountForTimeframe(timeframe: string): number | null {
  const match = /^T([1-9]\d{0,4})$/i.exec(timeframe.trim());
  if (!match) return null;
  const count = Number(match[1]);
  return Number.isSafeInteger(count) && count <= 10_000 ? count : null;
}

function tickPrice(tick: Mt5Tick): number {
  return Number.isFinite(tick.last) && tick.last > 0
    ? tick.last
    : Number.isFinite(tick.bid) && tick.bid > 0 ? tick.bid : tick.ask;
}

export function mt5TimeframeBucketStart(time: number, timeframe: string, anchorTime = 0): number {
  const resolved = resolveMt5Timeframe(timeframe);
  if (resolved.targetMinutes === 0) {
    const date = new Date(time);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
  }
  const intervalMs = resolved.targetMinutes * 60_000;
  return anchorTime + Math.floor((time - anchorTime) / intervalMs) * intervalMs;
}

export function updateMt5TimeframeBar(
  current: OHLCV | null,
  tick: Mt5Tick,
  timeframe: string,
  anchorTime = 0,
): OHLCV | null {
  const price = tickPrice(tick);
  if (!Number.isFinite(tick.time) || tick.time < 0 || !Number.isFinite(price) || price <= 0) return current;

  const time = mt5TimeframeBucketStart(tick.time, timeframe, anchorTime);
  if (current && time < current.time) return current;
  const realVolume = Number.isFinite(tick.volumeReal) ? tick.volumeReal : 0;
  const tickVolume = realVolume > 0
    ? realVolume
    : Number.isFinite(tick.volume) && tick.volume > 0 ? tick.volume : 0;
  if (current && time === current.time) {
    return {
      ...current,
      high: Math.max(current.high, price),
      low: Math.min(current.low, price),
      close: price,
      volume: (current.volume ?? 0) + tickVolume,
    };
  }
  return { time, open: price, high: price, low: price, close: price, volume: tickVolume };
}

function tickKey(tick: Mt5Tick): string {
  return `${tick.time}|${tick.bid}|${tick.ask}|${tick.last}|${tick.volume}|${tick.volumeReal}|${tick.flags}`;
}

export class Mt5DataProvider implements DataProvider, MarketDataProvider {
  private descriptors: SymbolDescriptor[] = [];
  private readonly bridge: Mt5Bridge;
  /** Fixed ATR-derived box sizes, reset only when this feed is re-created. */
  private readonly atrRenkoPips = new Map<string, number>();
  private connected = false;
  private historyConnection = nextHistoryConnection();

  constructor(bridge: Mt5Bridge) {
    this.bridge = bridge;
  }

  info() {
    return {
      name: 'mt5',
      displayName: 'MetaTrader 5 (broker feed)',
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  setSymbols(symbols: readonly Mt5Symbol[]) {
    this.connected = true;
    this.descriptors = symbols.map(symbol => ({
      ticker: symbol.ticker,
      description: symbol.description || symbol.ticker,
      type: mt5SymbolType(symbol.path),
      group: mt5SymbolGroup(symbol.path),
      prefix: 'MT5',
    }));
  }

  disconnect() {
    this.connected = false;
    this.historyConnection = nextHistoryConnection();
    this.descriptors = [];
    this.atrRenkoPips.clear();
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    return this.descriptors;
  }

  async getQuote(ticker: string): Promise<MarketQuote> {
    if (!this.connected) throw new Error('MetaTrader 5 feed is disconnected.');
    const quote = await this.bridge.quote(normalizeMt5Ticker(ticker));
    if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid === 0 || quote.ask === 0 || quote.ask < quote.bid
      || !Number.isFinite(quote.timeMsc) || quote.timeMsc <= 0) {
      throw new Error(`MetaTrader 5 returned an invalid quote for ${ticker}.`);
    }
    return { bid: quote.bid, ask: quote.ask, timeMsc: quote.timeMsc };
  }

  async getBars(ticker: string, timeframe: string, range: { from?: number; to?: number; limit?: number }): Promise<OHLCV[]> {
    if (!this.connected) throw new Error('MetaTrader 5 feed is disconnected.');
    const brokerTicker = normalizeMt5Ticker(ticker);
    const history = desktopHistory();
    if (history) {
      const connection = this.historyConnection;
      const { bars, atrRenkoPips } = await history.load({ provider: 'mt5', ticker: brokerTicker, timeframe, range, connection });
      if (connection === this.historyConnection && atrRenkoPips !== undefined) {
        this.atrRenkoPips.set(brokerTicker.toUpperCase(), atrRenkoPips);
      }
      return bars;
    }
    const ticksPerBar = mt5TickCountForTimeframe(timeframe);
    if (ticksPerBar !== null) return this.getTickBars(brokerTicker, ticksPerBar, range);
    const atrRenko = isAtrRenkoTimeframe(timeframe);
    const renkoPips = renkoPipsForTimeframe(timeframe);
    if (renkoPips !== null) return this.getRenkoBars(brokerTicker, renkoPips, range);
    if (atrRenko) return this.getAtrRenkoBars(brokerTicker, range);
    const rangePips = rangePipsForTimeframe(timeframe);
    if (rangePips !== null) return this.getRangeBars(brokerTicker, rangePips, range);
    const resolved = resolveMt5Timeframe(timeframe);
    const limit = Math.max(1, range.limit ?? 1000);
    const multiplier = resolved.sourceMinutes === 0
      ? 1
      : Math.max(1, Math.ceil(resolved.targetMinutes / resolved.sourceMinutes));
    const bars = await this.bridge.bars({
      ticker: brokerTicker,
      timeframe: resolved.timeframe,
      range: {
        ...range,
        limit: Math.min(50_000, limit * multiplier + 5),
      },
    });
    const aggregated = aggregateMt5Bars(bars, resolved.bucketMs);
    return aggregated.length > limit ? aggregated.slice(-limit) : aggregated;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo | undefined> {
    const info = await this.bridge.info(normalizeMt5Ticker(ticker));
    if (!info) return undefined;
    const contractSize = Number(info.tradeContractSize);
    const tickValue = Number(info.tickValue);
    return {
      ticker: info.ticker,
      name: info.ticker,
      description: info.description,
      currency: info.currencyProfit || undefined,
      baseCurrency: info.currencyBase || undefined,
      exchange: info.path || 'MetaTrader 5 broker',
      timezone: 'UTC',
      minTick: info.point,
      tradeTickSize: info.tradeTickSize,
      digits: info.digits,
      pointValue: Number.isFinite(tickValue) && tickValue > 0 ? tickValue : 1,
      ...(Number.isFinite(contractSize) && contractSize > 0 ? { contractSize } : {}),
    };
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    const brokerTicker = normalizeMt5Ticker(ticker);
    const ticksPerBar = mt5TickCountForTimeframe(timeframe);
    if (ticksPerBar !== null) return this.subscribeTicks(brokerTicker, ticksPerBar, onBar);
    const atrRenko = isAtrRenkoTimeframe(timeframe);
    const renkoPips = renkoPipsForTimeframe(timeframe);
    if (renkoPips !== null) return this.subscribeRenkoBars(brokerTicker, renkoPips, onBar);
    if (atrRenko) return this.subscribeAtrRenkoBars(brokerTicker, onBar);
    const rangePips = rangePipsForTimeframe(timeframe);
    if (rangePips !== null) return this.subscribeRangeBars(brokerTicker, rangePips, onBar);
    return this.subscribeTimeframeBars(brokerTicker, timeframe, onBar);
  }

  private async getRenkoBars(
    ticker: string,
    brickPips: number,
    range: { from?: number; to?: number; limit?: number },
  ): Promise<OHLCV[]> {
    const info = await this.bridge.info(ticker);
    const pipSize = resolveInstrumentPipSize(ticker, info?.point, info?.digits);
    const limit = Math.max(1, Math.min(50_000, range.limit ?? 1000));
    const minuteLimit = Math.min(50_000, Math.max(1000, limit * 4));
    const sourceBars = await this.bridge.bars({
      ticker,
      timeframe: 'M1',
      range: { ...range, limit: minuteLimit },
    });
    const renko = buildRenkoBars(sourceBars, brickPips, pipSize);
    return renko.length > limit ? renko.slice(-limit) : renko;
  }

  private async getAtrRenkoBars(
    ticker: string,
    range: { from?: number; to?: number; limit?: number },
  ): Promise<OHLCV[]> {
    const info = await this.bridge.info(ticker);
    const pipSize = resolveInstrumentPipSize(ticker, info?.point, info?.digits);
    const limit = Math.max(1, Math.min(50_000, range.limit ?? 1000));
    const sourceBars = await this.bridge.bars({
      ticker, timeframe: 'M1', range: { ...range, limit: Math.min(50_000, Math.max(600, limit * 4)) },
    });
    const key = normalizeMt5Ticker(ticker).toUpperCase();
    let brickPips = this.atrRenkoPips.get(key);
    if (!brickPips) {
      const atr = averageTrueRange(sourceBars, 600);
      if (!atr) throw new Error('ATR Renko requires 600 valid one-minute bars.');
      brickPips = atr / pipSize;
      this.atrRenkoPips.set(key, brickPips);
    }
    return buildRenkoBars(sourceBars, brickPips, pipSize).slice(-limit);
  }

  getLockedAtrRenkoPips(ticker: string): number | undefined {
    return this.atrRenkoPips.get(normalizeMt5Ticker(ticker).toUpperCase());
  }

  private async getRangeBars(
    ticker: string,
    rangePips: number,
    range: { from?: number; to?: number; limit?: number },
  ): Promise<OHLCV[]> {
    const info = await this.bridge.info(ticker);
    const pipSize = resolveInstrumentPipSize(ticker, info?.point, info?.digits);
    const limit = Math.max(1, Math.min(50_000, range.limit ?? 1000));
    const minuteLimit = Math.min(50_000, Math.max(1000, limit * 4));
    const sourceBars = await this.bridge.bars({
      ticker,
      timeframe: 'M1',
      range: { ...range, limit: minuteLimit },
    });
    const rangeBars = buildRangeBars(sourceBars, rangePips, pipSize);
    return rangeBars.length > limit ? rangeBars.slice(-limit) : rangeBars;
  }

  private subscribeRenkoBars(
    ticker: string,
    brickPips: number,
    onBar: (bar: OHLCV) => void,
    initialBarsLoader: () => Promise<OHLCV[]> = () => this.getBars(ticker, `R${brickPips}`, { limit: 1 }),
  ): () => void {
    let active = true;
    let stopTicks: (() => void) | null = null;
    void this.getSymbolInfo(ticker).then(info => {
      if (!active) return;
      const pipSize = resolveInstrumentPipSize(ticker, info?.minTick, info?.digits);
      const boxSize = brickPips * pipSize;
      void initialBarsLoader().then(initialBars => {
        if (!active) return;
        let lastBrick = initialBars.at(-1);
        let anchor = lastBrick ? lastBrick.close : 0;
        let direction: 1 | -1 | 0 = lastBrick ? (lastBrick.close >= lastBrick.open ? 1 : -1) : 0;
        let runningHigh = lastBrick ? lastBrick.high : 0;
        let runningLow = lastBrick ? lastBrick.low : 0;
        let runningVolume = 0;
        let lastTime = lastBrick ? lastBrick.time : -1;
        let formingTime = -1;

        stopTicks = this.subscribeLiveTicks(ticker, tick => {
          const price = tickPrice(tick);
          if (!Number.isFinite(price) || price <= 0) return;
          if (anchor === 0) {
            anchor = price;
            runningHigh = price;
            runningLow = price;
            return;
          }
          if (formingTime === -1) {
            formingTime = Math.max(tick.time, lastTime + 1);
          }
          const tickVol = Number.isFinite(tick.volumeReal) && tick.volumeReal > 0
            ? tick.volumeReal
            : Number.isFinite(tick.volume) && tick.volume > 0 ? tick.volume : 1;
          runningVolume += tickVol;
          runningHigh = Math.max(runningHigh, price);
          runningLow = Math.min(runningLow, price);

          if (direction === 0) {
            if (price >= anchor + boxSize) {
              direction = 1;
              const open = anchor;
              const close = anchor + boxSize;
              const brickTime = formingTime;
              lastTime = brickTime;
              formingTime = -1;
              const bar: OHLCV = { time: brickTime, open, high: close, low: Math.min(runningLow, open), close, volume: runningVolume };
              anchor = close;
              runningHigh = close;
              runningLow = close;
              runningVolume = 0;
              onBar(bar);
            } else if (price <= anchor - boxSize) {
              direction = -1;
              const open = anchor;
              const close = anchor - boxSize;
              const brickTime = formingTime;
              lastTime = brickTime;
              formingTime = -1;
              const bar: OHLCV = { time: brickTime, open, high: Math.max(runningHigh, open), low: close, close, volume: runningVolume };
              anchor = close;
              runningHigh = close;
              runningLow = close;
              runningVolume = 0;
              onBar(bar);
            } else {
              onBar({ time: formingTime, open: anchor, high: runningHigh, low: runningLow, close: price, volume: runningVolume });
            }
          } else if (direction === 1) {
            if (price >= anchor + boxSize) {
              const open = anchor;
              const close = anchor + boxSize;
              const brickTime = formingTime;
              lastTime = brickTime;
              formingTime = -1;
              const bar: OHLCV = { time: brickTime, open, high: close, low: Math.min(runningLow, open), close, volume: runningVolume };
              anchor = close;
              runningHigh = close;
              runningLow = close;
              runningVolume = 0;
              onBar(bar);
            } else if (price <= anchor - 2 * boxSize) {
              const open = anchor - boxSize;
              const close = anchor - 2 * boxSize;
              const brickTime = formingTime;
              lastTime = brickTime;
              formingTime = -1;
              const bar: OHLCV = { time: brickTime, open, high: Math.max(runningHigh, open), low: close, close, volume: runningVolume };
              direction = -1;
              anchor = close;
              runningHigh = close;
              runningLow = close;
              runningVolume = 0;
              onBar(bar);
            } else {
              onBar({ time: formingTime, open: anchor, high: runningHigh, low: runningLow, close: price, volume: runningVolume });
            }
          } else {
            if (price <= anchor - boxSize) {
              const open = anchor;
              const close = anchor - boxSize;
              const brickTime = formingTime;
              lastTime = brickTime;
              formingTime = -1;
              const bar: OHLCV = { time: brickTime, open, high: Math.max(runningHigh, open), low: close, close, volume: runningVolume };
              anchor = close;
              runningHigh = close;
              runningLow = close;
              runningVolume = 0;
              onBar(bar);
            } else if (price >= anchor + 2 * boxSize) {
              const open = anchor + boxSize;
              const close = anchor + 2 * boxSize;
              const brickTime = formingTime;
              lastTime = brickTime;
              formingTime = -1;
              const bar: OHLCV = { time: brickTime, open, high: close, low: Math.min(runningLow, open), close, volume: runningVolume };
              direction = 1;
              anchor = close;
              runningHigh = close;
              runningLow = close;
              runningVolume = 0;
              onBar(bar);
            } else {
              onBar({ time: formingTime, open: anchor, high: runningHigh, low: runningLow, close: price, volume: runningVolume });
            }
          }
        });
      });
    });

    return () => {
      active = false;
      stopTicks?.();
    };
  }

  private subscribeAtrRenkoBars(ticker: string, onBar: (bar: OHLCV) => void): () => void {
    let active = true;
    let stop: (() => void) | null = null;
    void this.getBars(ticker, 'RATR', { limit: 1 }).then(initial => {
      if (!active) return;
      const brickPips = this.getLockedAtrRenkoPips(ticker);
      if (!brickPips) return;
      // The chosen size stays in atrRenkoPips; the live stream therefore cannot resize bricks.
      stop = this.subscribeRenkoBars(ticker, brickPips, onBar, () => Promise.resolve(initial));
    }).catch(error => reportCaughtError('mt5:atr-renko', error, `Could not initialize ATR Renko for ${ticker}.`));
    return () => { active = false; stop?.(); };
  }

  private subscribeRangeBars(
    ticker: string,
    rangePips: number,
    onBar: (bar: OHLCV) => void,
  ): () => void {
    let active = true;
    let stopTicks: (() => void) | null = null;
    void this.getSymbolInfo(ticker).then(info => {
      if (!active) return;
      const pipSize = resolveInstrumentPipSize(ticker, info?.minTick, info?.digits);
      const rangeSize = rangePips * pipSize;
      void this.getBars(ticker, `RG${rangePips}`, { limit: 1 }).then(initialBars => {
        if (!active) return;
        let lastBar = initialBars.at(-1);
        let open = lastBar ? lastBar.close : 0;
        let high = open;
        let low = open;
        let runningVolume = 0;
        let lastTime = lastBar ? lastBar.time : -1;
        let formingTime = -1;

        stopTicks = this.subscribeLiveTicks(ticker, tick => {
          const price = tickPrice(tick);
          if (!Number.isFinite(price) || price <= 0) return;
          if (open === 0) {
            open = price;
            high = price;
            low = price;
            return;
          }
          if (formingTime === -1) {
            formingTime = Math.max(tick.time, lastTime + 1);
          }
          const tickVol = Number.isFinite(tick.volumeReal) && tick.volumeReal > 0
            ? tick.volumeReal
            : Number.isFinite(tick.volume) && tick.volume > 0 ? tick.volume : 1;
          runningVolume += tickVol;
          high = Math.max(high, price);
          low = Math.min(low, price);

          let completed = false;
          // One tick may cross more than one range. Emit every completed bar,
          // matching the historical range builder instead of silently losing
          // bars after the first breakout.
          for (let iteration = 0; iteration < 200 && high - low >= rangeSize; iteration += 1) {
            const isBullish = price >= low + rangeSize;
            const barLow = isBullish ? low : high - rangeSize;
            const barHigh = isBullish ? low + rangeSize : high;
            const close = isBullish ? barHigh : barLow;
            const barTime = formingTime;
            lastTime = barTime;
            formingTime = -1;
            onBar({ time: barTime, open, high: barHigh, low: barLow, close, volume: runningVolume });
            completed = true;
            open = close;
            high = open;
            low = open;
            runningVolume = 0;
            // Reapply the same tick to the newly forming range bar; its price
            // is still beyond the completed boundary.
            high = Math.max(high, price);
            low = Math.min(low, price);
            if (high - low < rangeSize) break;
            formingTime = Math.max(tick.time, lastTime + 1);
          }
          if (!completed) {
            onBar({
              time: formingTime,
              open,
              high,
              low,
              close: price,
              volume: runningVolume,
            });
          }
        });
      });
    });

    return () => {
      active = false;
      stopTicks?.();
    };
  }

  private async getTickBars(
    ticker: string,
    ticksPerBar: number,
    range: { from?: number; to?: number; limit?: number },
  ): Promise<OHLCV[]> {
    return this.bridge.tickBars({ provider: 'mt5', ticker, ticksPerBar, from: range.from, to: range.to, limit: range.limit });
  }

  private subscribeTicks(
    ticker: string,
    ticksPerBar: number,
    onBar: (bar: OHLCV) => void,
  ): () => void {
    return this.bridge.subscribeTickBars('mt5', ticker, ticksPerBar, onBar);
  }

  private subscribeTimeframeBars(
    ticker: string,
    timeframe: string,
    onBar: (bar: OHLCV) => void,
  ): () => void {
    let active = true;
    let stopTicks: (() => void) | null = null;
    const startTickStream = (seed: OHLCV | null) => {
      if (!active) return;
      let current = seed ? { ...seed } : null;
      const anchorTime = current?.time ?? 0;
      stopTicks = this.subscribeLiveTicks(ticker, tick => {
        const next = updateMt5TimeframeBar(current, tick, timeframe, anchorTime);
        if (!next || next === current) return;
        current = next;
        onBar(next);
      });
    };

    void this.getBars(ticker, timeframe, { limit: 1 })
      .then(bars => startTickStream(bars.at(-1) ?? null))
      .catch(() => {
        // Data requests can retry without writing background feed failures to the console.
        startTickStream(null);
      });

    return () => {
      active = false;
      stopTicks?.();
    };
  }

  private subscribeLiveTicks(ticker: string, onTick: (tick: Mt5Tick) => void): () => void {
    if (this.bridge.subscribeTicks) return this.subscribePushedTicks(ticker, onTick);
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cursor = Math.max(0, Date.now() - 1000);
    let seenAtCursor = new Map<string, number>();

    const poll = async () => {
      if (!active || !this.connected) return;
      try {
        const ticks = await this.bridge.ticks({ ticker, fromMsc: cursor, limit: 2000 });
        const batchOccurrences = new Map<string, number>();
        for (const tick of ticks) {
          if (tick.time < cursor) continue;
          if (tick.time > cursor) {
            cursor = tick.time;
            seenAtCursor = new Map();
          }
          const key = tickKey(tick);
          const occurrence = (batchOccurrences.get(key) ?? 0) + 1;
          batchOccurrences.set(key, occurrence);
          if (occurrence <= (seenAtCursor.get(key) ?? 0)) continue;
          seenAtCursor.set(key, occurrence);
          onTick(tick);
        }
        const lastTime = ticks.at(-1)?.time;
        if (lastTime !== undefined && lastTime > cursor) {
          cursor = lastTime;
          seenAtCursor = new Map();
        }
      } catch {
        // Keep recurring local-feed polling failures quiet.
      } finally {
        if (active) timer = setTimeout(() => { void poll(); }, MT5_TICK_POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }

  private subscribePushedTicks(ticker: string, onTick: (tick: Mt5Tick) => void): () => void {
    let cursor = Math.max(0, Date.now() - 1000);
    let seenAtCursor = new Map<string, number>();
    return this.bridge.subscribeTicks!(ticker, ticks => {
      const occurrences = new Map<string, number>();
      for (const tick of ticks) {
        if (tick.time < cursor) continue;
        if (tick.time > cursor) {
          cursor = tick.time;
          seenAtCursor = new Map();
        }
        const key = tickKey(tick);
        const occurrence = (occurrences.get(key) ?? 0) + 1;
        occurrences.set(key, occurrence);
        if (occurrence <= (seenAtCursor.get(key) ?? 0)) continue;
        seenAtCursor.set(key, occurrence);
        onTick(tick);
      }
    });
  }
}

function mt5SymbolType(path: string): string {
  const segments = path.split(/[\\/]/).map(segment => segment.trim().toLowerCase()).filter(Boolean);
  const knownTypes: Record<string, string> = {
    forex: 'forex',
    currencies: 'forex',
    stocks: 'stock',
    shares: 'stock',
    equities: 'stock',
    futures: 'futures',
    commodities: 'commodity',
    metals: 'commodity',
    indices: 'index',
    indexes: 'index',
    crypto: 'crypto',
    cryptocurrencies: 'crypto',
  };
  return segments.map(segment => knownTypes[segment]).find(Boolean) ?? segments[0] ?? 'market';
}

function mt5SymbolGroup(path: string): string {
  const type = mt5SymbolType(path);
  return ({ forex: 'Forex', crypto: 'Crypto', index: 'Indices', stock: 'Stocks', futures: 'Futures', commodity: 'Commodities' } as Record<string, string>)[type] ?? 'Other';
}

export function initializeMt5Feed(getWorkspace: () => VelaWorkspace): void {
  const modal = document.getElementById('mt5-feed-modal');
  const openButton = document.getElementById('mt5-feed-toggle');
  const closeButton = document.getElementById('mt5-feed-close');
  const connectButton = document.getElementById('mt5-feed-connect') as HTMLButtonElement | null;
  const disconnectButton = document.getElementById('mt5-feed-disconnect') as HTMLButtonElement | null;
  const tradingToolsPanel = document.getElementById('mt5-trading-tools-panel') as HTMLElement | null;
  const orderJournalEntries = document.getElementById('mt5-order-journal-entries');
  const orderJournalRefreshButton = document.getElementById('mt5-order-journal-refresh') as HTMLButtonElement | null;
  const executableInput = document.getElementById('mt5-python-path') as HTMLInputElement | null;
  const connectionStatus = document.getElementById('mt5-feed-connection-status');
  let connected = false;
  let revision = 0;
  let tradingAccountId: string | null = null;
  if (executableInput) {
    executableInput.value = 'python';
  }
  if (!modal || !openButton || !closeButton || !connectButton || !disconnectButton || !executableInput) {
    reportCaughtError('mt5:initialize', new Error('Required MT5 connection dialog controls are missing.'), 'The MT5 connection dialog could not initialize.');
    return;
  }
  const setConnectionStatus = (message: string, state: 'info' | 'success' | 'error' = 'info') => {
    if (!connectionStatus) return;
    connectionStatus.textContent = message;
    connectionStatus.dataset.state = state;
  };
  const refreshLiveTradingState = async () => {
    if (!window.velaMt5?.tradingStatus || !connected) return;
    const status = await window.velaMt5.tradingStatus();
    if (!status.armed && status.tradingAllowed && connected) {
      await window.velaMt5.armLiveTrading(true);
    }
  };
  if (!window.velaMt5) {
    connectButton.disabled = true;
    setConnectionStatus('The Electron MT5 bridge did not load. Restart Omega Desktop and check its preload error; Python setup can only be checked after the bridge loads.', 'error');
  }

  const provider = window.velaMt5 ? new Mt5DataProvider(window.velaMt5) : null;
  const orderJournalStatus = document.getElementById('mt5-order-journal-status');
  const setOrderJournalStatus = (message: string, isError = false) => {
    if (!orderJournalStatus) return;
    orderJournalStatus.textContent = message;
    orderJournalStatus.dataset.state = isError ? 'error' : 'info';
  };
  // Auto-arm Pine auto-trading on startup
  const autoArmPineAutoTrading = () => {
    let armedAccountId = getPineMt5AutoTradingAccountId();
    if (connected && !armedAccountId && tradingAccountId) {
      armPineMt5AutoTrading(tradingAccountId);
    }
    const selectedAccountId = localStorage.getItem('omega.selected-trading-account');
    if (armedAccountId && selectedAccountId && armedAccountId.toLowerCase() !== selectedAccountId.toLowerCase()) {
      if (selectedAccountId.toLowerCase().startsWith('mt5:')) {
        armPineMt5AutoTrading(selectedAccountId);
      }
    }
  };
  autoArmPineAutoTrading();
  document.addEventListener('omega:pine-auto-trading-state-changed', autoArmPineAutoTrading);
  document.addEventListener('omega:trading-account-selected', event => {
    const selected = (event as CustomEvent<{ id?: string }>).detail?.id;
    if (!tradingAccountId || selected?.toLowerCase() === tradingAccountId.toLowerCase()) return;
    if (!window.velaMt5) return;
    // Re-arm for the new account
    void window.velaMt5.armLiveTrading(true).catch(() => { /* ignore */ });
  });
  document.addEventListener('omega:mt5-live-disarmed', () => {
    // Re-arm automatically
    if (window.velaMt5 && connected) {
      void window.velaMt5.armLiveTrading(true).catch(() => { /* ignore */ });
    }
  });
  document.addEventListener('omega:trading-account-selected', event => {
    const selected = (event as CustomEvent<{ id?: string }>).detail?.id;
    const armed = getPineMt5AutoTradingAccountId();
    if (armed && selected?.toLowerCase() !== armed.toLowerCase() && selected) {
      armPineMt5AutoTrading(selected);
    }
  });
  const refreshOrderJournal = async () => {
    if (!window.velaMt5?.orderJournal || !orderJournalEntries) return;
    try {
      const journal = await window.velaMt5.orderJournal();
      orderJournalEntries.replaceChildren();
      if (!journal.available || !journal.integrity?.ok) {
        const warning = document.createElement('p');
        warning.className = 'mt5-order-journal-empty';
        warning.textContent = 'Order journal unavailable. Check current positions in MT5 before retrying an order.';
        orderJournalEntries.append(warning);
        return;
      }
      if (!journal.entries.length) {
        const empty = document.createElement('p');
        empty.className = 'mt5-order-journal-empty';
        empty.textContent = 'No journaled live orders.';
        orderJournalEntries.append(empty);
        return;
      }
      const openIds = new Set(journal.open.map(entry => entry.id));
      const visibleEntries = new Map<string, Mt5OrderJournalEntry>();
      for (const entry of [...journal.open, ...journal.entries.slice(0, 10)]) {
        visibleEntries.set(entry.id, entry);
      }
      for (const entry of visibleEntries.values()) {
        const row = document.createElement('div');
        row.className = 'mt5-order-journal-entry';
        const detail = document.createElement('p');
        const symbol = typeof entry.data?.symbol === 'string' ? entry.data.symbol : 'Order';
        const side = typeof entry.data?.side === 'string' ? entry.data.side : '';
        const volume = Number.isFinite(Number(entry.data?.volume)) ? `${entry.data.volume} lots` : '';
        detail.textContent = `${symbol} ${side} ${volume} · ${entry.status} · ${new Date(entry.updatedAt).toLocaleString()}`;
        row.append(detail);
        if (openIds.has(entry.id)) {
          const resolveButton = document.createElement('button');
          resolveButton.type = 'button';
          resolveButton.className = 'btn';
          resolveButton.textContent = 'Reconcile';
          resolveButton.addEventListener('click', async () => {
            if (!window.confirm(`Confirm that you checked MT5 and know the final state of ${symbol} ${side}? This only closes the journal warning; it does not change any broker position.`)) return;
            resolveButton.disabled = true;
            try {
              await window.velaMt5?.resolveOrderIntent({
                id: entry.id,
                note: 'Operator confirmed the order state in MT5 before allowing additional live orders.',
              });
              await refreshOrderJournal();
              setOrderJournalStatus('Order journal entry reconciled. Check current MT5 positions before trading.');
            } catch (error) {
              reportCaughtError('mt5:resolve-order-intent', error, 'Could not reconcile the MT5 order journal entry.');
              resolveButton.disabled = false;
              setOrderJournalStatus(error instanceof Error ? error.message : String(error), true);
            }
          });
          row.append(resolveButton);
        }
        orderJournalEntries.append(row);
      }
    } catch (error) {
      reportCaughtError('mt5:order-journal', error, 'Could not load the MT5 order journal.');
      setOrderJournalStatus(error instanceof Error ? error.message : String(error), true);
    }
  };
  const deactivate = () => {
    connected = false;
    if (tradingToolsPanel) tradingToolsPanel.hidden = true;
    revision += 1;
    provider?.disconnect();
    for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('mt5');
    if (tradingAccountId) {
      document.dispatchEvent(new CustomEvent('omega:trading-account-unavailable', { detail: tradingAccountId }));
    }
    tradingAccountId = null;
    connectButton.hidden = false;
    disconnectButton.hidden = true;
    if (window.velaMt5) setConnectionStatus('MT5 is not connected.');
  };
  const registerProvider = async (chart: VelaWorkspace['chart'], expectedRevision: number) => {
    if (!provider || !connected || expectedRevision !== revision) return;
    chart.data.registerProvider('mt5', provider);
    // A chart whose data engine never reports ready must not hang the whole connection. This
    // await is what left the panel stuck on "Connecting…" after a perfectly good connect.
    await Promise.race([
      chart.data.ready(),
      new Promise<void>((_, reject) => window.setTimeout(
        () => reject(new Error('the chart data engine did not become ready within 10 seconds')),
        10_000,
      )),
    ]);
    if (!connected || expectedRevision !== revision) chart.data.unregisterProvider('mt5');
  };
  const registerWorkspace = async (expectedRevision: number) => {
    const workspace = getWorkspace();
    // allSettled: one unresponsive chart must not discard the results of the others.
    const results = await Promise.allSettled(workspace.cells().map(cell => registerProvider(cell.chart, expectedRevision)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failure) throw failure.reason;
  };
  getWorkspace().on('cell:created', event => {
    if (!connected) return;
    const cell = getWorkspace().cell(event.id);
    if (cell) void registerProvider(cell.chart, revision).catch(error => {
      reportCaughtError('mt5:register-provider', error, 'Could not attach the MT5 feed to a new chart.');
      setConnectionStatus(`MT5 is connected, but the feed could not be attached to a new chart: ${error instanceof Error ? error.message : String(error)}`, 'error');
    });
  });
  document.addEventListener('omega:trading-broker-connecting', deactivate);
  document.addEventListener('omega:trading-broker-connected', event => {
    if ((event as CustomEvent<string>).detail !== 'mt5') deactivate();
  });

  openButton.addEventListener('click', () => {
    modal.hidden = false;
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
    void refreshLiveTradingState().catch(error => {
      reportCaughtError('mt5:trading-status', error, 'Could not refresh MT5 live-order session status.');
    });
  });
  const closeModal = () => {
    modal.hidden = true;
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  };
  closeButton.addEventListener('click', closeModal);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.classList.contains('open')) closeModal();
  });

  connectButton.addEventListener('click', async () => {
    if (!window.velaMt5 || !provider) {
      setConnectionStatus('The Electron MT5 bridge did not load. Restart Omega Desktop and check its preload error; Python setup can only be checked after the bridge loads.', 'error');
      return;
    }
    connectButton.disabled = true;
    setConnectionStatus('Connecting to the local MetaTrader 5 terminal…');
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'mt5' }));
    const attemptRevision = revision;
    try {
      const connection = await window.velaMt5.connect(executableInput?.value.trim() || undefined);
      if (attemptRevision !== revision) return;
      provider.setSymbols(connection.symbols);
      connected = true;
      if (tradingToolsPanel) tradingToolsPanel.hidden = false;
      const connectedRevision = ++revision;
      const accountLogin = connection.accountLogin || 'unknown-account';
      const accountServer = connection.server || connection.terminal || 'unknown-server';
      tradingAccountId = `mt5:${accountLogin}@${accountServer}`;
      // Ensure live trading and Pine strategy auto-trading are ARMED by default
      if (connection.tradingAllowed) {
        try {
          await window.velaMt5.armLiveTrading(true);
        } catch (error) {
          reportCaughtError('mt5:arm-live', error, 'MT5 is connected, but its live-order session could not be enabled.');
        }
      }
      if (connectedRevision !== revision) return;
      armPineMt5AutoTrading(tradingAccountId);
      document.dispatchEvent(new CustomEvent('omega:trading-account-available', {
        detail: {
          id: tradingAccountId,
          label: `MT5 · ${accountLogin} @ ${accountServer}`,
          mode: (connection.accountMode ?? 'unknown').toUpperCase(),
          detail: `MT5 market data · ${connection.tradingAllowed ? 'trading allowed' : 'check Algo Trading and account permissions in MT5'}`,
        },
      }));
      connectButton.hidden = true;
      disconnectButton.hidden = false;
      setConnectionStatus(`Connected to ${connection.company || connection.terminal || 'MetaTrader 5'} · ${accountLogin} @ ${accountServer}. Select MT5 instruments in the chart symbol picker.${connection.tradingAllowed ? '' : ' For orders, enable Algo Trading in MT5 and check account permissions.'}`, 'success');
      void refreshLiveTradingState().catch(error => {
        reportCaughtError('mt5:trading-status', error, 'Could not load MT5 live-order session status.');
      });
      document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'mt5' }));
      void refreshOrderJournal();

      // Attaching the feed to each chart happens AFTER the panel shows the connection. It
      // used to be awaited first, and chart.data.ready() never resolved for a chart with no
      // pending request, so a connect that finished in 641 ms left the panel frozen.
      void registerWorkspace(connectedRevision).then(() => {
        // Auto-load EURUSD on the active chart when the feed is ready and no symbol is selected yet.
        if (connectedRevision === revision && connected) {
          const activeChart = getWorkspace().active;
          const currentSymbol = activeChart?.chart?.market?.symbol ?? '';
          if (!currentSymbol || currentSymbol === 'AAPL') {
            const eurusd = connection.symbols.find(s => s.ticker.toUpperCase().replace(/[^A-Z]/g, '') === 'EURUSD');
            if (eurusd) activeChart.setSymbol(`MT5:${eurusd.ticker}`);
          }
        }
      }).catch(error => {
        reportCaughtError('mt5:register-provider', error, 'MT5 connected, but the chart feed could not be attached.');
        setConnectionStatus(`MT5 connected, but the chart feed could not be attached: ${error instanceof Error ? error.message : String(error)}`, 'error');
      });
    } catch (error) {
      if (attemptRevision !== revision) return;
      connected = false;
      provider.disconnect();
      for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('mt5');
      const details = error instanceof Error ? error.message : String(error);
      reportCaughtError('mt5:connect', error, 'Could not connect to the local MetaTrader 5 terminal.');
      setConnectionStatus(`Could not connect to MT5: ${details}`, 'error');
    } finally {
      connectButton.disabled = false;
    }
  });

  orderJournalRefreshButton?.addEventListener('click', () => void refreshOrderJournal());

  const disconnectFeed = async (): Promise<void> => {
    if (!window.velaMt5) return;
    for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('mt5');
    // Never call into the main process when nothing is connected: during the account
    // re-render loop this turned into tens of thousands of pointless IPC round trips a
    // minute. Staying idle here is what makes the guard effective.
    if (!connected) {
      deactivate();
      return;
    }
    await window.velaMt5.disconnect();
    deactivate();
    document.dispatchEvent(new CustomEvent('omega:trading-broker-disconnected', { detail: 'mt5' }));
  };

  // Only one broker may stay connected: an account from another broker was selected.
  document.addEventListener('omega:trading-broker-exclusive', event => {
    const provider = String((event as CustomEvent<string>).detail ?? '').toLowerCase();
    if (!provider || provider === 'mt5') return;
    void disconnectFeed().catch(() => {
      // Keep automatic provider switches quiet.
    });
  });

  disconnectButton.addEventListener('click', async () => {
    if (!window.velaMt5) return;
    disconnectButton.disabled = true;
    try {
      await disconnectFeed();
    } catch (error) {
      reportCaughtError('mt5:disconnect', error, 'Could not disconnect from the local MetaTrader 5 terminal.');
      setConnectionStatus(`Could not disconnect from MT5: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      disconnectButton.disabled = false;
    }
  });

}
