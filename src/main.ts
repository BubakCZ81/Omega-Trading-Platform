import { BinanceProvider, CoinbaseProvider, registerLayout, VelaWorkspace } from './platform';
import './styles.css';
import './editorDrawer';
import { ensureIndicatorBrowserRegistration, isIndicatorBrowserRegistered } from './indicatorBrowserLoader';
import { appAssetUrl } from './appPaths';
import { registerRendererLayer, registerStatePersistence, sidePanels, type IndicatorHandle } from './platform';
import type { PineModel } from './pineEditorNext';
import { getSavedScripts, saveScriptsToStorage } from './pineStorage';
import { createPineScriptManager } from './pineScriptManager';
import { createPineEditorLifecycle } from './pineEditorLifecycle';
import { initializePineScriptControls } from './pineScriptControls';
import { createPineAiAssistant } from './pineAiAssistant';
import { createPriceBarRatioController, type PriceBarRatioController, type WheelZoomMode } from './priceBarRatio';
import { preservePriceAxisAutoFit } from './priceAxisAutoFit';
import {
  BID_ASK_COLOR_OPTIONS,
  BID_ASK_WIDTH_OPTIONS,
  createBidAskLinesController,
  loadBidAskLineStyle,
  type BidAskLineStyle,
} from './bidAskLines';
import { clearStartupIndicators } from './startupWorkspaceState';
import { restoreWorkspaceScriptIndicators, snapshotWorkspaceScriptIndicators } from './workspaceScriptIndicators';
import { initializeChartTimeframeControls } from './chartTimeframeControls';
import { initializeSpreadReadout } from './spreadReadout';
import { initializeColorPickerDismissal } from './colorPickerDismissal';
import { initializeQuickTradeToggle } from './quickTradeToggle';
import './chartTopbarActions';
import './tradingPanel';
import './autoTrendlines';
import './supplyDemandZones';
import './priceActionDetectors';
import { CHART_GROUP_COLORS, initializeChartGroups } from './chartGroups';
import './favoriteDrawingTools';
import { isOptionalModuleEnabled, loadOptionalModule, type OptionalModule, type OptionalModuleId } from './featureModules';
import { createReplayAwareEngine } from './replayStreamingEngine';
import { validatePineSourceOnWorker } from './pineWorkerValidation';
import { refreshMarketFlowStyles } from './marketFlowPane';
import { attachFuturesMonthBoundaries } from './futuresMonthBoundaries';
import { formatTradingSessionStatus, getOpenTradingSessions } from './tradingSessions';
import { initializeWorkspaceProfiles } from './workspaceProfiles';
import type { ChartTabsState } from './chartTabs';
import { createWorkspaceFeatureLoaders } from './workspaceFeatureLoaders';
import { applyThemeUi, initializeThemeMenu, isOmegaTheme, omegaThemeMode, velaTheme, type OmegaTheme } from './themeControls';
import { LoadedBarsController } from './loadedBars';
import { initializeTradingAccounts } from './tradingAccounts';
import { reportCaughtError } from './diagnostics';
import { startLayoutCapture } from './layoutMap';
import { startUiInventory } from './uiInventory';
import { startPanelPicker } from './panelPicker';
import { initializeQuantowerFeed, QuantowerDataProvider } from './quantowerFeed';
import { initializeIbkrFeed } from './ibkrFeed';
import { initializeCTraderFeed } from './ctraderFeed';
import { initializeSaxoFeed } from './saxoFeed';
import { isReplayActive, setReplayActive } from './replayState';
import {
  armPineQuantowerAutoTrading,
  disarmPineQuantowerAutoTrading,
  getPineQuantowerAutoTradingAccountId,
} from './pineQuantowerAutoTrading';
import { registerHeikinVariants } from './heikinVariants';
import { registerTpoChartType } from './tpoChart';
import { registerFootprintChartType } from './footprintChart';
import { chartSidebarLayout, dockChartSidebarOnDrawingRail } from './chartToolsRail';
import { HEIKIN_VARIANTS } from './heikinMath';
import { guardBar } from './trading/marketDataGuards';
import { releaseOrderIntent, requestOrderIntent } from './trading/idempotency';
import { enableDataWindowResize } from './dataWindowResize';
import { initializeChartSettingsActions } from './chartSettingsActions';
import { initializeSafeguardsPanel } from './safeguardsPanel';
import { registerPaperTradeOverlay } from './paperTradeOverlay';
import { initializeChartContextActions } from './chartContextActions';
import { initializeChartReturnToLatest } from './chartReturnToLatest';
import { registerChartRendererSettings } from './chartRendererSettings';
import { bindPlatformChartResize } from './platformChartResize';
import {
  DEFAULT_RESET_CHART_CANDLES,
  MAX_RESET_CHART_CANDLES,
  parseResetChartCandleCount,
} from './chartReset';
import type { ScriptingEngine } from './platform';
import { StartupModuleIndex, moduleElementsReady } from './startupModuleIndex';
import { applyTopPanelMode, getTopPanelMode, type TopPanelMode } from './topPanelMode';
// createWindow will be loaded lazily inside openTauriStandaloneEditor

const startupScreen = document.getElementById('omega-startup-screen');
const startupStatus = document.getElementById('omega-startup-status');
const rendererStartupStartedAt = performance.now();

type DiagnosticEntry = {
  time: string;
  source?: string;
  type?: string;
  name?: string;
  target?: string;
  status?: string;
  message?: string;
  durationMs?: number;
};

declare global {
  interface Window {
    velaDiagnostics?: {
      openConsole(): Promise<boolean>;
      getRecent(): Promise<{ entries: DiagnosticEntry[]; file: string }>;
      record(entry: Omit<DiagnosticEntry, 'time'>): void;
      onEntry(callback: (entry: DiagnosticEntry) => void): () => void;
    };
    velaVisualBacktestWindow?: {
      open(config: { symbol: string; timeframe: string; provider?: string; strategy?: { title: string; source: string } }): Promise<boolean>;
      onOpenConfig(callback: (config: { symbol: string; timeframe: string; provider?: string; strategy?: { title: string; source: string } }) => void): () => void;
    };
  }
}

function setStartupStatus(message: string, state?: 'error'): void {
  if (startupStatus) {
    startupStatus.textContent = message;
    if (state) startupStatus.dataset.state = state;
  }
}

function showStartupFailure(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error('Platform startup failed:', error);
  setStartupStatus(`Omega could not finish starting: ${message}`, 'error');
  const retry = document.getElementById('omega-startup-retry');
  if (retry instanceof HTMLButtonElement) {
    retry.hidden = false;
    retry.addEventListener('click', () => window.location.reload(), { once: true });
  }
}

