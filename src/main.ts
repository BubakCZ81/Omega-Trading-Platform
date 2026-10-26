import { registerLayout, VelaWorkspace } from '@luxalgo/vela/workspace';
import './styles.css';
import './editorDrawer';
import { appAssetUrl } from './appPaths';
import { registerLegendAction, registerIcon, registerRendererLayer, registerStatePersistence, registerWidgetAction, timeframeToMs, type IndicatorHandle } from '@luxalgo/vela';
import { BinanceProvider } from '@luxalgo/vela/providers/binance';
import { initializeCTraderFeed } from './ctraderFeed';
import type { PineModel } from './pineEditorNext';
import { getSavedScripts, saveScriptsToStorage } from './pineStorage';
import { createPineScriptManager } from './pineScriptManager';
import { createPineEditorLifecycle } from './pineEditorLifecycle';
import { createPriceBarRatioController, type PriceBarRatioController } from './priceBarRatio';
import {
  BID_ASK_COLOR_OPTIONS,
  BID_ASK_STYLE_OPTIONS,
  BID_ASK_WIDTH_OPTIONS,
  createBidAskLinesController,
  loadBidAskLineStyle,
  type BidAskLineStyle,
} from './bidAskLines';
import { clearStartupIndicators } from './startupWorkspaceState';
import { restoreWorkspaceScriptIndicators, snapshotWorkspaceScriptIndicators } from './workspaceScriptIndicators';
import { initializeChartTimeframeControls } from './chartTimeframeControls';
import { registerOrderFlowChartTypes } from './orderFlowCharts';
import { initializeSpreadReadout } from './spreadReadout';
import { initializeColorPickerDismissal } from './colorPickerDismissal';
import { initializeQuickTradeToggle } from './quickTradeToggle';
import { CHART_GROUP_COLORS, initializeChartGroups } from './chartGroups';
import './favoriteDrawingTools';
import { loadOptionalModule, type OptionalModule, type OptionalModuleId } from './featureModules';
import { createReplayAwareEngine } from './replayStreamingEngine';
import { getMarketFlowStyle, refreshMarketFlowStyles, setMarketFlowStyle } from './marketFlowPane';
import { attachFuturesMonthBoundaries } from './futuresMonthBoundaries';
import { formatTradingSessionStatus, getOpenTradingSessions } from './tradingSessions';
import { PersistentCandleProvider } from './persistentCandleCache';
import { initializeWorkspaceProfiles } from './workspaceProfiles';
import type { ChartTabsState } from './chartTabs';
import { createWorkspaceFeatureLoaders } from './workspaceFeatureLoaders';
import { initializePlatformZoom } from './platformZoom';
import { initializePaperTradeDrag } from './paperTradeDrag';
import { applyThemeUi, initializeThemeMenu, isOmegaTheme, velaTheme, type OmegaTheme } from './themeControls';
import { LoadedBarsController } from './loadedBars';
import { initializeTradingAccounts } from './tradingAccounts';
// createWindow will be loaded lazily inside openTauriStandaloneEditor

const startupScreen = document.getElementById('omega-startup-screen');
const startupStatus = document.getElementById('omega-startup-status');

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
      onEntry(callback: (entry: DiagnosticEntry) => void): () => void;
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

window.addEventListener('error', event => showStartupFailure(event.error ?? event.message));
window.addEventListener('unhandledrejection', event => showStartupFailure(event.reason));

setStartupStatus('Loading chart tools and market data providers…');

const standalonePineEditor = new URLSearchParams(window.location.search).get('window') === 'pine-editor';
const standaloneEditorModules = standalonePineEditor
  ? Promise.all([import('./pineEditorNext'), import('./pineReferencePanel')])
  : null;

