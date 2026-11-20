import { fetchBidAskQuote } from './bidAskLines';
import { resolveChartOrderRoute } from './tradingAccountStatus';
import {
  type IndicatorHandle,
  type Vela,
} from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { inferPipSize } from './pipSize';
import { configureTradingSounds, playTradingSound, type TradingSoundEvent } from './tradingSounds';
import { reportCaughtError } from './diagnostics';
import { clientPointToElementLocal } from './chartPointerCoordinates';
import {
  clampTradesPaneHeight,
  DEFAULT_TRADES_PANE_HEIGHT,
  maxTradesPaneHeight,
} from './tradesPaneSizing';
import { guardBar } from './trading/marketDataGuards';
import { orderIntentKey, releaseOrderIntent, requestOrderIntent } from './trading/idempotency';
import { resolveTradePreviewPreferences, shouldPreviewTrade } from './trading/tradePreviewPreferences';
import { alignMt5ProtectionPrices, assertFreshMt5Quote, assertSelectedMt5Account, isFreshBrokerQuote, isFreshMt5Quote } from './chartMt5Orders';
import {
  calculatePaperTradePnl,
  calculateRoundTurnTradeFee,
  createConfiguredProtectionLevels,
  formatPaperTradePnl,
  formatPaperTradeProtectionLabel,
  moveProtectionLevel,
  type PaperTradeSide,
  shouldTriggerPendingPaperOrder,
  type ProtectionConfig,
  type ProtectionMode,
} from './paperTradeMath';
import { calculatePaperAccount, type PaperLedgerTrade } from './paperTradingAnalytics';
import { summarizeCurrentChartPnl } from './currentChartPnl';
import { createSingleFlightGate } from './singleFlight';
import { calculateAtr14, mergeLoadedCandleBars, readLoadedCandleBars } from './loadedCandleData';
import {
  cleanPaperTradeSymbol as cleanSymbol,
  formatPaperTradeLots as formatLots,
  formatPaperTradePrice as formatPrice,
  getPaperTradeContractSize as getContractSize,
  getPaperTradeMinTick as getMinTick,
  getPaperTradePipSize as getPipSize,
  getPaperTradeQuoteCurrency as getQuoteCurrency,
  readPaperTradeInstrument,
} from './paperTradeInstrument';
import {
  QUICK_TRADE_LAYER_ID,
  setPaperTradeOverlayTransparency,
  type OverlayAction,
  type TradeLineRole,
  type TradeOverlayCanvas,
  type TradeOverlayAction,
  type TradeOverlayHit,
  type TradeOverlayLevel,
  isTradeOverlayLabelHit,
  isTradePlotX,
  resolveMeasurementPoint,
} from './paperTradeOverlay';
import { resolvePineStrategyProtection, strategyBrokerEntrySide, strategyBrokerOrderSide, toInternalStrategyPaperTrades, type InternalStrategyPaperTrade, type StrategyTradeSnapshot } from './strategyPaperTrades';
import { submitPineLiveFill } from './pineLiveExecution';
import { isPineMt5AutoTradingArmed } from './pineStrategyAutoTrading';
import { isPineQuantowerAutoTradingArmed } from './pineQuantowerAutoTrading';
import { areLiveStrategyFillsAllowed } from './replayState';
import { isPineIbkrAutoTradingArmed } from './pineIbkrAutoTrading';
import { isPineSaxoAutoTradingArmed } from './pineSaxoAutoTrading';
import { fetchCTraderSpot, parseCTraderDetails } from './ctraderFeed';
import { validateCTraderLots } from './ctraderTrading';
import { parsePaperTrades, preservePaperTradeState } from './paperTradePersistence';
import { initializeWatchlist } from './watchlist';

const STORAGE_KEY = 'omega-paper-trades-v1';
const PENDING_STORAGE_KEY = 'omega-paper-pending-orders-v1';
const HISTORY_STORAGE_KEY = 'omega-paper-trades-history-v1';
const SETTINGS_STORAGE_KEY = 'omega-paper-trade-settings-v1';
const PREFERENCES_STORAGE_KEY = 'omega-paper-trade-preferences-v1';
const DEFAULT_PAPER_CAPITAL = 25_000;
const POSITION_COLOR = '#2962ff';
const TARGET_COLOR = '#089981';
const STOP_COLOR = '#f23645';

// Get theme-aware colors for chart overlay
function getTradeLineColor(role: TradeLineRole): string {
  const configuredColor = role === 'entry' ? tradeRectangleAppearance.entryColor
    : role === 'stopLoss' ? tradeRectangleAppearance.stopLossColor
      : tradeRectangleAppearance.takeProfitColor;
  if (configuredColor) return configuredColor;
  const isLight = document.body.dataset.theme === 'light';
  if (role === 'entry') return isLight ? '#1d4ed8' : POSITION_COLOR;
  if (role === 'stopLoss') return isLight ? '#dc2626' : STOP_COLOR;
  return isLight ? '#059669' : TARGET_COLOR;
}

interface TradeRectangleAppearance {
  entryColor: string | null;
  stopLossColor: string | null;
  takeProfitColor: string | null;
  transparency: number;
}

interface PaperTradePreferences {
  defaultLots: number;
  quickLots: [number, number, number, number];
  confirmOpenActions: boolean;
  soundsEnabled: boolean;
  soundVolume: number;
  maxOpenTrades: number;
  previewTrade: boolean;
  dontAskAgain: boolean;
}

const DEFAULT_TRADE_PREFERENCES: PaperTradePreferences = {
  defaultLots: 0.01,
  quickLots: [0.01, 0.1, 1, 5],
  confirmOpenActions: true,
  soundsEnabled: true,
  soundVolume: 50,
  maxOpenTrades: 0,
  previewTrade: true,
  dontAskAgain: false,
};

interface BrokerChartPosition {
  positionId: string;
  symbol: string;
  side: string;
  volume: string;
  entryPrice: number;
  stopLoss?: number;
  takeProfit?: number;
}

export interface ClosedPaperTrade extends PaperLedgerTrade {
  id: string;
  symbol: string;
  side: PaperTradeSide;
  lots: number;
  entryPrice: number;
  entryTime: number;
  closePrice: number;
  closeTime: number;
  pnl: number;
  currency: string;
  reason: string;
  minTick?: number;
}

interface PaperTrade {
  id: string;
  cellId: string;
  symbol: string;
  side: PaperTradeSide;
  lots: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  contractSize: number;
  currency: string;
  minTick: number;
  entryTime: number;
  labelTime: number;
  /** Last close seen for this trade's own symbol (not the cell's instrument). */
  lastKnownPrice?: number;
  brokerQuoteSymbol?: string;
  drawingIds: Record<TradeLineRole, string>;
  labelIds: Record<TradeLineRole, string>;
}

interface PendingPaperOrder {
  id: string;
  cellId: string;
  symbol: string;
  side: PaperTradeSide;
  orderType: 'limit' | 'stop';
  lots: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  contractSize: number;
  currency: string;
  minTick: number;
  createdAt: number;
  createdAfterBarTime: number;
}

interface ChartState {
  cellId: string;
  chart: Vela;
  host: HTMLElement;
  lastPrice: number | null;
  lastBarTime: number | null;
  atr14: number | null;
  atrHistoryKey: string;
  atrHistoryRequest: { key: string; promise: Promise<void> } | null;
  recentBars: Array<{ time: number; high: number; low: number; close: number }>;
  draggingLevel: { tradeId: string; role: 'stopLoss' | 'takeProfit'; preview: boolean } | null;
  dragChanged: boolean;
  hoveredLevelId: string | null;
  hoveredControlId: string | null;
  tradeOverlay: IndicatorHandle;
  pnlElement: HTMLDivElement;
  disposers: Array<() => void>;
}
let workspaceRef: VelaWorkspace | null = null;
let initializedTradingPane: HTMLElement | null = null;
let refreshTradingPane: (() => void) | null = null;
const chartStates = new Map<string, ChartState>();
const trades = new Map<string, PaperTrade>();
const strategyTradesByCell = new Map<string, InternalStrategyPaperTrade[]>();
const strategyBrokerTradesByCell = new Map<string, Map<string, StrategyTradeSnapshot>>();
const strategyBrokerBaselineCells = new Set<string>();
const strategyBrokerOrderIntents = new Set<string>();
interface PineStrategyFillPreview {
  state: ChartState;
  strategyId: string;
  trade: StrategyTradeSnapshot;
  action: 'open' | 'close';
  quantity: number;
  accountId: string;
  symbol: string;
  tradePositionKey: string;
  intentKey: string;
  createdAt: number;
  stopLoss?: number;
  takeProfit?: number;
}
const pineStrategyFillPreviews: PineStrategyFillPreview[] = [];
const MAX_PINE_STRATEGY_PREVIEWS = 25;
const PINE_STRATEGY_PREVIEW_TTL_MS = 30_000;
let activePineStrategyFillPreview: PineStrategyFillPreview | null = null;
let pineStrategyPreviewElement: HTMLDivElement | null = null;
let pineStrategyPreviewTimeout: number | undefined;
const strategySyncingCells = new Set<string>();
const brokerChartPositions = new Map<string, BrokerChartPosition>();
const tradeCreationGate = createSingleFlightGate();
const liveOrderSubmissionGate = createSingleFlightGate();
let overlayRenderFrame: number | null = null;
const restoredCells = new Set<string>();
let savedTrades: PaperTrade[] = [];
let savedTradeRecoveryBlocked = false;
let pendingOrders = readPendingOrders();
let closedTradesHistory: ClosedPaperTrade[] = readClosedTrades();
let protectionSettings: ProtectionConfig = readProtectionSettings();
let tradeRectangleAppearance: TradeRectangleAppearance = readTradeRectangleAppearance();
let tradePreferences = readTradePreferences();
const paperInitialCapital = DEFAULT_PAPER_CAPITAL;
let pendingOpenTrade: PaperTrade | null = null;
let pendingOpenTradeState: ChartState | null = null;
let pendingOpenTradeIsLive = false;
let pendingLiveAccountId: string | null = null;
let pendingLiveAccountMode: string | null = null;
let pendingLiveQuoteTimeMsc: number | null = null;
let pendingOrderContext: ChartState | null = null;
let pendingModalInitialized = false;
let refreshPendingProtectionPreview: (() => void) | null = null;
let refreshTradingPaneProtectionEstimate: (() => void) | null = null;
let tradeClickAudioContext: AudioContext | null = null;
let refreshOpenTradesList: (() => void) | null = null;

setPaperTradeOverlayTransparency(() => tradeRectangleAppearance.transparency);

function readTradePreferences(): PaperTradePreferences {
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TRADE_PREFERENCES, quickLots: [...DEFAULT_TRADE_PREFERENCES.quickLots] };
    const stored = JSON.parse(raw) as Partial<PaperTradePreferences>;
    const positiveLots = (value: unknown, fallback: number) => {
      const lots = Number(value);
      return Number.isFinite(lots) && lots >= 0.01 ? Math.min(lots, 100_000) : fallback;
    };
    const quickLots: PaperTradePreferences['quickLots'] = Array.isArray(stored.quickLots)
      ? [
        positiveLots(stored.quickLots[0], DEFAULT_TRADE_PREFERENCES.quickLots[0]),
        positiveLots(stored.quickLots[1], DEFAULT_TRADE_PREFERENCES.quickLots[1]),
        positiveLots(stored.quickLots[2], DEFAULT_TRADE_PREFERENCES.quickLots[2]),
        positiveLots(stored.quickLots[3], DEFAULT_TRADE_PREFERENCES.quickLots[3]),
      ]
      : [...DEFAULT_TRADE_PREFERENCES.quickLots];
    return resolveTradePreviewPreferences({
      defaultLots: positiveLots(stored.defaultLots, DEFAULT_TRADE_PREFERENCES.defaultLots),
      quickLots,
      confirmOpenActions: typeof stored.confirmOpenActions === 'boolean' ? stored.confirmOpenActions : true,
      soundsEnabled: typeof stored.soundsEnabled === 'boolean' ? stored.soundsEnabled : true,
      soundVolume: Number.isFinite(stored.soundVolume) ? Math.max(0, Math.min(100, Number(stored.soundVolume))) : 50,
      maxOpenTrades: Number.isInteger(stored.maxOpenTrades) ? Math.max(0, Math.min(100_000, Number(stored.maxOpenTrades))) : 0,
      previewTrade: typeof stored.previewTrade === 'boolean' ? stored.previewTrade : DEFAULT_TRADE_PREFERENCES.previewTrade,
      dontAskAgain: typeof stored.dontAskAgain === 'boolean' ? stored.dontAskAgain : DEFAULT_TRADE_PREFERENCES.dontAskAgain,
    });
  } catch (error) {
    console.warn('Could not read paper-trade preferences; using defaults:', error);
    return { ...DEFAULT_TRADE_PREFERENCES, quickLots: [...DEFAULT_TRADE_PREFERENCES.quickLots] };
  }
}

function saveTradePreferences(): void {
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(tradePreferences));
  } catch (error) {
    console.warn('Could not save paper-trade preferences:', error);
    setStatus(`Could not save trade preferences: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function readClosedTrades(): ClosedPaperTrade[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.flatMap(item => {
      const trade = item as Partial<ClosedPaperTrade>;
      const entryTime = Number.isFinite(trade.entryTime) ? trade.entryTime : trade.closeTime;
      if (typeof trade.id !== 'string'
        || (trade.side !== 'buy' && trade.side !== 'sell')
        || typeof trade.symbol !== 'string'
        || typeof trade.currency !== 'string'
        || !Number.isFinite(trade.lots) || (trade.lots as number) <= 0
        || !Number.isFinite(trade.entryPrice) || (trade.entryPrice as number) <= 0
        || !Number.isFinite(trade.closePrice) || (trade.closePrice as number) <= 0
        || !Number.isFinite(trade.pnl)
        || !Number.isFinite(entryTime)
        || !Number.isFinite(trade.closeTime)) return [];
      return [{ ...trade, entryTime, reason: typeof trade.reason === 'string' ? trade.reason : 'closed' } as ClosedPaperTrade];
    }) : [];
  } catch (error) {
    // Trade history is money data: losing it silently would look like "there were never
    // any trades". Report it, then keep the platform usable with an empty history.
    reportCaughtError('paper-trading:read-history', error, 'Closed trade history could not be read; starting from an empty history.');
    return [];
  }
}

function saveClosedTrades(): void {
  try {
    // Keep a generous window so the list does not silently lose older trades
    // between sessions while still bounding localStorage usage.
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(closedTradesHistory.slice(0, 2000)));
  } catch (err) {
    console.warn('Could not save trade history:', err);
  }
}

function readProtectionSettings(): ProtectionConfig {
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ProtectionConfig>;
      if ((parsed.mode === 'pips' || parsed.mode === 'atr') && Number.isFinite(parsed.slValue) && Number.isFinite(parsed.tpValue)) {
        return {
          mode: parsed.mode,
          slValue: Math.max(0.1, Number(parsed.slValue)),
          tpValue: Math.max(0.1, Number(parsed.tpValue)),
        };
      }
    }
  } catch (error) {
    console.warn('Could not read paper-trade protection settings; using defaults:', error);
  }
  return { mode: 'pips', slValue: 20, tpValue: 40 };
}

function readTradeRectangleAppearance(): TradeRectangleAppearance {
  const defaults: TradeRectangleAppearance = {
    entryColor: null,
    stopLossColor: null,
    takeProfitColor: null,
    transparency: 18,
  };
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<TradeRectangleAppearance>;
    return {
      entryColor: typeof parsed.entryColor === 'string' && /^#[\da-f]{6}$/i.test(parsed.entryColor) ? parsed.entryColor : null,
      stopLossColor: typeof parsed.stopLossColor === 'string' && /^#[\da-f]{6}$/i.test(parsed.stopLossColor) ? parsed.stopLossColor : null,
      takeProfitColor: typeof parsed.takeProfitColor === 'string' && /^#[\da-f]{6}$/i.test(parsed.takeProfitColor) ? parsed.takeProfitColor : null,
      transparency: Number.isFinite(parsed.transparency) ? Math.max(0, Math.min(80, Number(parsed.transparency))) : defaults.transparency,
    };
  } catch (error) {
    console.warn('Could not read trade rectangle appearance settings; using defaults:', error);
    return defaults;
  }
}

function saveProtectionSettings(): void {
  try {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...protectionSettings, ...tradeRectangleAppearance }));
  } catch (error) {
    console.warn('Could not save paper-trade settings:', error);
    setStatus(`Could not save paper-trade settings: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function computeAtr14(bars: Array<{ time: number; high: number; low: number; close: number }>): number | null {
  return calculateAtr14(bars);
}

function refreshLoadedCandleHistory(state: ChartState): Promise<void> {
  const symbol = state.chart.market.symbol ?? '';
  const timeframe = state.chart.market.timeframe ?? '';
  const resolved = symbol ? state.chart.data.resolve(symbol) : null;
  if (!resolved || !timeframe) {
    state.atr14 = null;
    return Promise.resolve();
  }
  const key = `${resolved.provider}:${resolved.ticker}|${timeframe}`;
  if (state.atrHistoryKey === key && state.atr14 !== null) return Promise.resolve();
  if (state.atrHistoryRequest?.key === key) return state.atrHistoryRequest.promise;

  // The chart already holds the loaded candle history — read it directly instead of
  // making a second provider request, then fetch from the provider only when the
  // chart cannot supply the 15 bars ATR(14) needs.
  const chartSource = (state.chart as unknown as { bars?: () => unknown }).bars?.()
    ?? (state.chart.data as unknown as { bars?: () => unknown }).bars?.() ?? [];
  const chartBars = readLoadedCandleBars(chartSource);
  if (chartBars.length >= 15) {
    state.recentBars = mergeLoadedCandleBars(chartBars, state.recentBars, 50);
    state.atr14 = computeAtr14(state.recentBars);
    if (state.atr14 !== null) {
      state.atrHistoryKey = key;
      return Promise.resolve();
    }
  }

  const provider = state.chart.data.providerInstance(resolved.provider);
  if (!provider) {
    state.atr14 = null;
    return Promise.resolve();
  }

  state.atr14 = null;
  const promise = provider.getBars(resolved.ticker, timeframe, { limit: 50 })
    .then(bars => {
      const current = state.chart.data.resolve(state.chart.market.symbol ?? '');
      if (state.chart.market.timeframe !== timeframe || current?.provider !== resolved.provider
        || current.ticker !== resolved.ticker) return;
      const loaded = readLoadedCandleBars(bars);
      if (loaded.length) state.recentBars = mergeLoadedCandleBars(loaded, state.recentBars, 50);
      state.atrHistoryKey = key;
      state.atr14 = computeAtr14(state.recentBars);
      const last = state.recentBars.at(-1);
      if (last && (state.lastPrice === null || !Number.isFinite(state.lastPrice))) {
        state.lastPrice = last.close;
        state.lastBarTime = last.time;
      }
      if (getActiveTradeState()?.cellId === state.cellId) {
        updateTradingPaneMarketData();
        refreshTradingPaneProtectionEstimate?.();
        refreshPendingProtectionPreview?.();
      }
    })
    .catch(error => {
      reportCaughtError('paper-trade:atr-history', error, `Could not load chart history for ATR(14) on ${symbol}.`);
    })
    .finally(() => {
      if (state.atrHistoryRequest?.promise === promise) state.atrHistoryRequest = null;
    });
  state.atrHistoryRequest = { key, promise };
  return promise;
}

function playTradeSound(kind: TradingSoundEvent = 'level'): void {
  // The trade preferences are the single source of truth for sound settings, so mirror
  // them into the engine on every play instead of keeping a second copy in sync.
  configureTradingSounds({ enabled: tradePreferences.soundsEnabled, volume: tradePreferences.soundVolume });
  playTradingSound(kind);
}

const lotsInput = document.getElementById('paper-trade-lots') as HTMLInputElement;
const buyButton = document.getElementById('paper-trade-buy') as HTMLButtonElement;
const sellButton = document.getElementById('paper-trade-sell') as HTMLButtonElement;
const statusElement = document.getElementById('paper-trade-status') as HTMLSpanElement;

function setStatus(message: string, state: 'error' | 'info' | 'success' | '' = ''): void {
  statusElement.textContent = '';
  delete statusElement.dataset.state;
  writeActivity(message, state || 'info');
  if (state === 'error') {
    document.getElementById('activity-console')?.removeAttribute('hidden');
    document.getElementById('activity-console-toggle')?.classList.add('active');
  }
}

function hidePendingOrderModal(): void {
  const modal = document.getElementById('paper-pending-order-modal');
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  pendingOrderContext = null;
}

export function openPendingOrderDialog(chart: Vela, pointerPrice: number | null | undefined): void {
  const state = [...chartStates.values()].find(candidate => candidate.chart === chart);
  const price = Number(pointerPrice);
  const symbol = chart.market.symbol;
  if (!state || !symbol || !Number.isFinite(price) || price <= 0) {
    setStatus('Right-click a price on the chart to add a pending paper order.', 'error');
    return;
  }
  const modal = document.getElementById('paper-pending-order-modal') as HTMLDivElement | null;
  const symbolLabel = document.getElementById('paper-pending-order-symbol');
  const entryInput = document.getElementById('paper-pending-order-entry') as HTMLInputElement | null;
  const lotsField = document.getElementById('paper-pending-order-lots') as HTMLInputElement | null;
  const sideField = document.getElementById('paper-pending-order-side') as HTMLSelectElement | null;
  const protectionMode = document.getElementById('paper-pending-order-protection-mode') as HTMLSelectElement | null;
  const stopField = document.getElementById('paper-pending-order-sl-value') as HTMLInputElement | null;
  const targetField = document.getElementById('paper-pending-order-tp-value') as HTMLInputElement | null;
  const message = document.getElementById('paper-pending-order-message');
  if (!modal || !entryInput || !lotsField || !sideField || !protectionMode || !stopField || !targetField || !message) {
    setStatus('Pending-order form is unavailable.', 'error');
    return;
  }
  pendingOrderContext = state;
  const resolved = chart.data.resolve(symbol);
  const ticker = resolved?.ticker ?? symbol;
  const minTick = getMinTick(ticker, undefined);
  const initialSide: PaperTradeSide = 'buy';
  if (symbolLabel) symbolLabel.textContent = symbol;
  entryInput.value = formatPrice(price, minTick);
  // The dialog opens synchronously; refine the pre-filled price once the
  // provider's real tick size is known so it is not rounded to a coarse guess.
  void chart.data.symbolInfo(symbol).then(rawInfo => {
    if (pendingOrderContext !== state || modal.hidden) return;
    const preciseTick = getMinTick(ticker, rawInfo as Record<string, unknown> | undefined);
    const current = Number(entryInput.value);
    if (preciseTick === minTick || !Number.isFinite(current)) return;
    if (formatPrice(current, minTick) !== entryInput.value) return;
    entryInput.value = formatPrice(price, preciseTick);
    refreshPendingProtectionPreview?.();
  }).catch(error => {
    reportCaughtError('paper-trade:entry-price', error, 'Live price could not be written into the entry field.');
  });
  lotsField.value = lotsInput.value || '0.10';
  sideField.value = initialSide;
  protectionMode.value = protectionSettings.mode;
  stopField.value = String(protectionSettings.slValue);
  targetField.value = String(protectionSettings.tpValue);
  message.textContent = '';
  delete message.dataset.state;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  refreshPendingProtectionPreview?.();
  entryInput.focus();
}

function findPendingPaperOrderAtPrice(chart: Vela, pointerPrice: number | null | undefined): PendingPaperOrder | undefined {
  const state = [...chartStates.values()].find(candidate => candidate.chart === chart);
  const price = Number(pointerPrice);
  if (!state || !Number.isFinite(price) || price <= 0) return undefined;
  const candidates = pendingOrders
    .filter(order => order.cellId === state.cellId && cleanSymbol(order.symbol) === cleanSymbol(chart.market.symbol))
    .map(order => ({ order, distance: Math.abs(order.entryPrice - price) }))
    .filter(({ order, distance }) => distance <= Math.max(order.minTick * 4, order.entryPrice * 1e-8))
    .sort((left, right) => left.distance - right.distance);
  return candidates[0]?.order;
}

export function hasPendingPaperOrderAtPrice(chart: Vela, pointerPrice: number | null | undefined): boolean {
  return Boolean(findPendingPaperOrderAtPrice(chart, pointerPrice));
}

export function cancelPendingPaperOrderAtPrice(chart: Vela, pointerPrice: number | null | undefined): boolean {
  const match = findPendingPaperOrderAtPrice(chart, pointerPrice);
  if (!match) return false;
  return cancelPendingPaperOrder(match);
}

function cancelPendingPaperOrder(order: PendingPaperOrder): boolean {
  if (!pendingOrders.some(candidate => candidate.id === order.id)) return false;
  pendingOrders = pendingOrders.filter(candidate => candidate.id !== order.id);
  savePendingOrders();
  updateAllTradeOverlays();
  setStatus(`${order.side.toUpperCase()} pending paper order at ${formatPrice(order.entryPrice, order.minTick)} cancelled.`, 'success');
  return true;
}

function initializePendingOrderModal(): void {
  if (pendingModalInitialized) return;
  const modal = document.getElementById('paper-pending-order-modal') as HTMLDivElement | null;
  const form = document.getElementById('paper-pending-order-form') as HTMLFormElement | null;
  const closeButton = document.getElementById('paper-pending-order-close') as HTMLButtonElement | null;
  const cancelButton = document.getElementById('paper-pending-order-cancel') as HTMLButtonElement | null;
  const sideField = document.getElementById('paper-pending-order-side') as HTMLSelectElement | null;
  const entryField = document.getElementById('paper-pending-order-entry') as HTMLInputElement | null;
  const protectionMode = document.getElementById('paper-pending-order-protection-mode') as HTMLSelectElement | null;
  const stopField = document.getElementById('paper-pending-order-sl-value') as HTMLInputElement | null;
  const targetField = document.getElementById('paper-pending-order-tp-value') as HTMLInputElement | null;
  const lotsField = document.getElementById('paper-pending-order-lots') as HTMLInputElement | null;
  const message = document.getElementById('paper-pending-order-message');
  const submitButton = document.getElementById('paper-pending-order-submit') as HTMLButtonElement | null;
  const stopLabel = document.getElementById('paper-pending-order-sl-label');
  const targetLabel = document.getElementById('paper-pending-order-tp-label');
  const preview = document.getElementById('paper-pending-order-protection-preview');
  if (!modal || !form || !closeButton || !cancelButton || !sideField || !entryField || !protectionMode || !stopField || !targetField || !lotsField || !message || !submitButton) return;
  pendingModalInitialized = true;
  const submissionGate = createSingleFlightGate();

  const close = () => hidePendingOrderModal();
  closeButton.addEventListener('click', close);
  cancelButton.addEventListener('click', close);
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  const updateProtectionPreview = () => {
    const state = pendingOrderContext;
    const entry = Number(entryField.value);
    const mode: ProtectionMode = protectionMode.value === 'atr' ? 'atr' : 'pips';
    const unit = mode === 'atr' ? 'ATR multiplier' : 'pips';
    if (stopLabel) stopLabel.textContent = `Stop loss (${unit})`;
    if (targetLabel) targetLabel.textContent = `Take profit (${unit})`;
    if (!state || !Number.isFinite(entry) || entry <= 0) return;
    try {
      void refreshLoadedCandleHistory(state);
      const symbol = state.chart.market.symbol ?? '';
      const ticker = state.chart.data.resolve(symbol)?.ticker ?? symbol;
      const minTick = getMinTick(ticker, undefined);
      const levels = createConfiguredProtectionLevels(sideField.value as PaperTradeSide, entry, minTick, {
        mode,
        slValue: Number(stopField.value),
        tpValue: Number(targetField.value),
      }, state.atr14, getPipSize(ticker, undefined));
      if (preview) preview.textContent = `Protection prices: SL ${formatPrice(levels.stopLoss, minTick)} · TP ${formatPrice(levels.takeProfit, minTick)}.`;
      message.textContent = '';
      delete message.dataset.state;
    } catch (error) {
      if (preview) preview.textContent = error instanceof Error ? error.message : String(error);
    }
  };
  refreshPendingProtectionPreview = updateProtectionPreview;
  sideField.addEventListener('change', updateProtectionPreview);
  entryField.addEventListener('input', updateProtectionPreview);
  protectionMode.addEventListener('change', updateProtectionPreview);
  stopField.addEventListener('input', updateProtectionPreview);
  targetField.addEventListener('input', updateProtectionPreview);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const state = pendingOrderContext;
    if (!state) return;
    const symbol = state.chart.market.symbol;
    const side = sideField.value as PaperTradeSide;
    const lots = Number(lotsField.value);
    const entryPrice = Number(entryField.value);
    const mode: ProtectionMode = protectionMode.value === 'atr' ? 'atr' : 'pips';
    const slValue = Number(stopField.value);
    const tpValue = Number(targetField.value);
    const marketPrice = state.lastPrice;
    if (!symbol || !state.chart.data.resolve(symbol)) {
      message.textContent = 'The chart symbol has no available market-data provider.';
      message.dataset.state = 'error';
      return;
    }
    if (!Number.isFinite(lots) || lots < 0.01 || !Number.isFinite(entryPrice) || entryPrice <= 0
      || !Number.isFinite(slValue) || !Number.isFinite(tpValue) || slValue <= 0 || tpValue <= 0) {
      message.textContent = 'Enter a valid volume, entry price, stop-loss and take-profit protection values.';
      message.dataset.state = 'error';
      return;
    }
    if (marketPrice === null || !Number.isFinite(marketPrice) || marketPrice <= 0) {
      message.textContent = 'Waiting for a current chart price.';
      message.dataset.state = 'error';
      return;
    }
    if (Math.abs(entryPrice - marketPrice) < Number.EPSILON) {
      message.textContent = 'Pending entry must be above or below the current market price.';
      message.dataset.state = 'error';
      return;
    }

    const releaseSubmission = submissionGate.acquire();
    if (!releaseSubmission) return;
    submitButton.disabled = true;
    message.textContent = 'Validating symbol details…';
    delete message.dataset.state;
    try {
      await refreshLoadedCandleHistory(state);
      const info = await state.chart.data.symbolInfo(symbol) as Record<string, unknown> | undefined;
      if (state.chart.market.symbol !== symbol) throw new Error('The chart symbol changed before the pending order was saved.');
      const resolved = state.chart.data.resolve(symbol);
      if (!resolved) throw new Error(`No market-data provider is available for ${symbol}.`);
      const ticker = resolved.ticker;
      const minTick = getMinTick(ticker, info);
      const protection = createConfiguredProtectionLevels(side, entryPrice, minTick, {
        mode,
        slValue,
        tpValue,
      }, state.atr14, getPipSize(ticker, info));
      if (Math.abs(entryPrice - marketPrice) < minTick * 0.5) {
        throw new Error('Entry or protection prices are invalid for this instrument.');
      }
      const orderType: PendingPaperOrder['orderType'] = side === 'buy'
        ? entryPrice < marketPrice ? 'limit' : 'stop'
        : entryPrice > marketPrice ? 'limit' : 'stop';
      const order: PendingPaperOrder = {
        id: crypto.randomUUID(),
        cellId: state.cellId,
        symbol,
        side,
        orderType,
        lots,
        entryPrice,
        stopLoss: protection.stopLoss,
        takeProfit: protection.takeProfit,
        contractSize: getContractSize(ticker, info),
        currency: getQuoteCurrency(symbol, info),
        minTick,
        createdAt: Date.now(),
        createdAfterBarTime: state.lastBarTime ?? 0,
      };
      pendingOrders.push(order);
      savePendingOrders();
      updateAllTradeOverlays();
      close();
      setStatus(`${side.toUpperCase()} ${orderType} pending paper order placed: ${formatLots(lots)} lots at ${formatPrice(entryPrice, minTick)}.`, 'success');
    } catch (error) {
      console.error('Could not place pending paper order:', error);
      message.textContent = error instanceof Error ? error.message : String(error);
      message.dataset.state = 'error';
    } finally {
      releaseSubmission();
      submitButton.disabled = false;
    }
  });
}