// A failure before the first paint must be visible; a failure afterwards must NOT replace
// the workspace with a failure screen. Report it, keep the platform alive, keep the charts.
function reportRendererFailure(error: unknown): void {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  try {
    window.velaDiagnostics?.record({
      source: 'renderer', type: 'process', name: 'unhandled', status: 'error', message,
    });
  } catch { /* never throw from an error handler */ }
  console.error('Unhandled renderer error (platform kept alive):', error);
  if (!workspaceInitialized) {
    showStartupFailure(error);
    return;
  }
  try {
    workspace.toast(`Recovered from an internal error: ${message}`, 'error');
  } catch (error) {
    reportCaughtError('renderer:toast', error);
  }
}
window.addEventListener('error', event => reportRendererFailure(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => reportRendererFailure(event.reason));

setStartupStatus('Loading chart tools and market data providers…');

const standalonePineEditor = new URLSearchParams(window.location.search).get('window') === 'pine-editor';
const standaloneEditorModules = standalonePineEditor
  ? Promise.all([import('./pineEditorNext'), import('./pineReferencePanel')])
  : null;


const optionalModuleLoads = Promise.all([
  loadStartupModule('broker', () => import('./brokerPanel')),
  loadStartupModule('mt5-feed', () => import('./mt5Feed')),
  loadStartupModule('alpaca-feed', () => import('./alpacaFeed')),
  loadStartupModule('price-bar-ratio', () => import('./priceBarRatioMenu')),
  loadStartupModule('backtest', () => import('./backtestPanel')),
  loadStartupModule('news', () => import('./newsPanel')),
  loadStartupModule('update-checker', () => import('./updateChecker')),
]);

function loadStartupModule<T>(id: OptionalModuleId, loader: () => Promise<T>): Promise<OptionalModule<T>> {
  if (standalonePineEditor && id !== 'pinets') {
    return Promise.resolve({ enabled: false });
  }
  return loadOptionalModule(id, loader);
}

// PineTS is large. The chart starts candle-only and the runtime is attached just
// after first interactive paint (or on the first validation request).
setStartupStatus('Restoring your charts and workspace settings…');

// ---------------------------------------------------------------------------
// 1. Script Storage
// ---------------------------------------------------------------------------
let scripts = getSavedScripts();
const requestedPineScript = new URLSearchParams(window.location.search).get('script');
let currentScriptName = requestedPineScript && scripts[requestedPineScript]
  ? requestedPineScript
  : Object.keys(scripts)[0] || 'Dual EMA Cross';
const savedTheme = localStorage.getItem('vela_theme') || localStorage.getItem('omega:theme');
let currentTheme: OmegaTheme = isOmegaTheme(savedTheme) ? savedTheme : 'dark';
let topPanelMode: TopPanelMode = getTopPanelMode();
applyTopPanelMode(topPanelMode);
const TOOLBAR_AUTO_FIT_STORAGE_KEY = 'omega.toolbar-auto-fit';
let toolbarAutoFitEnabled = localStorage.getItem(TOOLBAR_AUTO_FIT_STORAGE_KEY) !== 'false';

/** Keep the fixed application toolbar on one stable row when a window moves
 * between monitors. This affects only the platform toolbar, never chart cells
 * or Vela's chart-local controls. */
function fitTopToolbarToWindow(): void {
  const toolbar = document.getElementById('top-toolbar');
  if (!toolbar) return;
  const controlZone = toolbar.querySelector<HTMLElement>('.toolbar-control-zone');
  toolbar.dataset.omegaAutoFitToolbar = toolbarAutoFitEnabled ? 'true' : 'false';
  // The toolbar declares its own default value, so the fit scale must be set
  // on that element instead of the document root where it would be shadowed.
  const setScale = (scale: number) => toolbar.style.setProperty('--omega-toolbar-scale', String(scale));
  const compactToolbar = window.matchMedia('(max-width: 96rem)').matches;
  const overflows = () => toolbar.scrollWidth > toolbar.clientWidth + 1
    || (!compactToolbar && Boolean(controlZone && controlZone.scrollWidth > controlZone.clientWidth + 1));
  setScale(1);
  if (!toolbarAutoFitEnabled) return;

  let scale = 1;
  for (let attempt = 0; attempt < 12 && overflows(); attempt += 1) {
    scale = Math.max(0.64, Number((scale - 0.03).toFixed(2)));
    setScale(scale);
    if (scale === 0.64) break;
  }
}

let toolbarFitFrame = 0;
function scheduleToolbarFit(): void {
  if (toolbarFitFrame) return;
  toolbarFitFrame = window.requestAnimationFrame(() => {
    toolbarFitFrame = 0;
    fitTopToolbarToWindow();
    positionCompactToolbarMenus();
  });
}

function positionCompactToolbarMenus(): void {
  const compact = window.matchMedia('(max-width: 96rem)').matches;
  for (const id of ['ctrader-timeframe-menu', 'theme-menu', 'replay-menu']) {
    const details = document.getElementById(id) as HTMLDetailsElement | null;
    const popup = details?.querySelector<HTMLElement>(
      ':scope > .ctrader-timeframe-content, :scope > .theme-menu-content, :scope > .timeframe-menu-content',
    );
    const summary = details?.querySelector<HTMLElement>(':scope > summary');
    if (!details || !popup || !summary) continue;
    if (!compact || !details.open) {
      popup.style.removeProperty('position');
      popup.style.removeProperty('left');
      popup.style.removeProperty('right');
      popup.style.removeProperty('top');
      continue;
    }

    popup.style.position = 'fixed';
    popup.style.left = '0px';
    popup.style.right = 'auto';
    popup.style.top = '0px';
    const anchor = summary.getBoundingClientRect();
    const menu = popup.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menu.width - 8));
    const below = anchor.bottom + 6;
    const top = below + menu.height <= window.innerHeight - 8
      ? below
      : Math.max(8, anchor.top - menu.height - 6);
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }
}

let toolbarMenuPositionFrame = 0;
function scheduleToolbarMenuPosition(): void {
  if (toolbarMenuPositionFrame) return;
  toolbarMenuPositionFrame = window.requestAnimationFrame(() => {
    toolbarMenuPositionFrame = 0;
    positionCompactToolbarMenus();
  });
}

for (const id of ['ctrader-timeframe-menu', 'theme-menu', 'replay-menu']) {
  document.getElementById(id)?.addEventListener('toggle', scheduleToolbarMenuPosition);
}
document.querySelector('#top-toolbar .toolbar-control-zone')
  ?.addEventListener('scroll', scheduleToolbarMenuPosition);
window.addEventListener('resize', scheduleToolbarMenuPosition);

function setToolbarAutoFitEnabled(enabled: boolean): void {
  toolbarAutoFitEnabled = enabled;
  localStorage.setItem(TOOLBAR_AUTO_FIT_STORAGE_KEY, String(enabled));
  scheduleToolbarFit();
  if (workspaceInitialized) workspace.context().stateChanged();
}

window.addEventListener('resize', scheduleToolbarFit);
window.addEventListener('omega:platform-layout-resize-request', scheduleToolbarFit);
window.setTimeout(scheduleToolbarFit, 300);
let workspace: VelaWorkspace;
let loadedBarsController: LoadedBarsController;
let workspaceInitialized = false;
type PaperTradingModule = typeof import('./chartPaperTrading');
let paperTradingModule: PaperTradingModule | null = null;
let paperTradingInitialization: Promise<PaperTradingModule> | null = null;
let barThickness = Math.max(0.15, Math.min(1, Number(localStorage.getItem('vela_bar_thickness') ?? 1)));
const RESET_CHART_CANDLES_STORAGE_KEY = 'omega_reset_chart_candles';
let resetChartCandles = parseResetChartCandleCount(localStorage.getItem(RESET_CHART_CANDLES_STORAGE_KEY))
  ?? DEFAULT_RESET_CHART_CANDLES;

function ensurePaperTrading(): Promise<PaperTradingModule> {
  if (paperTradingModule) return Promise.resolve(paperTradingModule);
  if (!paperTradingInitialization) {
    paperTradingInitialization = import('./rightTradingPanel')
      .then(({ initializeRightTradingPanel }) => initializeRightTradingPanel(workspace))
      .then(module => {
        paperTradingModule = module;
        return module;
      })
      .catch(error => {
        paperTradingInitialization = null;
        throw error;
      });
  }
  return paperTradingInitialization;
}

document.addEventListener('omega:trading-panel-open', () => {
  void ensurePaperTrading().catch(error => {
    reportCaughtError('paper-trading:open-panel', error, 'The Trading Panel could not be initialized.');
    workspace.toast('Trading Panel could not be opened.', 'error');
  });
});