/* Removed Tauri bridge. Electron exposes the desktop APIs through preload.cjs.
if ('__TAURI_INTERNALS__' in window) {
  const { invoke } = await import('@tauri-apps/api/core');
  const { emitTo, listen } = await import('@tauri-apps/api/event');
  type AiBridgeApi = NonNullable<Window['velaAi']>;
  window.velaAi = {
    providers: () => invoke<Awaited<ReturnType<AiBridgeApi['providers']>>>('ai_providers'),
    saveKey: (provider, apiKey) => invoke<Awaited<ReturnType<AiBridgeApi['saveKey']>>>('ai_save_key', { provider, apiKey }),
    clearKey: provider => invoke<Awaited<ReturnType<AiBridgeApi['clearKey']>>>('ai_clear_key', { provider }),
    testKey: (provider, apiKey) => invoke<Awaited<ReturnType<AiBridgeApi['testKey']>>>('ai_test_key', { provider, apiKey }),
    complete: request => invoke<Awaited<ReturnType<AiBridgeApi['complete']>>>('ai_complete', { request }),
  };
  type Mt5BridgeApi = NonNullable<Window['velaMt5']>;
  window.velaMt5 = {
    connect: pythonExecutable => invoke<Awaited<ReturnType<Mt5BridgeApi['connect']>>>('mt5_connect', { pythonExecutable }),
    symbols: () => invoke<Awaited<ReturnType<Mt5BridgeApi['symbols']>>>('mt5_symbols'),
    bars: request => invoke<Awaited<ReturnType<Mt5BridgeApi['bars']>>>('mt5_bars', { request }),
    quote: ticker => invoke<Awaited<ReturnType<Mt5BridgeApi['quote']>>>('mt5_quote', { ticker }),
    ticks: request => invoke<Awaited<ReturnType<Mt5BridgeApi['ticks']>>>('mt5_ticks', { request }),
    marketBook: ticker => invoke<Awaited<ReturnType<Mt5BridgeApi['marketBook']>>>('mt5_market_book', { ticker }),
    info: ticker => invoke<Awaited<ReturnType<Mt5BridgeApi['info']>>>('mt5_info', { ticker }),
    disconnect: () => invoke<Awaited<ReturnType<Mt5BridgeApi['disconnect']>>>('mt5_disconnect'),
  };

  type BrokerBridge = NonNullable<Window['velaBroker']>;
  const cTraderQuotes = new Set<Parameters<BrokerBridge['onCTraderQuote']>[0]>();
  void listen<Parameters<BrokerBridge['onCTraderQuote']>[0] extends (quote: infer Quote) => void ? Quote : never>(
    'ctrader:quote',
    event => {
      for (const callback of cTraderQuotes) callback(event.payload);
    },
  ).catch(error => {
    console.error('Could not initialize cTrader quote events:', error);
    throw error;
  });
  window.velaBroker = {
    cTraderDataFeedOnly: true,
    listBrokers: async () => {
      const brokers = await invoke<Awaited<ReturnType<BrokerBridge['listBrokers']>>>('broker_sdk_list');
      return [...brokers, {
        id: 'ctrader',
        displayName: 'cTrader',
        credentials: [
          { key: 'clientId', label: 'cTrader Open API Client ID', secret: false },
          { key: 'clientSecret', label: 'cTrader Open API Client Secret', secret: true },
        ],
        readOnlySetup: 'Enter credentials for your cTrader Open API app. The sign-in page opens in your browser and supports cTrader ID sign-in, including Google when enabled. Register the redirect URL http://127.0.0.1:17863/ctrader/callback. Credentials are encrypted for this Windows account.',
      }];
    },
    connectReadOnly: (brokerId, credentials) => invoke<Awaited<ReturnType<BrokerBridge['connectReadOnly']>>>(
      'broker_sdk_connect_read_only', { brokerId, credentials },
    ),
    fetchSnapshot: () => invoke<Awaited<ReturnType<BrokerBridge['fetchSnapshot']>>>('broker_sdk_fetch_snapshot'),
    hasSavedCTraderCredentials: () => invoke('ctrader_has_saved_credentials'),
    authorizeCTrader: credentials => invoke<Awaited<ReturnType<BrokerBridge['authorizeCTrader']>>>(
      'ctrader_authorize',
      { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
    ),
    selectCTraderAccount: accountId => invoke<Awaited<ReturnType<BrokerBridge['selectCTraderAccount']>>>(
      'ctrader_select_account',
      { accountId },
    ),
    subscribeCTraderSymbol: async symbolId => {
      await invoke<string>('ctrader_subscribe_symbol', { symbolId });
      const symbols = await invoke<Awaited<ReturnType<CTraderFeedBridge['symbols']>>>('ctrader_symbols');
      const symbol = symbols.find(item => item.id === symbolId);
      return { symbolId, symbol: symbol?.name ?? symbolId };
    },
    placeDemoCTraderMarketOrder: async () => { throw new Error('cTrader order placement is disabled in the Tauri data-feed connection.'); },
    reconcileCTraderAccount: async () => { throw new Error('cTrader trading reconciliation is disabled in the Tauri data-feed connection.'); },
    onCTraderQuote: callback => {
      cTraderQuotes.add(callback);
      return () => cTraderQuotes.delete(callback);
    },
    disconnect: async () => {
      await invoke('broker_sdk_disconnect');
      return invoke<Awaited<ReturnType<BrokerBridge['disconnect']>>>('ctrader_disconnect');
    },
  };
  type CTraderFeedBridge = NonNullable<Window['velaCTraderFeed']>;
  window.velaCTraderFeed = {
    symbols: () => invoke<Awaited<ReturnType<CTraderFeedBridge['symbols']>>>('ctrader_symbols'),
    bars: request => invoke<Awaited<ReturnType<CTraderFeedBridge['bars']>>>('ctrader_bars', { request }),
    subscribeSymbol: symbolId => invoke<Awaited<ReturnType<CTraderFeedBridge['subscribeSymbol']>>>(
      'ctrader_subscribe_symbol',
      { symbolId },
    ),
    unsubscribe: subscriptionId => invoke<Awaited<ReturnType<CTraderFeedBridge['unsubscribe']>>>(
      'ctrader_unsubscribe',
      { subscriptionId },
    ),
    onQuote: callback => {
      const listener: Parameters<BrokerBridge['onCTraderQuote']>[0] = quote => callback(quote);
      cTraderQuotes.add(listener);
      return () => cTraderQuotes.delete(listener);
    },
  };

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  const editorWindowLabel = 'omega-pine-editor-window';
  const editorEvents = {
    openScript: 'omega-pine-editor-open-script',
    openDocked: 'omega-pine-editor-open-docked',
    scriptUpdated: 'omega-pine-editor-script-updated',
    scriptResult: 'omega-pine-editor-script-result',
  } as const;
  const onEditorEvent = <T>(eventName: string, target: string, callback: (payload: T) => void): (() => void) => {
    let unlisten: (() => void) | undefined;
    void listen<T>(eventName, event => callback(event.payload), { target })
      .then(dispose => { unlisten = dispose; })
      .catch(error => console.error(`Could not listen for ${eventName}:`, error));
    return () => unlisten?.();
  };
  const sendEditorEvent = <T>(target: string, eventName: string, payload?: T): void => {
    void emitTo(target, eventName, payload).catch(error => console.error(`Could not send ${eventName}:`, error));
  };
  const openEditorWindow = async (script?: { name: string; source: string }): Promise<boolean> => {
    const url = new URL(window.location.href);
    url.searchParams.set('window', 'pine-editor');
    if (script) url.searchParams.set('script', script.name);
    let editorWindow = await WebviewWindow.getByLabel(editorWindowLabel);
    if (editorWindow) {
      await editorWindow.show();
      await editorWindow.setFocus();
      if (script) sendEditorEvent(editorWindowLabel, editorEvents.openScript, script);
      return true;
    }

    editorWindow = new WebviewWindow(editorWindowLabel, {
      url: url.toString(),
      title: `Omega Pine Editor${script ? ` — ${script.name}` : ''}`,
      width: 1280,
      height: 820,
      focus: true,
      resizable: true,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Timed out while opening the Pine Editor window.')), 10_000);
      void editorWindow!.once('tauri://created', () => {
        window.clearTimeout(timeout);
        resolve();
      }).catch(error => {
        window.clearTimeout(timeout);
        reject(error);
      });
      void editorWindow!.once('tauri://error', error => {
        window.clearTimeout(timeout);
        reject(new Error(`Could not open the Pine Editor window: ${String(error)}`));
      }).catch(error => {
        window.clearTimeout(timeout);
        reject(error);
      });
    });
    if (script) sendEditorEvent(editorWindowLabel, editorEvents.openScript, script);
    return true;
  };

  window.velaPineEditorWindow = {
    open: () => openEditorWindow(),
    openScript: (name, source) => {
      const savedScripts = getSavedScripts();
      savedScripts[name] = source;
      saveScriptsToStorage(savedScripts);
      return openEditorWindow({ name, source });
    },
    openDocked: () => sendEditorEvent('main', editorEvents.openDocked),
    onOpenDocked: callback => onEditorEvent(editorEvents.openDocked, 'main', () => {
      callback();
      void WebviewWindow.getByLabel(editorWindowLabel)
        .then(editorWindow => editorWindow?.close())
        .catch(error => console.error('Could not close the Pine Editor window:', error));
    }),
    publishScriptUpdate: script => sendEditorEvent('main', editorEvents.scriptUpdated, script),
    onScriptUpdated: callback => onEditorEvent(editorEvents.scriptUpdated, 'main', callback),
    publishScriptResult: result => sendEditorEvent(editorWindowLabel, editorEvents.scriptResult, result),
    onScriptResult: callback => onEditorEvent(editorEvents.scriptResult, editorWindowLabel, callback),
    onOpenScript: callback => onEditorEvent(editorEvents.openScript, editorWindowLabel, callback),
  };
}
*/

const optionalModuleLoads = Promise.all([
  loadStartupModule('broker', () => import('./brokerPanel')),
  loadStartupModule('mt5-feed', () => import('./mt5Feed')),
  loadStartupModule('alpaca-feed', () => import('./alpacaFeed')),
  loadStartupModule('pine-editor', () => import('./pineAiAssistant')),
  loadStartupModule('indicator-browser', () => import('./indicatorBrowser')),
  loadStartupModule('price-bar-ratio', () => import('./priceBarRatioMenu')),
  loadStartupModule('backtest', () => import('./backtestPanel')),
  loadStartupModule('news', () => import('./newsPanel')),
  loadStartupModule('update-checker', () => import('./updateChecker')),
]);

function loadStartupModule<T>(id: OptionalModuleId, loader: () => Promise<T>): Promise<OptionalModule<T>> {
  if (standalonePineEditor && id !== 'pine-editor' && id !== 'pinets') {
    return Promise.resolve({ enabled: false });
  }
  return loadOptionalModule(id, loader);
}

const pineTsModule = await loadStartupModule('pinets', () => import('@luxalgo/vela-pinets'));
setStartupStatus('Restoring your charts and workspace settings…');