function playTradeLevelSetClick(): void {
  playTradeSound('level');
}

type ActivityState = 'error' | 'success' | 'info';
const activityEntries: Array<{ time: number; message: string; state: ActivityState }> = [];

function writeActivity(message: string, state: ActivityState = 'info'): void {
  const entry = { time: Date.now(), message, state };
  activityEntries.unshift(entry);
  if (activityEntries.length > 200) activityEntries.pop();
  const list = document.getElementById('activity-console-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = `activity-console-entry ${state}`;
  row.textContent = `[${new Date(entry.time).toLocaleTimeString()}] ${message}`;
  list.prepend(row);
  while (list.childElementCount > 200) list.lastElementChild?.remove();
}

/**
 * Price used to value an open trade.
 *
 * A chart cell can be switched to another instrument, so the cell's last price
 * is only valid while it still shows the trade's symbol. Otherwise fall back to
 * a cell showing the same symbol, then to the last price observed for it.
 */
function paperTradeMarketPrice(trade: PaperTrade): number | null {
  if (trade.brokerQuoteSymbol) return trade.lastKnownPrice ?? null;
  const wanted = cleanSymbol(trade.symbol);
  const ownState = chartStates.get(trade.cellId);
  if (ownState && cleanSymbol(ownState.chart.market.symbol) === wanted && Number.isFinite(ownState.lastPrice)) {
    return ownState.lastPrice;
  }
  for (const state of chartStates.values()) {
    if (cleanSymbol(state.chart.market.symbol) === wanted && Number.isFinite(state.lastPrice)) return state.lastPrice;
  }
  return Number.isFinite(trade.lastKnownPrice) ? trade.lastKnownPrice ?? null : null;
}

function updateTotalPnl(): void {
  refreshOpenTradesList?.();
  for (const state of chartStates.values()) {
    const summary = summarizeCurrentChartPnl(
      trades.values(),
      state.cellId,
      trade => {
        const price = paperTradeMarketPrice(trade);
        return price === null
          ? null
          : calculatePaperTradePnl(trade.side, trade.entryPrice, price, trade.lots, trade.contractSize);
      },
      formatPaperTradePnl,
    );
    state.pnlElement.textContent = summary.text;
    state.pnlElement.dataset.state = summary.state;
    state.pnlElement.setAttribute('aria-label', `Paper trading P/L for chart ${state.cellId}: ${summary.text}`);
  }
}

function createChartPnlElement(state: Pick<ChartState, 'host' | 'cellId'>): HTMLDivElement {
  const element = document.createElement('div');
  element.className = 'omega-chart-pnl';
  element.dataset.cellId = state.cellId;
  element.textContent = 'P/L: $0.00';
  element.dataset.state = 'zero';
  element.setAttribute('aria-label', `Paper trading P/L for chart ${state.cellId}: P/L: $0.00`);
  state.host.append(element);
  return element;
}

function openPaperLedger(): PaperLedgerTrade[] {
  const ledger: PaperLedgerTrade[] = [];
  for (const trade of trades.values()) {
    const price = paperTradeMarketPrice(trade);
    if (price === null) continue;
    ledger.push({
      id: trade.id,
      side: trade.side,
      lots: trade.lots,
      entryPrice: trade.entryPrice,
      entryTime: trade.entryTime,
      currency: trade.currency,
      pnl: calculatePaperTradePnl(trade.side, trade.entryPrice, price, trade.lots, trade.contractSize),
    });
  }
  return ledger;
}

function paperAccount() {
  const accountCurrency = 'USD';
  const open = openPaperLedger();
  const closedInAccountCurrency = closedTradesHistory.filter(trade => trade.currency.trim().toUpperCase() === accountCurrency);
  const openInAccountCurrency = open.filter(trade => trade.currency?.trim().toUpperCase() === accountCurrency);
  return {
    currency: accountCurrency,
    omittedTrades: closedTradesHistory.length - closedInAccountCurrency.length + open.length - openInAccountCurrency.length,
    account: calculatePaperAccount(paperInitialCapital, closedInAccountCurrency, openInAccountCurrency),
  };
}

let getActiveTradeState: () => ChartState | undefined = () => {
  const activeId = workspaceRef?.active?.id;
  return (activeId ? chartStates.get(activeId) : undefined) ?? chartStates.values().next().value;
};

function updateTradingPaneMarketData(): void {
  const state = getActiveTradeState();
  const price = state?.lastPrice;
  const symbol = state?.chart.market.symbol ?? '—';
  const symbolLabel = document.getElementById('omega-tp-symbol');
  const buyPrice = document.getElementById('omega-tp-buy-price');
  const sellPrice = document.getElementById('omega-tp-sell-price');
  if (symbolLabel) symbolLabel.textContent = symbol.split(':').at(-1) || '—';
  const text = Number.isFinite(price) ? Number(price).toFixed(5).replace(/0+$/, '').replace(/\.$/, '') : '—';
  if (buyPrice) buyPrice.textContent = text;
  if (sellPrice) sellPrice.textContent = text;
  const spreadSource = document.querySelector<HTMLElement>('[data-omega-spread-readout] .vela-dw-value');
  const spread = document.getElementById('omega-tp-spread');
  if (spread) spread.textContent = spreadSource?.textContent?.trim() || '—';
}

function initializeTradingPane(workspace: VelaWorkspace): void {
  const pane = document.getElementById('omega-trading-pane');
  const buy = document.getElementById('omega-tp-buy') as HTMLButtonElement | null;
  const sell = document.getElementById('omega-tp-sell') as HTMLButtonElement | null;
  const trade = document.getElementById('omega-tp-trade') as HTMLButtonElement | null;
  const paneLots = document.getElementById('omega-tp-lots') as HTMLInputElement | null;
  const sl = document.getElementById('omega-tp-sl') as HTMLInputElement | null;
  const tp = document.getElementById('omega-tp-tp') as HTMLInputElement | null;
  const protectionMode = document.getElementById('omega-tp-protection-mode') as HTMLSelectElement | null;
  const slUnit = document.getElementById('omega-tp-sl-unit');
  const tpUnit = document.getElementById('omega-tp-tp-unit');
  const atrReadout = document.getElementById('omega-tp-atr-readout');
  if (!pane || !buy || !sell || !trade || !paneLots || !sl || !tp || initializedTradingPane === pane) return;
  initializedTradingPane = pane;
  lotsInput.value = formatLots(tradePreferences.defaultLots);
  paneLots.value = lotsInput.value;

  let side: PaperTradeSide = 'buy';
  let paneInstrument: { symbol: string; contractSize: number; pipSize: number; currency: string } | null = null;
  let paneInstrumentRequest = '';
  const setSide = (next: PaperTradeSide) => {
    side = next;
    const isBuy = side === 'buy';
    buy.classList.toggle('active', isBuy);
    sell.classList.toggle('active', !isBuy);
    buy.setAttribute('aria-pressed', String(isBuy));
    sell.setAttribute('aria-pressed', String(!isBuy));
    trade.classList.toggle('buy', isBuy);
    trade.classList.toggle('sell', !isBuy);
    trade.textContent = `Place ${isBuy ? 'BUY' : 'SELL'} order`;
  };
  const syncLots = (source: HTMLInputElement) => {
    const value = Math.max(0.01, Number(source.value) || 0.01);
    lotsInput.value = value.toFixed(2);
    paneLots.value = value.toFixed(2);
    updateProtectionEstimate();
  };
  const updateProtectionEstimate = () => {
    const lots = Math.max(0.01, Number(paneLots.value) || 0.01);
    const state = getActiveTradeState();
    const activeSymbol = cleanSymbol(state?.chart.market.symbol);
    const firstTrade = [...trades.values()].find(item => item.cellId === state?.cellId
      && cleanSymbol(item.symbol) === activeSymbol);
    const contractSize = firstTrade?.contractSize ?? paneInstrument?.contractSize;
    const pipSize = firstTrade ? (inferPipSize(firstTrade.symbol) ?? firstTrade.minTick) : paneInstrument?.pipSize;
    const currency = firstTrade?.currency ?? paneInstrument?.currency;
    if (state && state.atr14 === null) void refreshLoadedCandleHistory(state);
    const atr14 = state?.atr14 ?? null;
    const isAtr = protectionSettings.mode === 'atr';
    if (atrReadout) {
      atrReadout.hidden = !isAtr;
      atrReadout.textContent = atr14 ? `ATR(14): ${atr14.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}` : 'ATR(14) needs 15 loaded bars';
      atrReadout.dataset.state = atr14 ? 'ready' : 'waiting';
    }
    const estimate = (input: HTMLInputElement, targetId: string) => {
      const target = document.getElementById(targetId);
      const distance = Math.abs(Number(input.value) || 0) * (isAtr ? (atr14 ?? 0) : (pipSize ?? 0));
      if (target) target.textContent = contractSize && currency && (atr14 || !isAtr)
        ? formatPaperTradePnl(distance * lots * contractSize, currency)
        : 'Loading…';
    };
    estimate(sl, 'omega-tp-sl-estimate');
    estimate(tp, 'omega-tp-tp-estimate');
  };
  refreshTradingPaneProtectionEstimate = updateProtectionEstimate;
  const loadPaneInstrument = () => {
    const state = getActiveTradeState();
    const symbol = state?.chart.market.symbol ?? '';
    if (!state || !symbol || paneInstrumentRequest === symbol) return;
    paneInstrumentRequest = symbol;
    paneInstrument = null;
    updateProtectionEstimate();
    void state.chart.data.symbolInfo(symbol).then(raw => {
      if (paneInstrumentRequest !== symbol) return;
      const info = raw as Record<string, unknown> | undefined;
      const ticker = state.chart.data.resolve(symbol)?.ticker ?? symbol;
      paneInstrument = {
        symbol,
        contractSize: getContractSize(ticker, info),
        pipSize: inferPipSize(ticker) ?? getMinTick(ticker, info),
        currency: getQuoteCurrency(symbol, info),
      };
      updateProtectionEstimate();
    }).catch(error => {
      reportCaughtError('paper-trade:instrument', error, 'Instrument details could not be loaded for the trade pane.');
      updateProtectionEstimate();
    });
  };
  buy.addEventListener('click', () => setSide('buy'));
  sell.addEventListener('click', () => setSide('sell'));
  paneLots.addEventListener('input', () => syncLots(paneLots));
  lotsInput.addEventListener('input', () => syncLots(lotsInput));
  pane.querySelectorAll<HTMLButtonElement>('[data-lot-step]').forEach(button => button.addEventListener('click', () => {
    paneLots.value = String(Math.max(0.01, (Number(paneLots.value) || 0.01) + Number(button.dataset.lotStep)));
    syncLots(paneLots);
  }));
  const quickLotButtons = [...pane.querySelectorAll<HTMLButtonElement>('[data-lots]')];
  quickLotButtons.forEach((button, index) => {
    button.dataset.lots = String(tradePreferences.quickLots[index] ?? DEFAULT_TRADE_PREFERENCES.quickLots[index]);
    button.textContent = formatLots(Number(button.dataset.lots));
    button.addEventListener('click', () => { paneLots.value = button.dataset.lots || '0.01'; syncLots(paneLots); });
  });
  const savePaneProtection = () => {
    protectionSettings = { mode: protectionMode?.value === 'atr' ? 'atr' : 'pips', slValue: Math.max(0.1, Number(sl.value) || 20), tpValue: Math.max(0.1, Number(tp.value) || 40) };
    saveProtectionSettings();
    updateProtectionEstimate();
  };
  const syncProtectionMode = () => {
    const isAtr = protectionMode?.value === 'atr';
    if (slUnit) slUnit.textContent = isAtr ? '× ATR' : 'Pips';
    if (tpUnit) tpUnit.textContent = isAtr ? '× ATR' : 'Pips';
    sl.step = '0.1';
    tp.step = '0.1';
    savePaneProtection();
  };
  sl.addEventListener('input', savePaneProtection);
  tp.addEventListener('input', savePaneProtection);
  sl.addEventListener('change', () => playTradeSound('protectionSaved'));
  tp.addEventListener('change', () => playTradeSound('protectionSaved'));
  protectionMode?.addEventListener('change', () => { syncProtectionMode(); playTradeSound('protectionSaved'); });
  trade.addEventListener('click', () => {
    const state = getActiveTradeState();
    if (state) void openTrade(state, side);
  });
  sl.value = String(protectionSettings.slValue);
  tp.value = String(protectionSettings.tpValue);
  if (protectionMode) protectionMode.value = protectionSettings.mode;
  getActiveTradeState = () => (workspace.active?.id ? chartStates.get(workspace.active.id) : undefined) ?? chartStates.values().next().value;
  refreshTradingPane = () => {
    updateTradingPaneMarketData();
    loadPaneInstrument();
    updateProtectionEstimate();
  };
  document.addEventListener('omega:spread-updated', updateTradingPaneMarketData as EventListener);
  setSide('buy');
  refreshTradingPane();
  syncProtectionMode();
}

function readPendingOrders(): PendingPaperOrder[] {
  try {
    const raw = localStorage.getItem(PENDING_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Saved pending paper orders are not an array.');
    return parsed.filter((item): item is PendingPaperOrder => {
      if (!item || typeof item !== 'object') return false;
      const order = item as Partial<PendingPaperOrder>;
      return typeof order.id === 'string'
        && typeof order.cellId === 'string'
        && typeof order.symbol === 'string'
        && (order.side === 'buy' || order.side === 'sell')
        && (order.orderType === 'limit' || order.orderType === 'stop')
        && [order.lots, order.entryPrice, order.stopLoss, order.takeProfit, order.contractSize, order.minTick, order.createdAt]
          .every(value => Number.isFinite(value))
        && Number.isFinite(order.createdAfterBarTime)
        && Number(order.lots) > 0
        && Number(order.entryPrice) > 0
        && Number(order.stopLoss) > 0
        && Number(order.takeProfit) > 0
        && Number(order.contractSize) > 0
        && Number(order.minTick) > 0
        && typeof order.currency === 'string';
    });
  } catch (error) {
    console.error('Could not restore pending paper orders:', error);
    localStorage.removeItem(PENDING_STORAGE_KEY);
    return [];
  }
}

function savePendingOrders(): void {
  try {
    localStorage.setItem(PENDING_STORAGE_KEY, JSON.stringify(pendingOrders));
  } catch (error) {
    console.error('Could not save pending paper orders:', error);
    setStatus(`Could not save pending orders: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function getTradeLevel(trade: PaperTrade, role: TradeLineRole): number {
  return role === 'entry' ? trade.entryPrice
    : role === 'stopLoss' ? trade.stopLoss : trade.takeProfit;
}

function updateTradeOverlay(state: ChartState): void {
  const levels: TradeOverlayLevel[] = [];
  const stateSym = cleanSymbol(state.chart.market.symbol);
  for (const trade of trades.values()) {
    if (cleanSymbol(trade.symbol) !== stateSym) continue;
    for (const role of ['entry', 'stopLoss', 'takeProfit'] as const) {
      const price = getTradeLevel(trade, role);
      const label = role === 'entry'
        ? `${trade.side.toUpperCase()} ${formatLots(trade.lots)} lots`
        : formatPaperTradeProtectionLabel(
          role,
          calculatePaperTradePnl(trade.side, trade.entryPrice, price, trade.lots, trade.contractSize),
          trade.currency,
        );
      levels.push({
        tradeId: trade.id,
        role,
        price,
        label,
        color: getTradeLineColor(role),
        lineWidth: role === 'entry' || state.hoveredLevelId === `${trade.id}:${role}` ? 2 : 1,
        hoveredAction: role === 'entry'
          ? (state.hoveredControlId === `${trade.id}:reverse` ? 'reverse'
            : state.hoveredControlId === `${trade.id}:close` ? 'close' : undefined)
          : undefined,
      });
    }
  }
  for (const trade of strategyTradesByCell.get(state.cellId) ?? []) {
    if (!trade.open || !Number.isFinite(trade.entryPrice)) continue;
    levels.push({
      tradeId: trade.id,
      role: 'entry',
      price: trade.entryPrice,
      label: `STRATEGY ${trade.side.toUpperCase()} ${trade.qty}`,
      color: trade.side === 'buy' ? '#26a69a' : '#ef5350',
      lineWidth: 2,
      readonly: true,
    });
  }
  const strategyPreview = activePineStrategyFillPreview;
  if (strategyPreview?.state === state) {
    const price = strategyPreview.action === 'open'
      ? strategyPreview.trade.entry.price
      : strategyPreview.trade.exit?.price;
    if (Number.isFinite(price)) {
      levels.push({
        tradeId: `pine-preview:${strategyPreview.intentKey}`,
        role: 'entry',
        price: price!,
        label: `PINE PREVIEW · ${strategyBrokerOrderSide(strategyPreview.trade.side, strategyPreview.action)} ${strategyPreview.quantity}`,
        color: '#f59e0b',
        lineWidth: 2,
        readonly: true,
      });
    }
  }
  // An order preview uses the exact same three levels as an opened trade, but it never
  // enters the ledger or persists until the operator explicitly confirms it.
  if (pendingOpenTrade && pendingOpenTradeState === state && cleanSymbol(pendingOpenTrade.symbol) === stateSym) {
    for (const role of ['entry', 'stopLoss', 'takeProfit'] as const) {
      const price = getTradeLevel(pendingOpenTrade, role);
      levels.push({
        tradeId: `preview:${pendingOpenTrade.id}`,
        role,
        price,
        label: role === 'entry'
          ? `PREVIEW · ${pendingOpenTrade.side.toUpperCase()} ${formatLots(pendingOpenTrade.lots)} lots`
          : `PREVIEW · ${role === 'stopLoss' ? 'SL' : 'TP'} ${formatPrice(price, pendingOpenTrade.minTick)}`,
        color: getTradeLineColor(role),
        lineWidth: 2,
        readonly: role === 'entry',
      });
    }
  }
  for (const position of brokerChartPositions.values()) {
    if (cleanSymbol(position.symbol) !== stateSym) continue;
    const side = position.side.toUpperCase();
    const color = side === 'BUY' ? '#26a69a' : '#ef5350';
    const id = `broker:${position.positionId}`;
    levels.push({
      tradeId: id,
      role: 'entry',
      price: position.entryPrice,
      label: `${side} ${position.volume} units · cTrader`,
      color,
      lineWidth: 2,
      readonly: true,
    });
    const stopLoss = position.stopLoss;
    if (stopLoss !== undefined && Number.isFinite(stopLoss) && stopLoss > 0) {
      levels.push({
        tradeId: `${id}:sl`,
        role: 'stopLoss',
        price: stopLoss,
        label: `cTrader SL ${stopLoss}`,
        color: '#ef5350',
        lineWidth: 1,
        readonly: true,
      });
    }
    const takeProfit = position.takeProfit;
    if (takeProfit !== undefined && Number.isFinite(takeProfit) && takeProfit > 0) {
      levels.push({
        tradeId: `${id}:tp`,
        role: 'takeProfit',
        price: takeProfit,
        label: `cTrader TP ${takeProfit}`,
        color: '#26a69a',
        lineWidth: 1,
        readonly: true,
      });
    }
  }
  for (const order of pendingOrders) {
    if (order.cellId !== state.cellId || cleanSymbol(order.symbol) !== stateSym) continue;
    levels.push({
      tradeId: order.id,
      role: 'entry',
      price: order.entryPrice,
      label: `${order.side.toUpperCase()} LIMIT/STOP ${formatLots(order.lots)} · PENDING`,
      color: getTradeLineColor('entry'),
      lineWidth: 1,
      pending: true,
      hoveredAction: state.hoveredControlId === `${order.id}:cancel` ? 'cancel' : undefined,
    });
  }
  state.tradeOverlay.setInputs({ levels: JSON.stringify(levels) });
}

function updateAllTradeOverlays(): void {
  if (overlayRenderFrame !== null) return;
  overlayRenderFrame = window.requestAnimationFrame(() => {
    overlayRenderFrame = null;
    for (const state of chartStates.values()) {
      updateTradeOverlay(state);
    }
    updatePreviewCardPosition();
  });
}

function pineStrategyFillIsArmed(accountId: string): boolean {
  const provider = accountId.slice(0, accountId.indexOf(':')).toLowerCase();
  if (provider === 'mt5') return isPineMt5AutoTradingArmed(accountId);
  if (provider === 'quantower') return isPineQuantowerAutoTradingArmed(accountId);
  if (provider === 'ibkr') return isPineIbkrAutoTradingArmed(accountId);
  if (provider === 'saxo') return isPineSaxoAutoTradingArmed(accountId);
  return false;
}

function removePineStrategyPreview(): void {
  if (pineStrategyPreviewTimeout !== undefined) {
    window.clearTimeout(pineStrategyPreviewTimeout);
    pineStrategyPreviewTimeout = undefined;
  }
  pineStrategyPreviewElement?.remove();
  pineStrategyPreviewElement = null;
}

function discardDependentPineStrategyClose(preview: PineStrategyFillPreview): void {
  if (preview.action !== 'open') return;
  for (let index = pineStrategyFillPreviews.length - 1; index >= 0; index -= 1) {
    const dependent = pineStrategyFillPreviews[index];
    if (dependent.tradePositionKey === preview.tradePositionKey && dependent.action === 'close') {
      strategyBrokerOrderIntents.delete(dependent.intentKey);
      pineStrategyFillPreviews.splice(index, 1);
    }
  }
}

function showNextPineStrategyFillPreview(): void {
  if (activePineStrategyFillPreview) return;
  while (pineStrategyFillPreviews.length) {
    const preview = pineStrategyFillPreviews.shift()!;
    if (Date.now() - preview.createdAt >= PINE_STRATEGY_PREVIEW_TTL_MS) {
      discardDependentPineStrategyClose(preview);
      setStatus(`Pine ${preview.action} preview expired for ${preview.symbol}; no broker order was sent.`, 'error');
      continue;
    }
    if (!preview.state.host.isConnected
      || String(preview.state.chart.market.symbol ?? '').trim() !== preview.symbol) {
      discardDependentPineStrategyClose(preview);
      continue;
    }

    activePineStrategyFillPreview = preview;
    updateAllTradeOverlays();
    const card = document.createElement('div');
    card.className = 'omega-order-preview-card omega-strategy-order-preview';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'false');
    card.setAttribute('aria-label', 'Confirm Pine strategy broker order');

    const heading = document.createElement('strong');
    heading.className = 'omega-order-preview-summary';
    heading.textContent = `PINE STRATEGY ${preview.action === 'open' ? 'ENTRY' : 'EXIT'} · ${preview.accountId}`;
    const details = document.createElement('span');
    details.className = 'omega-strategy-order-preview-details';
    const signalPrice = preview.action === 'open' ? preview.trade.entry.price : preview.trade.exit?.price;
    const orderSide = strategyBrokerOrderSide(preview.trade.side, preview.action);
    details.textContent = `${orderSide} ${preview.quantity} · ${preview.symbol} · strategy reference ${Number.isFinite(signalPrice) ? String(signalPrice) : 'unavailable'}${preview.action === 'open' && Number.isFinite(preview.stopLoss) ? ` · SL ${String(preview.stopLoss)}` : ''}${preview.action === 'open' && Number.isFinite(preview.takeProfit) ? ` · TP ${String(preview.takeProfit)}` : ''} · market order on confirmation`;

    const note = document.createElement('span');
    note.className = 'omega-strategy-order-preview-note';
    note.textContent = preview.accountId.startsWith('quantower:')
      ? 'Confirm sends a market order to the selected Quantower account. SL/TP are managed in Quantower. Preview expires after 30 seconds.'
      : 'Pine fill prices are simulated references, not live quotes. SL/TP use strategy levels when available, otherwise Omega’s configured protection. Confirm sends a market order; cancelling sends nothing. Preview expires after 30 seconds.';
    const buttons = document.createElement('div');
    buttons.className = 'omega-order-preview-buttons';
    const confirm = document.createElement('button');
    confirm.type = 'button';
    confirm.className = 'omega-preview-confirm-btn omega-preview-confirm-live';
    confirm.textContent = 'Confirm & send';
    confirm.setAttribute('aria-label', `Confirm Pine strategy ${preview.action} ${orderSide} order`);
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'omega-preview-cancel-btn omega-preview-cancel-live';
    cancel.textContent = 'Cancel';
    cancel.setAttribute('aria-label', 'Cancel Pine strategy order');
    buttons.append(confirm, cancel);
    card.append(heading, details, note, buttons);
    card.addEventListener('pointerdown', event => event.stopPropagation());
    card.addEventListener('mousedown', event => event.stopPropagation());

    const finish = () => {
      if (activePineStrategyFillPreview !== preview) return;
      activePineStrategyFillPreview = null;
      removePineStrategyPreview();
      updateAllTradeOverlays();
      showNextPineStrategyFillPreview();
    };
    const cancelPreview = () => {
      discardDependentPineStrategyClose(preview);
      finish();
      setStatus(`Pine strategy ${preview.action} cancelled for ${preview.symbol}; no broker order was sent.`, 'info');
      window.dispatchEvent(new CustomEvent('omega:pine-live-order-preview-cancelled', {
        detail: { symbol: preview.symbol, action: preview.action, strategyId: preview.strategyId },
      }));
    };
    card.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelPreview();
    });
    cancel.addEventListener('click', cancelPreview);
    confirm.addEventListener('click', () => {
      if (confirm.disabled || activePineStrategyFillPreview !== preview) return;
      confirm.disabled = true;
      cancel.disabled = true;
      confirm.textContent = 'Sending…';
      void (async () => {
        try {
          if (!areLiveStrategyFillsAllowed()) throw new Error('Exit replay before confirming a live strategy order.');
          if (!preview.state.host.isConnected) {
            throw new Error('The strategy chart closed after the preview. No order was sent.');
          }
          if (String(preview.state.chart.market.symbol ?? '').trim() !== preview.symbol) {
            throw new Error('The chart symbol changed after the strategy preview. No order was sent.');
          }
          if (localStorage.getItem('omega.selected-trading-account') !== preview.accountId) {
            throw new Error('The selected trading account changed after the strategy preview. No order was sent.');
          }
          if (!pineStrategyFillIsArmed(preview.accountId)) {
            throw new Error('Automatic Pine strategy trading is no longer armed for the previewed account. No order was sent.');
          }
          const outcome = await submitPineLiveFill(
            preview.accountId,
            preview.symbol,
            strategyBrokerEntrySide(preview.trade.side),
            preview.quantity,
            preview.tradePositionKey,
            preview.action,
            {
              stopLoss: preview.action === 'open' ? preview.stopLoss : undefined,
              takeProfit: preview.action === 'open' ? preview.takeProfit : undefined,
              confirmed: true,
            },
          );
          window.dispatchEvent(new CustomEvent('omega:pine-live-order-result', {
            detail: { symbol: preview.symbol, side: orderSide, quantity: preview.quantity, action: preview.action, strategyId: preview.strategyId, outcome },
          }));
          setStatus(`Pine strategy ${preview.action} order ${outcome} for ${preview.symbol}.`, 'success');
        } catch (error) {
          discardDependentPineStrategyClose(preview);
          console.error(`Pine ${preview.action} order failed for ${preview.symbol}:`, error);
          window.dispatchEvent(new CustomEvent('omega:pine-live-order-error', {
            detail: { symbol: preview.symbol, side: orderSide, quantity: preview.quantity, action: preview.action, strategyId: preview.strategyId, error: error instanceof Error ? error.message : String(error) },
          }));
        } finally {
          finish();
        }
      })();
    });

    preview.state.host.appendChild(card);
    pineStrategyPreviewElement = card;
    card.style.top = '8px';
    card.style.right = '8px';
    card.style.alignItems = 'flex-end';
    card.querySelector<HTMLButtonElement>('.omega-preview-confirm-btn')?.focus();
    const remaining = Math.max(0, PINE_STRATEGY_PREVIEW_TTL_MS - (Date.now() - preview.createdAt));
    pineStrategyPreviewTimeout = window.setTimeout(() => {
      if (activePineStrategyFillPreview !== preview) return;
      activePineStrategyFillPreview = null;
      removePineStrategyPreview();
      updateAllTradeOverlays();
      discardDependentPineStrategyClose(preview);
      setStatus(`Pine strategy ${preview.action} preview expired for ${preview.symbol}; no broker order was sent.`, 'error');
      showNextPineStrategyFillPreview();
    }, remaining);
    return;
  }
}

async function previewPineStrategyFill(state: ChartState, strategyId: string, trade: StrategyTradeSnapshot, action: 'open' | 'close', quantity = trade.qty): Promise<void> {
  const selectedAccount = localStorage.getItem('omega.selected-trading-account') ?? '';
  const provider = selectedAccount.slice(0, selectedAccount.indexOf(':')).toLowerCase();
  if (provider !== 'mt5' && provider !== 'quantower' && provider !== 'ibkr' && provider !== 'saxo') return;
  if (!pineStrategyFillIsArmed(selectedAccount)) return;
  const symbol = String(state.chart.market.symbol ?? '').trim();
  const volume = Math.abs(Number(quantity));
  const tradePositionKey = `${selectedAccount}:${state.cellId}:${strategyId}:${trade.id}`;
  const fillTime = action === 'open' ? trade.entry.time : (trade.exit?.time ?? state.lastBarTime ?? trade.entry.time);
  const intentKey = `${tradePositionKey}:${action}:${fillTime}:${volume}`;
  if (strategyBrokerOrderIntents.has(intentKey)) return;
  if (!symbol || !Number.isFinite(volume) || volume <= 0) {
    const side = strategyBrokerOrderSide(trade.side, action);
    const error = 'Pine strategy produced an invalid symbol or order quantity.';
    window.dispatchEvent(new CustomEvent('omega:pine-live-order-error', {
      detail: { symbol: symbol || undefined, side, quantity: volume, action, strategyId, error },
    }));
    setStatus(error, 'error');
    return;
  }
  if (pineStrategyFillPreviews.length >= MAX_PINE_STRATEGY_PREVIEWS) {
    const error = 'The Pine strategy preview queue is full. No broker order was sent.';
    window.dispatchEvent(new CustomEvent('omega:pine-live-order-error', {
      detail: { symbol, action, strategyId, error },
    }));
    setStatus(error, 'error');
    return;
  }
  let stopLoss: number | undefined;
  let takeProfit: number | undefined;
  if (action === 'open' && provider !== 'quantower') {
    try {
      if (protectionSettings.mode === 'atr' && state.atr14 === null) await refreshLoadedCandleHistory(state);
      const instrument = await readPaperTradeInstrument(state.chart.data, symbol, error => {
        reportCaughtError('pine-strategy:symbol-info', error, `Instrument metadata for ${symbol} could not be loaded; inferred tick and pip defaults will be used.`);
      });
      const ticker = instrument.ticker;
      const info = instrument.info;
      const minTick = getMinTick(ticker, info);
      const protection = resolvePineStrategyProtection(
        trade.side,
        trade.entry.price,
        minTick,
        getPipSize(ticker, info),
        protectionSettings,
        state.atr14,
        trade.stopLoss,
        trade.takeProfit,
      );
      stopLoss = protection.stopLoss;
      takeProfit = protection.takeProfit;
      if (state.chart.market.symbol !== symbol || !state.host.isConnected) {
        throw new Error('The strategy chart changed or closed while preparing the order preview.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reportCaughtError('pine-strategy:protection-preview', error, `Could not prepare protective levels for ${symbol}.`);
      window.dispatchEvent(new CustomEvent('omega:pine-live-order-error', {
        detail: { symbol, action, strategyId, error: message },
      }));
      setStatus(`Pine strategy entry preview blocked for ${symbol}: ${message}. No order was sent.`, 'error');
      return;
    }
  }
  if (localStorage.getItem('omega.selected-trading-account') !== selectedAccount || !pineStrategyFillIsArmed(selectedAccount)) {
    setStatus(`Pine strategy ${action} preview cancelled because the selected account changed or was disarmed. No order was sent.`, 'info');
    return;
  }
  strategyBrokerOrderIntents.add(intentKey);
  const shouldAutoExecute = provider !== 'quantower' && (!tradePreferences.previewTrade || pineStrategyFillIsArmed(selectedAccount));
  if (shouldAutoExecute) {
    void (async () => {
      try {
        const outcome = await submitPineLiveFill(
          selectedAccount,
          symbol,
          strategyBrokerEntrySide(trade.side),
          volume,
          tradePositionKey,
          action,
          {
            stopLoss: action === 'open' ? stopLoss : undefined,
            takeProfit: action === 'open' ? takeProfit : undefined,
          },
        );
        window.dispatchEvent(new CustomEvent('omega:pine-live-order-result', {
          detail: { symbol, side: strategyBrokerOrderSide(trade.side, action), quantity: volume, action, strategyId, outcome },
        }));
        setStatus(`Pine strategy auto-trading: ${action} order ${outcome} for ${symbol}.`, 'success');
      } catch (error) {
        console.error(`Pine ${action} auto-order failed for ${symbol}:`, error);
        window.dispatchEvent(new CustomEvent('omega:pine-live-order-error', {
          detail: { symbol, side: strategyBrokerOrderSide(trade.side, action), quantity: volume, action, strategyId, error: error instanceof Error ? error.message : String(error) },
        }));
        setStatus(`Pine strategy auto-order failed for ${symbol}: ${error instanceof Error ? error.message : String(error)}`, 'error');
      }
    })();
    return;
  }
  pineStrategyFillPreviews.push({
    state, strategyId, trade, action, quantity: volume, accountId: selectedAccount, symbol,
    tradePositionKey, intentKey, createdAt: Date.now(), stopLoss, takeProfit,
  });
  setStatus(`Pine strategy ${action} preview is ready for ${symbol}. Confirm or cancel it on the chart; no order has been sent yet.`, 'info');
  showNextPineStrategyFillPreview();
}

function discardPineStrategyPreviewsForCell(cellId: string): void {
  for (let index = pineStrategyFillPreviews.length - 1; index >= 0; index -= 1) {
    if (pineStrategyFillPreviews[index].state.cellId === cellId) pineStrategyFillPreviews.splice(index, 1);
  }
  if (activePineStrategyFillPreview?.state.cellId === cellId) {
    activePineStrategyFillPreview = null;
    removePineStrategyPreview();
    showNextPineStrategyFillPreview();
  }
}

async function syncInternalStrategyTrades(state: ChartState, executeLiveFills = false): Promise<void> {
  if (strategySyncingCells.has(state.cellId)) return;
  strategySyncingCells.add(state.cellId);
  try {
    const strategies = (state.chart.indicators?.() ?? []).filter((indicator: any) =>
      typeof indicator.source === 'string' && /^\s*strategy\s*\(/m.test(indicator.source)
        && typeof indicator.strategyState === 'function',
    );
    const groups = await Promise.all(strategies.map(async (strategy: any) => {
      const result = await strategy.strategyState();
      const rawTrades = (result?.trades ?? []) as StrategyTradeSnapshot[];
      return {
        strategyId: String(strategy.id),
        rawTrades,
        paperTrades: toInternalStrategyPaperTrades(String(strategy.id), state.chart.market.symbol ?? 'Strategy chart', rawTrades),
      };
    }));
    const previous = strategyBrokerTradesByCell.get(state.cellId) ?? new Map<string, StrategyTradeSnapshot>();
    const current = new Map<string, StrategyTradeSnapshot>();
    const liveWindowStart = state.recentBars.at(-2)?.time ?? state.recentBars.at(-1)?.time ?? 0;
    for (const group of groups) {
      for (const trade of group.rawTrades) {
        if (!trade?.id) continue;
        const key = `${group.strategyId}:${trade.id}`;
        current.set(key, trade);
        if (!executeLiveFills || !strategyBrokerBaselineCells.has(state.cellId)) continue;
        const oldTrade = previous.get(key);
        if (!oldTrade) {
          if (trade.entry.time >= liveWindowStart) await previewPineStrategyFill(state, group.strategyId, trade, 'open');
          if (!trade.open && (trade.exit?.time ?? 0) >= liveWindowStart) await previewPineStrategyFill(state, group.strategyId, trade, 'close');
        } else if (oldTrade.open && trade.open) {
          const difference = Math.abs(trade.qty) - Math.abs(oldTrade.qty);
          if (difference > 1e-9) await previewPineStrategyFill(state, group.strategyId, trade, 'open', difference);
          else if (difference < -1e-9) await previewPineStrategyFill(state, group.strategyId, trade, 'close', -difference);
        } else if (oldTrade.open && !trade.open && (trade.exit?.time ?? 0) >= liveWindowStart) {
          await previewPineStrategyFill(state, group.strategyId, oldTrade, 'close');
        }
      }
    }
    strategyBrokerTradesByCell.set(state.cellId, current);
    strategyBrokerBaselineCells.add(state.cellId);
    strategyTradesByCell.set(state.cellId, groups.flatMap(group => group.paperTrades));
    updateAllTradeOverlays();
  } catch (error) {
    console.warn('Could not update internal strategy paper trades:', error);
    const accountId = localStorage.getItem('omega.selected-trading-account') ?? '';
    if (isPineMt5AutoTradingArmed(accountId)) {
      window.dispatchEvent(new CustomEvent('omega:pine-live-order-error', {
        detail: {
          symbol: state.chart.market.symbol ?? undefined,
          action: 'strategy evaluation',
          error: error instanceof Error ? error.message : String(error),
        },
      }));
    }
  } finally {
    strategySyncingCells.delete(state.cellId);
  }
}

function removeLegacyTradeDrawings(state: ChartState, trade: PaperTrade): void {
  const existingIds = new Set(state.chart.drawings.all().map(drawing => drawing.id));
  for (const id of [...Object.values(trade.drawingIds), ...Object.values(trade.labelIds)]) {
    if (id && existingIds.has(id)) state.chart.drawings.remove(id);
  }
  trade.drawingIds = { entry: '', stopLoss: '', takeProfit: '' };
  trade.labelIds = { entry: '', stopLoss: '', takeProfit: '' };
}

function readSavedTrades(): PaperTrade[] {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) return [];
  const preserveOriginal = (reason: unknown): boolean => {
    try {
      const recoveryKey = preservePaperTradeState(localStorage, STORAGE_KEY, stored);
      reportCaughtError('paper-trading:recover-saved-state', reason,
        `Invalid open-trade data was preserved in local storage as ${recoveryKey}.`);
      return true;
    } catch (recoveryError) {
      savedTradeRecoveryBlocked = true;
      reportCaughtError('paper-trading:preserve-saved-state', recoveryError,
        'The original open-trade data remains untouched; further writes are blocked to prevent overwriting it.');
      setStatus(
        `Could not preserve invalid saved trade data; writes are blocked to protect it: ${recoveryError instanceof Error ? recoveryError.message : String(recoveryError)}`,
        'error',
      );
      return false;
    }
  };
  try {
    const parsed = parsePaperTrades(stored, (item): item is PaperTrade => {
      if (!item || typeof item !== 'object') return false;
      const candidate = item as Partial<PaperTrade>;
      return typeof candidate.id === 'string'
        && typeof candidate.cellId === 'string'
        && typeof candidate.symbol === 'string'
        && (candidate.side === 'buy' || candidate.side === 'sell')
        && Number.isFinite(candidate.lots) && Number(candidate.lots) > 0
        && Number.isFinite(candidate.entryPrice) && Number(candidate.entryPrice) > 0
        && Number.isFinite(candidate.stopLoss) && Number(candidate.stopLoss) > 0
        && Number.isFinite(candidate.takeProfit) && Number(candidate.takeProfit) > 0
        && Number.isFinite(candidate.contractSize) && Number(candidate.contractSize) > 0
        && typeof candidate.currency === 'string'
        && Number.isFinite(candidate.minTick) && Number(candidate.minTick) > 0
        && Number.isFinite(candidate.entryTime)
        && Number.isFinite(candidate.labelTime)
        && !!candidate.drawingIds
        && ['entry', 'stopLoss', 'takeProfit'].every(role =>
          typeof candidate.drawingIds?.[role as TradeLineRole] === 'string');
    });
    if (parsed.invalidCount > 0) {
      const preserved = preserveOriginal(new Error(`${parsed.invalidCount} invalid open-trade record(s) were found.`));
      if (preserved) {
        setStatus(
          `${parsed.invalidCount} invalid open-trade record(s) were found. The original data was preserved for recovery.`,
          'error',
        );
      }
    }
    return parsed.trades.map(trade => ({
      ...trade,
      labelIds: {
        entry: trade.labelIds?.entry ?? '',
        stopLoss: trade.labelIds?.stopLoss ?? '',
        takeProfit: trade.labelIds?.takeProfit ?? '',
      },
    }));
  } catch (error) {
    preserveOriginal(error);
    return [];
  }
}

function saveTrades(): void {
  if (savedTradeRecoveryBlocked) {
    setStatus('Open-trade storage is read-only because the original saved data could not be preserved.', 'error');
    return;
  }
  try {
    const pending = savedTrades.filter(trade => !restoredCells.has(trade.cellId) && !trades.has(trade.id));
    const merged = new Map(pending.map(trade => [trade.id, trade]));
    for (const trade of trades.values()) merged.set(trade.id, trade);
    savedTrades = [...merged.values()];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(savedTrades));
  } catch (error) {
    console.error('Could not save paper-trade state:', error);
    setStatus(`Could not save paper-trade state: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function restoreTradesForCell(state: ChartState): void {
  for (const savedTrade of savedTrades) {
    const trade = trades.get(savedTrade.id) ?? savedTrade;
    trades.set(trade.id, trade);
    try {
      removeLegacyTradeDrawings(state, trade);
    } catch (error) {
      console.error(`Could not restore paper trade ${trade.id}:`, error);
    }
  }
  updateAllTradeOverlays();
  restoredCells.add(state.cellId);
  saveTrades();
  updateTotalPnl();
}

function removeTrade(trade: PaperTrade, state: ChartState, reason: string, exitPrice?: number): void {
  const closePrice = exitPrice ?? paperTradeMarketPrice(trade) ?? trade.entryPrice;
  const pnl = calculatePaperTradePnl(trade.side, trade.entryPrice, closePrice, trade.lots, trade.contractSize);
  const closedTrade: ClosedPaperTrade = {
    id: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    lots: trade.lots,
    entryPrice: trade.entryPrice,
    entryTime: trade.entryTime,
    closePrice,
    // Chart time (epoch ms) keeps replayed trades on the replayed timeline
    // instead of stamping them with today's wall clock.
    closeTime: state.lastBarTime ?? Date.now(),
    pnl,
    currency: trade.currency,
    reason,
    minTick: trade.minTick,
  };
  closedTradesHistory.unshift(closedTrade);
  saveClosedTrades();

  trades.delete(trade.id);
  updateAllTradeOverlays();
  saveTrades();
  updateTotalPnl();
  // The close reason decides the sound: a stopped-out trade must not sound like a
  // take-profit, and a manual close must not sound like either.
  const closeReason = (reason ?? '').toLowerCase();
  if (closeReason.includes('stop')) playTradeSound('stopLossHit');
  else if (closeReason.includes('target') || closeReason.includes('take')) playTradeSound('takeProfitHit');
  else playTradeSound('tradeClosed');
  const pnlFormatted = formatPaperTradePnl(pnl, trade.currency);
  if (reason) setStatus(`${trade.side === 'buy' ? 'Buy' : 'Sell'} paper trade closed: ${reason} (P&L: ${pnlFormatted}).`, pnl >= 0 ? 'success' : 'error');
}

function handleBar(state: ChartState, bar: { time: number; high: number; low: number; close: number }): void {
  // Guard before anything trades on it: a NaN or inverted bar would corrupt entry prices,
  // stop distances and P&L silently.
  const guarded = guardBar({ open: bar.close, ...bar }, 'paper-trade bar');
  if (!guarded.ok) return;
  state.lastPrice = bar.close;
  state.lastBarTime = bar.time;

  // `bar` fires on every tick of the forming candle. Keep one sample per bar
  // time, otherwise ATR(14) is computed from copies of a single candle.
  const previous = state.recentBars.at(-1);
  const isNewBar = !previous || previous.time !== bar.time;
  if (previous && previous.time === bar.time) {
    state.recentBars[state.recentBars.length - 1] = bar;
  } else {
    state.recentBars.push(bar);
    if (state.recentBars.length > 50) state.recentBars.shift();
  }
  state.atr14 = computeAtr14(state.recentBars);
  if (state.atr14 !== null) {
    const resolved = state.chart.data.resolve(state.chart.market.symbol ?? '');
    if (resolved) state.atrHistoryKey = `${resolved.provider}:${resolved.ticker}|${state.chart.market.timeframe ?? ''}`;
  }
  if (getActiveTradeState()?.cellId === state.cellId) refreshTradingPaneProtectionEstimate?.();

  const currentSym = cleanSymbol(state.chart.market.symbol);
  for (const trade of trades.values()) {
    if (cleanSymbol(trade.symbol) === currentSym && (!trade.brokerQuoteSymbol || state.chart.replay.state.active)) {
      trade.lastKnownPrice = bar.close;
    }
  }
  // A strategy ledger is the complete run history. Refresh it only after a
  // completed/new bar, never once per tick of the forming candle.
  if (isNewBar) void syncInternalStrategyTrades(state, areLiveStrategyFillsAllowed());
  let pendingOrderFilled = false;
  for (const order of [...pendingOrders]) {
    if (order.cellId !== state.cellId || cleanSymbol(order.symbol) !== currentSym
      || bar.time <= order.createdAfterBarTime
      || (tradePreferences.maxOpenTrades > 0 && trades.size >= tradePreferences.maxOpenTrades)) continue;
    const triggered = shouldTriggerPendingPaperOrder(order.side, order.orderType, order.entryPrice, bar);
    if (!triggered) continue;
    const range = state.chart.getVisibleRange();
    const trade: PaperTrade = {
      id: order.id,
      cellId: order.cellId,
      symbol: order.symbol,
      side: order.side,
      lots: order.lots,
      entryPrice: order.entryPrice,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      contractSize: order.contractSize,
      currency: order.currency,
      minTick: order.minTick,
      entryTime: bar.time,
      labelTime: range && range.to > range.from ? range.from + (range.to - range.from) * 0.88 : bar.time,
      drawingIds: { entry: '', stopLoss: '', takeProfit: '' },
      labelIds: { entry: '', stopLoss: '', takeProfit: '' },
    };
    trades.set(trade.id, trade);
    pendingOrders = pendingOrders.filter(item => item.id !== order.id);
    pendingOrderFilled = true;
    setStatus(`${order.side === 'buy' ? 'Buy' : 'Sell'} pending paper order filled at ${formatPrice(order.entryPrice, order.minTick)}.`, 'success');
  }
  if (pendingOrderFilled) savePendingOrders();

  for (const trade of [...trades.values()]) {
    if (cleanSymbol(trade.symbol) !== currentSym) continue;
    if (bar.time <= trade.entryTime || (trade.brokerQuoteSymbol && !state.chart.replay.state.active)) continue;

    const stopHit = trade.side === 'buy' ? bar.low <= trade.stopLoss : bar.high >= trade.stopLoss;
    const targetHit = trade.side === 'buy' ? bar.high >= trade.takeProfit : bar.low <= trade.takeProfit;
    if (stopHit) removeTrade(trade, state, 'stop loss hit', trade.stopLoss);
    else if (targetHit) removeTrade(trade, state, 'take profit hit', trade.takeProfit);
  }
  updatePaperTradeQuotes(state);
  if (pendingOrderFilled) {
    updateAllTradeOverlays();
    saveTrades();
  }
  updateTotalPnl();
  updateTradingPaneMarketData();
}

function getTradeAtPointer(
  state: ChartState,
  clientX: number,
  clientY: number,
  roles: readonly TradeLineRole[],
  labelOnly = false,
): { trade: PaperTrade; role: TradeLineRole; preview: boolean } | null {
  const canvas = state.host.querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]');
  const hitData = canvas?.dataset.omegaTradeLevels;
  if (!canvas || !hitData) return null;

  const rect = canvas.getBoundingClientRect();
  const pointerX = rect.width > 0
    ? (clientX - rect.left) * canvas.clientWidth / rect.width
    : Number.NaN;
  if (!isTradePlotX(pointerX, canvas.omegaTradePlotWidth ?? Number.NaN)) return null;
  const pointerY = clientY - rect.top;
  const hits = (JSON.parse(hitData) as TradeOverlayHit[])
    .filter(hit => roles.includes(hit.role))
    .filter(hit => !labelOnly || isTradeOverlayLabelHit(hit, pointerX, pointerY))
    .map(hit => ({ hit, distance: Math.abs(hit.y - pointerY) }))
    .filter(item => item.distance <= 10)
    .sort((a, b) => a.distance - b.distance);
  const chartSym = cleanSymbol(state.chart.market.symbol);
  for (const { hit } of hits) {
    const trade = trades.get(hit.tradeId);
    if (trade && cleanSymbol(trade.symbol) === chartSym) {
      return { trade, role: hit.role, preview: false };
    }
    if (pendingOpenTrade
      && pendingOpenTradeState === state
      && `preview:${pendingOpenTrade.id}` === hit.tradeId
      && cleanSymbol(pendingOpenTrade.symbol) === chartSym) {
      return { trade: pendingOpenTrade, role: hit.role, preview: true };
    }
  }
  return null;
}

function getTradeActionAtPointer(
  state: ChartState,
  clientX: number,
  clientY: number,
): { id: string; trade?: PaperTrade; pendingOrder?: PendingPaperOrder; action: OverlayAction } | null {
  const canvas = state.host.querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]');
  const hitData = canvas?.dataset.omegaTradeLevels;
  if (!canvas || !hitData) return null;

  const rect = canvas.getBoundingClientRect();
  const pointerX = rect.width > 0
    ? (clientX - rect.left) * canvas.clientWidth / rect.width
    : Number.NaN;
  if (!isTradePlotX(pointerX, canvas.omegaTradePlotWidth ?? Number.NaN)) return null;
  const pointerY = clientY - rect.top;
  const chartSym = cleanSymbol(state.chart.market.symbol);
  const hits = (JSON.parse(hitData) as TradeOverlayHit[])
    .filter((hit): hit is TradeOverlayHit & { action: OverlayAction } => Boolean(hit.action))
    .filter(hit => pointerX >= hit.x && pointerX <= hit.x + hit.width
      && pointerY >= (hit.top ?? hit.y - hit.height / 2)
      && pointerY <= (hit.top ?? hit.y - hit.height / 2) + hit.height);
  for (const hit of hits) {
    const trade = trades.get(hit.tradeId);
    if (trade && cleanSymbol(trade.symbol) === chartSym && (hit.action === 'close' || hit.action === 'reverse')) {
      return { id: trade.id, trade, action: hit.action };
    }
    const pendingOrder = pendingOrders.find(order => order.id === hit.tradeId
      && order.cellId === state.cellId && cleanSymbol(order.symbol) === chartSym);
    if (pendingOrder && hit.action === 'cancel') return { id: pendingOrder.id, pendingOrder, action: hit.action };
  }
  return null;
}

function getProtectionLevelAtPointer(
  state: ChartState,
  clientX: number,
  clientY: number,
): { trade: PaperTrade; role: 'stopLoss' | 'takeProfit'; preview: boolean } | null {
  const match = getTradeAtPointer(state, clientX, clientY, ['stopLoss', 'takeProfit'], true);
  if (!match || match.role === 'entry') return null;
  return { trade: match.trade, role: match.role, preview: match.preview };
}

function moveTradeLevel(trade: PaperTrade, role: 'stopLoss' | 'takeProfit', price: number): void {
  if (!Number.isFinite(price) || price <= 0) return;
  trade[role] = moveProtectionLevel(trade.side, role, trade.entryPrice, price, trade.minTick);
  if (pendingOpenTrade?.id === trade.id) updateOrderPreviewSummary();
}

function setHoveredLevel(
  state: ChartState,
  match: { trade: PaperTrade; role: 'stopLoss' | 'takeProfit' } | null,
): void {
  const nextId = match ? `${match.trade.id}:${match.role}` : null;
  if (state.hoveredLevelId === nextId) return;
  state.hoveredLevelId = nextId;
  updateTradeOverlay(state);
}

function setTradeCursor(state: ChartState, mode: 'default' | 'hover' | 'dragging' | 'action'): void {
  const cursor = mode === 'dragging' ? 'grabbing'
    : mode === 'hover' ? 'ns-resize'
      : mode === 'action' ? 'pointer' : 'crosshair';
  const canvas = state.host.querySelector<HTMLCanvasElement>('canvas[data-omega-trade-overlay="true"]');
  state.host.classList.toggle('omega-trade-level-hover', mode === 'hover' || mode === 'action');
  state.host.classList.toggle('omega-trade-level-dragging', mode === 'dragging');
  if (mode === 'default') state.host.style.removeProperty('cursor');
  else state.host.style.setProperty('cursor', cursor, 'important');
  if (canvas) {
    if (mode === 'default') canvas.style.removeProperty('cursor');
    else canvas.style.setProperty('cursor', cursor, 'important');
  }
}

async function executeTradeAction(trade: PaperTrade, action: TradeOverlayAction): Promise<void> {
  const state = chartStates.get(trade.cellId);
  if (!state) {
    setStatus(`Could not ${action} paper trade: its chart is no longer available.`, 'error');
    return;
  }
  try {
    let exitPrice: number | undefined;
    if (trade.brokerQuoteSymbol && !state.chart.replay.state.active) {
      const quote = await readPaperBrokerQuote(state, trade.brokerQuoteSymbol);
      exitPrice = trade.side === 'buy' ? quote.bid : quote.ask;
    }
    if (!trades.has(trade.id)) return;
    if (action === 'reverse') reverseTrade(trade, state, exitPrice);
    else removeTrade(trade, state, 'manually closed', exitPrice);
  } catch (error) {
    console.error(`Could not ${action} paper trade:`, error);
    setStatus(`Could not ${action} paper trade: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

let previewCardElement: HTMLDivElement | null = null;
let previewPositionObserver: MutationObserver | null = null;
let previewQuoteTimer: number | undefined;

function removeOrderPreviewCard(): void {
  previewPositionObserver?.disconnect();
  previewPositionObserver = null;
  if (previewQuoteTimer !== undefined) {
    window.clearInterval(previewQuoteTimer);
    previewQuoteTimer = undefined;
  }
  window.removeEventListener('resize', updatePreviewCardPosition);
  window.removeEventListener('scroll', updatePreviewCardPosition, true);
  if (previewCardElement) {
    previewCardElement.remove();
    previewCardElement = null;
  }
}

function updatePreviewCardPosition(): boolean {
  if (!previewCardElement || !pendingOpenTrade || !pendingOpenTradeState) return false;
  const state = pendingOpenTradeState;
  const canvas = state.host.querySelector<HTMLCanvasElement>('canvas[data-omega-trade-overlay="true"]');
  const labelData = canvas?.dataset.omegaPreviewEntryLabel;
  if (!canvas || !labelData) return false;
  let entryLabel: Pick<TradeOverlayHit, 'x' | 'y' | 'width' | 'height'>;
  try {
    entryLabel = JSON.parse(labelData) as Pick<TradeOverlayHit, 'x' | 'y' | 'width' | 'height'>;
  } catch (error) {
    reportCaughtError('paper-trade:preview-label', error);
    return false;
  }
  const canvasRect = canvas.getBoundingClientRect();
  const hostRect = state.host.getBoundingClientRect();
  const scaleX = canvas.clientWidth > 0 ? canvasRect.width / canvas.clientWidth : 1;
  const scaleY = canvas.clientHeight > 0 ? canvasRect.height / canvas.clientHeight : 1;
  const labelLeft = canvasRect.left - hostRect.left + entryLabel.x * scaleX;
  const labelTop = canvasRect.top - hostRect.top + entryLabel.y * scaleY;
  const left = Math.max(8, Math.min(
    state.host.clientWidth - previewCardElement.offsetWidth - 8,
    labelLeft - previewCardElement.offsetWidth - 8,
  ));
  const top = Math.max(8, Math.min(
    state.host.clientHeight - previewCardElement.offsetHeight - 8,
    labelTop + (entryLabel.height * scaleY - previewCardElement.offsetHeight) / 2,
  ));
  previewCardElement.style.right = 'auto';
  previewCardElement.style.left = `${Math.round(left)}px`;
  previewCardElement.style.top = `${Math.round(top)}px`;
  previewCardElement.style.visibility = 'visible';
  return true;
}

function getLiveOrderProviderName(accountId: string): string {
  if (accountId.toLowerCase().startsWith('quantower:')) return 'Quantower';
  if (accountId.toLowerCase().startsWith('ctrader:')) return 'cTrader';
  if (accountId.toLowerCase().startsWith('saxo:')) return 'Saxo';
  if (accountId.toLowerCase().startsWith('ibkr:')) return 'IBKR';
  if (accountId.toLowerCase().startsWith('mt5:')) return 'MT5';
  return 'broker';
}

function getLiveOrderQuantityUnit(accountId: string, symbol: string): string {
  const provider = accountId.slice(0, accountId.indexOf(':')).toLowerCase();
  const ticker = symbol.replace(/\//g, '').toUpperCase();
  if (provider === 'quantower') return 'quantity';
  if (provider === 'ctrader') return 'lots';
  if (provider === 'saxo') return /^[A-Z]{6}$/.test(ticker) ? 'lots' : 'units';
  if (provider !== 'ibkr') return 'lots';
  if (/^[A-Z]{6}$/.test(ticker)) return 'lots';
  if (/\s\d{6}@/.test(symbol)) return 'contracts';
  return 'shares';
}

function updateOrderPreviewSummary(): void {
  if (!pendingOpenTrade || !previewCardElement) return;
  const summary = previewCardElement.querySelector<HTMLElement>('.omega-order-preview-summary');
  if (!summary) return;
  const trade = pendingOpenTrade;
  if (!pendingLiveAccountMode || !pendingLiveAccountId) {
    summary.textContent = `PAPER · ${trade.side.toUpperCase()} ${trade.symbol} · ${formatLots(trade.lots)} lots · Entry ${formatPrice(trade.entryPrice, trade.minTick)} · SL ${formatPrice(trade.stopLoss, trade.minTick)} · TP ${formatPrice(trade.takeProfit, trade.minTick)}`;
    return;
  }
  const quantityUnit = getLiveOrderQuantityUnit(pendingLiveAccountId ?? '', trade.symbol);
  const providerName = getLiveOrderProviderName(pendingLiveAccountId ?? '');
  const quoteAge = pendingLiveQuoteTimeMsc === null
    ? 'quote time unavailable'
    : providerName === 'cTrader'
      ? `MCP response received · ${Math.round(Math.abs(Date.now() - pendingLiveQuoteTimeMsc) / 1000)}s; source timestamp unavailable`
      : `${(providerName === 'MT5' ? isFreshMt5Quote(pendingLiveQuoteTimeMsc) : isFreshBrokerQuote(pendingLiveQuoteTimeMsc)) ? 'quote' : 'STALE quote'} · ${Math.round(Math.abs(Date.now() - pendingLiveQuoteTimeMsc) / 1000)}s`;
  summary.textContent = `${providerName} ${pendingLiveAccountMode.toUpperCase()} · ${trade.side.toUpperCase()} ${trade.symbol} · ${formatLots(trade.lots)} ${quantityUnit} · Entry ${formatPrice(trade.entryPrice, trade.minTick)} · SL ${formatPrice(trade.stopLoss, trade.minTick)} · TP ${formatPrice(trade.takeProfit, trade.minTick)} · ${quoteAge}`;
}

let pendingOpenTradeIntentKey: string | null = null;

function clearOpenTradePreview(releaseIntent = true): void {
  if (releaseIntent && pendingOpenTradeIntentKey) {
    releaseOrderIntent(pendingOpenTradeIntentKey);
  }
  pendingOpenTradeIntentKey = null;
  pendingOpenTrade = null;
  pendingOpenTradeState = null;
  pendingOpenTradeIsLive = false;
  pendingLiveAccountId = null;
  pendingLiveAccountMode = null;
  pendingLiveQuoteTimeMsc = null;
  removeOrderPreviewCard();
  updateAllTradeOverlays();
}

function showOpenTradePreview(
  trade: PaperTrade,
  state: ChartState,
  liveAccount?: { id: string; mode: string },
  liveQuoteTimeMsc?: number,
): void {
  pendingOpenTrade = trade;
  pendingOpenTradeState = state;
  pendingOpenTradeIsLive = Boolean(liveAccount);
  pendingLiveAccountId = liveAccount?.id ?? null;
  pendingLiveAccountMode = liveAccount?.mode ?? null;
  pendingLiveQuoteTimeMsc = liveAccount ? liveQuoteTimeMsc ?? null : null;
  updateAllTradeOverlays();

  removeOrderPreviewCard();

  const card = document.createElement('div');
  card.id = 'omega-order-preview-card';
  card.className = 'omega-order-preview-card';
  const isMt5Order = Boolean(liveAccount?.id.toLowerCase().startsWith('mt5:'));
  if (isMt5Order) card.classList.add('omega-mt5-order-confirmation');
  card.setAttribute('role', 'region');
  card.setAttribute('aria-label', liveAccount ? `${getLiveOrderProviderName(liveAccount.id)} live order confirmation` : 'Paper order preview actions');

  const summary = document.createElement('strong');
  summary.className = 'omega-order-preview-summary';
  if (liveAccount) {
    const providerName = getLiveOrderProviderName(liveAccount.id);
    const quantityUnit = getLiveOrderQuantityUnit(liveAccount.id, trade.symbol);
    const protectionNote = providerName === 'Quantower' ? ' · SL/TP not attached; manage in Quantower'
      : providerName === 'cTrader' ? ' · uses active cTrader account; verify demo/live there; source quote timestamp unavailable' : '';
    summary.textContent = `${providerName} ${liveAccount.mode.toUpperCase()} · ${trade.side.toUpperCase()} ${trade.symbol} · ${formatLots(trade.lots)} ${quantityUnit} · Entry ${formatPrice(trade.entryPrice, trade.minTick)} · SL ${formatPrice(trade.stopLoss, trade.minTick)} · TP ${formatPrice(trade.takeProfit, trade.minTick)}${protectionNote}`;
  } else {
    summary.textContent = `PAPER · ${trade.side.toUpperCase()} ${trade.symbol} · ${formatLots(trade.lots)} lots · Entry ${formatPrice(trade.entryPrice, trade.minTick)} · SL ${formatPrice(trade.stopLoss, trade.minTick)} · TP ${formatPrice(trade.takeProfit, trade.minTick)}`;
  }
  card.append(summary);

  const buttonsRow = document.createElement('div');
  buttonsRow.className = 'omega-order-preview-buttons';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'omega-preview-confirm-btn';
  const providerName = liveAccount ? getLiveOrderProviderName(liveAccount.id) : '';
  confirmBtn.textContent = liveAccount && !isMt5Order ? `Send ${providerName} order` : '✓';
  confirmBtn.title = liveAccount ? `Submit this live market order to ${providerName}` : 'Confirm order';
  confirmBtn.setAttribute('aria-label', liveAccount ? `Submit live ${providerName} order` : 'Confirm order');
  if (liveAccount) confirmBtn.classList.add('omega-preview-confirm-live');

  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'omega-preview-cancel-btn';
  if (liveAccount) cancelBtn.classList.add('omega-preview-cancel-live');
  cancelBtn.textContent = liveAccount && !isMt5Order ? 'Cancel' : '✕';
  cancelBtn.title = 'Cancel order';
  cancelBtn.setAttribute('aria-label', 'Cancel order');

  buttonsRow.append(confirmBtn, cancelBtn);

  const dontAskLabel = document.createElement('label');
  dontAskLabel.className = 'omega-preview-dont-ask';
  const dontAskCheck = document.createElement('input');
  dontAskCheck.type = 'checkbox';
  dontAskCheck.id = 'omega-preview-dont-ask-check';
  const dontAskSpan = document.createElement('span');
  dontAskSpan.textContent = "Don't show again";
  dontAskLabel.append(dontAskCheck, dontAskSpan);

  dontAskLabel.hidden = Boolean(liveAccount);
  card.append(buttonsRow, dontAskLabel);

  const handleConfirm = () => {
    if (!liveAccount && dontAskCheck.checked) {
      tradePreferences.previewTrade = false;
      tradePreferences.dontAskAgain = true;
      saveTradePreferences();
    }
    const currentTrade = pendingOpenTrade;
    const intentKey = pendingOpenTradeIntentKey;
    const accountId = pendingLiveAccountId;
    const isLive = pendingOpenTradeIsLive;
    clearOpenTradePreview(false);
    if (!currentTrade) return;
    if (isLive) {
      if (accountId && intentKey) void submitLiveQuickTrade(currentTrade, accountId, intentKey);
      else setStatus('The live order preview is incomplete; no order was sent.', 'error');
    } else {
      commitPaperTrade(currentTrade);
    }
  };

  const handleCancel = () => {
    if (!liveAccount && dontAskCheck.checked) {
      tradePreferences.previewTrade = false;
      tradePreferences.dontAskAgain = true;
      saveTradePreferences();
    }
    clearOpenTradePreview();
    setStatus('Trade order cancelled.', 'info');
  };

  card.addEventListener('cancel', event => {
    event.preventDefault();
    handleCancel();
  });
  confirmBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleConfirm();
  });
  cancelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    handleCancel();
  });

  card.addEventListener('pointerdown', e => e.stopPropagation());
  card.addEventListener('mousedown', e => e.stopPropagation());

  state.host.appendChild(card);
  previewCardElement = card;
  card.style.top = '90px';
  card.style.right = '16px';
  card.style.visibility = 'visible';
  updateOrderPreviewSummary();
  previewPositionObserver = new MutationObserver(() => updatePreviewCardPosition());
  previewPositionObserver.observe(state.host, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['data-omega-preview-entry-label'],
  });
  window.addEventListener('resize', updatePreviewCardPosition);
  window.addEventListener('scroll', updatePreviewCardPosition, true);
  if (liveAccount) previewQuoteTimer = window.setInterval(updateOrderPreviewSummary, 1000);
  window.requestAnimationFrame(() => {
    updatePreviewCardPosition();
    confirmBtn.focus();
  });
}

function commitPaperTrade(trade: PaperTrade): void {
  trades.set(trade.id, trade);
  const state = chartStates.get(trade.cellId);
  if (state) updatePaperTradeQuotes(state);
  updateAllTradeOverlays();
  saveTrades();
  updateTotalPnl();
  refreshOpenTradesList?.();
  const modeDesc = protectionSettings.mode === 'atr' ? `ATR(14) SL:${protectionSettings.slValue}x TP:${protectionSettings.tpValue}x` : `Pips SL:${protectionSettings.slValue} TP:${protectionSettings.tpValue}`;
  setStatus(`${trade.side === 'buy' ? 'Buy' : 'Sell'} paper trade added (${modeDesc}). Drag SL/TP to adjust; use the entry controls to close or reverse.`, 'success');
  playTradeSound('orderPlaced');
}

function reverseTrade(trade: PaperTrade, state: ChartState, quotedPrice?: number): void {
  if (!trades.has(trade.id)) return;
  void refreshLoadedCandleHistory(state);
  const entryPrice = quotedPrice ?? (state.lastPrice && Number.isFinite(state.lastPrice) && state.lastPrice > 0
    ? state.lastPrice
    : trade.entryPrice);
  const side: PaperTradeSide = trade.side === 'buy' ? 'sell' : 'buy';
  const protection = createConfiguredProtectionLevels(
    side,
    entryPrice,
    trade.minTick,
    protectionSettings,
    state.atr14,
  );
  const range = state.chart.getVisibleRange();
  const reversedTrade: PaperTrade = {
    ...trade,
    id: crypto.randomUUID(),
    side,
    entryPrice,
    stopLoss: protection.stopLoss,
    takeProfit: protection.takeProfit,
    entryTime: state.lastBarTime ?? Date.now(),
    labelTime: range && range.to > range.from
      ? range.from + (range.to - range.from) * 0.88
      : state.lastBarTime ?? Date.now(),
    drawingIds: { entry: '', stopLoss: '', takeProfit: '' },
    labelIds: { entry: '', stopLoss: '', takeProfit: '' },
  };
  removeTrade(trade, state, 'reversed', entryPrice);
  trades.set(reversedTrade.id, reversedTrade);
  updateAllTradeOverlays();
  saveTrades();
  updateTotalPnl();
  setStatus(`${side === 'buy' ? 'Buy' : 'Sell'} paper trade opened after reversing ${formatLots(trade.lots)} lots.`, 'success');
}

async function submitLiveQuickTrade(trade: PaperTrade, accountId: string, intentKey: string): Promise<void> {
  const releaseSubmission = liveOrderSubmissionGate.acquire();
  if (!releaseSubmission) return;
  buyButton.disabled = true;
  sellButton.disabled = true;
  const isCTrader = accountId.toLowerCase().startsWith('ctrader:');
  const isQuantower = accountId.toLowerCase().startsWith('quantower:');
  const isSaxo = accountId.toLowerCase().startsWith('saxo:');
  const isIbkr = accountId.toLowerCase().startsWith('ibkr:');
  const isMt5 = accountId.toLowerCase().startsWith('mt5:');
  const providerName = getLiveOrderProviderName(accountId);
  setStatus(`Submitting ${trade.side.toUpperCase()} ${trade.symbol} to ${providerName}…`);
  let submissionStarted = false;
  try {
    if (isCTrader) {
      const bridge = window.velaCtrader;
      if (!bridge) throw new Error('The cTrader MCP order bridge is unavailable.');
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
        throw new Error('The selected trading account changed after the order preview. Review the account and try again.');
      }
      const status = await bridge.status();
      if (!status.connected || !status.tools.some(tool => tool.name === 'place_market_order')) {
        throw new Error('The cTrader MCP market-order tool is unavailable; no order was sent.');
      }
      const state = chartStates.get(trade.cellId);
      if (!state || state.chart.market.symbol?.replace(/^(?:saxo|ibkr|mt5|quantower|ctrader):/i, '').toUpperCase() !== trade.symbol.toUpperCase()) {
        throw new Error('The chart symbol changed or its chart closed after the order preview. Review the symbol and try again.');
      }
      const details = parseCTraderDetails(await bridge.marketData('get_symbol_details', { symbolName: trade.symbol }), trade.symbol);
      validateCTraderLots(trade.lots, details);
      const quote = await fetchCTraderSpot(bridge, trade.symbol);
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
        throw new Error('The selected cTrader account changed while the order was being prepared. No order was sent.');
      }
      const currentState = chartStates.get(trade.cellId);
      if (!currentState || currentState.chart.market.symbol?.replace(/^(?:saxo|ibkr|mt5|quantower|ctrader):/i, '').toUpperCase() !== trade.symbol.toUpperCase()) {
        throw new Error('The chart symbol changed or its chart closed while the cTrader order was being confirmed. No order was sent.');
      }
      const stopLossPips = typeof trade.stopLoss === 'number' ? Math.abs(trade.entryPrice - trade.stopLoss) / details.pipSize : undefined;
      const takeProfitPips = typeof trade.takeProfit === 'number' ? Math.abs(trade.takeProfit - trade.entryPrice) / details.pipSize : undefined;
      if ((stopLossPips !== undefined && (!Number.isFinite(stopLossPips) || stopLossPips <= 0))
        || (takeProfitPips !== undefined && (!Number.isFinite(takeProfitPips) || takeProfitPips <= 0))) {
        throw new Error('The cTrader stop-loss or take-profit distance is invalid; no order was sent.');
      }
      submissionStarted = true;
      const result = await bridge.placeMarketOrder({
        symbolName: trade.symbol,
        side: trade.side,
        volume: trade.lots,
        volumeType: 'lots',
        ...(stopLossPips === undefined ? {} : { stopLossPips }),
        ...(takeProfitPips === undefined ? {} : { takeProfitPips }),
      });
      const resultRecord = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : undefined;
      const resultStatus = typeof resultRecord?.status === 'string' ? resultRecord.status.toLowerCase() : '';
      if (resultRecord?.success === false || ['rejected', 'failed', 'error'].includes(resultStatus)) {
        releaseOrderIntent(intentKey);
        throw new Error(`cTrader reported ${resultStatus || 'a failed order'}${typeof resultRecord?.message === 'string' ? `: ${resultRecord.message}` : ''}.`);
      }
      const reference = resultRecord?.orderId ?? resultRecord?.positionId ?? resultRecord?.tradeId;
      // Track the confirmed cTrader order as a local trade entry so it shows on the chart
      // and in the open-trades pane. The MCP gateway does not push live positions, so this
      // gives the user visual confirmation of their fill without a separate positions poll.
      trades.set(trade.id, trade);
      updateAllTradeOverlays();
      saveTrades();
      updateTotalPnl();
      refreshOpenTradesList?.();
      setStatus(`cTrader MCP accepted ${trade.side.toUpperCase()} ${formatLots(trade.lots)} lots of ${trade.symbol} on the active cTrader account. ${reference ? `Reference ${String(reference)}; ` : ''}Check the account and final fill in cTrader. The MCP quote has no source timestamp.`, 'success');
      playTradeSound('orderPlaced');
      return;
    }
    if (isSaxo) {
      const bridge = window.velaSaxo;
      if (!bridge) throw new Error('The Saxo order bridge is unavailable.');
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
        throw new Error('The selected trading account changed after the order preview. Review the account and try again.');
      }
      const accountKey = accountId.slice('saxo:'.length);
      const status = await bridge.status();
      if (!status.connected || !status.accounts.some(account => account.accountKey === accountKey)) {
        throw new Error('The selected Saxo account is no longer connected.');
      }
      const state = chartStates.get(trade.cellId);
      if (!state || state.chart.market.symbol?.replace(/^(?:saxo|ibkr|mt5|quantower|ctrader):/i, '').toUpperCase() !== trade.symbol.toUpperCase()) {
        throw new Error('The chart symbol changed or its chart closed after the order preview. Review the symbol and try again.');
      }
      const quote = await bridge.quote(accountKey, trade.symbol);
      if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid
        || quote.delayedByMinutes > 0 || !isFreshBrokerQuote(quote.timeMsc ?? Number.NaN)) {
        throw new Error('Saxo did not provide a fresh real-time quote; no order was sent. Refresh prices and retry.');
      }
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
        throw new Error('The selected Saxo account changed while the order was being prepared. No order was sent.');
      }
      submissionStarted = true;
      const result = await bridge.placeOrder({
        accountKey,
        symbol: trade.symbol,
        side: trade.side === 'buy' ? 'BUY' : 'SELL',
        quantity: trade.lots,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        source: 'manual',
        confirmed: true,
        intentId: intentKey,
      });
      setStatus(`Saxo accepted ${trade.side.toUpperCase()} ${formatLots(trade.lots)} ${trade.symbol} on ${accountKey}. Order ${result.orderId}; ${result.protected ? 'attached stop/target orders submitted' : 'no stop/target attached'}. Check Saxo for final fill status.`, 'success');
      playTradeSound('orderPlaced');
      return;
    }
    if (isQuantower) {
      const bridge = window.velaQuantower;
      if (!bridge) throw new Error('The Quantower order bridge is unavailable.');
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
        throw new Error('The selected trading account changed after the order preview. Review the account and try again.');
      }
      const quantowerAccountId = accountId.slice('quantower:'.length);
      const accounts = await bridge.accounts();
      if (!accounts.some(account => account.id === quantowerAccountId)) {
        throw new Error('The selected Quantower account is no longer connected.');
      }
      const state = chartStates.get(trade.cellId);
      if (!state || state.chart.market.symbol?.replace(/^(?:saxo|ibkr|mt5|quantower|ctrader):/i, '').toUpperCase() !== trade.symbol.toUpperCase()) {
        throw new Error('The chart symbol changed or its chart closed after the order preview. Review the symbol and try again.');
      }
      const quote = await bridge.quote(trade.symbol);
      const quoteTimeMsc = Date.parse(quote.time);
      if (quote.ticker.toLowerCase() !== trade.symbol.toLowerCase()) {
        throw new Error(`Quantower returned a quote for ${quote.ticker}, not ${trade.symbol}; no order was sent.`);
      }
      if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid
        || !isFreshBrokerQuote(quoteTimeMsc)) {
        throw new Error('Quantower quote is stale or invalid; no order was sent. Refresh prices and retry.');
      }
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
        throw new Error('The selected Quantower account changed while the order was being prepared. No order was sent.');
      }
      submissionStarted = true;
      const result = await bridge.placeOrder({
        accountId: quantowerAccountId,
        symbol: trade.symbol,
        side: trade.side === 'buy' ? 'BUY' : 'SELL',
        quantity: trade.lots,
      });
      if (result.status !== 'submitted' && result.status !== 'filled') {
        if (result.status === 'rejected') releaseOrderIntent(intentKey);
        throw new Error(`Quantower returned ${result.status || 'an unknown order status'}${result.message ? `: ${result.message}` : ''}. Check Quantower before retrying.`);
      }
      setStatus(`Quantower accepted ${trade.side.toUpperCase()} ${formatLots(trade.lots)} ${trade.symbol}. Order ${result.orderId ?? result.requestId ?? 'submitted'}; verify the fill in Quantower. SL/TP were not attached.`, 'success');
      playTradeSound('orderPlaced');
      return;
    }
    if (isIbkr) {
      const bridge = window.velaIbkr;
      if (!bridge) throw new Error('The IBKR order bridge is unavailable.');
      const selectedAccountId = localStorage.getItem('omega.selected-trading-account');
      if (selectedAccountId?.toLowerCase() !== accountId.toLowerCase()) {
        throw new Error('The selected trading account changed after the order preview. Review the account and try again.');
      }
      const ibkrAccountId = accountId.slice('ibkr:'.length);
      const status = await bridge.status();
      if (!status.connected || !status.accounts.includes(ibkrAccountId)) throw new Error('The selected IBKR account is no longer connected to TWS / Gateway.');
      const state = chartStates.get(trade.cellId);
      if (!state || state.chart.market.symbol?.replace(/^(?:saxo|ibkr|mt5|quantower|ctrader):/i, '').toUpperCase() !== trade.symbol.toUpperCase()) {
        throw new Error('The chart symbol changed or its chart closed after the order preview. Review the symbol and try again.');
      }
      const quote = await bridge.quote(trade.symbol);
      if (!isFreshBrokerQuote(quote.timeMsc)) throw new Error('IBKR quote is stale; no order was sent. Refresh prices and retry.');
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
        throw new Error('The selected IBKR account changed while the order was being prepared. No order was sent.');
      }
      submissionStarted = true;
      const result = await bridge.placeOrder({
        accountId: ibkrAccountId,
        symbol: trade.symbol,
        side: trade.side === 'buy' ? 'BUY' : 'SELL',
        quantity: trade.lots,
        stopLoss: trade.stopLoss,
        takeProfit: trade.takeProfit,
        source: 'manual',
        confirmed: true,
        intentId: intentKey,
      });
      setStatus(`IBKR accepted ${trade.side.toUpperCase()} ${formatLots(trade.lots)} ${trade.symbol} on ${ibkrAccountId}. Order ${result.orderId}; ${result.protected ? 'attached stop/target orders submitted' : 'no stop/target attached'}. Check TWS for final fill status.`, 'success');
      playTradeSound('orderPlaced');
      return;
    }
    if (!isMt5) throw new Error(`Live chart orders are not supported for the selected ${providerName} account.`);
    const bridge = window.velaMt5;
    if (!bridge) throw new Error('The MT5 order bridge is unavailable.');
    const status = await bridge.tradingStatus();
    assertSelectedMt5Account(status, localStorage.getItem('omega.selected-trading-account'));
    if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
      throw new Error('The selected trading account changed after the order preview. Review the account and try again.');
    }
    const state = chartStates.get(trade.cellId);
    if (!state || state.chart.market.symbol?.replace(/^(?:saxo|ibkr|mt5|quantower|ctrader):/i, '').toUpperCase() !== trade.symbol.toUpperCase()) {
      throw new Error('The chart symbol changed or its chart closed after the order preview. Review the symbol and try again.');
    }
    const quote = await bridge.quote(trade.symbol);
    assertFreshMt5Quote(quote.timeMsc);
    if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== accountId.toLowerCase()) {
      throw new Error('The selected trading account changed while getting the MT5 quote. No order was sent.');
    }
    submissionStarted = true;
    const result = await bridge.placeOrder({
      confirmedAccountId: accountId,
      intentId: crypto.randomUUID(),
      symbol: trade.symbol,
      side: trade.side === 'buy' ? 'BUY' : 'SELL',
      volume: trade.lots,
      stopLoss: trade.stopLoss,
      takeProfit: trade.takeProfit,
    });
    if (result.status === 'filled') {
      setStatus(`MT5 filled ${trade.side.toUpperCase()} ${formatLots(trade.lots)} ${trade.symbol} (${status.accountMode.toUpperCase()}). Deal ${String(result.result.deal ?? 'n/a')}, price ${String(result.result.price ?? 'n/a')}.`, 'success');
      playTradeSound('orderPlaced');
    } else {
      if (result.status === 'rejected') releaseOrderIntent(intentKey);
      setStatus(`MT5 order result is ${result.status}; check the MT5 order journal before retrying.`, 'error');
      playTradeSound('error');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const staleQuote = /stale quote/i.test(message);
    if (!submissionStarted || staleQuote) releaseOrderIntent(intentKey);
    reportCaughtError(`chart-${providerName.toLowerCase()}:place-order`, error, `The chart ${providerName} order submission needs attention.`);
    setStatus(staleQuote
      ? (message.includes('No order was sent') ? message : `${message} No order was sent. Check that the market is open and ${providerName} is receiving live ticks.`)
      : `${message}${submissionStarted ? ` Check ${providerName} before retrying.` : ''}`, 'error');
    playTradeSound('error');
  } finally {
    releaseSubmission();
    buyButton.disabled = false;
    sellButton.disabled = false;
  }
}

const paperQuotePolls = new WeakMap<ChartState, { symbol: string; time: number; running: boolean }>();

function updatePaperTradeQuotes(state: ChartState): void {
  const symbol = state.chart.market.symbol;
  if (!symbol || state.chart.replay.state.active) return;
  const resolved = state.chart.data.resolve(symbol);
  if (!resolved) return;
  const quoteSymbol = `${resolved.provider}:${resolved.ticker}`;
  const open = [...trades.values()].filter(trade => trade.brokerQuoteSymbol === quoteSymbol);
  if (!open.length) return;
  const previous = paperQuotePolls.get(state);
  const now = Date.now();
  if (previous?.symbol === symbol && (previous.running || now - previous.time < 1000)) return;
  const poll = { symbol, time: now, running: true };
  paperQuotePolls.set(state, poll);
  void readPaperBrokerQuote(state, symbol).then(quote => {
    if (!state.host.isConnected || state.chart.market.symbol !== symbol || state.chart.replay.state.active) return;
    for (const trade of open) {
      if (!trades.has(trade.id)) continue;
      const price = trade.side === 'buy' ? quote.bid : quote.ask;
      trade.lastKnownPrice = price;
      const stopped = trade.side === 'buy' ? price <= trade.stopLoss : price >= trade.stopLoss;
      const target = trade.side === 'buy' ? price >= trade.takeProfit : price <= trade.takeProfit;
      if (stopped || target) removeTrade(trade, state, stopped ? 'stop loss hit' : 'take profit hit', price);
    }
    updateTotalPnl();
  }).catch(error => {
    if (previous?.symbol !== symbol) {
      reportCaughtError('paper-trade:quote', error, `Could not update local demo prices for ${symbol}.`);
    }
  }).finally(() => { poll.running = false; });
}

async function readPaperBrokerQuote(state: ChartState, symbol: string) {
  const resolved = state.chart.data.resolve(symbol);
  if (!resolved) throw new Error('Connect a data feed with Bid/Ask prices for this symbol.');
  const instance = state.chart.data.providerInstance(resolved.provider) as Parameters<typeof fetchBidAskQuote>[3];
  const quote = await fetchBidAskQuote(resolved.provider, resolved.ticker, AbortSignal.timeout(8_000), instance);
  if (!quote) throw new Error(`No fresh Bid/Ask quote for ${resolved.ticker}.`);
  return { ...quote, sourceSymbol: `${resolved.provider}:${resolved.ticker}` };
}

async function openTrade(state: ChartState, side: PaperTradeSide, requestedRoute: 'paper' | 'live' = 'paper'): Promise<void> {
  const selectedTradingAccountId = document.querySelector<HTMLSelectElement>('#trading-account-select')?.value
    || localStorage.getItem('omega.selected-trading-account') || 'local-demo';
  const route = resolveChartOrderRoute(selectedTradingAccountId, requestedRoute);
  if (pendingOpenTrade) {
    setStatus('Confirm or cancel the current trade preview first.', 'info');
    return;
  }
  if (route === 'live' && selectedTradingAccountId?.startsWith('alpaca:')) {
    const symbol = state.chart.market.symbol?.replace(/^alpaca:/i, '') ?? '';
    document.dispatchEvent(new CustomEvent('omega:alpaca-order-form', { detail: { symbol, side } }));
    return;
  }
  const lots = Number(lotsInput.value);
  if (!Number.isFinite(lots) || lots < 0.01) {
    lotsInput.setAttribute('aria-invalid', 'true');
    setStatus('Enter a lot size of at least 0.01.', 'error');
    return;
  }
  lotsInput.removeAttribute('aria-invalid');
  if (route === 'paper' || protectionSettings.mode === 'atr') await refreshLoadedCandleHistory(state);
  if (route === 'paper' && tradePreferences.maxOpenTrades > 0 && trades.size >= tradePreferences.maxOpenTrades) {
    setStatus(`Cannot open another paper trade: the configured limit is ${tradePreferences.maxOpenTrades}.`, 'error');
    return;
  }

  const activeSymbol = state.chart.market.symbol;
  const useBrokerSpread = route === 'paper' && selectedTradingAccountId === 'local-demo'
    && !state.chart.market.offline && !state.chart.replay.state.active;
  if (!activeSymbol) {
    setStatus('The active chart does not have a selected symbol.', 'error');
    return;
  }
  let brokerQuoteSymbol: string | undefined;
  let lastKnownPrice: number | undefined;
  let entryPrice = route === 'paper' ? state.lastPrice : null;
  if (route === 'paper' && !useBrokerSpread && (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0)) {
    const marketData = (state.chart.market as { data?: unknown[] })?.data;
    const lastBar = Array.isArray(marketData) ? marketData.at(-1) : undefined;
    if (lastBar) {
      const close = Array.isArray(lastBar) ? Number(lastBar[4]) : (typeof lastBar === 'object' && lastBar !== null ? Number((lastBar as { close?: number }).close) : NaN);
      if (Number.isFinite(close) && close > 0) {
        entryPrice = close;
        state.lastPrice = close;
      }
    }
  }
  if (route === 'paper' && !useBrokerSpread && (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0)) {
    setStatus('Waiting for a live or replay price before opening a paper trade.', 'error');
    return;
  }

  const releaseTradeCreation = tradeCreationGate.acquire();
  if (!releaseTradeCreation) return;
  buyButton.disabled = true;
  sellButton.disabled = true;
  setStatus(route === 'live' ? 'Preparing a confirmed chart order…' : 'Creating paper trade…');
  let intentKey: string | null = null;
  try {
    let ticker: string;
    let info: Record<string, unknown> | undefined;
    let metadataUnavailable = false;
    let liveAccount: { id: string; mode: string } | undefined;
    let liveQuoteTimeMsc: number | undefined;
    const selectedAccountId = route === 'live' ? selectedTradingAccountId : null;
    if (route === 'live' && localStorage.getItem('omega.selected-trading-account') !== selectedAccountId) {
      throw new Error('The selected account changed while preparing the order. Try again.');
    }
    const liveProvider = selectedAccountId?.slice(0, selectedAccountId.indexOf(':')).toLowerCase();
    if (route === 'live' && liveProvider === 'saxo') {
      const bridge = window.velaSaxo;
      if (!bridge || !selectedAccountId) throw new Error('Select a connected Saxo account before placing chart orders.');
      const accountKey = selectedAccountId.slice('saxo:'.length);
      const status = await bridge.status();
      if (!status.connected || !status.accounts.some(account => account.accountKey === accountKey)) {
        throw new Error('The selected Saxo account is not connected.');
      }
      const requestedTicker = activeSymbol.replace(/^(?:saxo|ibkr|mt5|quantower):/i, '').trim();
      const quote = await bridge.quote(accountKey, requestedTicker);
      if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) {
        throw new Error(`Saxo returned an invalid ${requestedTicker} quote.`);
      }
      ticker = quote.symbol;
      info = {
        minTick: quote.instrument.minTick,
        quoteCurrency: quote.instrument.currency,
        contractSize: quote.instrument.contractSize ?? (quote.instrument.assetType === 'FxSpot' ? 100_000 : 1),
      };
      liveQuoteTimeMsc = quote.timeMsc ?? undefined;
      if (!isFreshBrokerQuote(quote.timeMsc ?? Number.NaN) || quote.delayedByMinutes > 0) {
        throw new Error('Saxo did not provide a fresh real-time quote; no order was prepared.');
      }
      if (state.chart.market.symbol !== activeSymbol) throw new Error('The chart symbol changed before the Saxo order could be prepared.');
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== selectedAccountId.toLowerCase()) {
        throw new Error('The selected Saxo account changed while the order was being prepared.');
      }
      entryPrice = side === 'buy' ? quote.ask : quote.bid;
      liveAccount = { id: selectedAccountId, mode: status.environment === 'live' ? 'live' : 'simulation' };
    } else if (route === 'live' && liveProvider === 'quantower') {
      const bridge = window.velaQuantower;
      if (!bridge || !selectedAccountId) throw new Error('Select a connected Quantower account before placing chart orders.');
      const accountId = selectedAccountId.slice('quantower:'.length);
      const accounts = await bridge.accounts();
      if (!accounts.some(account => account.id === accountId)) throw new Error('The selected Quantower account is not connected.');
      const requestedTicker = activeSymbol.replace(/^(?:saxo|ibkr|mt5|quantower):/i, '').trim();
      const [quote, symbols] = await Promise.all([bridge.quote(requestedTicker), bridge.symbols()]);
      const symbolInfo = symbols.find(symbol => symbol.ticker.toLowerCase() === quote.ticker.toLowerCase());
      if (quote.ticker.toLowerCase() !== requestedTicker.toLowerCase()) {
        throw new Error(`Quantower returned a quote for ${quote.ticker}, not ${requestedTicker}; no order was prepared.`);
      }
      if (!symbolInfo) throw new Error(`Quantower did not provide symbol metadata for ${requestedTicker}.`);
      const minTick = symbolInfo.point;
      if (typeof minTick !== 'number' || !Number.isFinite(minTick) || minTick <= 0) {
        throw new Error(`Quantower did not provide a valid minimum tick for ${requestedTicker}; no order was prepared.`);
      }
      const quoteTimeMsc = Date.parse(quote.time);
      if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) {
        throw new Error(`Quantower returned an invalid ${requestedTicker} quote.`);
      }
      liveQuoteTimeMsc = Number.isFinite(quoteTimeMsc) ? quoteTimeMsc : undefined;
      if (!isFreshBrokerQuote(quoteTimeMsc)) throw new Error('Quantower did not provide a fresh quote; no order was prepared.');
      if (state.chart.market.symbol !== activeSymbol) throw new Error('The chart symbol changed before the Quantower order could be prepared.');
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== selectedAccountId.toLowerCase()) {
        throw new Error('The selected Quantower account changed while the order was being prepared.');
      }
      ticker = quote.ticker;
      info = { minTick, digits: symbolInfo.digits, quoteCurrency: symbolInfo.currency };
      entryPrice = side === 'buy' ? quote.ask : quote.bid;
      liveAccount = { id: selectedAccountId, mode: 'connected' };
    } else if (route === 'live' && liveProvider === 'ctrader') {
      const bridge = window.velaCtrader;
      if (!bridge || !selectedAccountId) throw new Error('Select a connected cTrader MCP account before placing chart orders.');
      const status = await bridge.status();
      if (!status.connected) throw new Error('The cTrader MCP session is no longer connected.');
      if (!status.tools.some(tool => tool.name === 'place_market_order')) {
        throw new Error('The connected cTrader MCP does not provide place_market_order; chart trading is unavailable.');
      }
      const requestedTicker = activeSymbol.replace(/^(?:saxo|ibkr|mt5|quantower|ctrader):/i, '').trim();
      const details = parseCTraderDetails(await bridge.marketData('get_symbol_details', { symbolName: requestedTicker }), requestedTicker);
      validateCTraderLots(lots, details);
      const quote = await fetchCTraderSpot(bridge, requestedTicker);
      if (state.chart.market.symbol !== activeSymbol) throw new Error('The chart symbol changed before the cTrader order could be prepared.');
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== selectedAccountId.toLowerCase()) {
        throw new Error('The selected cTrader account changed while the order was being prepared.');
      }
      ticker = details.symbolName;
      info = {
        minTick: 10 ** -details.digits,
        digits: details.digits,
        pipSize: details.pipSize,
        contractSize: details.lotSize,
      };
      entryPrice = side === 'buy' ? quote.ask : quote.bid;
      liveQuoteTimeMsc = Date.now();
      liveAccount = { id: selectedAccountId, mode: 'connected' };
    } else if (route === 'live' && liveProvider === 'mt5') {
      const bridge = window.velaMt5;
      if (!bridge) throw new Error('The MT5 order bridge is unavailable.');
      const status = assertSelectedMt5Account(await bridge.tradingStatus(), selectedAccountId);
      const requestedTicker = activeSymbol.replace(/^(?:saxo|mt5|ibkr|quantower|ctrader):/i, '').trim();
      const mt5Info = await bridge.info(requestedTicker);
      if (!mt5Info?.ticker || !Number.isFinite(mt5Info.point) || mt5Info.point <= 0) {
        throw new Error(`MT5 does not provide valid symbol metadata for ${requestedTicker}.`);
      }
      ticker = mt5Info.ticker;
      info = {
        minTick: mt5Info.tradeTickSize ?? mt5Info.point,
        digits: mt5Info.digits,
        quoteCurrency: mt5Info.currencyProfit,
        contractSize: mt5Info.tradeContractSize,
      };
      const quote = await bridge.quote(ticker);
      if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) {
        throw new Error(`MT5 returned an invalid ${ticker} quote.`);
      }
      liveQuoteTimeMsc = quote.timeMsc;
      if (state.chart.market.symbol !== activeSymbol) throw new Error('The chart symbol changed before the MT5 order could be prepared.');
      assertSelectedMt5Account(status, localStorage.getItem('omega.selected-trading-account'));
      if (!selectedAccountId) throw new Error('Select a connected MT5 account before placing chart orders.');
      entryPrice = side === 'buy' ? quote.ask : quote.bid;
      liveAccount = { id: selectedAccountId, mode: status.accountMode };
    } else if (route === 'live' && liveProvider === 'ibkr') {
      const bridge = window.velaIbkr;
      if (!bridge || !selectedAccountId) throw new Error('Select a connected IBKR account before placing chart orders.');
      const ibkrAccountId = selectedAccountId.slice('ibkr:'.length);
      const status = await bridge.status();
      if (!status.connected || !status.accounts.includes(ibkrAccountId)) throw new Error('The selected IBKR account is not connected to TWS / Gateway.');
      const requestedTicker = activeSymbol.replace(/^(?:saxo|ibkr|mt5|quantower|ctrader):/i, '').trim();
      const quote = await bridge.quote(requestedTicker);
      if (!Number.isFinite(quote.bid) || !Number.isFinite(quote.ask) || quote.bid <= 0 || quote.ask < quote.bid) {
        throw new Error(`IBKR returned an invalid ${requestedTicker} quote.`);
      }
      ticker = requestedTicker;
      info = {
        minTick: quote.minTick,
        quoteCurrency: quote.contract.currency,
        contractSize: quote.contract.secType === 'CASH' ? 100_000 : Number(quote.contract.multiplier) || 1,
      };
      liveQuoteTimeMsc = quote.timeMsc;
      if (!isFreshBrokerQuote(quote.timeMsc)) throw new Error('IBKR did not provide a fresh real-time quote; no order was prepared.');
      if (state.chart.market.symbol !== activeSymbol) throw new Error('The chart symbol changed before the IBKR order could be prepared.');
      if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== selectedAccountId.toLowerCase()) {
        throw new Error('The selected IBKR account changed while the order was being prepared.');
      }
      entryPrice = side === 'buy' ? quote.ask : quote.bid;
      liveAccount = { id: selectedAccountId, mode: ibkrAccountId.toUpperCase().startsWith('DU') ? 'paper' : 'live' };
    } else if (route === 'live') {
      throw new Error('Select a connected MT5, Quantower, cTrader, IBKR, or Saxo account in the account selector before placing a live chart order.');
    } else {
      const instrument = await readPaperTradeInstrument(state.chart.data, activeSymbol, error => {
        reportCaughtError('paper-trading:symbol-info', error, `Instrument metadata for ${activeSymbol} could not be loaded; inferred sizing and tick defaults will be used.`);
      });
      ticker = instrument.ticker;
      info = instrument.info;
      metadataUnavailable = instrument.metadataUnavailable;
      if (useBrokerSpread) {
        const quote = await readPaperBrokerQuote(state, activeSymbol);
        brokerQuoteSymbol = quote.sourceSymbol;
        lastKnownPrice = side === 'buy' ? quote.bid : quote.ask;
        entryPrice = side === 'buy' ? quote.ask : quote.bid;
      }
      if (state.chart.market.symbol !== activeSymbol) {
        throw new Error('The chart symbol changed before the paper trade could be created.');
      }
    }
    const minTick = getMinTick(ticker, info);
    if (entryPrice === null || !Number.isFinite(entryPrice) || entryPrice <= 0) {
      throw new Error(route === 'live' ? `The connected broker has no valid current quote for ${ticker}.` : 'The chart has no valid entry price.');
    }
    const symbol = ticker;
    intentKey = orderIntentKey({
      cellId: state.cellId,
      symbol,
      side,
      lots,
    });
    const atr14 = state.atr14;
    const protection = createConfiguredProtectionLevels(
      side,
      entryPrice,
      minTick,
      protectionSettings,
      atr14,
      getPipSize(ticker, info),
    );
    const liveProtection = route === 'live' && liveProvider === 'mt5'
      ? alignMt5ProtectionPrices(side, protection.stopLoss, protection.takeProfit, minTick, Number(info?.digits))
      : protection;

    const trade: PaperTrade = {
      id: crypto.randomUUID(),
      cellId: state.cellId,
      symbol,
      side,
      brokerQuoteSymbol,
      lastKnownPrice,
      lots,
      entryPrice,
      stopLoss: liveProtection.stopLoss,
      takeProfit: liveProtection.takeProfit,
      contractSize: getContractSize(ticker, info),
      currency: getQuoteCurrency(symbol, info),
      minTick,
      entryTime: state.lastBarTime ?? state.chart.getVisibleRange()?.to ?? Date.now(),
      labelTime: (() => {
        const range = state.chart.getVisibleRange();
        return range && range.to > range.from
          ? range.from + (range.to - range.from) * 0.88
          : state.lastBarTime ?? Date.now();
      })(),
      drawingIds: { entry: '', stopLoss: '', takeProfit: '' },
      labelIds: { entry: '', stopLoss: '', takeProfit: '' },
    };

    // Reserve the intent only once the order is ready to be submitted. A cancelled
    // preview releases it so an intentional retry is not mistaken for a duplicate.
    const intent = requestOrderIntent(intentKey);
    if (!intent.allowed) {
      setStatus(intent.reason ?? 'Duplicate order blocked.', 'error');
      playTradeSound('error');
      return;
    }

    if (route === 'paper' && !shouldPreviewTrade(tradePreferences)) {
      commitPaperTrade(trade);
    } else {
      pendingOpenTradeIntentKey = intentKey;
      showOpenTradePreview(trade, state, liveAccount, liveQuoteTimeMsc);
    }
    if (metadataUnavailable) {
      setStatus(`Paper trade prepared using inferred contract size and tick values because ${activeSymbol} metadata is unavailable.`, 'info');
    } else if (liveAccount) {
      const quoteFresh = liveQuoteTimeMsc !== undefined && (liveProvider === 'ctrader' || isFreshBrokerQuote(liveQuoteTimeMsc));
      const providerName = liveProvider === 'quantower' ? 'Quantower' : liveProvider === 'ctrader' ? 'cTrader' : liveProvider === 'saxo' ? 'Saxo' : liveProvider === 'ibkr' ? 'IBKR' : 'MT5';
      setStatus(quoteFresh
        ? `Review the ${providerName} ${liveAccount.mode.toUpperCase()} order preview and confirm to submit.${providerName === 'Quantower' ? ' SL/TP are not attached; manage protection in Quantower.' : providerName === 'cTrader' ? ' Verify the active demo/live account in cTrader; the MCP quote has no source timestamp and is fetched again on confirmation.' : ''}`
        : `The ${providerName} order preview is shown, but its broker quote is stale; no order will be sent until live prices update.`, quoteFresh ? 'info' : 'error');
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Could not prepare ${route === 'live' ? 'live broker order' : 'paper trade'}:`, error);
    setStatus(`Could not prepare ${route === 'live' ? 'live broker order' : 'paper trade'}: ${message}`, 'error');
    playTradeSound('error');
    if (pendingOpenTradeIntentKey === intentKey) clearOpenTradePreview();
    // The order never reached the book, so the intent must be retryable.
    if (intentKey) releaseOrderIntent(intentKey);
  } finally {
    releaseTradeCreation();
    buyButton.disabled = false;
    sellButton.disabled = false;
  }
}

function attachChart(cellId: string, chart: Vela, host: HTMLElement): void {
  if (chartStates.has(cellId)) return;
  const tradeOverlay = chart.addNativeIndicator(QUICK_TRADE_LAYER_ID, { inputs: { levels: '[]' } });
  const state: ChartState = {
    cellId, chart, host, lastPrice: null, lastBarTime: null,
    atr14: null,
    atrHistoryKey: '',
    atrHistoryRequest: null,
    recentBars: [],
    draggingLevel: null, dragChanged: false, hoveredLevelId: null, hoveredControlId: null, tradeOverlay,
    pnlElement: createChartPnlElement({ cellId, host }),
    disposers: [],
  };
  chartStates.set(cellId, state);
  void refreshLoadedCandleHistory(state);

  state.disposers.push(
    chart.on('bar', bar => handleBar(state, bar)),
    chart.on('history:complete', () => {
      void refreshLoadedCandleHistory(state);
      updateTradingPaneMarketData();
      refreshTradingPaneProtectionEstimate?.();
    }),
    chart.on('market:changed', () => {
      // Prices and candles belong to the previous instrument; never carry them
      // over to the new symbol (they would be used as entry prices and as ATR
      // samples).
      state.lastPrice = null;
      state.lastBarTime = null;
      state.atr14 = null;
      state.atrHistoryKey = '';
      state.recentBars = [];
      state.atrHistoryRequest = null;
      state.hoveredLevelId = null;
      state.hoveredControlId = null;
      void refreshLoadedCandleHistory(state);
      updateAllTradeOverlays();
      updateTradingPaneMarketData();
      updateTotalPnl();
    }),
  );

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const action = getTradeActionAtPointer(state, event.clientX, event.clientY);
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      if (action.pendingOrder) cancelPendingPaperOrder(action.pendingOrder);
      else if (action.trade && (action.action === 'close' || action.action === 'reverse')) {
        executeTradeAction(action.trade, action.action);
      }
      return;
    }
    const match = getProtectionLevelAtPointer(state, event.clientX, event.clientY);
    if (!match) return;
    state.draggingLevel = { tradeId: match.trade.id, role: match.role, preview: match.preview };
    state.dragChanged = false;
    setTradeCursor(state, 'dragging');
    const target = event.target;
    if (event.isTrusted && target instanceof Element && 'setPointerCapture' in target) {
      (target as Element & { setPointerCapture(pointerId: number): void }).setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerMove = (event: PointerEvent): void => {
    if (state.draggingLevel) {
      const canvas = host.querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]');
      const rect = canvas?.getBoundingClientRect();
      const priceAtY = canvas?.omegaTradePriceAtY;
      const pointerX = canvas && rect && rect.width > 0
        ? (event.clientX - rect.left) * canvas.clientWidth / rect.width
        : Number.NaN;
      const trade = state.draggingLevel.preview
        ? pendingOpenTrade?.id === state.draggingLevel.tradeId ? pendingOpenTrade : undefined
        : trades.get(state.draggingLevel.tradeId);
      if (canvas && isTradePlotX(pointerX, canvas.omegaTradePlotWidth ?? Number.NaN) && rect && priceAtY && trade) {
        const previousPrice = trade[state.draggingLevel.role];
        moveTradeLevel(trade, state.draggingLevel.role, priceAtY(event.clientY - rect.top));
        if (trade[state.draggingLevel.role] !== previousPrice) state.dragChanged = true;
        updateAllTradeOverlays();
      }
      setTradeCursor(state, isTradePlotX(pointerX, canvas?.omegaTradePlotWidth ?? Number.NaN) ? 'dragging' : 'default');
      return;
    }
    const action = getTradeActionAtPointer(state, event.clientX, event.clientY);
    const nextControlId = action ? `${action.id}:${action.action}` : null;
    if (state.hoveredControlId !== nextControlId) {
      state.hoveredControlId = nextControlId;
      updateTradeOverlay(state);
    }
    if (action) {
      setHoveredLevel(state, null);
      setTradeCursor(state, 'action');
      return;
    }
    const match = getProtectionLevelAtPointer(state, event.clientX, event.clientY);
    setHoveredLevel(state, match);
    setTradeCursor(state, match ? 'hover' : 'default');
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!state.draggingLevel) return;
    const didChangeLevel = state.dragChanged;
    const isPreviewLevel = state.draggingLevel.preview;
    state.draggingLevel = null;
    state.dragChanged = false;
    if (!isPreviewLevel) saveTrades();
    updateAllTradeOverlays();
    if (didChangeLevel) playTradeLevelSetClick();
    const hovered = getProtectionLevelAtPointer(state, event.clientX, event.clientY);
    setHoveredLevel(state, hovered);
    setTradeCursor(state, hovered ? 'hover' : 'default');
  };
  host.addEventListener('pointerdown', onPointerDown, true);
  host.addEventListener('pointermove', onPointerMove, true);
  host.addEventListener('pointerup', onPointerUp, true);
  host.addEventListener('pointercancel', onPointerUp, true);
  state.disposers.push(() => {
    host.removeEventListener('pointerdown', onPointerDown, true);
    host.removeEventListener('pointermove', onPointerMove, true);
    host.removeEventListener('pointerup', onPointerUp, true);
    host.removeEventListener('pointercancel', onPointerUp, true);
    setTradeCursor(state, 'default');
  });

  const onContextMenu = (event: MouseEvent): void => {
    const match = getTradeAtPointer(state, event.clientX, event.clientY, ['entry'], true);
    if (!match) return;
    event.preventDefault();
    event.stopPropagation();
    executeTradeAction(match.trade, 'close');
  };
  host.addEventListener('contextmenu', onContextMenu);
  state.disposers.push(() => host.removeEventListener('contextmenu', onContextMenu));

  void chart.ready().then(() => {
    restoreTradesForCell(state);
    return syncInternalStrategyTrades(state);
  }).catch(error => {
    console.error(`Could not restore paper trades for chart ${cellId}:`, error);
    setStatus(`Could not restore paper trades: ${error instanceof Error ? error.message : String(error)}`, 'error');
  });
}

export function initializeChartPaperTrading(workspace: VelaWorkspace): () => void {
  workspaceRef = workspace;
  const onTradingPanelMounted = () => initializeTradingPane(workspace);
  const onTradingPanelOpened = () => refreshTradingPane?.();
  const onTradingPanelUnmounted = () => {
    if (initializedTradingPane && !initializedTradingPane.isConnected) {
      initializedTradingPane = null;
      refreshTradingPane = null;
    }
  };
  document.addEventListener('omega:trading-panel-mounted', onTradingPanelMounted);
  document.addEventListener('omega:trading-panel-open', onTradingPanelOpened);
  document.addEventListener('omega:trading-panel-unmounted', onTradingPanelUnmounted);
  initializePendingOrderModal();
  savedTrades = readSavedTrades();
  for (const cell of workspace.cells()) attachChart(cell.id, cell.chart, cell.host);
  const cleanupWatchlist = initializeWatchlist(workspace);
  initializeTradingPane(workspace);
  const onBrokerPositionsUpdated = (event: Event) => {
    const positions = (event as CustomEvent<BrokerChartPosition[]>).detail;
    brokerChartPositions.clear();
    if (Array.isArray(positions)) {
      for (const position of positions) {
        if (!position || !position.positionId || !position.symbol
          || !Number.isFinite(position.entryPrice) || position.entryPrice <= 0
          || !Number.isFinite(Number(position.volume)) || Number(position.volume) <= 0
          || typeof position.side !== 'string'
          || !['BUY', 'SELL'].includes(position.side.toUpperCase())) continue;
        brokerChartPositions.set(position.positionId, position);
      }
    }
    updateAllTradeOverlays();
  };
  document.addEventListener('omega:ctrader-positions-updated', onBrokerPositionsUpdated);
  const openTradesModal = document.getElementById('paper-open-trades-modal') as HTMLDivElement | null;
  const openTradesList = document.getElementById('paper-open-trades-list') as HTMLDivElement | null;
  const openTradesClose = (document.getElementById('paper-open-trades-pane-close') ?? document.getElementById('paper-open-trades-close')) as HTMLButtonElement | null;
  const feePerLotInput = document.getElementById('paper-open-trades-fee-per-lot') as HTMLInputElement | null;
  const FEE_PER_LOT_STORAGE_KEY = 'omega.open-trades.round-turn-fee-per-lot';
  let feePerLotRoundTurn = 0;
  try {
    const storedFee = Number(localStorage.getItem(FEE_PER_LOT_STORAGE_KEY));
    if (Number.isFinite(storedFee) && storedFee >= 0) feePerLotRoundTurn = storedFee;
    if (feePerLotInput) feePerLotInput.value = String(feePerLotRoundTurn);
  } catch (error) {
    reportCaughtError('paper-trade:read-fee-setting', error);
  }
  const onFeePerLotChange = (): void => {
    if (!feePerLotInput) return;
    const fee = Number(feePerLotInput.value);
    if (!Number.isFinite(fee) || fee < 0 || fee > Number.MAX_SAFE_INTEGER) {
      feePerLotInput.setAttribute('aria-invalid', 'true');
      setStatus('Estimated round-turn fee per lot must be a non-negative number.', 'error');
      return;
    }
    feePerLotInput.removeAttribute('aria-invalid');
    const previousFee = feePerLotRoundTurn;
    try {
      localStorage.setItem(FEE_PER_LOT_STORAGE_KEY, String(fee));
      feePerLotRoundTurn = fee;
      refreshOpenTradesList?.();
    } catch (error) {
      feePerLotRoundTurn = previousFee;
      feePerLotInput.value = String(previousFee);
      reportCaughtError('paper-trade:save-fee-setting', error);
      setStatus('Could not save the estimated fee setting.', 'error');
    }
  };
  feePerLotInput?.addEventListener('change', onFeePerLotChange);
  const renderOpenTrades = () => {
    if (!openTradesList) return;
    const scrollTop = openTradesList.scrollTop;
    const scrollLeft = openTradesList.scrollLeft;
    openTradesList.replaceChildren();
    const strategyOpenTrades: PaperTrade[] = [...strategyTradesByCell.entries()].flatMap(([cellId, sTrades]) => sTrades.flatMap(sTrade => {
      if (!sTrade.open || !Number.isFinite(sTrade.entryPrice)) return [];
      const state = chartStates.get(cellId);
      const symbol = sTrade.symbol || state?.chart.market.symbol || 'Strategy';
      const stateMarketPrice = state?.lastPrice ?? null;
      return [{
        id: sTrade.id,
        cellId,
        symbol,
        side: sTrade.side,
        lots: sTrade.qty,
        entryPrice: sTrade.entryPrice,
        stopLoss: 0,
        takeProfit: 0,
        contractSize: 1,
        currency: 'USD',
        minTick: 0.0001,
        entryTime: sTrade.entryTime,
        labelTime: sTrade.entryTime,
        drawingIds: { entry: '', stopLoss: '', takeProfit: '' },
        labelIds: { entry: '', stopLoss: '', takeProfit: '' },
        lastKnownPrice: stateMarketPrice ?? sTrade.entryPrice,
      }];
    }));
    const openTrades = [...trades.values(), ...strategyOpenTrades];
    if (openTrades.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'omega-open-trades-empty';
      empty.textContent = 'There are no open trades.';
      openTradesList.append(empty);
      return;
    }

    const table = document.createElement('table');
    table.className = 'omega-open-trade-table';
    const header = document.createElement('thead');
    const headings = document.createElement('tr');
    for (const label of ['Date / time', 'Symbol', 'Type', 'Volume', 'Price', 'SL', 'TP', 'Current price', 'Fees', 'Profit', '']) {
      const cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = label;
      headings.append(cell);
    }
    header.append(headings);
    const body = document.createElement('tbody');

    for (const trade of openTrades) {
      const currentPrice = paperTradeMarketPrice(trade);
      const grossPnl = currentPrice !== null
        ? calculatePaperTradePnl(trade.side, trade.entryPrice, currentPrice, trade.lots, trade.contractSize)
        : null;
      const fees = calculateRoundTurnTradeFee(trade.lots, feePerLotRoundTurn);
      const pnl = grossPnl === null ? null : grossPnl - fees;
      const row = document.createElement('tr');
      const date = document.createElement('td');
      date.textContent = Number.isFinite(trade.entryTime)
        ? new Intl.DateTimeFormat(undefined, { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(trade.entryTime))
        : '—';
      const symbolCell = document.createElement('td');
      const symbol = document.createElement('button');
      symbol.type = 'button';
      symbol.className = 'omega-open-trade-symbol';
      symbol.textContent = trade.symbol;
      symbol.title = 'Double-click to show this symbol on its chart';
      symbol.setAttribute('aria-label', `Show ${trade.symbol} on its chart`);
      const tradeType = document.createElement('td');
      tradeType.className = trade.side === 'buy' ? 'omega-open-trade-side-buy' : 'omega-open-trade-side-sell';
      tradeType.textContent = trade.side.toUpperCase();
      const volume = document.createElement('td');
      volume.textContent = `${formatLots(trade.lots)} lots`;
      const entry = document.createElement('td');
      entry.textContent = formatPrice(trade.entryPrice, trade.minTick);
      const stopLoss = document.createElement('td');
      stopLoss.textContent = trade.stopLoss > 0 ? formatPrice(trade.stopLoss, trade.minTick) : '—';
      const takeProfit = document.createElement('td');
      takeProfit.textContent = trade.takeProfit > 0 ? formatPrice(trade.takeProfit, trade.minTick) : '—';
      const current = document.createElement('td');
      current.textContent = currentPrice !== null ? formatPrice(currentPrice, trade.minTick) : '—';
      const feeCell = document.createElement('td');
      feeCell.textContent = formatPaperTradePnl(-fees, trade.currency);
      feeCell.className = fees > 0 ? 'omega-open-trade-negative' : '';
      const result = document.createElement('td');
      result.className = pnl === null ? '' : pnl >= 0 ? 'omega-open-trade-positive' : 'omega-open-trade-negative';
      result.textContent = pnl === null ? '—' : formatPaperTradePnl(pnl, trade.currency);
      const actionCell = document.createElement('td');
      const showTradeSymbolOnChart = () => {
        const cell = workspace.cell(trade.cellId);
        if (!cell) {
          reportCaughtError('paper-trade:navigate-chart', new Error(`Chart cell ${trade.cellId} is no longer available.`), 'The trade symbol could not be opened because its chart is no longer available.');
          return;
        }
        workspace.setActiveCell(cell.id);
        void cell.chart.setMarket({ symbol: trade.symbol }).catch(error => {
          reportCaughtError('paper-trade:navigate-chart', error, `The chart could not be changed to ${trade.symbol}.`);
        });
      };
      symbol.addEventListener('dblclick', showTradeSymbolOnChart);
      symbol.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        showTradeSymbolOnChart();
      });
      symbolCell.append(symbol);
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'omega-open-trade-close';
      close.textContent = '×';
      if (trade.id.startsWith('strategy:')) {
        close.title = 'Strategy position (managed automatically by script)';
        close.disabled = true;
        close.style.opacity = '0.35';
        close.style.cursor = 'default';
      } else {
        close.setAttribute('aria-label', `Close ${trade.side} paper trade in ${trade.symbol}`);
        close.title = 'Close trade';
        close.addEventListener('click', () => {
          const activeTrade = trades.get(trade.id);
          if (activeTrade) executeTradeAction(activeTrade, 'close');
        });
      }
      actionCell.append(close);
      row.append(date, symbolCell, tradeType, volume, entry, stopLoss, takeProfit, current, feeCell, result, actionCell);
      body.append(row);
    }
    table.append(header, body);
    openTradesList.append(table);
    openTradesList.scrollTop = scrollTop;
    openTradesList.scrollLeft = scrollLeft;
  };
  refreshOpenTradesList = renderOpenTrades;

  // The Trades surface participates in chart-wrapper layout so it cannot shrink
  // into a floating card or cover the chart while its height is adjusted.
  const OPEN_TRADES_PANE_HEIGHT_KEY = 'omega.open-trades.pane-height';
  const openTradesResize = document.getElementById('paper-open-trades-resize') as HTMLElement | null;
  const chartWrapper = document.getElementById('chart-wrapper');
  const chartStage = document.getElementById('chart-stage');
  if (openTradesModal && chartStage) chartStage.insertAdjacentElement('afterend', openTradesModal);

  const maxPaneHeight = (): number => {
    const toolbarHeight = document.getElementById('top-toolbar')?.offsetHeight ?? 36;
    return maxTradesPaneHeight(window.innerHeight, chartWrapper?.clientHeight ?? window.innerHeight, toolbarHeight);
  };
  const clampPaneHeight = (height: number): number =>
    clampTradesPaneHeight(height, maxPaneHeight());
  const applyPaneHeight = (height: number): void => {
    if (openTradesModal) openTradesModal.style.height = `${clampPaneHeight(height)}px`;
  };
  const storedPaneHeight = (): number => {
    try {
      const height = Number(localStorage.getItem(OPEN_TRADES_PANE_HEIGHT_KEY));
      return Number.isFinite(height) && height > 0 ? clampPaneHeight(height) : DEFAULT_TRADES_PANE_HEIGHT;
    } catch (error) {
      reportCaughtError('paper-trade:read-pane-height', error);
      return DEFAULT_TRADES_PANE_HEIGHT;
    }
  };
  const persistPaneHeight = (): void => {
    if (!openTradesModal) return;
    try {
      localStorage.setItem(OPEN_TRADES_PANE_HEIGHT_KEY, String(Math.round(openTradesModal.offsetHeight)));
    } catch (error) {
      reportCaughtError('paper-trade:save-pane-height', error);
    }
  };

  let resizePointerId: number | null = null;
  let resizeStartY = 0;
  let resizeStartHeight = 0;
  openTradesResize?.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element | null)?.closest('button') || !chartWrapper || !openTradesModal) return;
    resizePointerId = event.pointerId;
    resizeStartY = clientPointToElementLocal(chartWrapper, event.clientX, event.clientY).y;
    resizeStartHeight = openTradesModal.offsetHeight;
    openTradesResize.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  openTradesResize?.addEventListener('pointermove', event => {
    if (resizePointerId !== event.pointerId || !chartWrapper) return;
    const currentY = clientPointToElementLocal(chartWrapper, event.clientX, event.clientY).y;
    applyPaneHeight(resizeStartHeight + resizeStartY - currentY);
  });
  const endPaneResize = (event: PointerEvent): void => {
    if (resizePointerId !== event.pointerId) return;
    resizePointerId = null;
    openTradesResize?.releasePointerCapture?.(event.pointerId);
    persistPaneHeight();
  };
  openTradesResize?.addEventListener('pointerup', endPaneResize);
  openTradesResize?.addEventListener('pointercancel', endPaneResize);
  openTradesResize?.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp') applyPaneHeight((openTradesModal?.offsetHeight ?? DEFAULT_TRADES_PANE_HEIGHT) + 20);
    else if (event.key === 'ArrowDown') applyPaneHeight((openTradesModal?.offsetHeight ?? DEFAULT_TRADES_PANE_HEIGHT) - 20);
    else return;
    event.preventDefault();
    persistPaneHeight();
  });

  window.addEventListener('resize', () => {
    if (openTradesModal && !openTradesModal.hidden) applyPaneHeight(openTradesModal.offsetHeight);
    if (historyModal && !historyModal.hidden) applyHistoryPaneHeight(historyModal.offsetHeight);
  });

  const openTrades = () => {
    if (!openTradesModal) return;
    renderOpenTrades();
    applyPaneHeight(storedPaneHeight());
    openTradesModal.hidden = false;
    openTradesModal.setAttribute('aria-hidden', 'false');
    document.getElementById('open-trades-toggle')?.setAttribute('aria-expanded', 'true');
    document.getElementById('open-trades-toggle')?.classList.add('active');
  };
  const closeOpenTrades = () => {
    if (!openTradesModal) return;
    persistPaneHeight();
    openTradesModal.hidden = true;
    openTradesModal.setAttribute('aria-hidden', 'true');
    document.getElementById('open-trades-toggle')?.setAttribute('aria-expanded', 'false');
    document.getElementById('open-trades-toggle')?.classList.remove('active');
  };
  document.addEventListener('omega:paper-trading:open-trades', openTrades);
  openTradesClose?.addEventListener('click', closeOpenTrades);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && openTradesModal && !openTradesModal.hidden) closeOpenTrades();
  });
  updateTotalPnl();
  const consolePanel = document.getElementById('activity-console') as HTMLElement | null;
  const consoleToggle = document.getElementById('activity-console-toggle') as HTMLButtonElement | null;
  const consoleClose = document.getElementById('activity-console-close') as HTMLButtonElement | null;
  const consoleClear = document.getElementById('activity-console-clear') as HTMLButtonElement | null;
  const consoleCopy = document.getElementById('activity-console-copy') as HTMLButtonElement | null;
  const setConsoleOpen = (open: boolean) => {
    if (!consolePanel || !consoleToggle) return;
    consolePanel.hidden = !open;
    consoleToggle.classList.toggle('active', open);
  };
  document.addEventListener('omega:paper-trading:activity-console', () => setConsoleOpen(consolePanel?.hidden !== false));
  consoleClose?.addEventListener('click', () => setConsoleOpen(false));
  consoleClear?.addEventListener('click', () => {
    activityEntries.length = 0;
    document.getElementById('activity-console-list')?.replaceChildren();
  });
  consoleCopy?.addEventListener('click', async () => {
    const list = document.getElementById('activity-console-list');
    const text = Array.from(list?.querySelectorAll<HTMLElement>('.activity-console-entry') ?? [])
      .map(entry => entry.textContent ?? '')
      .filter(Boolean)
      .join('\n');
    if (!text) {
      consoleCopy.title = 'There are no console messages to copy.';
      return;
    }

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const temporary = document.createElement('textarea');
        temporary.value = text;
        temporary.setAttribute('readonly', '');
        temporary.style.position = 'fixed';
        temporary.style.opacity = '0';
        let copied = false;
        try {
          document.body.append(temporary);
          temporary.select();
          copied = document.execCommand('copy');
        } finally {
          temporary.remove();
        }
        if (!copied) throw new Error('Clipboard access is unavailable.');
      }
      consoleCopy.textContent = 'Copied';
      consoleCopy.title = 'Copied all console messages.';
      window.setTimeout(() => {
        consoleCopy.textContent = 'Copy all';
        consoleCopy.title = 'Copy all console messages';
      }, 1600);
    } catch (error) {
      console.error('Could not copy platform console:', error);
      consoleCopy.textContent = 'Copy failed';
      consoleCopy.title = error instanceof Error ? error.message : String(error);
    }
  });
  document.addEventListener('click', event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>('button');
    if (!button || button.closest('#activity-console')) return;
    const label = button.getAttribute('aria-label') || button.textContent?.trim();
    if (label) writeActivity(`Action: ${label}`);
  }, true);
  writeActivity('Paper trading console ready.');
  const unsubscribeCells = workspace.on('cell:created', event => {
    const cell = workspace.cell(event.id);
    if (cell) {
      attachChart(cell.id, cell.chart, cell.host);
      const state = chartStates.get(cell.id);
      if (state) attachMeasurementTool(state);
    }
    updateTradingPaneMarketData();
  });
  const unsubscribeDestroyed = workspace.on('cell:destroyed', event => {
    const state = chartStates.get(event.id);
    if (!state) return;
    discardPineStrategyPreviewsForCell(event.id);
    state.disposers.forEach(dispose => dispose());
    state.tradeOverlay.remove();
    chartStates.delete(event.id);
    saveTrades();
    updateTotalPnl();
  });

  const onTradePreviewKeyDown = (event: KeyboardEvent) => {
    if (!pendingOpenTrade) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      clearOpenTradePreview();
      setStatus('Trade order cancelled.', 'info');
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const currentTrade = pendingOpenTrade;
      const currentIntentKey = pendingOpenTradeIntentKey;
      const currentAccountId = pendingLiveAccountId;
      const isLive = pendingOpenTradeIsLive;
      const dontAsk = document.getElementById('omega-preview-dont-ask-check') as HTMLInputElement | null;
      if (!isLive && dontAsk?.checked) {
        tradePreferences.previewTrade = false;
        tradePreferences.dontAskAgain = true;
        saveTradePreferences();
      }
      clearOpenTradePreview(false);
      if (!currentTrade) return;
      if (isLive) {
        if (currentAccountId && currentIntentKey) void submitLiveQuickTrade(currentTrade, currentAccountId, currentIntentKey);
        else setStatus('The live order preview is incomplete; no order was sent.', 'error');
      } else {
        commitPaperTrade(currentTrade);
      }
    }
  };
  window.addEventListener('keydown', onTradePreviewKeyDown);

  document.addEventListener('omega:paper-trading:buy', () => {
    const state = getActiveTradeState();
    if (state) void openTrade(state, 'buy');
  });
  document.addEventListener('omega:paper-trading:sell', () => {
    const state = getActiveTradeState();
    if (state) void openTrade(state, 'sell');
  });
  document.addEventListener('omega:chart-live-trade:buy', () => {
    const state = getActiveTradeState();
    if (state) void openTrade(state, 'buy', 'live');
  });
  document.addEventListener('omega:chart-live-trade:sell', () => {
    const state = getActiveTradeState();
    if (state) void openTrade(state, 'sell', 'live');
  });
  // Settings Modal wiring
  const settingsBtn = document.getElementById('paper-trade-settings-btn') as HTMLButtonElement | null;
  const settingsModal = document.getElementById('paper-trade-settings-modal') as HTMLDivElement | null;
  const settingsClose = document.getElementById('paper-trade-settings-close') as HTMLButtonElement | null;
  const settingsSave = document.getElementById('paper-trade-settings-save') as HTMLButtonElement | null;
  const settingsMode = document.getElementById('paper-trade-settings-mode') as HTMLSelectElement | null;
  const settingsSl = document.getElementById('paper-trade-settings-sl') as HTMLInputElement | null;
  const settingsTp = document.getElementById('paper-trade-settings-tp') as HTMLInputElement | null;
  const entryColor = document.getElementById('paper-trade-entry-color') as HTMLInputElement | null;
  const stopLossColor = document.getElementById('paper-trade-sl-color') as HTMLInputElement | null;
  const takeProfitColor = document.getElementById('paper-trade-tp-color') as HTMLInputElement | null;
  const transparency = document.getElementById('paper-trade-transparency') as HTMLInputElement | null;
  const transparencyValue = document.getElementById('paper-trade-transparency-value') as HTMLOutputElement | null;
  const transparencyInput = document.getElementById('paper-trade-transparency-input') as HTMLInputElement | null;
  const maxOpenTradesField = document.getElementById('paper-trade-max-open') as HTMLInputElement | null;
  const confirmOpenField = document.getElementById('paper-trade-confirm-open') as HTMLInputElement | null;
  const previewTradeField = document.getElementById('paper-trade-preview-trade') as HTMLInputElement | null;
  const dontAskAgainField = document.getElementById('paper-trade-dont-ask-again') as HTMLInputElement | null;
  const soundsEnabledField = document.getElementById('paper-trade-sounds-enabled') as HTMLInputElement | null;
  const soundVolumeField = document.getElementById('paper-trade-sound-volume') as HTMLInputElement | null;
  const soundVolumeValue = document.getElementById('paper-trade-sound-volume-value') as HTMLOutputElement | null;
  const soundVolumeInput = document.getElementById('paper-trade-sound-volume-input') as HTMLInputElement | null;
  const slLabel = document.getElementById('paper-trade-sl-label') as HTMLSpanElement | null;
  const tpLabel = document.getElementById('paper-trade-tp-label') as HTMLSpanElement | null;
  const settingsHint = document.getElementById('paper-trade-settings-hint') as HTMLElement | null;

  const updateSettingsFields = () => {
    if (!settingsMode || !slLabel || !tpLabel || !settingsHint) return;
    if (settingsMode.value === 'atr') {
      slLabel.textContent = 'Stop Loss (ATR multiplier):';
      tpLabel.textContent = 'Take Profit (ATR multiplier):';
      settingsHint.textContent = 'ATR(14) uses Wilder\'s smoothing. Enter multiplier (e.g., 1.5 = 1.5× ATR, 3.0 = 3× ATR).';
    } else {
      slLabel.textContent = 'Stop Loss (pips):';
      tpLabel.textContent = 'Take Profit (pips):';
      settingsHint.textContent = 'Pip distance. e.g. 20 pips SL / 40 pips TP.';
    }
  };

  const openSettingsModal = () => {
    if (!settingsModal || !settingsMode || !settingsSl || !settingsTp) return;
    settingsMode.value = protectionSettings.mode;
    settingsSl.value = String(protectionSettings.slValue);
    settingsTp.value = String(protectionSettings.tpValue);
    if (entryColor) entryColor.value = getTradeLineColor('entry');
    if (stopLossColor) stopLossColor.value = getTradeLineColor('stopLoss');
    if (takeProfitColor) takeProfitColor.value = getTradeLineColor('takeProfit');
    if (transparency) transparency.value = String(tradeRectangleAppearance.transparency);
    if (transparencyValue && transparency) transparencyValue.value = `${transparency.value}%`;
    if (transparencyInput && transparency) transparencyInput.value = transparency.value;
    if (maxOpenTradesField) maxOpenTradesField.value = String(tradePreferences.maxOpenTrades);
    if (confirmOpenField) confirmOpenField.checked = tradePreferences.confirmOpenActions;
    if (previewTradeField) previewTradeField.checked = tradePreferences.previewTrade;
    if (dontAskAgainField) dontAskAgainField.checked = tradePreferences.dontAskAgain;
    if (soundsEnabledField) soundsEnabledField.checked = tradePreferences.soundsEnabled;
    if (soundVolumeField) soundVolumeField.value = String(tradePreferences.soundVolume);
    if (soundVolumeValue && soundVolumeField) soundVolumeValue.value = `${soundVolumeField.value}%`;
    if (soundVolumeInput && soundVolumeField) soundVolumeInput.value = soundVolumeField.value;
    updateSettingsFields();
    settingsModal.hidden = false;
    settingsModal.setAttribute('aria-hidden', 'false');
  };

  const closeSettingsModal = () => {
    if (!settingsModal) return;
    settingsModal.hidden = true;
    settingsModal.setAttribute('aria-hidden', 'true');
  };

  settingsBtn?.addEventListener('click', openSettingsModal);
  settingsClose?.addEventListener('click', closeSettingsModal);
  settingsMode?.addEventListener('change', updateSettingsFields);
  transparency?.addEventListener('input', () => {
    if (transparencyValue) transparencyValue.value = `${transparency.value}%`;
    if (transparencyInput && transparency) transparencyInput.value = transparency.value;
  });
  transparencyInput?.addEventListener('input', () => {
    if (!transparency || !transparencyInput) return;
    const clamped = Math.max(0, Math.min(80, Number(transparencyInput.value) || 0));
    transparency.value = String(clamped);
    if (transparencyValue) transparencyValue.value = `${transparency.value}%`;
  });
  soundVolumeField?.addEventListener('input', () => {
    if (soundVolumeValue) soundVolumeValue.value = `${soundVolumeField.value}%`;
    if (soundVolumeInput && soundVolumeField) soundVolumeInput.value = soundVolumeField.value;
  });
  soundVolumeInput?.addEventListener('input', () => {
    if (!soundVolumeField || !soundVolumeInput) return;
    const clamped = Math.max(0, Math.min(100, Number(soundVolumeInput.value) || 0));
    soundVolumeField.value = String(clamped);
    if (soundVolumeValue) soundVolumeValue.value = `${soundVolumeField.value}%`;
  });
  // Let the operator hear each event without placing a trade.
  document.querySelectorAll<HTMLButtonElement>('.paper-trade-sound-test').forEach(button => {
    button.addEventListener('click', () => {
      const event = button.dataset.sound;
      if (event) playTradeSound(event as TradingSoundEvent);
    });
  });
  settingsSave?.addEventListener('click', () => {
    if (!settingsMode || !settingsSl || !settingsTp) return;
    // The panel's own "Lots" field IS the order volume, so it is the one place the default
    // is entered. A second "Default volume" box repeated the same value and made the panel
    // look like it had three different lot settings.
    const defaultLots = Number(lotsInput.value);
    const maxOpenTrades = Number(maxOpenTradesField?.value);
    if (!Number.isFinite(defaultLots) || defaultLots < 0.01 || defaultLots > 100_000
      || !Number.isInteger(maxOpenTrades) || maxOpenTrades < 0 || maxOpenTrades > 100_000) {
      if (settingsHint) {
        settingsHint.textContent = 'Enter a lot size from 0.01 to 100,000 and a whole-number trade limit (0 = unlimited).';
        settingsHint.dataset.state = 'error';
      }
      return;
    }
    if (settingsHint) delete settingsHint.dataset.state;
    updateSettingsFields();
    const mode = (settingsMode.value === 'atr' ? 'atr' : 'pips') as ProtectionMode;
    const slValue = Math.max(0.1, Number(settingsSl.value) || 20);
    const tpValue = Math.max(0.1, Number(settingsTp.value) || 40);
    protectionSettings = { mode, slValue, tpValue };
    tradePreferences = resolveTradePreviewPreferences({
      defaultLots,
      quickLots: tradePreferences.quickLots,
      maxOpenTrades,
      confirmOpenActions: confirmOpenField?.checked ?? true,
      soundsEnabled: soundsEnabledField?.checked ?? true,
      soundVolume: Math.max(0, Math.min(100, Number(soundVolumeField?.value ?? 50))),
      previewTrade: previewTradeField?.checked ?? tradePreferences.previewTrade,
      dontAskAgain: dontAskAgainField?.checked ?? tradePreferences.dontAskAgain,
    });
    lotsInput.value = formatLots(tradePreferences.defaultLots);
    const paneLots = document.getElementById('omega-tp-lots') as HTMLInputElement | null;
    if (paneLots) paneLots.value = lotsInput.value;
    const quickButtons = document.querySelectorAll<HTMLButtonElement>('#omega-trading-pane [data-lots]');
    quickButtons.forEach((button, index) => {
      const value = tradePreferences.quickLots[index];
      button.dataset.lots = String(value);
      button.textContent = formatLots(value);
    });
    if (entryColor && stopLossColor && takeProfitColor) {
      tradeRectangleAppearance = {
        entryColor: entryColor.value,
        stopLossColor: stopLossColor.value,
        takeProfitColor: takeProfitColor.value,
        transparency: Math.max(0, Math.min(80, Number(transparency?.value ?? 18))),
      };
    }
    saveProtectionSettings();
    saveTradePreferences();
    updateAllTradeOverlays();
    closeSettingsModal();
    playTradeSound('protectionSaved');
    setStatus(`Protection settings saved: ${mode.toUpperCase()} (SL: ${slValue}, TP: ${tpValue})`, 'success');
  });
  settingsModal?.addEventListener('click', event => {
    if (event.target === settingsModal) closeSettingsModal();
  });

  // History Modal wiring
  const historyModal = document.getElementById('paper-trade-history-modal') as HTMLDivElement | null;
  const historyClose = (document.getElementById('paper-trade-history-pane-close') ?? document.getElementById('paper-trade-history-close')) as HTMLButtonElement | null;
  const historyClear = document.getElementById('paper-trade-history-clear') as HTMLButtonElement | null;
  const historyList = document.getElementById('paper-trade-history-list') as HTMLDivElement | null;

  const renderHistoryTable = () => {
    if (!historyList) return;
    historyList.replaceChildren();
    const strategyHistory = [...strategyTradesByCell.entries()].flatMap(([cellId, trades]) => trades.flatMap(trade =>
      !trade.open && Number.isFinite(trade.exitPrice) && Number.isFinite(trade.exitTime) ? [{
        id: trade.id, symbol: trade.symbol, side: trade.side,
        lots: trade.qty, entryPrice: trade.entryPrice, entryTime: trade.entryTime,
        closePrice: trade.exitPrice!, closeTime: trade.exitTime!, pnl: trade.pnl ?? 0,
        // StrategyState exposes a P/L amount but not a verified account
        // currency, so never claim that it is USD.
        currency: 'USD', reason: 'Strategy (internal)', minTick: undefined,
      } satisfies ClosedPaperTrade] : [],
    ));
    const displayHistory = [...closedTradesHistory, ...strategyHistory]
      .sort((left, right) => right.closeTime - left.closeTime);
    const { account, currency: accountCurrency, omittedTrades } = paperAccount();
    const summary = document.createElement('div');
    summary.style.cssText = 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0.4375rem;margin:0 0 0.625rem;';
    const addMetric = (label: string, value: string, color = '') => {
      const card = document.createElement('div');
      card.style.cssText = 'padding:0.4375rem;border:0.0625rem solid var(--omega-border);border-radius:0.3125rem;background:var(--omega-elevated);min-width:0;';
      const caption = document.createElement('span'); caption.textContent = label;
      caption.style.cssText = 'display:block;color:var(--omega-muted);font-size:0.625rem;';
      const result = document.createElement('strong'); result.textContent = value;
      result.style.cssText = `display:block;margin-top:0.125rem;overflow:hidden;text-overflow:ellipsis;${color ? `color:${color};` : ''}`;
      card.append(caption, result); summary.append(card);
    };
    addMetric('Balance', formatPaperTradePnl(account.initialCapital + account.realisedPnl, accountCurrency).replace(/^\+/, ''));
    addMetric('Equity', formatPaperTradePnl(account.equity, accountCurrency).replace(/^\+/, ''));
    addMetric('Net P&L', formatPaperTradePnl(account.realisedPnl, accountCurrency), account.realisedPnl >= 0 ? 'var(--omega-success)' : 'var(--omega-error)');
    addMetric('Max drawdown', formatPaperTradePnl(-account.analytics.maxDrawdown, accountCurrency), 'var(--omega-error)');
    addMetric('Win rate', account.analytics.winRate === null ? '—' : `${account.analytics.winRate.toFixed(1)}%`);
    addMetric('Profit factor', account.analytics.profitFactor === null ? '—' : Number.isFinite(account.analytics.profitFactor) ? account.analytics.profitFactor.toFixed(2) : '∞');
    addMetric('Closed trades', String(account.analytics.ledgerClosedTrades));
    historyList.append(summary);
    if (displayHistory.length === 0) {
      const emptyMsg = document.createElement('p');
      emptyMsg.style.cssText = 'color:var(--omega-muted); text-align:center; padding:2rem 1rem; font-size:0.75rem; margin:0;';
      emptyMsg.textContent = 'No closed paper trades recorded yet.';
      historyList.appendChild(emptyMsg);
      return;
    }
    if (omittedTrades > 0) {
      const note = document.createElement('p');
      note.style.cssText = 'margin:0 0 0.625rem;color:var(--omega-muted);font-size:0.6875rem;';
      note.textContent = `${omittedTrades} trade(s) in another quote currency are listed below but excluded from the USD account summary. No FX conversion is assumed.`;
      historyList.append(note);
    }

    const table = document.createElement('table');
    table.className = 'omega-history-table';
    table.innerHTML = `
      <thead>
        <tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Side</th>
          <th>Lots</th>
          <th>Entry</th>
          <th>Close</th>
          <th>P&L</th>
          <th>Reason</th>
        </tr>
      </thead>
      <tbody></tbody>
    `;
    const tbody = table.querySelector('tbody')!;
    const historyCell = (text: string, className?: string, color?: string): HTMLTableCellElement => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (className) cell.className = className;
      if (color) cell.style.color = color;
      return cell;
    };
    for (const trade of displayHistory) {
      const row = document.createElement('tr');
      const timeStr = new Date(trade.closeTime).toLocaleString(undefined, {
        month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'UTC',
      });
      const minTick = trade.minTick ?? inferPipSize(trade.symbol) ?? 0.01;
      const symbolCell = document.createElement('td');
      const strong = document.createElement('strong');
      strong.textContent = trade.symbol;
      symbolCell.append(strong);
      const sideCell = document.createElement('td');
      const sideStrong = document.createElement('strong');
      sideStrong.style.color = trade.side === 'buy' ? 'var(--omega-success)' : 'var(--omega-error)';
      sideStrong.textContent = trade.side.toUpperCase();
      sideCell.append(sideStrong);
      row.append(
        historyCell(timeStr, undefined, 'var(--omega-muted)'),
        symbolCell,
        sideCell,
        historyCell(formatLots(trade.lots)),
        historyCell(formatPrice(trade.entryPrice, minTick)),
        historyCell(formatPrice(trade.closePrice, minTick)),
        historyCell(formatPaperTradePnl(trade.pnl, trade.currency), trade.pnl >= 0 ? 'omega-history-positive' : 'omega-history-negative'),
        historyCell(trade.reason, undefined, 'var(--omega-muted)'),
      );
      tbody.appendChild(row);
    }
    historyList.appendChild(table);
  };

  const openHistoryModal = () => {
    if (!historyModal) return;
    renderHistoryTable();
    closeOpenTrades();
    applyHistoryPaneHeight(storedHistoryPaneHeight());
    historyModal.hidden = false;
    historyModal.setAttribute('aria-hidden', 'false');
    document.getElementById('trade-history-toggle')?.classList.add('active');
  };

  const closeHistoryModal = () => {
    if (!historyModal) return;
    persistHistoryPaneHeight();
    historyModal.hidden = true;
    historyModal.setAttribute('aria-hidden', 'true');
    document.getElementById('trade-history-toggle')?.classList.remove('active');
  };

  const historyResize = document.getElementById('paper-trade-history-resize') as HTMLElement | null;
  const HISTORY_PANE_HEIGHT_KEY = 'omega.trade-history.pane-height';
  if (historyModal && chartStage) chartStage.insertAdjacentElement('afterend', historyModal);
  const applyHistoryPaneHeight = (height: number): void => {
    if (historyModal) historyModal.style.height = `${clampPaneHeight(height)}px`;
  };
  const storedHistoryPaneHeight = (): number => {
    try {
      const height = Number(localStorage.getItem(HISTORY_PANE_HEIGHT_KEY));
      return Number.isFinite(height) && height > 0 ? clampPaneHeight(height) : DEFAULT_TRADES_PANE_HEIGHT;
    } catch (error) {
      reportCaughtError('paper-trade:read-history-pane-height', error);
      return DEFAULT_TRADES_PANE_HEIGHT;
    }
  };
  const persistHistoryPaneHeight = (): void => {
    if (!historyModal) return;
    try {
      localStorage.setItem(HISTORY_PANE_HEIGHT_KEY, String(Math.round(historyModal.offsetHeight)));
    } catch (error) {
      reportCaughtError('paper-trade:save-history-pane-height', error);
    }
  };
  let historyResizePointerId: number | null = null;
  let historyResizeStartY = 0;
  let historyResizeStartHeight = 0;
  historyResize?.addEventListener('pointerdown', event => {
    if (event.button !== 0 || (event.target as Element | null)?.closest('button') || !chartWrapper || !historyModal) return;
    historyResizePointerId = event.pointerId;
    historyResizeStartY = clientPointToElementLocal(chartWrapper, event.clientX, event.clientY).y;
    historyResizeStartHeight = historyModal.offsetHeight;
    historyResize.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  historyResize?.addEventListener('pointermove', event => {
    if (historyResizePointerId !== event.pointerId || !chartWrapper) return;
    const currentY = clientPointToElementLocal(chartWrapper, event.clientX, event.clientY).y;
    applyHistoryPaneHeight(historyResizeStartHeight + historyResizeStartY - currentY);
  });
  const endHistoryResize = (event: PointerEvent): void => {
    if (historyResizePointerId !== event.pointerId) return;
    historyResizePointerId = null;
    historyResize?.releasePointerCapture?.(event.pointerId);
    persistHistoryPaneHeight();
  };
  historyResize?.addEventListener('pointerup', endHistoryResize);
  historyResize?.addEventListener('pointercancel', endHistoryResize);
  historyResize?.addEventListener('keydown', event => {
    if (event.key === 'ArrowUp') applyHistoryPaneHeight((historyModal?.offsetHeight ?? DEFAULT_TRADES_PANE_HEIGHT) + 20);
    else if (event.key === 'ArrowDown') applyHistoryPaneHeight((historyModal?.offsetHeight ?? DEFAULT_TRADES_PANE_HEIGHT) - 20);
    else return;
    event.preventDefault();
    persistHistoryPaneHeight();
  });

  document.addEventListener('omega:paper-trading:trade-history', openHistoryModal);
  historyClose?.addEventListener('click', closeHistoryModal);
  historyClear?.addEventListener('click', () => {
    if (confirm('Clear all paper trade history?')) {
      closedTradesHistory = [];
      saveClosedTrades();
      renderHistoryTable();
    }
  });
  historyModal?.addEventListener('click', event => {
    if (event.target === historyModal) closeHistoryModal();
  });

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if (settingsModal && !settingsModal.hidden) closeSettingsModal();
      if (historyModal && !historyModal.hidden) closeHistoryModal();
      if (openTradesModal && !openTradesModal.hidden) closeOpenTrades();
    }
  });

  // Custom measurement overlay for paper trading
  function createMeasurementOverlay(): void {
    document.getElementById('omega-measurement-overlay')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'omega-measurement-overlay';
    overlay.style.cssText = `
      position: absolute;
      left: 0;
      top: 0;
      background: var(--omega-surface);
      border: 0.0625rem solid var(--omega-border);
      border-radius: 0.5rem;
      padding: 0.75rem 1rem;
      font-size: 0.75rem;
      color: var(--omega-text);
      box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.3);
      z-index: 22;
      display: none;
      min-width: 13.75rem;
    `;
    // Keep the card inside the chart workspace: a body-level element would
    // always paint above Vela's menu layers (which live in the workspace).
    (document.querySelector('.vela-workspace') ?? document.body).appendChild(overlay);
  }

  type MeasurementAnchor = {
    time: number;
    price: number;
    barIndex: number | null;
    symbol: string;
    contractSize: number;
    minTick: number;
    currency: string;
  };
  let measurementStartPoint: MeasurementAnchor | null = null;
  let measurementEnd: { time: number; price: number; barIndex: number | null } | null = null;
  let measurementModeActive = false;
  let measurementFinished = false;
  let measurementDragging = false;
  let measurementChart: ChartState | null = null;
  let measurementStartX = 0;
  let measurementStartY = 0;
  let measurementGesture = 0;
  let measurementLastPointer: { clientX: number; clientY: number } | null = null;
  let measurementVisual: { container: HTMLDivElement; horizontal: HTMLDivElement; vertical: HTMLDivElement; line: SVGLineElement } | null = null;

  function ensureMeasurementVisual(state: ChartState) {
    measurementVisual?.container.remove();
    const container = document.createElement('div');
    container.className = 'omega-measure-container';
    const horizontal = document.createElement('div');
    horizontal.className = 'omega-measure-cross-h';
    const vertical = document.createElement('div');
    vertical.className = 'omega-measure-cross-v';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'omega-measure-svg');
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('class', 'omega-measure-line');
    svg.append(line);
    container.append(svg, horizontal, vertical);
    state.host.append(container);
    measurementVisual = { container, horizontal, vertical, line };
    return measurementVisual;
  }

  function updateMeasurementVisual(state: ChartState, event: PointerEvent): void {
    const visual = measurementVisual ?? ensureMeasurementVisual(state);
    const point = clientPointToElementLocal(state.host, event.clientX, event.clientY);
    const x = Math.max(0, Math.min(state.host.offsetWidth, point.x));
    const y = Math.max(0, Math.min(state.host.offsetHeight, point.y));
    visual.horizontal.style.top = `${y}px`;
    visual.vertical.style.left = `${x}px`;
    visual.horizontal.style.display = 'block';
    visual.vertical.style.display = 'block';
    visual.line.setAttribute('x1', String(measurementStartX));
    visual.line.setAttribute('y1', String(measurementStartY));
    visual.line.setAttribute('x2', String(x));
    visual.line.setAttribute('y2', String(y));
    visual.line.style.display = measurementStartPoint ? 'block' : 'none';
  }

  function positionMeasurementCard(event: { clientX: number; clientY: number }): void {
    const overlay = document.getElementById('omega-measurement-overlay');
    if (!overlay) return;
    const parent = overlay.offsetParent instanceof HTMLElement ? overlay.offsetParent : document.body;
    const point = clientPointToElementLocal(parent, event.clientX, event.clientY);
    const width = 200;
    const height = 190;
    const maxLeft = Math.max(8, parent.clientWidth - width - 8);
    const maxTop = Math.max(8, parent.clientHeight - height - 8);
    overlay.style.left = `${Math.min(maxLeft, Math.max(8, point.x + 18))}px`;
    overlay.style.top = `${Math.min(maxTop, Math.max(8, point.y + 18))}px`;
    overlay.style.right = 'auto';
    overlay.style.bottom = 'auto';
  }

  function updateMeasurementOverlay(
    startPoint: MeasurementAnchor | null,
    endPoint: { time: number; price: number; barIndex: number | null } | null,
    lots: number,
  ): void {
    const overlay = document.getElementById('omega-measurement-overlay');
    if (!overlay || !startPoint || !endPoint) {
      overlay?.style.setProperty('display', 'none');
      return;
    }

    const priceDiff = Math.abs(endPoint.price - startPoint.price);
    const pipSize = inferPipSize(startPoint.symbol) ?? startPoint.minTick;
    const pips = priceDiff / pipSize;
    const selectedLots = Number.isFinite(lots) && lots > 0 ? lots : 0.01;
    const monetaryValue = priceDiff * selectedLots * startPoint.contractSize;
    const barDistance = startPoint.barIndex === null || endPoint.barIndex === null
      ? '—'
      : String(Math.abs(endPoint.barIndex - startPoint.barIndex));

    overlay.className = 'omega-ctrader-measure-card';
    overlay.innerHTML = `
      <div class="omega-measure-header">${startPoint.symbol}</div>
      <div class="omega-measure-divider"></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Price</span><strong class="omega-measure-value">${formatPrice(endPoint.price, startPoint.minTick)}</strong></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Bars</span><strong class="omega-measure-value">${barDistance}</strong></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Pips</span><strong class="omega-measure-value">${pips.toFixed(1)}</strong></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Change</span><strong class="omega-measure-value positive">${startPoint.price === 0 ? '0.00' : ((priceDiff / startPoint.price) * 100).toFixed(2)} %</strong></div>
      <div class="omega-measure-divider"></div>
      <div class="omega-measure-sublabel">Quick Trade size</div>
      <div class="omega-measure-row"><span class="omega-measure-label">Volume</span><strong class="omega-measure-value">${formatLots(selectedLots)} lots</strong></div>
      <div class="omega-measure-row"><span class="omega-measure-label">Estimated move value</span><strong class="omega-measure-value">${formatPaperTradePnl(monetaryValue, startPoint.currency)}</strong></div>
      <div class="omega-measure-sublabel">Estimate uses Quick Trade volume; fees and currency conversion are excluded.</div>
    `;
    overlay.style.setProperty('display', 'block');
  }

  // Add click listener for measurement
  for (const state of chartStates.values()) {
    const unsubscribeClick = state.chart.renderer.onClick((data) => {
      if (measurementModeActive) return;
      if (!data || !data.time || !data.price) return;

      const lots = parseFloat(lotsInput?.value || '0.01');
      const symbol = state.chart.market.symbol ?? '';
      if (!symbol) return;

      // Check if Shift key is held
      if (!window.event || !(window.event as KeyboardEvent).shiftKey) {
        // If not shift, cancel measurement
        measurementStartPoint = null;
        measurementEnd = null;
        const overlay = document.getElementById('omega-measurement-overlay');
        overlay?.style.setProperty('display', 'none');
        return;
      }

      // Get contract size from metadata
      state.chart.data.symbolInfo(symbol).then((info: Record<string, unknown> | undefined) => {
        const contractSize = getContractSize(symbol, info);
        const minTick = getMinTick(symbol, info);

        if (!measurementStartPoint && data.time !== null && data.price !== null) {
          // Set start point
          measurementFinished = false;
          measurementStartPoint = {
            time: data.time,
            price: data.price,
            barIndex: state.host
              .querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]')
              ?.omegaTradeBarIndexAtTime?.(data.time) ?? null,
            symbol,
            contractSize,
            minTick,
            currency: getQuoteCurrency(symbol, info),
          };
          setStatus('Measurement: First point set. Shift+click to set second point.', '');
        } else if (measurementStartPoint && data.time !== null && data.price !== null) {
          // Set end point and show measurement
          measurementEnd = {
            time: data.time,
            price: data.price,
            barIndex: state.host
              .querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]')
              ?.omegaTradeBarIndexAtTime?.(data.time) ?? null,
          };
          measurementFinished = true;
          updateMeasurementOverlay(measurementStartPoint, measurementEnd, lots);
          setStatus('Measurement complete. Shift+click to start new measurement.', 'success');
        }
      });
    });

    const unsubscribeCrosshair = state.chart.renderer.onCrosshairMove((data) => {
      if (measurementModeActive || measurementFinished) return;
      if (!measurementStartPoint || !data || data.time === null || data.price === null) return;

      const lots = parseFloat(lotsInput?.value || '0.01');
      measurementEnd = {
        time: data.time,
        price: data.price,
        barIndex: state.host
          .querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]')
          ?.omegaTradeBarIndexAtTime?.(data.time) ?? null,
      };
      updateMeasurementOverlay(measurementStartPoint, measurementEnd, lots);
    });

    state.disposers.push(unsubscribeClick, unsubscribeCrosshair);
  }

  const cancelMeasurement = () => {
    measurementGesture += 1;
    measurementStartPoint = null;
    measurementEnd = null;
    measurementDragging = false;
    measurementModeActive = false;
    measurementFinished = false;
    if (measurementChart) measurementChart.host.classList.remove('omega-measure-active');
    measurementVisual?.container.remove();
    measurementVisual = null;
    measurementChart = null;
    measurementLastPointer = null;
    document.getElementById('omega-measurement-overlay')?.style.setProperty('display', 'none');
  };

  const finishMeasurement = () => {
    cancelMeasurement();
  };

  const attachMeasurementTool = (state: ChartState): void => {
    const measurementPointAtPointer = (event: PointerEvent): { price: number; barIndex: number | null } | null => {
      const canvas = state.host.querySelector<TradeOverlayCanvas>('canvas[data-omega-trade-overlay="true"]');
      const localPoint = canvas ? clientPointToElementLocal(canvas, event.clientX, event.clientY) : null;
      const priceAtY = canvas?.omegaTradePriceAtY;
      if (!canvas || !localPoint || !priceAtY) return null;
      return resolveMeasurementPoint(
        localPoint.x,
        localPoint.y,
        canvas.omegaTradePlotWidth ?? 0,
        priceAtY,
        canvas.omegaTradeBarIndexAtX,
      );
    };
    const stopChartGesture = (event: Event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onMeasurePointerDown = (event: PointerEvent) => {
      if (event.button === 1) {
        if (measurementModeActive) {
          cancelMeasurement();
          stopChartGesture(event);
          writeActivity('Measurement tool deactivated.');
          return;
        }
        measurementModeActive = true;
        measurementFinished = false;
        measurementChart = state;
        measurementGesture += 1;
        measurementStartPoint = null;
        measurementEnd = null;
        measurementLastPointer = { clientX: event.clientX, clientY: event.clientY };
        document.getElementById('omega-measurement-overlay')?.style.setProperty('display', 'none');
        state.host.classList.add('omega-measure-active');
        ensureMeasurementVisual(state);
        updateMeasurementVisual(state, event);
        stopChartGesture(event);
        writeActivity('Measurement tool activated. Drag with the left mouse button; releasing it completes and exits measurement mode.');
        return;
      }
      if (!measurementModeActive || measurementChart !== state || event.button !== 0) return;
      // Lock chart panning for the whole gesture, even if no price can be read
      // (for example before the first quote) — the tool must not move the chart.
      stopChartGesture(event);
      const measurementPoint = measurementPointAtPointer(event);
      const symbol = state.chart.market.symbol ?? '';
      if (!measurementPoint || !symbol) return;
      measurementDragging = true;
      const localPoint = clientPointToElementLocal(state.host, event.clientX, event.clientY);
      measurementStartY = localPoint.y;
      measurementStartX = localPoint.x;
      const gesture = ++measurementGesture;
      measurementLastPointer = { clientX: event.clientX, clientY: event.clientY };
      measurementStartPoint = {
        time: Date.now(),
        price: measurementPoint.price,
        barIndex: measurementPoint.barIndex,
        symbol,
        contractSize: getContractSize(symbol, undefined),
        minTick: getMinTick(symbol, undefined),
        currency: getQuoteCurrency(symbol, undefined),
      };
      measurementEnd = { time: Date.now(), price: measurementPoint.price, barIndex: measurementPoint.barIndex };
      updateMeasurementOverlay(measurementStartPoint, measurementEnd, Math.max(0.01, Number(lotsInput.value) || 0.01));
      positionMeasurementCard(event);
      Promise.resolve().then(() => state.chart.data.symbolInfo(symbol)).then((info: Record<string, unknown> | undefined) => {
        if (measurementGesture !== gesture || measurementChart !== state || !measurementStartPoint) return;
        measurementStartPoint = {
          ...measurementStartPoint,
          contractSize: getContractSize(symbol, info),
          minTick: getMinTick(symbol, info),
          currency: getQuoteCurrency(symbol, info),
        };
        updateMeasurementOverlay(measurementStartPoint, measurementEnd, Math.max(0.01, Number(lotsInput.value) || 0.01));
        if (measurementLastPointer) positionMeasurementCard(measurementLastPointer);
      }).catch(error => {
        if (measurementGesture === gesture && measurementChart === state) {
          setStatus(`Could not load symbol details for the measurement: ${error instanceof Error ? error.message : String(error)}`, 'error');
        }
      });
      try {
        state.host.setPointerCapture(event.pointerId);
      } catch (error) {
        reportCaughtError(
          'paper-trade:measurement-pointer-capture',
          error,
          'Measurement continues, but dragging outside the chart may stop tracking.',
        );
      }
      stopChartGesture(event);
    };
    const onMeasurePointerMove = (event: PointerEvent) => {
      if (!measurementModeActive || measurementChart !== state) return;
      measurementLastPointer = { clientX: event.clientX, clientY: event.clientY };
      updateMeasurementVisual(state, event);
      if (!measurementDragging || !measurementStartPoint) return;
      const measurementPoint = measurementPointAtPointer(event);
      if (!measurementPoint) return;
      measurementEnd = {
        time: Date.now(),
        price: measurementPoint.price,
        barIndex: measurementPoint.barIndex,
      };
      updateMeasurementOverlay(measurementStartPoint, measurementEnd, Math.max(0.01, Number(lotsInput.value) || 0.01));
      positionMeasurementCard(event);
      stopChartGesture(event);
    };
    const onMeasurePointerUp = (event: PointerEvent) => {
      if (!measurementModeActive || measurementChart !== state) return;
      if (event.type !== 'pointercancel' && event.button !== 0) return;
      try {
        if (state.host.hasPointerCapture(event.pointerId)) {
          state.host.releasePointerCapture(event.pointerId);
        }
      } catch {}
      const wasDragging = measurementDragging;
      cancelMeasurement();
      if (wasDragging) {
        writeActivity('Measurement complete. Middle-click again to measure.');
      }
      stopChartGesture(event);
    };
    const onMeasureAuxClick = (event: MouseEvent) => {
      if (event.button === 1) stopChartGesture(event);
    };
    const onMeasureWheel = (event: WheelEvent) => {
      if (measurementModeActive && measurementChart === state) stopChartGesture(event);
    };
    state.host.addEventListener('pointerdown', onMeasurePointerDown, true);
    state.host.addEventListener('pointermove', onMeasurePointerMove, true);
    state.host.addEventListener('pointerup', onMeasurePointerUp, true);
    state.host.addEventListener('pointercancel', onMeasurePointerUp, true);
    state.host.addEventListener('auxclick', onMeasureAuxClick, true);
    state.host.addEventListener('wheel', onMeasureWheel, { capture: true, passive: false });
    state.disposers.push(() => {
      state.host.removeEventListener('pointerdown', onMeasurePointerDown, true);
      state.host.removeEventListener('pointermove', onMeasurePointerMove, true);
      state.host.removeEventListener('pointerup', onMeasurePointerUp, true);
      state.host.removeEventListener('pointercancel', onMeasurePointerUp, true);
      state.host.removeEventListener('auxclick', onMeasureAuxClick, true);
      state.host.removeEventListener('wheel', onMeasureWheel, true);
    });
  };

  for (const state of chartStates.values()) attachMeasurementTool(state);

  const onMeasurementKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && (measurementModeActive || measurementStartPoint || measurementVisual)) cancelMeasurement();
  };
  window.addEventListener('keydown', onMeasurementKeyDown);

  createMeasurementOverlay();

  return () => {
    document.removeEventListener('omega:trading-panel-mounted', onTradingPanelMounted);
    document.removeEventListener('omega:trading-panel-open', onTradingPanelOpened);
    document.removeEventListener('omega:trading-panel-unmounted', onTradingPanelUnmounted);
    if (initializedTradingPane && !initializedTradingPane.isConnected) initializedTradingPane = null;
    refreshTradingPane = null;
    cleanupWatchlist();
    if (overlayRenderFrame !== null) window.cancelAnimationFrame(overlayRenderFrame);
    overlayRenderFrame = null;
    unsubscribeCells();
    unsubscribeDestroyed();
    feePerLotInput?.removeEventListener('change', onFeePerLotChange);
    document.removeEventListener('omega:ctrader-positions-updated', onBrokerPositionsUpdated);
    window.removeEventListener('keydown', onMeasurementKeyDown);
    window.removeEventListener('keydown', onTradePreviewKeyDown);
    removeOrderPreviewCard();
    cancelMeasurement();
    document.getElementById('omega-measurement-overlay')?.remove();
    for (const state of chartStates.values()) {
      state.disposers.forEach(dispose => dispose());
      state.tradeOverlay.remove();
    }
    chartStates.clear();
    brokerChartPositions.clear();
    restoredCells.clear();
    refreshOpenTradesList = null;
  };
}