async function loadIndicatorManifest() {
  try {
    const response = await fetch(appAssetUrl('/indicators/catalog.json'));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = await response.json();
    if (!Array.isArray(manifest)) throw new Error('The indicator catalog has an invalid format.');
    return manifest.filter(entry => entry && typeof entry === 'object' && entry.referenceOnly !== true);
  } catch (error) {
    const message = `Indicator catalog failed to load: ${error instanceof Error ? error.message : String(error)}`;
    const status = document.getElementById('editor-status');
    if (status) {
      status.textContent = message;
      status.dataset.state = 'error';
    }
    console.error(message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 2. Vela Workspace
// ---------------------------------------------------------------------------
// Keep Pine compilation and execution off the renderer thread so heavy scripts
// cannot stall chart interaction.
let pineEngine: ScriptingEngine | null = null;
let pineRuntimeLoading: Promise<void> | null = null;
function ensurePineRuntime(): Promise<void> {
  if (pineEngine) return Promise.resolve();
  if (!pineRuntimeLoading) {
    pineRuntimeLoading = loadStartupModule('pinets', () => import('@luxalgo/vela-pinets')).then(module => {
      const PineEngine = module.value?.PineEngine;
      if (!PineEngine) throw new Error('PineTS 0.14 engine is disabled or unavailable.');
      pineEngine = createReplayAwareEngine(new PineEngine(), isReplayActive);
      for (const cell of workspace.cells()) cell.chart.registerEngine('pine', pineEngine!);
      window.velaDiagnostics?.record({ source: 'startup', type: 'performance', name: 'pine-runtime-ready', status: 'ok' });
    }).catch(error => { pineRuntimeLoading = null; console.error('Pine runtime could not be loaded:', error); throw error; });
  }
  return pineRuntimeLoading;
}
const scriptHandles = new Map<string, Map<string, IndicatorHandle>>();
const chartGroupColors = ['red', 'blue', 'green', 'yellow', 'purple'] as const;
const groupByCellId: Record<string, string> = {};
const OMEGA_TABS_LAYOUT_PREFIX = 'omega-tabs-';
const OMEGA_TABS_MAX = 8;
const storedChartTabCount = Number(localStorage.getItem('omega_chart_tabs_count'));
const chartTabsState: ChartTabsState = {
  enabled: localStorage.getItem('omega_chart_tabs_enabled') === 'true',
  count: Number.isInteger(storedChartTabCount) ? Math.max(1, Math.min(OMEGA_TABS_MAX, storedChartTabCount)) : 1,
  previousLayout: localStorage.getItem('omega_chart_tabs_previous_layout') || '1',
};
const chartTabsLayoutId = (count: number) => `${OMEGA_TABS_LAYOUT_PREFIX}${count}`;
const isChartTabsLayout = (layoutId: string) => /^omega-tabs-[1-8]$/.test(layoutId);
if (isChartTabsLayout(chartTabsState.previousLayout)) chartTabsState.previousLayout = '1';

// Each tab count has its own overlapping layout. Reducing the count therefore makes
// Vela destroy the removed cells instead of merely hiding live chart instances.
for (let count = 1; count <= OMEGA_TABS_MAX; count += 1) {
  registerLayout({
    id: chartTabsLayoutId(count),
    label: 'Chart tabs',
    cols: [1],
    rows: [1],
    areas: ['main'],
    cells: Array.from({ length: count }, (_, index) => ({ id: `tab-${index + 1}`, area: 'main' })),
  });
}
const priceBarRatioControllers = new Set<PriceBarRatioController>();
const bidAskLinesControllers = new Map<string, ReturnType<typeof createBidAskLinesController>>();
const futuresMonthBoundaryDisposers = new Map<string, () => void>();
let lockPriceToBarRatio = localStorage.getItem('vela_lock_price_to_bar_ratio') === 'true';
const savedWheelZoomMode = localStorage.getItem('omega_mouse_wheel_zoom_mode');
let wheelZoomMode: WheelZoomMode = savedWheelZoomMode === 'price' || savedWheelZoomMode === 'both'
  ? savedWheelZoomMode
  : 'both';
let showBidAskLines = localStorage.getItem('vela_show_bid_ask_lines') !== 'false';
let bidAskLineStyle = loadBidAskLineStyle();
let propagatingGroupState = false;

interface WorkspaceFileBridge {
  load(): Promise<string | null>;
  save(state: string): Promise<void>;
  saveProfile(name: string, state: string): Promise<{ canceled: boolean; path?: string }>;
  loadProfile(): Promise<{ canceled: boolean; state?: string; path?: string }>;
}

interface ProfileBridge extends WorkspaceFileBridge {}

interface PineExportBridge {
  save(name: string, source: string): Promise<{ canceled: boolean; path?: string }>;
}

declare global {
  interface Window {
    velaWorkspaceFiles?: ProfileBridge;
    velaPineExport?: PineExportBridge;
    velaApp?: {
      ready(): void;
    };
  }
}

function getWorkspaceStorage() {
  if (window.velaWorkspaceFiles) {
    return {
      get: (key: string) => key === 'vela-workspace' ? clearStartupIndicators(savedWorkspaceRaw) : null,
      set: (key: string, value: string) => key === 'vela-workspace' ? window.velaWorkspaceFiles!.save(value) : undefined,
    };
  }
  return {
    get: (key: string) => Promise.resolve(key === 'vela-workspace'
      ? clearStartupIndicators(localStorage.getItem(key))
      : localStorage.getItem(key)),
    set: (key: string, value: string) => localStorage.setItem(key, value),
  };
}

const barThicknessStorageKey = 'vela_bar_thickness';

registerStatePersistence({
  key: 'vela.chartPreferences',
  scope: 'global',
  serialize: () => ({ barThickness }),
  restore: payload => {
    if (payload && typeof payload === 'object' && 'barThickness' in payload) {
      const value = Number((payload as { barThickness: unknown }).barThickness);
      if (Number.isFinite(value)) setBarThickness(value, false);
    }
  },
});

registerStatePersistence({
  key: 'vela.chartGroup',
  scope: 'cell',
  serialize: ctx => ({ color: groupByCellId[ctx.cellId] ?? '' }),
  restore: (payload, ctx) => {
    const color = payload && typeof payload === 'object' && 'color' in payload
      ? String((payload as { color: unknown }).color)
      : '';
    if (chartGroupColors.includes(color as typeof chartGroupColors[number])) groupByCellId[ctx.cellId] = color;
  },
});

registerStatePersistence({
  key: 'omega.scriptIndicators',
  scope: 'cell',
  serialize: ctx => snapshotWorkspaceScriptIndicators(ctx.chart.indicators()),
  restore: (payload, ctx) => restoreWorkspaceScriptIndicators(payload, ctx),
});

registerStatePersistence({
  key: 'omega.chartPreferences',
  scope: 'global',
  serialize: () => ({
    theme: currentTheme,
    barThickness,
    resetChartCandles,
    lockPriceToBarRatio,
    wheelZoomMode,
    showBidAskLines,
    bidAskLineStyle,
    chartTabsEnabled: chartTabsState.enabled,
    chartTabCount: chartTabsState.count,
    chartTabsPreviousLayout: chartTabsState.previousLayout,
  }),
  restore: payload => {
    if (!payload || typeof payload !== 'object') return;
    const preferences = payload as Record<string, unknown>;
    if (isOmegaTheme(preferences.theme)) {
      currentTheme = preferences.theme;
      localStorage.setItem('vela_theme', currentTheme);
      applyThemeUi(currentTheme);
      if (workspaceInitialized) {
        workspace.setTheme(velaTheme(currentTheme));
        for (const cell of workspace.cells()) applyChartVisualSettings(cell.chart);
        applyChartAxisTextColor();
        pineEditorLifecycle.setTheme(omegaThemeMode(currentTheme));
      }
    }
    if (typeof preferences.barThickness === 'number' && Number.isFinite(preferences.barThickness)) {
      setBarThickness(preferences.barThickness, false);
    }
    const restoredResetChartCandles = parseResetChartCandleCount(preferences.resetChartCandles);
    if (restoredResetChartCandles != null) setResetChartCandles(restoredResetChartCandles, false);
    if (typeof preferences.lockPriceToBarRatio === 'boolean') {
      setLockPriceToBarRatio(preferences.lockPriceToBarRatio);
    }
    if (preferences.wheelZoomMode === 'time' || preferences.wheelZoomMode === 'price' || preferences.wheelZoomMode === 'both') {
      setWheelZoomMode(preferences.wheelZoomMode);
    }
    if (typeof preferences.showBidAskLines === 'boolean') {
      setShowBidAskLines(preferences.showBidAskLines);
    }
    if (typeof preferences.chartTabsEnabled === 'boolean') chartTabsState.enabled = preferences.chartTabsEnabled;
    if (typeof preferences.chartTabCount === 'number' && Number.isInteger(preferences.chartTabCount)) {
      chartTabsState.count = Math.max(1, Math.min(OMEGA_TABS_MAX, preferences.chartTabCount));
    }
    if (typeof preferences.chartTabsPreviousLayout === 'string' && !isChartTabsLayout(preferences.chartTabsPreviousLayout)) {
      chartTabsState.previousLayout = preferences.chartTabsPreviousLayout;
    }
    if (preferences.bidAskLineStyle && typeof preferences.bidAskLineStyle === 'object') {
      const style = preferences.bidAskLineStyle as Partial<BidAskLineStyle>;
      const supportedColors = BID_ASK_COLOR_OPTIONS.map(([color]) => color);
      const supportedWidths = BID_ASK_WIDTH_OPTIONS as readonly number[];
      const validated: Partial<BidAskLineStyle> = {};
      if (typeof style.bidColor === 'string' && supportedColors.includes(style.bidColor as typeof supportedColors[number])) {
        validated.bidColor = style.bidColor;
      }
      if (typeof style.askColor === 'string' && supportedColors.includes(style.askColor as typeof supportedColors[number])) {
        validated.askColor = style.askColor;
      }
      if (typeof style.lineWidth === 'number' && supportedWidths.includes(style.lineWidth)) {
        validated.lineWidth = style.lineWidth;
      }
      if (style.lineStyle === 'solid' || style.lineStyle === 'dashed' || style.lineStyle === 'dotted') {
        validated.lineStyle = style.lineStyle;
      }
      setBidAskLineStyle(validated);
    }
  },
});

registerRendererLayer({
  id: 'vela-bar-thickness',
  placement: 'below-data',
  create: () => ({
    mount: () => undefined,
    render: () => undefined,
    modulateBase: () => ({ candleBodyScale: barThickness }),
  }),
});

function setBarThickness(value: number, notifyWorkspace = true) {
  barThickness = Math.max(0.15, Math.min(1, value));
  localStorage.setItem(barThicknessStorageKey, String(barThickness));
  if (workspaceInitialized) {
    for (const cell of workspace.cells()) {
      const config = cell.chart.renderer.getConfig() as { layout?: { fontSize?: number } } | null;
      if (config?.layout) cell.chart.renderer.applyConfig({ layout: { fontSize: config.layout.fontSize } });
    }
    if (notifyWorkspace) workspace.context().stateChanged();
  }
}

function setResetChartCandles(value: number, notifyWorkspace = true): void {
  const validatedValue = parseResetChartCandleCount(value);
  if (validatedValue == null) {
    throw new RangeError(`Reset chart candles must be a whole number from 1 to ${MAX_RESET_CHART_CANDLES}.`);
  }
  resetChartCandles = validatedValue;
  localStorage.setItem(RESET_CHART_CANDLES_STORAGE_KEY, String(resetChartCandles));
  if (notifyWorkspace && workspaceInitialized) workspace.context().stateChanged();
}

// Single sources of truth for these preferences — both the settings UI (via
// chartRendererSettingsOptions) and state restoration route through these, so the
// variable, persistence and controller updates can never drift apart.
function setLockPriceToBarRatio(enabled: boolean): void {
  lockPriceToBarRatio = enabled;
  localStorage.setItem('vela_lock_price_to_bar_ratio', String(enabled));
  for (const controller of priceBarRatioControllers) controller.setEnabled(enabled);
  if (workspaceInitialized) workspace.context().stateChanged();
}

function setWheelZoomMode(mode: WheelZoomMode): void {
  wheelZoomMode = mode;
  localStorage.setItem('omega_mouse_wheel_zoom_mode', mode);
  for (const controller of priceBarRatioControllers) controller.setWheelMode(mode);
  if (workspaceInitialized) workspace.context().stateChanged();
}

function setShowBidAskLines(enabled: boolean): void {
  showBidAskLines = enabled;
  localStorage.setItem('vela_show_bid_ask_lines', String(enabled));
  for (const controller of bidAskLinesControllers.values()) controller.setEnabled(enabled);
  if (workspaceInitialized) workspace.context().stateChanged();
}

function setBidAskLineStyle(next: Partial<BidAskLineStyle>): void {
  bidAskLineStyle = { ...bidAskLineStyle, ...next };
  localStorage.setItem('vela_bid_ask_bid_color', bidAskLineStyle.bidColor);
  localStorage.setItem('vela_bid_ask_ask_color', bidAskLineStyle.askColor);
  localStorage.setItem('vela_bid_ask_line_width', String(bidAskLineStyle.lineWidth));
  localStorage.setItem('vela_bid_ask_line_style', bidAskLineStyle.lineStyle);
  for (const controller of bidAskLinesControllers.values()) controller.setStyle(bidAskLineStyle);
  if (workspaceInitialized) workspace.context().stateChanged();
}

const chartRendererSettingsOptions = {
  getWorkspace: () => workspace,
  chartTabsState,
  groupByCellId,
  isChartTabsLayout,
  setChartTabsEnabled: (enabled: boolean) => setChartTabsEnabled(enabled),
  setCellGroup: (cellId: string, group: string) => setCellGroup(cellId, group),
  getTheme: () => currentTheme,
  setTheme,
  getTopPanelMode: () => topPanelMode,
  setTopPanelMode: (mode: TopPanelMode) => {
    topPanelMode = mode;
    applyTopPanelMode(mode);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
  getToolbarAutoFitEnabled: () => toolbarAutoFitEnabled,
  setToolbarAutoFitEnabled,
  getBarThickness: () => barThickness,
  setBarThickness: (value: number) => setBarThickness(value),
  getLockPriceToBarRatio: () => lockPriceToBarRatio,
  setLockPriceToBarRatio,
  getWheelZoomMode: () => wheelZoomMode,
  setWheelZoomMode,
  getShowBidAskLines: () => showBidAskLines,
  setShowBidAskLines,
  getBidAskLineStyle: () => bidAskLineStyle,
  setBidAskLineStyle,
  setLoadedBars: (cellId: string, bars: number) => loadedBarsController.set(cellId, 0, bars),
};

function configureChartRenderer(chart: VelaWorkspace['chart'], cellId: string) {
  preservePriceAxisAutoFit(chart, cellId);
  // Renko and Range were retired: Vela cannot sequence styles that change the bar count or
  // the time axis, which is why those bars were never reliable. A profile saved with one of
  // them now falls back to candles instead of failing to mount.
  const storedStyle = String(chart.renderer.get('priceStyle') ?? '');
  if (storedStyle === 'renko' || storedStyle === 'range') {
    chart.renderer.set('priceStyle', 'candles');
    window.velaDiagnostics?.record({
      source: 'chart-style', type: 'migration', name: 'retired-style', status: 'ok',
      message: `${storedStyle} bars were retired by this version; this chart now shows candles.`,
    });
  }
  if (pineEngine) chart.registerEngine('pine', pineEngine);
  chart.renderer.set('zoomAnchor', 'cursor');
  const priceBarRatio = createPriceBarRatioController(chart.renderer);
  priceBarRatioControllers.add(priceBarRatio);
  priceBarRatio.setWheelMode(wheelZoomMode);
  const syncPriceBarRatio = () => {
    // Every remaining chart style is time-based, so the price-to-bar ratio always applies.
    priceBarRatio.setEnabled(lockPriceToBarRatio);
  };
  syncPriceBarRatio();
  chart.on('priceStyle:change', syncPriceBarRatio);
  const bidAskLines = createBidAskLinesController(chart);
  bidAskLinesControllers.set(cellId, bidAskLines);
  futuresMonthBoundaryDisposers.get(cellId)?.();
  futuresMonthBoundaryDisposers.set(cellId, attachFuturesMonthBoundaries(chart));
  registerChartRendererSettings(chart, chartRendererSettingsOptions);
  applyChartVisualSettings(chart);
}

function applyChartVisualSettings(chart: VelaWorkspace['chart']): void {
  const borderColor = velaTheme(currentTheme).chart.borderColor;
  chart.renderer.applyConfig({ style: { borderColor, separatorColor: borderColor } });
  const crosshair = chart.renderer.get('crosshair');
  if (crosshair && typeof crosshair === 'object') {
    chart.renderer.set('crosshair', {
      ...crosshair,
      color: '#ef4444',
      opacity: 0.9,
      labelBackground: '#b91c1c',
    });
  }
}

const workspaceStorage = getWorkspaceStorage();
// Renko and Range chart types are no longer registered (retired in Omega 4.0.0).
let savedWorkspaceRaw: string | null = null;
let restoredWorkspaceState: any = null;
try {
  savedWorkspaceRaw = window.velaWorkspaceFiles
    ? await window.velaWorkspaceFiles.load()
    : localStorage.getItem('vela-workspace');
  if (savedWorkspaceRaw) {
    const parsed = JSON.parse(savedWorkspaceRaw);
    restoredWorkspaceState = parsed && parsed.version === 1 && Array.isArray(parsed.charts) ? parsed : null;
  }
} catch (error) {
  console.error('Could not load saved chart workspace:', error);
}

const isDefaultWorkspace = restoredWorkspaceState?.ext?.['omega.workspaceProfile']?.name === 'default';
const restoredLayout = restoredWorkspaceState?.layout;
const initialWorkspaceLayout = chartTabsState.enabled
  ? '1'
  : (restoredLayout && !isChartTabsLayout(restoredLayout) ? restoredLayout : '1');
const chartGridHost = document.createElement('div');
chartGridHost.id = 'chart-grid';
Object.assign(chartGridHost.style, { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' });
document.getElementById('chart')!.append(chartGridHost);

setStartupStatus('Building your trading workspace…');
// Vela snapshots its renderer-layer list when a chart mounts. Register the
// paper-trade overlay first so the measurement tool always has its canvas.
registerPaperTradeOverlay();
// Heikin Ashi variants are 1:1 bar transforms, so they must be registered before any chart
// mounts — a chart cannot switch to a style the layer does not know yet.
registerHeikinVariants();
registerTpoChartType();
registerFootprintChartType();
try {
  workspace = new VelaWorkspace(chartGridHost, {
    layout: initialWorkspaceLayout, symbol: 'EURUSD', timeframe: '60', live: true, volume: false, theme: velaTheme(currentTheme), persist: 'vela-workspace', storage: workspaceStorage,
    cells: restoredWorkspaceState?.charts?.length ? Object.fromEntries(restoredWorkspaceState.charts.map((chart: { id: string; symbol?: string; timeframe?: string }) => [chart.id, { symbol: chart.symbol, timeframe: chart.timeframe }])) : (window.velaWorkspaceFiles ? { primary: { symbol: 'EURUSD', timeframe: '60' } } : undefined),
    sync: restoredWorkspaceState?.sync,
    topbar: { left: ['symbol', 'indicators', 'omega-favorite-drawing-tools', 'omega-pine-editor'] },
    sidebar: chartSidebarLayout,
    providers: {},
    engines: {},
    indicators: loadIndicatorManifest,
  });
  if (!dockChartSidebarOnDrawingRail(chartGridHost)) {
    throw new Error('Could not move chart sidebar controls to the left drawing-tools rail.');
  }
  console.log('Vela Workspace loaded.');
} catch (err) {
  console.error('Workspace init error:', err);
  showStartupFailure(err);
  throw err;
}
const platformChartResize = bindPlatformChartResize(
  workspace,
  document,
  callback => window.requestAnimationFrame(callback),
);
void Promise.all(workspace.cells().map(cell => cell.chart.ready()))
  .then(() => platformChartResize.requestResize())
  .catch(error => reportCaughtError(
    'chart-resize-readiness',
    error,
    'Could not initialize chart sizing.',
  ));
loadedBarsController = new LoadedBarsController(workspace);
// The built-in Data Window is the only dock panel Vela creates without a resize policy.
enableDataWindowResize(workspace);
// Renderer settings are core chart functionality. Attach them before waiting
// for optional panels so Settings is complete on the first click every time.
for (const cell of workspace.cells()) configureChartRenderer(cell.chart, cell.id);
const [
  brokerModule,
  mt5FeedModule,
  alpacaSdkFeedModule,
  priceBarRatioModule,
  // Backtest and news register side panels on import; the values are only used
  // here to index their health.
  backtestModule,
  newsModule,
  updateCheckerModule,
] = await optionalModuleLoads;

function hideFeatureElements(enabled: boolean, ...ids: string[]) {
  if (enabled) return;
  for (const id of ids) {
    const element = document.getElementById(id);
    if (element) element.hidden = true;
  }
}

hideFeatureElements(brokerModule.enabled, 'broker-toggle', 'broker-modal');
hideFeatureElements(mt5FeedModule.enabled, 'mt5-feed-toggle', 'mt5-feed-modal');
// Keep the Local Feeds surface available even when the optional MT5 module is
// disabled; Quantower is an independent local data provider.
const quantowerProvider = initializeQuantowerFeed(() => workspace);
if (!quantowerProvider) hideFeatureElements(false, 'quantower-feed-toggle', 'quantower-feed-modal');
initializeTradingAccounts();
initializeIbkrFeed();
initializeCTraderFeed(() => workspace);
initializeSaxoFeed();

/** The broker chosen in the top-right account selector, lower-cased; '' for the local demo account. */
function selectedBrokerProvider(): string {
  const account = localStorage.getItem('omega.selected-trading-account') ?? '';
  const separator = account.indexOf(':');
  return separator > 0 ? account.slice(0, separator).toLowerCase() : '';
}

/**
 * A multi-chart layout creates its new cells with the workspace default instrument.
  * When a broker is connected that default belongs to another feed,
 * so the operator ends up with charts for assets the broker does not offer. Move every
 * cell that is outside the selected broker's universe onto that broker's own symbols.
 */
async function alignCellsToSelectedBroker(): Promise<void> {
  const provider = selectedBrokerProvider();
  if (!provider || !workspaceInitialized) return;
  const reference = workspace.active?.chart ?? workspace.cells()[0]?.chart;
  if (!reference) return;
  const connected = reference.data.providers().some(item => item.name.toLowerCase() === provider);
  if (!connected) return;
  const symbols = reference.data.symbols(provider);
  if (!symbols.length) return;
  let index = 0;
  for (const cell of workspace.cells()) {
    const chart = cell.chart;
    const current = chart.market.symbol ?? '';
    const owner = current ? chart.data.resolve(current)?.provider?.toLowerCase() ?? '' : '';
    if (owner === provider) continue;
    const descriptor = symbols[index % symbols.length];
    index += 1;
    const prefix = typeof (descriptor as { prefix?: unknown }).prefix === 'string'
      ? String((descriptor as { prefix: string }).prefix)
      : '';
    const symbol = prefix ? `${prefix}:${descriptor.ticker}` : descriptor.ticker;
    try {
      await chart.setMarket({ symbol, timeframe: chart.market.timeframe ?? '60' });
    } catch {
      // Feed alignment retries on the next account or layout change without console chatter.
    }
  }
}

let brokerAlignmentPending = false;
function scheduleBrokerAlignment(): void {
  if (brokerAlignmentPending) return;
  brokerAlignmentPending = true;
  window.setTimeout(() => {
    brokerAlignmentPending = false;
    void alignCellsToSelectedBroker();
  }, 250);
}
document.addEventListener('omega:trading-account-selected', scheduleBrokerAlignment);
workspace.on('layout:changed', scheduleBrokerAlignment);
workspace.on('cell:created', scheduleBrokerAlignment);
if (updateCheckerModule.enabled && updateCheckerModule.value) {
  updateCheckerModule.value.initializeUpdateChecker();
}

workspaceInitialized = true;
workspace.setTheme(velaTheme(currentTheme));
for (const cell of workspace.cells()) applyChartVisualSettings(cell.chart);
applyChartAxisTextColor();

async function registerPublicCryptoFeed(chart: VelaWorkspace['chart']): Promise<void> {
  chart.data.registerProvider('binance', new BinanceProvider());
  chart.data.registerProvider('coinbase', new CoinbaseProvider());
  await chart.data.ready();
}

for (const cell of workspace.cells()) {
  const chart = cell.chart;
  const defaultDemoMarket = isDefaultWorkspace
    && ['binance:btcusdt', 'coinbase:btc-usd'].includes(chart.market.symbol?.toLowerCase() ?? '');
  let triedAlternateDemoMarket = false;
  let stopFallbackWatch = (): void => undefined;
  if (defaultDemoMarket) {
    stopFallbackWatch = chart.on('load:end', ({ symbol, bars }) => {
      const normalizedSymbol = symbol.toLowerCase();
      if (bars > 0) {
        stopFallbackWatch();
        return;
      }
      const fallbackSymbol = normalizedSymbol === 'binance:btcusdt'
        ? 'coinbase:BTC-USD'
        : normalizedSymbol === 'coinbase:btc-usd' ? 'binance:BTCUSDT' : null;
      if (!fallbackSymbol || triedAlternateDemoMarket || chart.market.symbol?.toLowerCase() !== normalizedSymbol) return;
      triedAlternateDemoMarket = true;
      stopFallbackWatch();
      void chart.setMarket({ symbol: fallbackSymbol, timeframe: chart.market.timeframe ?? '60' })
        .then(() => window.addConsoleActivity?.(`Default demo candles were unavailable; switched to ${fallbackSymbol} public market data.`, 'warning'))
        .catch(error => reportCaughtError(
          'public-crypto-feed:fallback',
          error,
          'Neither public demo market feed could load candles for the default chart.',
        ));
    });
  }
  void registerPublicCryptoFeed(chart).then(async () => {
    if (!defaultDemoMarket) return;
    if (chart.market.symbol?.toLowerCase() !== 'binance:btcusdt') {
      await chart.setMarket({ symbol: 'binance:BTCUSDT', timeframe: chart.market.timeframe ?? '60' });
    } else {
      await chart.ready();
    }
  }).catch(error => {
    stopFallbackWatch();
    reportCaughtError(
      'public-crypto-feed:register',
      error,
      'The public Coinbase/Binance demo market feeds could not be initialized.',
    );
  });
}
workspace.on('cell:created', event => {
  const chart = workspace.cell(event.id)?.chart;
  if (chart) void registerPublicCryptoFeed(chart).catch(error => reportCaughtError(
    'public-crypto-feed:register-cell',
    error,
    'The public Coinbase/Binance feeds could not be attached to a new chart.',
  ));
});

mt5FeedModule.value?.initializeMt5Feed(() => workspace);
initializeQuantowerFeedUi(quantowerProvider);
alpacaSdkFeedModule.value?.initializeAlpacaSdkFeed(() => workspace);

function initializeQuantowerFeedUi(provider: QuantowerDataProvider | null): void {
  const modal = document.getElementById('quantower-feed-modal');
  const open = document.getElementById('quantower-feed-toggle');
  const close = document.getElementById('quantower-feed-close');
  const connect = document.getElementById('quantower-feed-connect') as HTMLButtonElement | null;
  const disconnect = document.getElementById('quantower-feed-disconnect') as HTMLButtonElement | null;
  const search = document.getElementById('quantower-symbol-search') as HTMLInputElement | null;
  const list = document.getElementById('quantower-symbol-list');
  const connectionStatus = document.getElementById('quantower-feed-status');
  if (!modal || !open || !close || !connect || !disconnect || !search || !list || !provider || !window.velaQuantower) return;
  let connectedAccountIds = new Set<string>();
  const syncPineOrderAccount = () => {
    const selected = localStorage.getItem('omega.selected-trading-account') ?? '';
    if (selected === getPineQuantowerAutoTradingAccountId()) return;
    disarmPineQuantowerAutoTrading();
    if (selected.startsWith('quantower:') && connectedAccountIds.has(selected.slice('quantower:'.length))) {
      armPineQuantowerAutoTrading(selected);
    }
  };
  document.addEventListener('omega:trading-account-selected', syncPineOrderAccount);
  document.addEventListener('omega:trading-broker-connecting', event => {
    if ((event as CustomEvent<string>).detail === 'quantower') return;
    connectedAccountIds.clear();
    syncPineOrderAccount();
  });
  document.addEventListener('omega:trading-broker-disconnected', event => {
    if ((event as CustomEvent<string>).detail !== 'quantower') return;
    connectedAccountIds.clear();
    disarmPineQuantowerAutoTrading();
    syncPineOrderAccount();
  });
  const closeModal = () => { modal.hidden = true; modal.setAttribute('aria-hidden', 'true'); };
  let renderSequence = 0;
  let renderDebounce: number | null = null;
  const renderNow = () => {
    const query = search.value.trim().toLowerCase();
    const requestSequence = ++renderSequence;
    void provider.listSymbols().then(symbols => {
      // A keystroke during a pending request invalidates it; only the newest result renders.
      if (requestSequence !== renderSequence) return;
      list.replaceChildren();
      const filtered = symbols.filter(symbol => !query || `${symbol.ticker} ${symbol.description}`.toLowerCase().includes(query));
      for (const symbol of filtered.slice(0, 200)) {
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'quantower-symbol-row';
        const ticker = document.createElement('strong'); ticker.textContent = symbol.ticker;
        const detail = document.createElement('small'); detail.textContent = `${symbol.description} · Quantower`;
        button.append(ticker, detail);
        button.addEventListener('click', () => workspace.active?.setSymbol(`Quantower:${symbol.ticker}`));
        list.append(button);
      }
      if (!filtered.length) { const empty = document.createElement('p'); empty.textContent = 'No Quantower symbols available.'; list.append(empty); }
    });
  };
  const render = () => {
    if (renderDebounce !== null) window.clearTimeout(renderDebounce);
    renderDebounce = window.setTimeout(() => { renderDebounce = null; renderNow(); }, 150);
  };
  open.addEventListener('click', () => { modal.hidden = false; modal.setAttribute('aria-hidden', 'false'); render(); });
  close.addEventListener('click', closeModal);
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  search.addEventListener('input', render);
  connect.addEventListener('click', async () => {
    connect.disabled = true;
    if (connectionStatus) connectionStatus.textContent = 'Connecting to the Quantower bridge…';
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'quantower' }));
    try {
      await window.velaQuantower!.start();
      const deadline = Date.now() + 90_000;
      let health: { connected: boolean; symbols: number } | null = null;
      let lastHealthError = '';
      let healthErrorReported = false;
      while (Date.now() < deadline) {
        try {
          health = await window.velaQuantower!.health();
          if (health.connected) break;
          lastHealthError = '';
        } catch (error) {
          lastHealthError = error instanceof Error ? error.message : String(error);
          if (!healthErrorReported) {
            reportCaughtError('quantower:health', error, 'Retrying the local Quantower bridge health request.');
            healthErrorReported = true;
          }
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      if (!health?.connected) {
        const detail = lastHealthError ? ` Bridge error: ${lastHealthError}` : ' Connect a data provider in Quantower and retry.';
        throw new Error(`Quantower did not report an active data connection.${detail}`);
      }
      const symbols = await window.velaQuantower!.symbols();
      let accounts: Array<{ id: string; label: string; connectionId: string; connection: string }> = [];
      let accountsEndpointUnavailable = false;
      try {
        accounts = await window.velaQuantower!.accounts();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/unknown endpoint/i.test(message)) throw error;
        reportCaughtError('quantower:accounts', error, 'The loaded bridge does not expose /accounts; continuing with market data only.');
        accountsEndpointUnavailable = true;
      }
      provider.setSymbols(symbols);
      connectedAccountIds = new Set(accounts.map(account => account.id));
      for (const cell of workspace.cells()) cell.chart.data.registerProvider('quantower', provider);
      const first = symbols.find(symbol => symbol.type?.toLowerCase().includes('future')) ?? symbols[0];
      if (first && (!workspace.active?.chart?.market?.symbol || workspace.active.chart.market.symbol === 'AAPL')) workspace.active?.setSymbol(`Quantower:${first.ticker}`);
      if (accounts.length) {
        for (const account of accounts) document.dispatchEvent(new CustomEvent('omega:trading-account-available', { detail: { id: `quantower:${account.id}`, label: `Quantower · ${account.label}`, mode: 'CONNECTED', detail: `${account.connection} · ${account.connectionId}` } }));
      } else {
        document.dispatchEvent(new CustomEvent('omega:trading-account-available', { detail: { id: 'quantower:local', label: 'Quantower · data only', mode: 'DATA', detail: `${symbols.length} symbols from the active Quantower connection` } }));
      }
      document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'quantower' }));
      syncPineOrderAccount();
      connect.hidden = true; disconnect.hidden = false;
      if (connectionStatus) {
        connectionStatus.textContent = accountsEndpointUnavailable
          ? `Connected to Quantower market data (${symbols.length} symbols), but the loaded bridge is outdated and does not expose trading accounts. Update the Quantower plugin and restart Quantower to enable trading.`
          : accounts.length
            ? `Connected to Quantower (${symbols.length} symbols, ${accounts.length} trading account${accounts.length === 1 ? '' : 's'}).`
            : `Connected to Quantower market data (${symbols.length} symbols). No connected trading accounts were reported.`;
      }
      render();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (connectionStatus) connectionStatus.textContent = `Quantower connection failed: ${message}`;
      reportCaughtError('quantower:connect', error, 'Quantower connection failed.');
    } finally { connect.disabled = false; }
  });
  disconnect.addEventListener('click', () => {
    provider.disconnect();
    connectedAccountIds.clear();
    disarmPineQuantowerAutoTrading();
    for (const cell of workspace.cells()) cell.chart.data.unregisterProvider('quantower');
    document.dispatchEvent(new CustomEvent('omega:trading-broker-disconnected', { detail: 'quantower' }));
    disconnect.hidden = true; connect.hidden = false;
    if (connectionStatus) connectionStatus.textContent = 'Disconnected.';
    syncPineOrderAccount();
    render();
  });
}

function waitForAlpacaProvider(): Promise<boolean> {
  return new Promise(resolve => {
    const timeout = window.setTimeout(() => {
      document.removeEventListener('omega:alpaca-provider-ready', ready);
      resolve(false);
    }, 4_000);
    const ready = () => {
      window.clearTimeout(timeout);
      document.removeEventListener('omega:alpaca-provider-ready', ready);
      resolve(true);
    };
    document.addEventListener('omega:alpaca-provider-ready', ready, { once: true });
  });
}

async function autoConnectPreferredDataFeed(): Promise<void> {
  const providerReady = waitForAlpacaProvider();
  const alpacaConnected = await brokerModule.value?.autoConnectSavedAlpaca?.() ?? false;
  if (!alpacaConnected) {
    window.velaDiagnostics?.record({
      source: 'broker-autoconnect', type: 'connection', name: 'no-saved-account', status: 'ok',
      message: 'No saved Alpaca account was connected; no brokerage feed was auto-connected.',
    });
    return;
  }
  if (!await providerReady) {
    window.velaDiagnostics?.record({
      source: 'broker-autoconnect', type: 'connection', name: 'alpaca-provider', status: 'error',
      message: 'Alpaca connected but its chart provider did not become ready in time.',
    });
    return;
  }
  const chart = workspace.active?.chart;
  if (chart?.market.symbol?.toUpperCase() === 'EURUSD') {
    await chart.setMarket({ symbol: 'alpaca:AAPL', timeframe: chart.market.timeframe ?? '60' });
  }
  window.velaDiagnostics?.record({
    source: 'broker-autoconnect', type: 'connection', name: 'alpaca', status: 'ok',
    message: 'Saved Alpaca account connected read-only.',
  });
}

priceBarRatioModule.value?.initializePriceBarRatioMenu(
  () => lockPriceToBarRatio,
  enabled => {
    lockPriceToBarRatio = enabled;
    localStorage.setItem('vela_lock_price_to_bar_ratio', String(enabled));
    for (const controller of priceBarRatioControllers) controller.setEnabled(enabled);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
);
initializeSpreadReadout(() => workspace.chart);
initializeColorPickerDismissal();
initializeQuickTradeToggle();

for (const cell of workspace.cells()) configureChartRenderer(cell.chart, cell.id);
workspace.on('cell:created', event => {
  const chart = workspace.cell(event.id)?.chart;
  if (chart) configureChartRenderer(chart, event.id);
});
workspace.on('cell:destroyed', event => {
  const controller = bidAskLinesControllers.get(event.id);
  controller?.destroy();
  bidAskLinesControllers.delete(event.id);
  futuresMonthBoundaryDisposers.get(event.id)?.();
  futuresMonthBoundaryDisposers.delete(event.id);
  for (const [scriptName, handles] of scriptHandles) {
    handles.delete(event.id);
    if (handles.size === 0) scriptHandles.delete(scriptName);
  }
});

// ---------------------------------------------------------------------------
// 3. Pine Editor
// ---------------------------------------------------------------------------
const editorHost = document.getElementById('code-editor') as HTMLDivElement;
const editorStatus = document.getElementById('editor-status') as HTMLSpanElement;
const editorModels = new Map<string, PineModel>();
let pineScriptManager: ReturnType<typeof createPineScriptManager>;
const pineEditorLifecycle = createPineEditorLifecycle({
  editorHost,
  editorStatus,
  editorModels,
  scriptSelect: document.getElementById('script-select') as HTMLSelectElement,
  getScripts: () => scripts,
  getCurrentScriptName: () => currentScriptName,
  getTheme: () => omegaThemeMode(currentTheme),
  isEnabled: () => true,
  standalone: standalonePineEditor,
  standaloneModules: standaloneEditorModules,
  saveScripts: saveScriptsToStorage,
  validateSource: validatePineSource,
  displayDiagnostics: (error, code, name) => pineScriptManager.displayDiagnosticsInConsole(error, code, name),
});
const setEditorStatus = pineEditorLifecycle.setStatus;
const loadScriptIntoEditor = pineEditorLifecycle.loadScript;
const refreshDropdown = pineEditorLifecycle.refreshDropdown;

pineScriptManager = createPineScriptManager({
  getWorkspace: () => workspace,
  getScripts: () => scripts,
  scriptHandles,
  groupByCellId,
  editorModels,
  getPineDiagnostics: pineEditorLifecycle.getDiagnostics,
  getPineCompileDiagnostics: pineEditorLifecycle.getCompileDiagnostics,
  setEditorStatus,
  isPropagating: () => propagatingGroupState,
  setPropagating: value => { propagatingGroupState = value; },
});
const scriptSelect = document.getElementById('script-select') as HTMLSelectElement;
pineEditorLifecycle.attach();
refreshDropdown();
loadScriptIntoEditor(currentScriptName);

async function validatePineSource(code: string): Promise<Error | null> {
  try {
    await ensurePineRuntime();
    if (!pineEngine) throw new Error('PineTS worker engine is not ready.');
    await validatePineSourceOnWorker(code, pineEngine);
    return null;
  } catch (reason) {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    reportCaughtError('pine-validation:failed', error);
    return error;
  }
}

const pineScriptControls = initializePineScriptControls({
  workspace,
  scripts,
  getCurrentScriptName: () => currentScriptName,
  setCurrentScriptName: name => { currentScriptName = name; },
  editorModels,
  scriptHandles,
  groupByCellId,
  scriptSelect,
  editorLifecycle: pineEditorLifecycle,
  scriptManager: pineScriptManager,
  standalone: standalonePineEditor,
  isPineTsEnabled: () => Boolean(pineEngine),
  saveScripts: saveScriptsToStorage,
  validateSource: validatePineSource,
});
createPineAiAssistant({
  getCurrentScriptName: () => currentScriptName,
  getEditorValue: () => pineEditorLifecycle.getValue(),
  applyCodeToEditor: (code, mode) => pineEditorLifecycle.applyCodeToEditor(code, mode),
});
export const openScriptInEditor = pineScriptControls.openScriptInEditor;
(window as any).openScriptInEditor = openScriptInEditor;

// ---------------------------------------------------------------------------
const { sync: syncChartControls } = initializeChartTimeframeControls(workspace, {
  getResetChartCandles: () => resetChartCandles,
});

const marketChangeListeners = new Map<string, () => void>();
function watchCellMarketChanges(cellId: string) {
  if (marketChangeListeners.has(cellId)) return;
  const cell = workspace.cell(cellId);
  if (!cell) return;
  marketChangeListeners.set(cellId, cell.chart.on('market:changed', () => {
    if (workspace.active.id === cellId) syncChartControls();
    renderChartTabs();
  }));
}
for (const cell of workspace.cells()) {
  watchCellMarketChanges(cell.id);
  loadedBarsController.watch(cell.id);
}
workspace.on('cell:created', event => {
  watchCellMarketChanges(event.id);
  loadedBarsController.watch(event.id);
});
workspace.on('cell:destroyed', event => {
  marketChangeListeners.get(event.id)?.();
  marketChangeListeners.delete(event.id);
  loadedBarsController.unwatch(event.id);
});
workspace.on('cell:active', () => {
  syncChartControls();
  loadedBarsController.render();
});
loadedBarsController.render();
syncChartControls();

const chartLayoutSelect = document.getElementById('chart-layout-select') as HTMLSelectElement;
chartLayoutSelect.value = workspace.layout.id;

const workspaceFeatureLoaders = createWorkspaceFeatureLoaders({
  workspace,
  tabsState: chartTabsState,
  maxTabs: OMEGA_TABS_MAX,
  layoutId: chartTabsLayoutId,
  isTabsLayout: isChartTabsLayout,
  groupByCellId,
  groupColorHex: CHART_GROUP_COLORS,
  chartGridHost,
  chartLayoutSelect,
  onReplayActiveChange: setReplayActive,
});
const {
  ensureChartTabs,
  renderChartTabs,
  setChartTabsEnabled,
  ensureReplayControls,
  openReplayControls,
  startReplayAt,
  openVisualBacktest,
} = workspaceFeatureLoaders;

const chartGroups = initializeChartGroups({
  workspace,
  chartGridHost,
  groupByCellId,
  getInitialGroup: cellId => {
    const chartState = restoredWorkspaceState?.charts?.find((entry: { id: string }) => entry.id === cellId);
    const savedGroup = chartState?.ext?.['vela.chartGroup'];
    return savedGroup && typeof savedGroup === 'object' && 'color' in savedGroup
      ? String(savedGroup.color)
      : '';
  },
  renderChartTabs: () => workspaceFeatureLoaders.renderChartTabs(),
  isPropagating: () => propagatingGroupState,
  setPropagating: value => { propagatingGroupState = value; },
});
const { setCellGroup } = chartGroups;



function applyWorkspaceState(state: unknown) {
  workspace.applyState(state);
  syncChartControls();
  chartLayoutSelect.value = workspace.layout.id;
}

initializeWorkspaceProfiles(workspace, applyWorkspaceState);

workspace.on('state:changed', () => {
  const state = workspace.getState();
  chartLayoutSelect.value = workspace.layout.id;
  void state;
});

function setTheme(theme: OmegaTheme) {
  const changed = theme !== currentTheme;
  currentTheme = theme;
  localStorage.setItem('vela_theme', currentTheme);
  applyThemeUi(currentTheme);
  refreshMarketFlowStyles();
  try {
    workspace.setTheme(velaTheme(currentTheme));
    for (const cell of workspace.cells()) applyChartVisualSettings(cell.chart);
    applyChartAxisTextColor();
  } catch (error) {
    console.error('Could not apply the selected theme to the chart workspace:', error);
  }
  try {
    pineEditorLifecycle.setTheme(omegaThemeMode(currentTheme));
  } catch (error) {
    console.error('Could not apply the selected theme to the Pine editor:', error);
  }
  if (changed) workspace.context().stateChanged();
}

/** Keep persisted renderer settings from leaving the price scale unreadable
 * after a theme change. The explicit chart setting can still change this
 * colour afterwards; this only restores the safe theme default. */
function applyChartAxisTextColor(): void {
  const savedTextColor = localStorage.getItem('omega:price-axis-text-color');
  const textColor = savedTextColor ?? velaTheme(currentTheme).chart.textColor;
  for (const cell of workspace.cells()) {
    cell.chart.renderer.applyConfig({ layout: { textColor } });
    // Axis labels are an independent renderer feature. A saved Vela workspace
    // can retain `axisLabels: false`, which removes the entire price scale even
    // though candles and the text colour are valid. Restore the platform default
    // so every connected feed keeps a visible price axis.
    cell.chart.renderer.set('axisLabels', true);
  }
}

initializeThemeMenu({ getTheme: () => currentTheme, setTheme });

const { openChartSettings } = initializeChartSettingsActions({
  workspace,
  openReplayControls,
  getTheme: () => currentTheme,
  setTheme,
  getResetChartCandles: () => resetChartCandles,
  setResetChartCandles,
  updatesEnabled: updateCheckerModule.enabled,
});
initializeSafeguardsPanel();

initializeChartContextActions({
  workspace,
  getShowBidAskLines: () => showBidAskLines,
  setShowBidAskLines,
  ensurePaperTrading,
  hasPendingPaperOrderAtPrice: (chart, price) => Boolean(paperTradingModule?.hasPendingPaperOrderAtPrice(chart, price)),
  getTheme: () => currentTheme,
  setTheme,
  getResetChartCandles: () => resetChartCandles,
  openChartSettings,
  openReplayControls,
  startReplayAt,
});
initializeChartReturnToLatest(workspace);

const bottomClock = document.getElementById('bottom-clock');
if (bottomClock) {
  const updateClock = () => {
    const now = new Date();
    bottomClock.textContent = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };
  updateClock();
  setInterval(updateClock, 1000);
}

const tradingSessionStatus = document.getElementById('trading-session-status');
const tradingSessionLabel = document.getElementById('trading-session-label');
if (tradingSessionStatus && tradingSessionLabel) {
  const updateTradingSessions = () => {
    const sessions = getOpenTradingSessions(new Date());
    tradingSessionLabel.textContent = formatTradingSessionStatus(sessions);
    tradingSessionStatus.dataset.open = String(sessions.length > 0);
  };
  updateTradingSessions();
  setInterval(updateTradingSessions, 60_000);
}

const { initializeTopPanel } = await import('./topPanel');
const { initializeBottomPanel } = await import('./bottomPanel');
initializeBottomPanel({
  mt5Enabled: mt5FeedModule.enabled,
  alpacaEnabled: brokerModule.enabled,
  ibkrEnabled: Boolean(window.velaIbkr),
  ctraderEnabled: Boolean(window.velaCtrader),
  saxoEnabled: Boolean(window.velaSaxo),
  onPaperTradingAction: async action => {
    await ensurePaperTrading();
    document.dispatchEvent(new CustomEvent(`omega:paper-trading:${action}`));
  },
  onChartLiveTrade: async side => {
    await ensurePaperTrading();
    document.dispatchEvent(new CustomEvent(`omega:chart-live-trade:${side}`));
  },
});

initializeTopPanel(workspace, {
  onGroupChange: group => {
    if (workspace.active) void chartGroups.setCellGroup(workspace.active.id, group);
  },
  onChartTabsToggle: () => {
    void ensureChartTabs().then(controller => controller.toggle()).catch(error => {
      console.error('Could not initialize chart tabs:', error);
      workspace.toast('Chart tabs could not be loaded.', 'error');
    });
  },
  onChartTabsAdd: () => {
    void ensureChartTabs().then(controller => controller.addTab()).catch(error => {
      console.error('Could not initialize chart tabs:', error);
      workspace.toast('Chart tabs could not be loaded.', 'error');
    });
  },
  onReplayMenuOpen: () => {
    void ensureReplayControls().catch(error => {
      console.error('Could not initialize Replay:', error);
      workspace.toast('Replay could not be loaded.', 'error');
    });
  },
  onVisualBacktest: () => {
    void openVisualBacktest().catch(error => {
      reportCaughtError('visual-backtest:open', error, 'Visual Backtest could not be opened.');
    });
  },
  onSettings: () => { void openChartSettings(); },
});

// Electron keeps the main window hidden until all core UI wiring and the first
// workspace chart are ready, so users never see controls assembling in stages.
setStartupStatus('Loading charts and finalizing your workspace…');
let startupTimeout: number | undefined;
const startupChart = workspace.active?.chart;
const startupReady = startupChart
  ? startupChart.ready().then(() => true).catch(error => {
      console.error('Chart startup readiness failed:', error);
      return false;
  })
  : Promise.resolve(false);
const fullStartupTimeout = new Promise<false>(resolve => {
  // Market data may take longer, but it must never block the usable platform.
  startupTimeout = window.setTimeout(() => resolve(false), 900);
});
const chartsReady = await Promise.race([startupReady, fullStartupTimeout]);
window.clearTimeout(startupTimeout);
if (!chartsReady) {
  setStartupStatus('Market data is still connecting. The platform will continue loading it in the background.');
  console.warn('The startup screen is closing while chart data continues to load.');
} else {
  setStartupStatus('Workspace ready');
}
if (chartTabsState.enabled) {
  const controller = await ensureChartTabs();
  controller.setEnabled(true);
}
await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
startupScreen?.setAttribute('data-state', 'leaving');
window.setTimeout(() => startupScreen?.remove(), 300);
window.velaApp?.ready();
const rendererStartupDuration = Math.round(performance.now() - rendererStartupStartedAt);
window.velaDiagnostics?.record({
  source: 'startup', type: 'performance', name: 'first-interactive', status: 'ok', durationMs: rendererStartupDuration,
  message: chartsReady ? 'Chart ready' : 'Chart continues loading in background',
});
console.info(`Omega first interactive UI: ${rendererStartupDuration}ms`);
// Record what the layout actually looks like, so a panel can be identified by position.
startLayoutCapture();
// Full inventory of every element: buttons, panels, windows and text.
startUiInventory();
// Ctrl+Shift+P then click any panel: the platform records exactly what was clicked.
startPanelPicker();
void ensurePineRuntime().catch(error => {
  reportCaughtError('pine-runtime:preload', error, 'Pine runtime preload failed; it will retry on first use.');
});
window.setTimeout(() => {
  void autoConnectPreferredDataFeed().catch(error => {
    console.error('Could not auto-connect the preferred market-data feed:', error);
    window.velaDiagnostics?.record({
      source: 'broker-autoconnect', type: 'connection', name: 'startup', status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
}, 0);

// The cTrader-style meter is a chart interaction, not a Trade-panel feature.
// Load it only after the first usable frame so middle-click works even before
// the trader opens the panel, without delaying platform startup.
window.setTimeout(() => {
  window.velaDiagnostics?.record({
    source: 'measurement', type: 'lifecycle', name: 'load', status: 'start',
    message: 'Preparing middle-click measurement tool.',
  });
  void ensurePaperTrading().then(() => {
    window.velaDiagnostics?.record({
      source: 'measurement', type: 'lifecycle', name: 'ready', status: 'ok',
      message: 'Middle-click measurement tool is ready.',
    });
  }).catch(error => {
    console.error('Could not initialize middle-click measurement tool:', error);
    window.velaDiagnostics?.record({
      source: 'measurement', type: 'lifecycle', name: 'ready', status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
}, 0);

const startupModuleIndex = new StartupModuleIndex(entry => window.velaDiagnostics?.record(entry));
startupModuleIndex.register({
  id: 'chart-workspace',
  label: 'Chart workspace',
  isReady: () => Boolean(workspace.active?.chart && workspace.active.host.isConnected),
});
startupModuleIndex.register({
  id: 'indicator-browser',
  label: 'Indicators panel',
  isReady: () => isIndicatorBrowserRegistered(),
  recover: () => ensureIndicatorBrowserRegistration(),
});
startupModuleIndex.register({
  id: 'chart-timeframe-controls',
  label: 'Timeframe and chart-style controls',
  isReady: () => Boolean(document.getElementById('ctrader-timeframe-menu')),
});
startupModuleIndex.register({
  id: 'theme-controls',
  label: 'Theme controls',
  isReady: () => document.body.dataset.theme === currentTheme,
  recover: () => setTheme(currentTheme),
});
startupModuleIndex.register({
  id: 'middle-click-measurement',
  label: 'Middle-click measurement',
  isReady: () => paperTradingModule !== null,
  recover: async () => { await ensurePaperTrading(); },
});
startupModuleIndex.register({
  id: 'pine-runtime',
  label: 'Pine runtime',
  isReady: () => pineEngine !== null,
  recover: async () => { await ensurePineRuntime(); },
});

// Every optional module is indexed, so a platform that opens with only part of its
// panels reports exactly which module is missing instead of silently losing settings.
const indexedOptionalModules: {
  id: OptionalModuleId;
  label: string;
  module: OptionalModule<unknown>;
  domIds: readonly string[];
  load(): Promise<unknown>;
}[] = [
  { id: 'broker', label: 'Broker panel', module: brokerModule, domIds: ['broker-toggle', 'broker-modal'], load: () => import('./brokerPanel') },
  { id: 'mt5-feed', label: 'MetaTrader 5 feed', module: mt5FeedModule, domIds: ['mt5-feed-modal'], load: () => import('./mt5Feed') },
  { id: 'alpaca-feed', label: 'Alpaca feed', module: alpacaSdkFeedModule, domIds: [], load: () => import('./alpacaFeed') },
  { id: 'price-bar-ratio', label: 'Price to bar ratio', module: priceBarRatioModule, domIds: [], load: () => import('./priceBarRatioMenu') },
  { id: 'backtest', label: 'Backtest panel', module: backtestModule, domIds: [], load: () => import('./backtestPanel') },
  { id: 'news', label: 'News panel', module: newsModule, domIds: [], load: () => import('./newsPanel') },
  { id: 'update-checker', label: 'Update checker', module: updateCheckerModule, domIds: [], load: () => import('./updateChecker') },
];
for (const entry of indexedOptionalModules) {
  startupModuleIndex.register({
    id: `module:${entry.id}`,
    label: entry.label,
    optional: true,
    isReady: () => (entry.module.enabled ? moduleElementsReady(entry.domIds) : true),
    recover: async () => { await entry.load(); },
  });
}

startupModuleIndex.register({
  id: 'side-panels:market-flow',
  label: 'Time & Sales and DOM panels',
  isReady: () => {
    const registered = new Set(sidePanels().map(panel => panel.id));
    return registered.has('omega-time-sales') && registered.has('omega-dom');
  },
  recover: async () => { await import('./marketFlowPane'); },
});
startupModuleIndex.register({
  id: 'quick-trade',
  label: 'QuickTrade controls',
  isReady: () => moduleElementsReady(['chart-paper-trade-controls', 'paper-trade-settings-btn']),
});
startupModuleIndex.register({
  id: 'heikin-variants',
  label: 'Heikin Ashi calculation variants',
  isReady: () => HEIKIN_VARIANTS.length > 0,
});
startupModuleIndex.register({
  id: 'trading-safety',
  label: 'Market-data guards and order idempotency',
  isReady: () => typeof guardBar === 'function'
    && typeof requestOrderIntent === 'function'
    && typeof releaseOrderIntent === 'function',
});
startupModuleIndex.register({
  id: 'trading-accounts',
  label: 'Trading account selector',
  isReady: () => moduleElementsReady(['trading-account-select', 'trading-account-status']),
  recover: () => initializeTradingAccounts(),
});
startupModuleIndex.register({
  id: 'paper-trading-panel',
  label: 'Trade panel',
  isReady: () => paperTradingModule !== null,
  recover: async () => { await ensurePaperTrading(); },
});

// Modules the platform fetches on first use. They are indexed anyway, so the platform can
// state exactly what is loaded and what is still deferred, and so a failed load can be
// retried one module at a time instead of disappearing silently.
const deferredFeatureModules: { id: string; label: string; load: () => Promise<unknown> }[] = [
  { id: 'chart-tabs', label: 'Chart tabs', load: () => import('./chartTabs') },
  { id: 'replay', label: 'Replay controls', load: () => import('./replayControls') },
  { id: 'pine-editor-runtime', label: 'Pine editor runtime', load: () => import('./pineEditorNext') },
  { id: 'pine-reference', label: 'Pine method reference', load: () => import('./pineReferencePanel') },
];
for (const entry of deferredFeatureModules) startupModuleIndex.registerDeferred(entry);

const startupModuleInventory = startupModuleIndex.inventory();
window.velaDiagnostics?.record({
  source: 'startup-index', type: 'inventory', name: 'platform-modules', status: 'ok',
  message: `Indexed ${startupModuleInventory.length} platform modules: ${startupModuleInventory.map(entry => entry.id).join(', ')}`,
});

// Two bounded passes: deferred modules settle first, then anything that was still
// missing gets a second recovery attempt before the platform reports its health.
function reportPlatformHealth(pass: number): void {
  void startupModuleIndex.verifyAndRecover().then(result => {
    const unhealthy = Object.entries(result).filter(([, state]) => state === 'missing' || state === 'failed');
    window.velaDiagnostics?.record({
      source: 'startup-index', type: 'summary', name: `platform-health-${pass}`,
      status: unhealthy.length ? 'error' : 'ok',
      message: unhealthy.length
        ? `Unavailable: ${unhealthy.map(([id]) => id).join(', ')}`
        : `All ${Object.keys(result).length} indexed platform modules are ready.`,
    });
    console.info(`Omega module health (pass ${pass}):`, result);
    const audit = startupModuleIndex.audit();
    window.velaDiagnostics?.record({
      source: 'startup-index', type: 'audit', name: `platform-audit-${pass}`,
      status: audit.problematic.length ? 'error' : 'ok',
      message: `ready ${audit.ready.length}, recovered ${audit.recovered.length}, deferred ${audit.deferred.length}, disabled ${audit.disabled.length}, problematic ${audit.problematic.length ? audit.problematic.join(', ') : 'none'}`,
    });
    console.info(`Omega module audit (pass ${pass}):`, audit);
  });
}
window.setTimeout(() => reportPlatformHealth(1), 750);
window.setTimeout(() => reportPlatformHealth(2), 4_000);