// ---------------------------------------------------------------------------
// 1. Script Storage
// ---------------------------------------------------------------------------
let scripts = getSavedScripts();
const requestedPineScript = new URLSearchParams(window.location.search).get('script');
let currentScriptName = requestedPineScript && scripts[requestedPineScript]
  ? requestedPineScript
  : Object.keys(scripts)[0] || 'Dual EMA Cross';
const savedTheme = localStorage.getItem('vela_theme');
let currentTheme: OmegaTheme = isOmegaTheme(savedTheme) ? savedTheme : 'dark';
let workspace: VelaWorkspace;
let loadedBarsController: LoadedBarsController;
let workspaceInitialized = false;
type PaperTradingModule = typeof import('./chartPaperTrading');
let paperTradingModule: PaperTradingModule | null = null;
let paperTradingInitialization: Promise<PaperTradingModule> | null = null;
let barThickness = Math.max(0.15, Math.min(1, Number(localStorage.getItem('vela_bar_thickness') ?? 1)));

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

async function loadIndicatorManifest() {
  try {
    const response = await fetch(appAssetUrl('/indicators/catalog.json'));
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
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
let replayActive = false;
// PineEngine is used deliberately here. It executes the same PineTS runtime as
// the worker but avoids Electron's Blob-worker parser path, which can reject
// valid Pine v6 source with a JavaScript "Unterminated regular expression" error.
const PineEngine = pineTsModule.value?.PineEngine;
const pineEngine = PineEngine
  ? createReplayAwareEngine(new PineEngine(), () => replayActive)
  : null;
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
let showBidAskLines = localStorage.getItem('vela_show_bid_ask_lines') === 'true';
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

initializePlatformZoom();

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
    lockPriceToBarRatio,
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
      if (workspaceInitialized) {
        workspace.setTheme(velaTheme(currentTheme));
        pineEditorLifecycle.setTheme(currentTheme === 'light' || currentTheme === 'high-contrast' ? 'light' : 'dark');
        applyThemeUi(currentTheme);
      }
    }
    if (typeof preferences.barThickness === 'number' && Number.isFinite(preferences.barThickness)) {
      setBarThickness(preferences.barThickness, false);
    }
    if (typeof preferences.lockPriceToBarRatio === 'boolean') {
      lockPriceToBarRatio = preferences.lockPriceToBarRatio;
      localStorage.setItem('vela_lock_price_to_bar_ratio', String(lockPriceToBarRatio));
      for (const controller of priceBarRatioControllers) controller.setEnabled(lockPriceToBarRatio);
    }
    if (typeof preferences.showBidAskLines === 'boolean') {
      showBidAskLines = preferences.showBidAskLines;
      localStorage.setItem('vela_show_bid_ask_lines', String(showBidAskLines));
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
      if (typeof style.bidColor === 'string' && supportedColors.includes(style.bidColor as typeof supportedColors[number])) {
        bidAskLineStyle.bidColor = style.bidColor;
      }
      if (typeof style.askColor === 'string' && supportedColors.includes(style.askColor as typeof supportedColors[number])) {
        bidAskLineStyle.askColor = style.askColor;
      }
      if (typeof style.lineWidth === 'number' && supportedWidths.includes(style.lineWidth)) {
        bidAskLineStyle.lineWidth = style.lineWidth;
      }
      if (style.lineStyle === 'solid' || style.lineStyle === 'dashed' || style.lineStyle === 'dotted') {
        bidAskLineStyle.lineStyle = style.lineStyle;
      }
      localStorage.setItem('vela_bid_ask_bid_color', bidAskLineStyle.bidColor);
      localStorage.setItem('vela_bid_ask_ask_color', bidAskLineStyle.askColor);
      localStorage.setItem('vela_bid_ask_line_width', String(bidAskLineStyle.lineWidth));
      localStorage.setItem('vela_bid_ask_line_style', bidAskLineStyle.lineStyle);
    }
    for (const controller of bidAskLinesControllers.values()) {
      controller.setEnabled(showBidAskLines);
      controller.setStyle(bidAskLineStyle);
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

// A renderer can be configured more than once while a workspace is restored or
// re-mounted.  Settings sections are a replacement API, so registering them
// repeatedly can leave the native dialog in an inconsistent state.
const chartSettingsRegistered = new WeakSet<object>();

function configureChartRenderer(chart: VelaWorkspace['chart'], cellId: string) {
  chart.renderer.set('zoomAnchor', 'cursor');
  const priceBarRatio = createPriceBarRatioController(chart.renderer);
  priceBarRatioControllers.add(priceBarRatio);
  priceBarRatio.setEnabled(lockPriceToBarRatio);
  const bidAskLines = createBidAskLinesController(chart);
  bidAskLinesControllers.set(cellId, bidAskLines);
  futuresMonthBoundaryDisposers.get(cellId)?.();
  futuresMonthBoundaryDisposers.set(cellId, attachFuturesMonthBoundaries(chart));
  registerChartSettings(chart);
}

function registerChartSettings(chart: VelaWorkspace['chart']) {
  if (chartSettingsRegistered.has(chart)) return;
  const settingsCellId = () => workspace.cells().find(cell => cell.chart === chart)?.id ?? workspace.active.id;
  const setBidAskStyle = (next: Partial<BidAskLineStyle>) => {
    bidAskLineStyle = { ...bidAskLineStyle, ...next };
    for (const controller of bidAskLinesControllers.values()) controller.setStyle(bidAskLineStyle);
    if (workspaceInitialized) workspace.context().stateChanged();
  };
  const bidAskColorOptions = BID_ASK_COLOR_OPTIONS.map(([color, label]) => [color, label] as const);
  const marketFlowFontOptions = [10, 11, 12, 13, 14, 16, 18].map(size => [String(size), `${size}px`] as const);
  const marketFlowSettings = (view: 'time-sales' | 'dom', title: string) => {
    const colorRows = [
      ['background', 'Panel background'],
      ['text', 'Text'],
      ['buy', 'Buy / bid'],
      ['sell', 'Sell / ask'],
      ['grid', 'Grid and separators'],
    ] as const;
    return {
      title,
      id: `omega-${view}-appearance`,
      rows: [
        {
          kind: 'select' as const,
          label: 'Font size',
          options: marketFlowFontOptions,
          get: () => String(getMarketFlowStyle(view).fontSize),
          set: (value: string) => setMarketFlowStyle(view, 'fontSize', value),
        },
        ...colorRows.map(([key, label]) => ({
          kind: 'color' as const,
          label,
          get: () => getMarketFlowStyle(view)[key],
          set: (value: string) => setMarketFlowStyle(view, key, value),
        })),
      ],
    };
  };
  const bidAskWidthOptions = BID_ASK_WIDTH_OPTIONS.map(width => [String(width), `${width}px`] as const);
  const bidAskStyleOptions = BID_ASK_STYLE_OPTIONS;
  chart.renderer.setSettingsSections([
    {
      title: 'Workspace',
      id: 'omega-workspace',
      rows: [
        {
          kind: 'select',
          label: 'Layout',
          options: [['1', '1 chart'], ['2h', '2 charts — side by side'], ['2v', '2 charts — stacked'], ['4', '4 charts']],
          get: () => isChartTabsLayout(workspace.layout.id) ? '1' : workspace.layout.id,
          set: (layout: string) => {
            if (isChartTabsLayout(workspace.layout.id)) setChartTabsEnabled(false);
            workspace.setLayout(layout);
          },
        },
        {
          kind: 'toggle',
          label: 'Chart tabs',
          get: () => chartTabsState.enabled,
          set: (enabled: boolean) => setChartTabsEnabled(enabled),
        },
        {
          kind: 'select',
          label: 'Active chart group',
          options: [['', 'None'], ['red', 'Red'], ['blue', 'Blue'], ['green', 'Green'], ['yellow', 'Yellow'], ['purple', 'Purple']],
          get: () => groupByCellId[settingsCellId()] ?? '',
          set: (group: string) => { void setCellGroup(settingsCellId(), group); },
        },
        {
          kind: 'select',
          label: 'Workspace file',
          options: [['idle', 'Choose action…'], ['save', 'Save workspace…'], ['load', 'Load workspace…']],
          get: () => 'idle',
          set: (action: string) => {
            if (action === 'save') document.getElementById('workspace-save-profile')?.click();
            if (action === 'load') document.getElementById('workspace-load-profile')?.click();
          },
        },
      ],
    },
    {
      title: 'Appearance',
      id: 'omega-appearance',
      rows: [
        {
          kind: 'select',
          label: 'Platform theme',
          options: [['dark', 'Dark blue'], ['light', 'Light'], ['high-contrast', 'High contrast — light blue'], ['high-contrast-dark', 'High contrast — dark blue']],
          get: () => currentTheme,
          set: (theme: string) => setTheme(isOmegaTheme(theme) ? theme : 'dark'),
        },
        {
          kind: 'color',
          label: 'Chart background',
          get: () => (chart.renderer.getConfig() as { layout?: { background?: string } }).layout?.background ?? '#101d30',
          set: (background: string) => chart.renderer.applyConfig({ layout: { background } }),
        },
      ],
    },
    marketFlowSettings('time-sales', 'Time & Sales'),
    marketFlowSettings('dom', 'DOM'),
    {
      title: 'Market data',
      id: 'market-data',
      rows: [{
        kind: 'select',
        label: 'Candles to load',
        options: [
          ['500', '500'], ['1000', '1,000'], ['3000', '3,000'], ['5000', '5,000'],
          ['10000', '10,000'], ['15000', '15,000'], ['20000', '20,000'], ['25000', '25,000'],
          ['30000', '30,000'], ['40000', '40,000'], ['50000', '50,000'],
        ],
        get: () => String(chart.market.bars ?? 3000),
        set: (value: string) => {
          const bars = Number.parseInt(value, 10);
          if (!Number.isSafeInteger(bars) || bars < 1 || bars > 50_000) return;
          loadedBarsController.set(settingsCellId(), 0, bars);
          void chart.setMarket({ bars });
        },
      }],
    },
    {
      title: 'Bar thickness',
      id: 'bar-thickness',
      rows: [{
        kind: 'select',
        label: 'Candle body width',
        options: ['15%', '25%', '35%', '45%', '55%', '65%', '75%', '85%', '95%', '100%'].map(value => [value, value] as const),
        get: () => `${Math.round(barThickness * 100)}%`,
        set: (value: string) => {
          setBarThickness(Number.parseInt(value, 10) / 100);
        },
      }],
    },
    {
      title: 'Scale',
      id: 'price-bar-ratio',
      rows: [{
        kind: 'toggle',
        label: 'Lock price to bar ratio',
        get: () => lockPriceToBarRatio,
        set: (enabled: boolean) => {
          lockPriceToBarRatio = enabled;
          localStorage.setItem('vela_lock_price_to_bar_ratio', String(enabled));
          for (const controller of priceBarRatioControllers) controller.setEnabled(enabled);
          if (workspaceInitialized) workspace.context().stateChanged();
        },
      }],
    },
    {
      title: 'Price lines',
      id: 'price-lines',
      rows: [
        {
          kind: 'toggle',
          label: 'Show bid and ask lines',
          get: () => showBidAskLines,
          set: (enabled: boolean) => {
            showBidAskLines = enabled;
            for (const controller of bidAskLinesControllers.values()) controller.setEnabled(enabled);
            if (workspaceInitialized) workspace.context().stateChanged();
          },
        },
        {
          kind: 'select',
          label: 'Bid line color',
          options: bidAskColorOptions,
          get: () => bidAskLineStyle.bidColor,
          set: (bidColor: string) => setBidAskStyle({ bidColor }),
        },
        {
          kind: 'select',
          label: 'Ask line color',
          options: bidAskColorOptions,
          get: () => bidAskLineStyle.askColor,
          set: (askColor: string) => setBidAskStyle({ askColor }),
        },
        {
          kind: 'select',
          label: 'Line width',
          options: bidAskWidthOptions,
          get: () => String(bidAskLineStyle.lineWidth),
          set: (lineWidth: string) => setBidAskStyle({ lineWidth: Number(lineWidth) }),
        },
        {
          kind: 'select',
          label: 'Line style',
          options: bidAskStyleOptions,
          get: () => bidAskLineStyle.lineStyle,
          set: (lineStyle: string) => setBidAskStyle({ lineStyle: lineStyle as BidAskLineStyle['lineStyle'] }),
        },
      ],
    },
  ]);
  chartSettingsRegistered.add(chart);
}

const workspaceStorage = getWorkspaceStorage();
registerOrderFlowChartTypes();
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

const restoredLayout = restoredWorkspaceState?.layout;
const initialWorkspaceLayout = chartTabsState.enabled
  ? '1'
  : (restoredLayout && !isChartTabsLayout(restoredLayout) ? restoredLayout : '1');
const chartGridHost = document.createElement('div');
chartGridHost.id = 'chart-grid';
Object.assign(chartGridHost.style, { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' });
document.getElementById('chart')!.append(chartGridHost);

setStartupStatus('Building your trading workspace…');
try {
  workspace = new VelaWorkspace(chartGridHost, {
    layout: initialWorkspaceLayout, symbol: 'BTCUSDT', timeframe: '60', live: true, volume: false, theme: velaTheme(currentTheme), persist: 'vela-workspace', storage: workspaceStorage,
    cells: restoredWorkspaceState?.charts?.length ? Object.fromEntries(restoredWorkspaceState.charts.map((chart: { id: string; symbol?: string; timeframe?: string }) => [chart.id, { symbol: chart.symbol, timeframe: chart.timeframe }])) : (window.velaWorkspaceFiles ? { primary: { symbol: 'BTCUSDT', timeframe: '60' } } : undefined),
    sync: restoredWorkspaceState?.sync,
    topbar: { left: ['symbol', 'indicators', 'omega-favorite-drawing-tools'] },
    providers: {
      binance: () => new PersistentCandleProvider(new BinanceProvider()),
    },
    engines: pineEngine ? { pine: () => pineEngine } : {},
    indicators: loadIndicatorManifest,
  });
  console.log('Vela Workspace loaded.');
} catch (err) {
  console.error('Workspace init error:', err);
  showStartupFailure(err);
  throw err;
}
loadedBarsController = new LoadedBarsController(workspace);
const [
  brokerModule,
  mt5FeedModule,
  alpacaSdkFeedModule,
  pineEditorModule,
  indicatorBrowserModule,
  priceBarRatioModule,
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
hideFeatureElements(mt5FeedModule.enabled, 'local-feeds-toggle', 'local-feeds-modal');
hideFeatureElements(pineEditorModule.enabled, 'editor-toggle-btn', 'editor-drawer', 'resize-handle');
hideFeatureElements(updateCheckerModule.enabled, 'check-updates');
initializeTradingAccounts();
if (updateCheckerModule.enabled && updateCheckerModule.value) {
  updateCheckerModule.value.initializeUpdateChecker();
}

workspaceInitialized = true;
workspace.setTheme(velaTheme(currentTheme));

mt5FeedModule.value?.initializeMt5Feed(() => workspace);
alpacaSdkFeedModule.value?.initializeAlpacaSdkFeed(() => workspace);
initializeCTraderFeed(() => workspace);

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
  getTheme: () => currentTheme === 'dark' ? 'dark' : 'light',
  isEnabled: () => pineEditorModule.enabled && Boolean(pineEditorModule.value),
  standalone: standalonePineEditor,
  standaloneModules: standaloneEditorModules,
  saveScripts: saveScriptsToStorage,
  validateSource: validatePineSource,
  displayDiagnostics: (error, code, name) => pineScriptManager.displayDiagnosticsInConsole(error, code, name),
});
const setEditorStatus = pineEditorLifecycle.setStatus;
const getScriptModel = pineEditorLifecycle.getScriptModel;
const initializeCodeEditor = pineEditorLifecycle.initialize;
const getEditorValue = pineEditorLifecycle.getValue;
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
const scriptIndicatorId = pineScriptManager.scriptIndicatorId;
const applyScriptToChart = pineScriptManager.applyScriptToChart;
const addScriptToChart = pineScriptManager.addScriptToChart;
const updateScriptOnChart = pineScriptManager.updateScriptOnChart;
const scriptSelect = document.getElementById('script-select') as HTMLSelectElement;
pineEditorLifecycle.attach();
refreshDropdown();
loadScriptIntoEditor(currentScriptName);

scriptSelect.addEventListener('change', () => {
  pineEditorLifecycle.cancelPendingSave();
  currentScriptName = scriptSelect.value;
  loadScriptIntoEditor(currentScriptName);
});

const modal = document.getElementById('new-script-modal')!;
const modalInput = document.getElementById('modal-script-name') as HTMLInputElement;
const modalConfirmButton = document.getElementById('modal-confirm-btn') as HTMLButtonElement;
pineEditorModule.value?.createPineAiAssistant({
  getCurrentScriptName: () => currentScriptName,
  getEditorValue,
});

const openStandaloneEditorButton = document.getElementById('btn-open-standalone-editor') as HTMLButtonElement | null;



async function openTauriStandaloneEditor(name: string, source: string): Promise<boolean> {
  scripts[name] = source;
  saveScriptsToStorage(scripts);
  if (window.velaPineEditorWindow) {
    return window.velaPineEditorWindow.openScript(name, source);
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.set('window', 'pine-editor');
    url.searchParams.set('script', name);
    const popup = window.open(url.toString(), 'omega-pine-editor-window', 'popup=yes,width=1280,height=820');
    return popup !== null;
  } catch (error) {
    console.error('Could not open the separate Pine Editor:', error);
    return false;
  }
}

if (openStandaloneEditorButton) {
  if (standalonePineEditor) {
    openStandaloneEditorButton.hidden = true;
  } else {
    openStandaloneEditorButton.addEventListener('click', async () => {
      if (!window.velaPineEditorWindow) {
        const opened = await openTauriStandaloneEditor(currentScriptName, getEditorValue());
        const message = opened
          ? `Opened "${currentScriptName}" in a separate editor window.`
          : 'The separate Pine Editor window was blocked by the browser.';
        setEditorStatus(message, opened ? 'success' : 'error');
        window.addConsoleActivity?.(message, opened ? 'success' : 'error');
        return;
      }

      openStandaloneEditorButton.disabled = true;
      try {
        const opened = await window.velaPineEditorWindow.openScript(currentScriptName, getEditorValue());
        if (opened) window.toggleEditor(false);
      } finally {
        openStandaloneEditorButton.disabled = false;
      }
    });
  }
}

if (!standalonePineEditor) {
  window.velaPineEditorWindow?.onOpenDocked(() => {
    window.toggleEditor(true);
  });
  window.velaPineEditorWindow?.onScriptUpdated(async ({ name, source, action }) => {
    if (!name || typeof source !== 'string') return;
    scripts[name] = source;
    saveScriptsToStorage(scripts);
    if (!Object.keys(scripts).includes(currentScriptName)) currentScriptName = name;
    refreshDropdown();
    try {
      const error = action === 'update'
        ? await updateScriptOnChart(name, source)
        : await addScriptToChart(name, source);
      if (error) {
        setEditorStatus(error.message, 'error');
        window.velaPineEditorWindow?.publishScriptResult({ name, action, ok: false, message: error.message });
        return;
      }
      const message = `${action === 'update' ? 'Updated' : 'Added'} "${name}" from the separate Pine Editor.`;
      setEditorStatus(message, 'success');
      window.velaPineEditorWindow?.publishScriptResult({ name, action, ok: true, message });
    } catch (error) {
      const message = `Could not update the chart: ${error instanceof Error ? error.message : String(error)}`;
      setEditorStatus(message, 'error');
      window.velaPineEditorWindow?.publishScriptResult({ name, action, ok: false, message });
    }
  });
}

if (standalonePineEditor) {
  const requestedScript = new URLSearchParams(window.location.search).get('script');
  if (requestedScript && scripts[requestedScript]) currentScriptName = requestedScript;
  window.velaPineEditorWindow?.onOpenScript(({ name, source }) => {
    if (!name || typeof source !== 'string') return;
    scripts[name] = source;
    saveScriptsToStorage(scripts);
    currentScriptName = name;
    refreshDropdown();
    void initializeCodeEditor().then(() => {
      const model = getScriptModel(name);
      if (model && model.getValue() !== source) model.setValue(source);
      loadScriptIntoEditor(name);
      pineEditorLifecycle.getEditor()?.focus();
      setEditorStatus(`Opened "${name}" from chart.`, 'success');
    });
  });
  window.velaPineEditorWindow?.onScriptResult(({ name, action, ok, message }) => {
    if (name !== currentScriptName) return;
    setEditorStatus(message, ok ? 'success' : 'error');
    if (!ok) window.addConsoleOutput?.(message, 'error', `pine:${name}`);
  });
}

async function validatePineSource(code: string): Promise<Error | null> {
  try {
    if (!pineTsModule.enabled || !pineTsModule.value) {
      throw new Error('PineTS is disabled or unavailable.');
    }
    const { PineTS } = await import('pinets');
    const validationBars = Array.from({ length: 120 }, (_, index) => {
      const close = 100 + Math.sin(index / 4) * 5 + index * 0.03;
      return {
        open: close + Math.sin(index) * 0.3,
        high: close + 1,
        low: close - 1,
        close,
        volume: 100 + index % 17,
        openTime: 1_700_000_000_000 + index * 60_000,
      };
    });
    await new PineTS(validationBars).run(code);
    return null;
  } catch (reason) {
    return reason instanceof Error ? reason : new Error(String(reason));
  }
}

async function transpileSavedScript(name: string, code: string): Promise<Error | null> {
  const error = await validatePineSource(code);
  if (!error) {
    const model = editorModels.get(name);
    if (model) pineEditorLifecycle.getCompileDiagnostics()?.(model, null);
    window.clearConsoleDiagnostics?.(`pine:${name}`);
    return null;
  }
  const model = editorModels.get(name);
  if (model) pineEditorLifecycle.getCompileDiagnostics()?.(model, error);
  window.clearConsoleDiagnostics?.(`pine:${name}`);
  pineScriptManager.displayDiagnosticsInConsole(error, code, name);
  return error;
}

document.getElementById('btn-save')!.addEventListener('click', () => { void (async () => {
  const code = getEditorValue();
  scripts[currentScriptName] = code;
  saveScriptsToStorage(scripts);
  setEditorStatus(`Saved "${currentScriptName}". Transpiling…`);
  const error = await transpileSavedScript(currentScriptName, code);
  if (error) {
    setEditorStatus(error.message, 'error');
    return;
  }
  setEditorStatus(`Saved and transpiled "${currentScriptName}".`, 'success');
})(); });

async function addOrUpdateCurrentScript(action: 'add' | 'update'): Promise<void> {
  const code = action === 'add' ? (scripts[currentScriptName] ?? '') : getEditorValue();

  if (action === 'add' && code !== getEditorValue()) {
    setEditorStatus(`Adding the last saved version of "${currentScriptName}". Save first to use current changes.`);
  } else if (action === 'update') {
    scripts[currentScriptName] = code;
    saveScriptsToStorage(scripts);
  }

  // The standalone editor has no visible chart and must never compile against its
  // hidden workspace. Send the source to the primary window, which owns the live
  // chart, its data engine and all indicator handles.
  if (standalonePineEditor) {
    if (!window.velaPineEditorWindow) {
      setEditorStatus('The main Omega window is not available.', 'error');
      return;
    }
    window.velaPineEditorWindow.publishScriptUpdate({ name: currentScriptName, source: code, action });
    setEditorStatus(`${action === 'add' ? 'Adding' : 'Updating'} "${currentScriptName}" on the main chart…`);
    return;
  }

  setEditorStatus('Compiling Pine script');
  try {
    const error = action === 'add'
      ? await addScriptToChart(currentScriptName, code)
      : await updateScriptOnChart(currentScriptName, code);
    if (error) {
      setEditorStatus(error.message, 'error');
      return;
    }
    setEditorStatus(`${action === 'add' ? 'Added' : 'Updated'} "${currentScriptName}" on chart.`, 'success');
  } catch (error) {
    setEditorStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

document.getElementById('btn-add-to-chart')!.addEventListener('click', () => { void addOrUpdateCurrentScript('add'); });
document.getElementById('btn-update-chart')!.addEventListener('click', () => { void addOrUpdateCurrentScript('update'); });
document.getElementById('btn-export-script')!.addEventListener('click', async () => {
  const source = getEditorValue();
  const name = currentScriptName || 'pine-script';
  try {
    if (window.velaPineExport) {
      const result = await window.velaPineExport.save(name, source);
      if (!result.canceled) setEditorStatus(`Exported "${name}"${result.path ? ` to ${result.path}` : '.'}`, 'success');
      return;
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([source], { type: 'text/plain;charset=utf-8' }));
    link.download = `${name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'pine-script'}.pine`;
    link.click();
    URL.revokeObjectURL(link.href);
    setEditorStatus(`Exported "${name}".`, 'success');
  } catch (error) {
    setEditorStatus(`Could not export script: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
});

document.getElementById('btn-upgrade-v6')!.addEventListener('click', async (event) => {
  const button = event.currentTarget as HTMLButtonElement;
  button.disabled = true;
  try {
    if (!pineTsModule.enabled || !pineTsModule.value) {
      throw new Error('PineTS is disabled or unavailable. The chart is still running without Pine script compilation.');
    }
    await initializeCodeEditor();
    const editor = pineEditorLifecycle.getEditor();
    if (!editor) throw new Error('The Pine editor is not ready.');
    const source = editor.getValue();
    const [converterModule, pineTsRuntime] = await Promise.all([
      import('./pineVersionConverter.mjs'),
      import('pinets'),
    ]);
    const conversion = converterModule.convertPineScriptToV6(source);
    pineEditorLifecycle.cancelPendingSave();
    editor.updateOptions({ readOnly: true });
    setEditorStatus(`Checking Pine v${conversion.version} → v6 conversion…`);

    const validationBars = Array.from({ length: 120 }, (_, index) => {
      const close = 100 + Math.sin(index / 4) * 5 + index * 0.03;
      const open = close + Math.sin(index) * 0.3;
      return {
        open,
        high: Math.max(open, close) + 1,
        low: Math.min(open, close) - 1,
        close,
        volume: 100 + index % 17,
        openTime: 1_700_000_000_000 + index * 60_000,
      };
    });
    await new pineTsRuntime.PineTS(validationBars).run(conversion.source);

    const chartError = await applyScriptToChart(currentScriptName, conversion.source);
    if (chartError) throw chartError;

    pineEditorLifecycle.setValueWithoutValidation(conversion.source);
    scripts[currentScriptName] = conversion.source;
    saveScriptsToStorage(scripts);
    setEditorStatus(`Upgraded Pine v${conversion.version} to v6, saved, and compiled "${currentScriptName}".`, 'success');
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    setEditorStatus(`Unable to upgrade script: ${reason}`, 'error');
  } finally {
    pineEditorLifecycle.getEditor()?.updateOptions({ readOnly: false });
    button.disabled = false;
  }
});

document.getElementById('btn-delete')!.addEventListener('click', () => {
  if (Object.keys(scripts).length <= 1) { alert('Keep at least one script.'); return; }
  if (!confirm(`Delete "${currentScriptName}"?`)) return;
  const deletedName = currentScriptName;
  scriptHandles.get(deletedName)?.forEach(handle => handle.remove());
  for (const cell of workspace.cells()) {
    if (cell.id !== workspace.active.id && groupByCellId[cell.id] === groupByCellId[workspace.active.id]) {
      cell.chart.indicators().find(indicator => indicator.id === scriptIndicatorId(deletedName))?.remove();
    }
  }
  scriptHandles.delete(deletedName);
  editorModels.get(deletedName)?.dispose();
  editorModels.delete(deletedName);
  delete scripts[deletedName];
  saveScriptsToStorage(scripts);
  currentScriptName = Object.keys(scripts)[0];
  refreshDropdown();
  loadScriptIntoEditor(currentScriptName);
  setEditorStatus(`Deleted "${deletedName}".`, 'success');
});

document.getElementById('btn-new')!.addEventListener('click', () => {
  modalInput.value = '';
  modal.style.display = 'flex';
  setTimeout(() => modalInput.focus(), 50);
});
document.getElementById('modal-cancel-btn')!.addEventListener('click', () => {
  modal.style.display = 'none';
});
modalConfirmButton.addEventListener('click', () => {
  const name = modalInput.value.trim();
  if (!name) return;
  if (Object.hasOwn(scripts, name)) {
    setEditorStatus(`A script named "${name}" already exists.`, 'error');
    return;
  }
  scripts[name] = `//@version=6\nindicator(${JSON.stringify(name)}, overlay = true)\n\nplot(ta.ema(close, 20), "EMA 20", color = color.yellow)\n`;
  saveScriptsToStorage(scripts);
  currentScriptName = name;
  refreshDropdown();
  loadScriptIntoEditor(name);
  modal.style.display = 'none';
  setEditorStatus(`Created "${name}".`, 'success');
});



export async function openScriptInEditor(name: string, source?: string) {
  if (!pineEditorModule.enabled || !pineEditorModule.value) {
    throw new Error('The Pine editor module is disabled or unavailable.');
  }
  // 1. Open the drawer if closed
  const drawer = document.getElementById('editor-drawer');
  if (drawer && drawer.style.display !== 'flex') {
    window.toggleEditor(true);
  }

  // 2. If source provided, save to memory & storage and update model
  if (source) {
    scripts[name] = source;
    saveScriptsToStorage(scripts);
    const existingModel = editorModels.get(name);
    if (existingModel && !existingModel.isDisposed()) {
      existingModel.setValue(source);
    }
  }

  currentScriptName = name;
  refreshDropdown();
  scriptSelect.value = name;

  await initializeCodeEditor();
  loadScriptIntoEditor(name);
  pineEditorLifecycle.getEditor()?.layout();
  pineEditorLifecycle.getEditor()?.focus();
  setEditorStatus(`Editing "${name}"`, 'success');
}
(window as any).openScriptInEditor = openScriptInEditor;

// ---------------------------------------------------------------------------
// Register TradingView-style "{ }" Legend Row Action: Open Source Code
// ---------------------------------------------------------------------------
if (pineEditorModule.enabled && pineEditorModule.value) {
registerIcon(
  'source-code',
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M5.5 3C4.5 3 4 3.5 4 4.5v2c0 .8-.5 1.5-1.5 1.5.8 0 1.5.7 1.5 1.5v2c0 1 .5 1.5 1.5 1.5M10.5 3c1 0 1.5.5 1.5 1.5v2c0 .8.5 1.5 1.5 1.5-.8 0-1.5.7-1.5 1.5v2c0 1-.5 1.5-1.5 1.5"/>' +
  '</svg>'
);

registerLegendAction({
  id: 'open-source-code',
  icon: 'source-code',
  tooltip: 'Source code',
  order: 5,
  when: () => true,
  run: async (_ctx, indicator) => {
    let source = indicator.source;
    const name = indicator.title || 'Indicator';

    if (!source && scripts[name]) {
      source = scripts[name];
    }

    if (!source) {
      try {
        const catRes = await fetch(appAssetUrl('/indicators/catalog.json'));
        if (catRes.ok) {
          const catalog: Array<{ name: string; url: string }> = await catRes.json();
          const cleanName = name.replace(/\s*\([^)]*\)/g, '').trim().toLowerCase();
          const found = catalog.find(c => {
            const cName = c.name.toLowerCase();
            return cName === cleanName || cName.includes(cleanName) || cleanName.includes(cName);
          });
          if (found) {
            const srcRes = await fetch(appAssetUrl(found.url));
            if (srcRes.ok) source = await srcRes.text();
          }
        }
      } catch (err) {
        console.warn('Could not fetch source from catalog:', err);
      }
    }

    if (window.velaPineEditorWindow) {
      const sourceToOpen = source ?? scripts[name] ?? '';
      scripts[name] = sourceToOpen;
      saveScriptsToStorage(scripts);
      const opened = await window.velaPineEditorWindow.openScript(name, sourceToOpen);
      if (opened) return;
    }
    await openScriptInEditor(name, source);
  },
});
}

if (!pineEngine) {
  console.info('PineTS is disabled; the chart is available without Pine script compilation.');
}
// ---------------------------------------------------------------------------
const { sync: syncChartControls } = initializeChartTimeframeControls(workspace);

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
  onReplayActiveChange: active => { replayActive = active; },
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


initializePaperTradeDrag();

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
  } catch (error) {
    console.error('Could not apply the selected theme to the chart workspace:', error);
  }
  try {
    pineEditorLifecycle.setTheme(currentTheme === 'light' || currentTheme === 'high-contrast' ? 'light' : 'dark');
  } catch (error) {
    console.error('Could not apply the selected theme to the Pine editor:', error);
  }
  if (changed) workspace.context().stateChanged();
}

initializeThemeMenu({ getTheme: () => currentTheme, setTheme });

function installSettingsActionButtons(): void {
  // Vela Settings supports value rows only. Add true one-shot actions beside its
  // native Reset button instead of misrepresenting commands as select dropdowns.
  const settingsDialog = document.querySelector<HTMLElement>('.vela-dialog--settings');
  const resetButton = settingsDialog?.querySelector<HTMLButtonElement>('button.vela-sd-btn');
  const footer = resetButton?.parentElement;
  if (!footer || footer.querySelector('[data-omega-settings-action]')) return;

  const makeButton = (label: string, action: () => void) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vela-sd-btn';
    button.textContent = label;
    button.dataset.omegaSettingsAction = label;
    button.addEventListener('click', action);
    footer.insertBefore(button, resetButton);
  };
  makeButton('Replay', openReplayControls);
  makeButton('Check for updates', () => document.getElementById('check-updates')?.click());
}

// The same Settings dialog can also be opened from Vela's in-chart gear. Observe
// only newly inserted dialog roots so the action buttons are present on that path too.
new MutationObserver(records => {
  const settingsWasInserted = records.some(record => [...record.addedNodes].some(node =>
    node instanceof Element && (node.matches('.vela-dialog--settings') || Boolean(node.querySelector('.vela-dialog--settings'))),
  ));
  if (settingsWasInserted) requestAnimationFrame(installSettingsActionButtons);
}).observe(document.body, { childList: true, subtree: true });

function openChartSettings(): void {
  // The toolbar belongs to the chart the trader is working with, not necessarily
  // the first workspace chart. Its sections were registered when the cell mounted.
  const activeChart = workspace.active?.chart ?? workspace.chart;
  try {
    activeChart.renderer.setSettingsVisibility({ hidden: [] });
    activeChart.renderer.openSettings();
    requestAnimationFrame(installSettingsActionButtons);
  } catch (error) {
    console.error('Could not open chart settings:', error);
    workspace.toast('Could not open chart settings. Please try again.', 'error');
  }
}

// Keep the chart's right-click menu useful for the actions traders reach for
// while working on the plot. These actions deliberately reuse the same paths as
// the toolbar and Settings, so there is one source of truth for each command.
const contextActionIcons: Record<string, string> = {
  'omega-context-cancel-order': '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="m17 3 4 4m0-4-4 4"/>',
  'omega-context-add-order': '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M19 14v7m-3.5-3.5h7"/>',
  'omega-context-volume': '<path d="M3 10v4h4l5 4V6l-5 4z"/><path d="M16 9a5 5 0 0 1 0 6m3-9a9 9 0 0 1 0 12"/>',
  'omega-context-bid-ask': '<path d="M3 7h18M3 17h18"/><path d="m7 4-4 3 4 3m10 4 4 3-4 3"/>',
  'omega-context-reset-view': '<path d="M4 11a8 8 0 1 1 2 6"/><path d="M4 4v7h7"/><path d="M12 7v5l3 2"/>',
  'omega-context-background': '<path d="M12 3a9 9 0 1 0 0 18h1a2 2 0 0 0 1-3.7 2 2 0 0 1 1-3.8h2a3 3 0 0 0 3-3c0-4.1-4-7.5-9-7.5z"/><path d="M7.5 10h.01M11 7h.01M15.5 8.5h.01"/>',
  'omega-context-theme-light': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
  'omega-context-theme-dark': '<path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5 8.5 8.5 0 1 0 20.5 14.2z"/>',
  'omega-context-pine': '<path d="m8 5-6 7 6 7m8-14 6 7-6 7m-2-15-4 16"/>',
  'omega-context-replay': '<path d="M4 5v6h6"/><path d="M5.5 15a7 7 0 1 0 1-7"/><path d="m10 8 6 4-6 4z"/>',
  'omega-context-replay-panel': '<path d="M3 4h18v16H3z"/><path d="M3 9h18m-6-5v5"/><path d="m8 12 5 3-5 3z"/>',
};
for (const [id, pathData] of Object.entries(contextActionIcons)) {
  registerIcon(id, `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathData}</svg>`);
}
registerWidgetAction({
  id: 'omega-context-cancel-pending-paper-order',
  target: 'context:body',
  label: 'Cancel pending paper order',
  icon: 'omega-context-cancel-order',
  order: -21,
  when: context => context.pointer?.paneKind === 'price'
    && Number.isFinite(context.pointer.price)
    && Boolean(paperTradingModule?.hasPendingPaperOrderAtPrice(context.chart, context.pointer?.price)),
  run: async context => {
    const paperTrading = await ensurePaperTrading();
    if (!paperTrading.cancelPendingPaperOrderAtPrice(context.chart, context.pointer?.price)) {
      context.toast('No pending paper order was found at that price.', 'error');
    }
  },
});
registerWidgetAction({
  id: 'omega-context-add-pending-paper-order',
  target: 'context:body',
  label: 'Add pending paper order…',
  icon: 'omega-context-add-order',
  order: -20,
  when: context => context.pointer?.paneKind === 'price'
    && Number.isFinite(context.pointer.price)
    && Number(context.pointer.price) > 0
    && Boolean(context.symbol)
    && Boolean(context.chart.data.resolve(context.symbol)),
  run: async context => {
    const paperTrading = await ensurePaperTrading();
    paperTrading.openPendingOrderDialog(context.chart, context.pointer?.price);
  },
});
registerWidgetAction({
  id: 'omega-context-show-real-volumes',
  target: 'context:body',
  label: 'Show real volumes',
  icon: 'omega-context-volume',
  order: -28,
  when: context => !context.chart.presentNativeIndicators().includes('volume'),
  run: context => {
    context.addNativeIndicator('volume');
  },
});
registerWidgetAction({
  id: 'omega-context-hide-real-volumes',
  target: 'context:body',
  label: 'Hide real volumes',
  icon: 'omega-context-volume',
  order: -28,
  when: context => context.chart.presentNativeIndicators().includes('volume'),
  run: context => {
    const volume = context.chart.indicators().find(indicator => indicator.nativeType === 'volume');
    if (!volume) {
      context.toast('Real volumes could not be disabled because the volume indicator is unavailable.', 'error');
      return;
    }
    volume.remove();
  },
});
registerWidgetAction({
  id: 'omega-context-show-bid-ask-lines',
  target: 'context:body',
  label: 'Show bid/ask lines',
  icon: 'omega-context-bid-ask',
  order: -27,
  when: () => !showBidAskLines,
  run: () => {
    showBidAskLines = true;
    localStorage.setItem('vela_show_bid_ask_lines', 'true');
    for (const controller of bidAskLinesControllers.values()) controller.setEnabled(true);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
});
registerWidgetAction({
  id: 'omega-context-hide-bid-ask-lines',
  target: 'context:body',
  label: 'Hide bid/ask lines',
  icon: 'omega-context-bid-ask',
  order: -27,
  when: () => showBidAskLines,
  run: () => {
    showBidAskLines = false;
    localStorage.setItem('vela_show_bid_ask_lines', 'false');
    for (const controller of bidAskLinesControllers.values()) controller.setEnabled(false);
    if (workspaceInitialized) workspace.context().stateChanged();
  },
});
registerWidgetAction({
  id: 'omega-context-reset-view',
  target: 'context:body',
  label: 'Reset chart view (50 bars)',
  icon: 'omega-context-reset-view',
  order: -29,
  run: context => {
    workspace.active.resetView();
    const fullRange = context.chart.getVisibleRange();
    const barDuration = timeframeToMs(context.timeframe);
    if (fullRange) {
      const requestedBars = Math.max(0, Number(context.chart.market.bars) || 0);
      const averageLoadedBarDuration = requestedBars > 50
        ? (fullRange.to - fullRange.from) / Math.max(1, requestedBars - 1)
        : 0;
      const resetDuration = averageLoadedBarDuration > 0 ? averageLoadedBarDuration : barDuration;
      if (!Number.isFinite(resetDuration) || resetDuration <= 0) return;
      context.chart.setVisibleRange({
        from: fullRange.to - resetDuration * 49,
        to: fullRange.to,
      });
    }
    context.toast('Chart view reset to the latest 50 bars.', 'success');
  },
});
registerWidgetAction({
  id: 'omega-context-background',
  target: 'context:body',
  label: 'Chart background color…',
  icon: 'omega-context-background',
  order: 120,
  run: context => {
    context.chart.renderer.openSettings('Canvas');
  },
});
registerWidgetAction({
  id: 'omega-context-theme-light',
  target: 'context:body',
  label: 'Switch to Light theme',
  icon: 'omega-context-theme-light',
  order: 121,
  when: () => currentTheme !== 'light',
  run: context => {
    setTheme('light');
    context.toast('Switched to Light theme.', 'success');
  },
});
registerWidgetAction({
  id: 'omega-context-theme-dark',
  target: 'context:body',
  label: 'Switch to Dark blue theme',
  icon: 'omega-context-theme-dark',
  order: 121,
  when: () => currentTheme !== 'dark',
  run: context => {
    setTheme('dark');
    context.toast('Switched to Dark blue theme.', 'success');
  },
});
registerWidgetAction({
  id: 'omega-context-pine-window',
  target: 'context:body',
  label: 'Open Pine Editor in new window',
  icon: 'omega-context-pine',
  order: 122,
  run: context => {
    const button = document.getElementById('btn-open-standalone-editor') as HTMLButtonElement | null;
    if (button && !button.hidden) {
      button.click();
      return;
    }
    context.toast('The separate Pine Editor is available only in the Omega desktop app.', 'info');
  },
});
registerWidgetAction({
  id: 'omega-context-start-replay',
  target: 'context:body',
  label: 'Start replay from here',
  icon: 'omega-context-replay',
  order: 123,
  when: context => Number.isFinite(context.pointer?.time),
  run: context => {
    const from = context.pointer?.time;
    if (from == null || !Number.isFinite(from)) return;
    const cell = workspace.cells().find(candidate => candidate.chart === context.chart);
    if (!cell) {
      context.toast('Could not identify the chart for replay.', 'error');
      return;
    }
    openReplayControls();
    void startReplayAt(from, cell.id);
  },
});
registerWidgetAction({
  id: 'omega-context-open-replay',
  target: 'context:body',
  label: 'Open Replay',
  icon: 'omega-context-replay-panel',
  order: 124,
  run: () => openReplayControls(),
});

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
  onPaperTradingAction: async action => {
    await ensurePaperTrading();
    document.dispatchEvent(new CustomEvent(`omega:paper-trading:${action}`));
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
    void openVisualBacktest().catch(() => undefined);
  },
  onSettings: openChartSettings,
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
  startupTimeout = window.setTimeout(() => resolve(false), 4_500);
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
