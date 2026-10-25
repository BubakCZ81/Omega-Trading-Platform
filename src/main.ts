import { registerLayout, VelaWorkspace } from '@luxalgo/vela/workspace';
import './styles.css';
import './editorDrawer';
import { appAssetUrl } from './appPaths';
import { registerLegendAction, registerIcon, registerRendererLayer, registerStatePersistence, registerWidgetAction, timeframeToMs, type IndicatorHandle, type VelaTheme } from '@luxalgo/vela';
import { BinanceProvider } from '@luxalgo/vela/providers/binance';
import { initializeCTraderFeed } from './ctraderFeed';
import type { PineEditor, PineModel } from './pineEditorNext';
import { getSavedScripts, saveScriptsToStorage } from './pineStorage';
import { createPineScriptManager } from './pineScriptManager';
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
import { applyTimeframe, timeframeInputState } from './timeframeSelection';
import { registerOrderFlowChartTypes } from './orderFlowCharts';
import { initializeSpreadReadout } from './spreadReadout';
import { initializeColorPickerDismissal } from './colorPickerDismissal';
import {
  cancelPendingPaperOrderAtPrice,
  hasPendingPaperOrderAtPrice,
  initializeChartPaperTrading,
  openPendingOrderDialog,
} from './chartPaperTrading';
import { initializeQuickTradeToggle } from './quickTradeToggle';
import { ChartCellControlsManager } from './chartCellControls';
import './favoriteDrawingTools';
import { bootWithOptionalModules, loadOptionalModule, type OptionalModule, type OptionalModuleId } from './featureModules';
import { createReplayAwareEngine } from './replayStreamingEngine';
import { getMarketFlowStyle, refreshMarketFlowStyles, setMarketFlowStyle } from './marketFlowPane';
import { attachFuturesMonthBoundaries } from './futuresMonthBoundaries';
import { initializeVisualBacktest } from './visualBacktest';
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

document.getElementById('diagnostics-console-toggle')?.addEventListener('click', () => {
  void window.velaDiagnostics?.openConsole().catch(error => {
    console.error('Could not open the diagnostic console:', error);
  });
});

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
  loadStartupModule('pinets', () => import('@luxalgo/vela-pinets')),
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

const [
  brokerModule,
  mt5FeedModule,
  alpacaSdkFeedModule,
  pineEditorModule,
  pineTsModule,
  indicatorBrowserModule,
  priceBarRatioModule,
  backtestModule,
  newsModule,
  updateCheckerModule,
] = await optionalModuleLoads;
setStartupStatus('Restoring your charts and workspace settings…');

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
hideFeatureElements(backtestModule.enabled, 'backtest-toggle');
hideFeatureElements(pineEditorModule.enabled, 'editor-toggle-btn', 'editor-drawer', 'resize-handle');
hideFeatureElements(updateCheckerModule.enabled, 'check-updates');
const connectionLatency = document.getElementById('connection-latency');
const tradingAccountMode = document.getElementById('trading-account-mode');
const tradingAccountDetail = document.getElementById('trading-account-detail');
const tradingAccountSelect = document.getElementById('trading-account-select') as HTMLSelectElement | null;
type TradingAccountChoice = { id: string; label: string; mode: string; detail: string };
const LOCAL_DEMO_ACCOUNT: TradingAccountChoice = {
  id: 'local-demo', label: 'DEMO · Local account', mode: 'DEMO', detail: 'Local account',
};
const availableTradingAccounts = new Map<string, TradingAccountChoice>([[LOCAL_DEMO_ACCOUNT.id, LOCAL_DEMO_ACCOUNT]]);
const TRADING_ACCOUNT_STORAGE_KEY = 'omega.selected-trading-account';
function selectTradingAccount(id: string, persist = true) {
  const account = availableTradingAccounts.get(id) ?? LOCAL_DEMO_ACCOUNT;
  if (tradingAccountSelect) tradingAccountSelect.value = account.id;
  if (tradingAccountMode) tradingAccountMode.textContent = account.mode;
  if (tradingAccountDetail) tradingAccountDetail.textContent = account.detail;
  if (persist) localStorage.setItem(TRADING_ACCOUNT_STORAGE_KEY, account.id);
  document.dispatchEvent(new CustomEvent('omega:trading-account-selected', {
    detail: {
      id: account.id,
      provider: account.id.includes(':') ? account.id.slice(0, account.id.indexOf(':')).toLowerCase() : '',
    },
  }));
}
function renderTradingAccounts() {
  if (!tradingAccountSelect) return;
  const selected = localStorage.getItem(TRADING_ACCOUNT_STORAGE_KEY) || LOCAL_DEMO_ACCOUNT.id;
  tradingAccountSelect.replaceChildren(...[...availableTradingAccounts.values()].map(account => {
    const option = document.createElement('option');
    option.value = account.id;
    option.textContent = account.label;
    return option;
  }));
  selectTradingAccount(availableTradingAccounts.has(selected) ? selected : LOCAL_DEMO_ACCOUNT.id, false);
}
tradingAccountSelect?.addEventListener('change', () => selectTradingAccount(tradingAccountSelect.value));
document.addEventListener('omega:trading-account-available', event => {
  const account = (event as CustomEvent<TradingAccountChoice>).detail;
  if (!account?.id || !account.label || !account.mode || !account.detail) return;
  availableTradingAccounts.set(account.id, account);
  renderTradingAccounts();
});
document.addEventListener('omega:trading-account-unavailable', event => {
  const id = (event as CustomEvent<string>).detail;
  if (!id || id === LOCAL_DEMO_ACCOUNT.id) return;
  availableTradingAccounts.delete(id);
  renderTradingAccounts();
});
document.addEventListener('omega:trading-broker-disconnected', event => {
  const brokerId = (event as CustomEvent<string>).detail;
  if (!brokerId) return;
  for (const id of availableTradingAccounts.keys()) {
    if (id.startsWith(`${brokerId}:`)) availableTradingAccounts.delete(id);
  }
  renderTradingAccounts();
});
renderTradingAccounts();
document.addEventListener('omega:connection-latency', (event) => {
  const milliseconds = (event as CustomEvent<number>).detail;
  if (!connectionLatency || !Number.isFinite(milliseconds)) return;
  connectionLatency.textContent = `Server: ${Math.round(milliseconds)} ms`;
  connectionLatency.dataset.quality = milliseconds < 100 ? 'good' : milliseconds < 300 ? 'warning' : 'poor';
});
if (updateCheckerModule.enabled && updateCheckerModule.value) {
  updateCheckerModule.value.initializeUpdateChecker();
}

// ---------------------------------------------------------------------------
// 1. Script Storage
// ---------------------------------------------------------------------------
let scripts = getSavedScripts();
const requestedPineScript = new URLSearchParams(window.location.search).get('script');
let currentScriptName = requestedPineScript && scripts[requestedPineScript]
  ? requestedPineScript
  : Object.keys(scripts)[0] || 'Dual EMA Cross';
const savedTheme = localStorage.getItem('vela_theme');
type OmegaTheme = 'dark' | 'light' | 'high-contrast';
const HIGH_CONTRAST_THEME: VelaTheme = {
  background: '#f7fbff',
  textColor: '#061a33',
  gridColor: '#9bb1c8',
  borderColor: '#183b60',
  upColor: '#0063a8',
  downColor: '#b00020',
  fontFamily: 'Arial, sans-serif',
};
let currentTheme: OmegaTheme = savedTheme === 'light' || savedTheme === 'high-contrast' ? savedTheme : 'dark';
let workspace: VelaWorkspace;
let workspaceInitialized = false;
let barThickness = Math.max(0.15, Math.min(1, Number(localStorage.getItem('vela_bar_thickness') ?? 1)));

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
let chartTabsEnabled = localStorage.getItem('omega_chart_tabs_enabled') === 'true';
const storedChartTabCount = Number(localStorage.getItem('omega_chart_tabs_count'));
let chartTabCount = Number.isInteger(storedChartTabCount)
  ? Math.max(1, Math.min(OMEGA_TABS_MAX, storedChartTabCount))
  : 1;
let chartTabsPreviousLayout = localStorage.getItem('omega_chart_tabs_previous_layout') || '1';
const chartTabsLayoutId = (count: number) => `${OMEGA_TABS_LAYOUT_PREFIX}${count}`;
const isChartTabsLayout = (layoutId: string) => /^omega-tabs-[1-8]$/.test(layoutId);
if (isChartTabsLayout(chartTabsPreviousLayout)) chartTabsPreviousLayout = '1';

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
      getZoomFactor(): Promise<number>;
      setZoomFactor(factor: number): Promise<number>;
    };
  }
}

const PLATFORM_ZOOM_STORAGE_KEY = 'omega_platform_zoom_factor';
const PLATFORM_ZOOM_MIN = 0.75;
const PLATFORM_ZOOM_MAX = 1.5;
const PLATFORM_ZOOM_STEP = 0.1;
const platformZoomOutButton = document.getElementById('platform-zoom-out') as HTMLButtonElement | null;
const platformZoomInButton = document.getElementById('platform-zoom-in') as HTMLButtonElement | null;
const platformZoomValue = document.getElementById('platform-zoom-value') as HTMLInputElement | null;
const chartWrapper = document.getElementById('chart-wrapper');
const chartSurface = document.getElementById('chart');
const chartStage = document.getElementById('chart-stage');
const savedPlatformZoom = localStorage.getItem(PLATFORM_ZOOM_STORAGE_KEY);
const parsedPlatformZoom = savedPlatformZoom === null ? 1 : Number(savedPlatformZoom);
let platformZoom = Number.isFinite(parsedPlatformZoom) && parsedPlatformZoom > 0
  ? Math.min(PLATFORM_ZOOM_MAX, Math.max(PLATFORM_ZOOM_MIN, parsedPlatformZoom))
  : 1;

function updatePlatformZoomControls(): void {
  const percent = Math.round(platformZoom * 100);
  if (platformZoomValue && document.activeElement !== platformZoomValue) platformZoomValue.value = `${percent}%`;
  if (platformZoomOutButton) platformZoomOutButton.disabled = platformZoom <= PLATFORM_ZOOM_MIN;
  if (platformZoomInButton) platformZoomInButton.disabled = platformZoom >= PLATFORM_ZOOM_MAX;
}

function applyPlatformScaleStyles(zoom: number): void {
  document.documentElement.style.setProperty('--omega-platform-scale', String(zoom));
  document.documentElement.style.zoom = '';
}

function preserveChartSize(): void {
  if (!chartWrapper || !chartSurface || !chartStage) return;
  const fixedHeight = Array.from(chartWrapper.children).reduce((height, child) => {
    if (!(child instanceof HTMLElement) || child === chartStage) return height;
    const position = getComputedStyle(child).position;
    return position === 'absolute' || position === 'fixed' ? height : height + child.offsetHeight;
  }, 0);
  const availableHeight = Math.max(0, chartWrapper.clientHeight - fixedHeight);
  chartSurface.style.flex = '0 0 auto';
  chartSurface.style.height = `${availableHeight * platformZoom}px`;
}

if (chartWrapper && chartSurface && chartStage) {
  const chartResizeObserver = new ResizeObserver(preserveChartSize);
  chartResizeObserver.observe(chartWrapper);
  chartResizeObserver.observe(chartStage);
  for (const id of ['top-toolbar', 'chart-tabs-bar']) {
    const element = document.getElementById(id);
    if (element) chartResizeObserver.observe(element);
  }
  window.addEventListener('resize', preserveChartSize);
}

async function applyPlatformZoom(nextZoom: number): Promise<void> {
  platformZoom = Math.round(Math.min(PLATFORM_ZOOM_MAX, Math.max(PLATFORM_ZOOM_MIN, nextZoom)) * 100) / 100;
  localStorage.setItem(PLATFORM_ZOOM_STORAGE_KEY, String(platformZoom));
  updatePlatformZoomControls();
  if (window.velaApp) {
    try {
      platformZoom = await window.velaApp.setZoomFactor(platformZoom);
      localStorage.setItem(PLATFORM_ZOOM_STORAGE_KEY, String(platformZoom));
    } catch (error) {
      console.warn('Could not persist platform zoom in the desktop shell:', error);
    }
  }
  applyPlatformScaleStyles(platformZoom);
  preserveChartSize();
  updatePlatformZoomControls();
}

platformZoomOutButton?.addEventListener('click', () => { void applyPlatformZoom(platformZoom - PLATFORM_ZOOM_STEP); });
platformZoomInButton?.addEventListener('click', () => { void applyPlatformZoom(platformZoom + PLATFORM_ZOOM_STEP); });
function readPlatformZoomInput(): number | null {
  const value = platformZoomValue?.value.trim().replace(',', '.').replace('%', '');
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 5 ? parsed / 100 : parsed;
}
function commitPlatformZoomInput(): void {
  const zoom = readPlatformZoomInput();
  if (zoom === null) {
    updatePlatformZoomControls();
    return;
  }
  void applyPlatformZoom(zoom);
}
platformZoomValue?.addEventListener('change', commitPlatformZoomInput);
platformZoomValue?.addEventListener('blur', commitPlatformZoomInput);
platformZoomValue?.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    commitPlatformZoomInput();
    platformZoomValue.blur();
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    updatePlatformZoomControls();
    platformZoomValue.blur();
  }
});
updatePlatformZoomControls();
void applyPlatformZoom(platformZoom);

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
  serialize: () => ({ theme: currentTheme, barThickness, lockPriceToBarRatio, showBidAskLines, bidAskLineStyle, chartTabsEnabled, chartTabCount, chartTabsPreviousLayout }),
  restore: payload => {
    if (!payload || typeof payload !== 'object') return;
    const preferences = payload as Record<string, unknown>;
    if (preferences.theme === 'dark' || preferences.theme === 'light' || preferences.theme === 'high-contrast') {
      currentTheme = preferences.theme;
      localStorage.setItem('vela_theme', currentTheme);
      if (workspaceInitialized) {
        workspace.setTheme(currentTheme === 'high-contrast' ? HIGH_CONTRAST_THEME : currentTheme);
        setPineEditorTheme?.(currentTheme === 'dark' ? 'dark' : 'light');
        updateThemeUI(currentTheme);
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
    if (typeof preferences.chartTabsEnabled === 'boolean') chartTabsEnabled = preferences.chartTabsEnabled;
    if (typeof preferences.chartTabCount === 'number' && Number.isInteger(preferences.chartTabCount)) {
      chartTabCount = Math.max(1, Math.min(OMEGA_TABS_MAX, preferences.chartTabCount));
    }
    if (typeof preferences.chartTabsPreviousLayout === 'string' && !isChartTabsLayout(preferences.chartTabsPreviousLayout)) {
      chartTabsPreviousLayout = preferences.chartTabsPreviousLayout;
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
          get: () => chartTabsEnabled,
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
          options: [['dark', 'Dark blue'], ['light', 'Light'], ['high-contrast', 'High contrast (blue)']],
          get: () => currentTheme,
          set: (theme: string) => setTheme(theme === 'high-contrast' ? 'high-contrast' : theme === 'light' ? 'light' : 'dark'),
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
          setLoadedBarCount(settingsCellId(), 0, bars);
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
const initialWorkspaceLayout = chartTabsEnabled
  ? chartTabsLayoutId(chartTabCount)
  : (restoredLayout && !isChartTabsLayout(restoredLayout) ? restoredLayout : '1');
const chartGridHost = document.createElement('div');
chartGridHost.id = 'chart-grid';
Object.assign(chartGridHost.style, { position: 'absolute', inset: '0', display: 'flex', flexDirection: 'column' });
document.getElementById('chart')!.append(chartGridHost);

setStartupStatus('Building your trading workspace…');
try {
  workspace = await bootWithOptionalModules([optionalModuleLoads], () => new VelaWorkspace(chartGridHost, {
    layout: initialWorkspaceLayout, symbol: 'BTCUSDT', timeframe: '60', live: true, volume: false, theme: currentTheme === 'high-contrast' ? HIGH_CONTRAST_THEME : currentTheme, persist: 'vela-workspace', storage: workspaceStorage,
    cells: restoredWorkspaceState?.charts?.length ? Object.fromEntries(restoredWorkspaceState.charts.map((chart: { id: string; symbol?: string; timeframe?: string }) => [chart.id, { symbol: chart.symbol, timeframe: chart.timeframe }])) : (window.velaWorkspaceFiles ? { primary: { symbol: 'BTCUSDT', timeframe: '60' } } : undefined),
    sync: restoredWorkspaceState?.sync,
    topbar: { left: ['symbol', 'indicators', 'omega-favorite-drawing-tools'] },
    providers: {
      binance: () => new BinanceProvider(),
    },
    engines: pineEngine ? { pine: () => pineEngine } : {},
    indicators: loadIndicatorManifest,
  }));
  console.log('Vela Workspace loaded.');
} catch (err) {
  console.error('Workspace init error:', err);
  showStartupFailure(err);
  throw err;
}
workspaceInitialized = true;
workspace.setTheme(currentTheme === 'high-contrast' ? HIGH_CONTRAST_THEME : currentTheme);

mt5FeedModule.value?.initializeMt5Feed(() => workspace);
alpacaSdkFeedModule.value?.initializeAlpacaSdkFeed(() => workspace);
initializeCTraderFeed(() => workspace);

const localFeedsModal = document.getElementById('local-feeds-modal');
const localFeedsToggle = document.getElementById('local-feeds-toggle');
const closeLocalFeeds = () => {
  localFeedsModal?.setAttribute('aria-hidden', 'true');
  if (localFeedsModal) localFeedsModal.hidden = true;
};
localFeedsToggle?.addEventListener('click', () => {
  if (!localFeedsModal) return;
  localFeedsModal.hidden = false;
  localFeedsModal.setAttribute('aria-hidden', 'false');
});
document.getElementById('local-feeds-close')?.addEventListener('click', closeLocalFeeds);
localFeedsModal?.addEventListener('click', event => {
  if (event.target === localFeedsModal) closeLocalFeeds();
});
document.querySelectorAll<HTMLButtonElement>('[data-local-feed]').forEach(button => {
  const trigger = document.getElementById('mt5-feed-toggle') as HTMLButtonElement | null;
  const enabled = mt5FeedModule.enabled;
  if (!trigger || !enabled) button.hidden = true;
  button.addEventListener('click', () => {
    trigger?.click();
    closeLocalFeeds();
  });
});

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
initializeChartPaperTrading(workspace);

document.getElementById('backtest-toggle')?.addEventListener('click', () => {
  workspace.context().togglePanel('omega-backtest');
});

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
let pineEditor: PineEditor | null = null;
let createPineModel: ((uri: string, value: string) => PineModel) | null = null;
let setPineEditorTheme: ((theme: 'dark' | 'light') => void) | null = null;
let setPineDiagnostics: ((model: PineModel, error: Error | null) => void) | null = null;
let setPineCompileDiagnostics: ((model: PineModel, error: Error | null) => void) | null = null;
let editorLoad: Promise<void> | null = null;
let autosaveTimer: number | undefined;
let liveValidationTimer: number | undefined;
let liveValidationRevision = 0;
let isApplyingPineUpgrade = false;

function setEditorStatus(message: string, state: 'error' | 'success' | '' = '', writeActivity = state !== 'error') {
  editorStatus.textContent = '';
  editorStatus.title = message;
  if (state) editorStatus.dataset.state = state;
  else delete editorStatus.dataset.state;
  if (writeActivity && message !== 'Unsaved changes') window.addConsoleActivity?.(message, state || 'info');
}

function getScriptModel(name: string): PineModel | null {
  if (!createPineModel) return null;
  const existing = editorModels.get(name);
  if (existing && !existing.isDisposed()) return existing;
  const model = createPineModel(`inmemory://pine/${encodeURIComponent(name)}.pine`, scripts[name] ?? '');
  editorModels.set(name, model);
  return model;
}

const pineScriptManager = createPineScriptManager({
  getWorkspace: () => workspace,
  getScripts: () => scripts,
  scriptHandles,
  groupByCellId,
  editorModels,
  getPineDiagnostics: () => setPineDiagnostics,
  getPineCompileDiagnostics: () => setPineCompileDiagnostics,
  setEditorStatus,
  isPropagating: () => propagatingGroupState,
  setPropagating: value => { propagatingGroupState = value; },
});
const scriptIndicatorId = pineScriptManager.scriptIndicatorId;
const applyScriptToChart = pineScriptManager.applyScriptToChart;
const addScriptToChart = pineScriptManager.addScriptToChart;
const updateScriptOnChart = pineScriptManager.updateScriptOnChart;

async function initializeCodeEditor() {
  if (!pineEditorModule.enabled || !pineEditorModule.value) {
    throw new Error('The Pine editor module is disabled or unavailable.');
  }
  if (pineEditor) {
    const model = getScriptModel(currentScriptName);
    if (model) pineEditor.setModel(model);
    pineEditor.layout();
    pineEditor.focus();
    return;
  }

  if (!editorLoad) {
    editorLoad = (async () => {
      const [editorModule, referenceModule] = standaloneEditorModules
        ? await standaloneEditorModules
        : await Promise.all([import('./pineEditorNext'), import('./pineReferencePanel')]);
      createPineModel = editorModule.createPineModel;
      setPineEditorTheme = editorModule.setPineEditorTheme;
      setPineDiagnostics = editorModule.setPineDiagnostics;
      setPineCompileDiagnostics = editorModule.setPineCompileDiagnostics;
      const referencePanel = referenceModule.createPineReferencePanel(() => pineEditor);
      renderPineReference = filter => referencePanel.render(filter);

      const model = getScriptModel(currentScriptName);
      if (!model) throw new Error('Could not create the Pine editor model.');

      pineEditor = editorModule.createPineEditor(editorHost, model, currentTheme === 'dark' ? 'dark' : 'light');
      pineEditor.onMouseDown(event => {
        if (event.event.browserEvent.detail !== 2 || !event.target.position) return;
        const activeModel = pineEditor?.getModel();
        if (!activeModel) return;
        const referenceName = editorModule.getPineReferenceNameAtPosition(activeModel, event.target.position);
        if (referenceName) referencePanel.open(referenceName);
      });
      pineEditor.onDidChangeModelContent(() => {
        if (isApplyingPineUpgrade) return;
        const editedModel = pineEditor?.getModel();
        const diagnosticKey = `pine:${currentScriptName}`;
        window.clearConsoleDiagnostics?.(diagnosticKey);
        if (editedModel) {
          setPineDiagnostics?.(editedModel, null);
          for (const diagnostic of editorModule.getPineSyntaxDiagnostics(editedModel)) {
            window.addConsoleOutput?.(
              `Line ${diagnostic.line}, column ${diagnostic.column}: ${diagnostic.message}`,
              diagnostic.severity,
              diagnosticKey,
            );
          }
        }
        window.clearTimeout(liveValidationTimer);
        const validationRevision = ++liveValidationRevision;
        const validationName = currentScriptName;
        const validationCode = editedModel?.getValue() ?? '';
        liveValidationTimer = window.setTimeout(() => {
          void validatePineSource(validationCode).then(error => {
            if (validationRevision !== liveValidationRevision || currentScriptName !== validationName) return;
            const currentModel = pineEditor?.getModel();
            if (currentModel) setPineCompileDiagnostics?.(currentModel, error);
            if (error) {
              window.clearConsoleDiagnostics?.(`pine:${validationName}`);
              pineScriptManager.displayDiagnosticsInConsole(error, validationCode, validationName);
            }
          });
        }, 300);
        window.clearTimeout(autosaveTimer);
        setEditorStatus('Unsaved changes');
        const modelName = currentScriptName;
        const activeModel = pineEditor?.getModel();

        autosaveTimer = window.setTimeout(() => {
          if (!activeModel || activeModel.isDisposed()) return;

          const nextValue = activeModel.getValue();
          scripts[modelName] = nextValue;
          saveScriptsToStorage(scripts);
          if (currentScriptName === modelName) setEditorStatus(`Auto-saved "${modelName}".`, 'success');
        }, 750);
      });

      renderPineReference();
      pineEditor.focus();
    })().catch((error: unknown) => {
      editorLoad = null;
      throw error;
    });
  }

  await editorLoad;
}

window.addEventListener('editor-opened', () => {
  if (!pineEditorModule.enabled || !pineEditorModule.value) return;
  void initializeCodeEditor().catch((error: unknown) => {
    setEditorStatus(`Editor failed to load: ${error instanceof Error ? error.message : String(error)}`, 'error');
  });
});

// The standalone window announces `editor-opened` during module startup, before
// this top-level module may finish loading optional features. Initialise again
// after the listener exists so that event timing can never leave Monaco and the
// local Pine reference unmounted. `initializeCodeEditor` shares `editorLoad`,
// making this safe when the event was received as well.
if (standalonePineEditor && pineEditorModule.enabled && pineEditorModule.value) {
  void initializeCodeEditor().catch((error: unknown) => {
    setEditorStatus(`Editor failed to load: ${error instanceof Error ? error.message : String(error)}`, 'error');
  });
}

function getEditorValue(): string {
  return pineEditor?.getValue() ?? scripts[currentScriptName] ?? '';
}

let renderPineReference: (filter?: string) => void = () => undefined;

const scriptSelect = document.getElementById('script-select') as HTMLSelectElement;

function loadScriptIntoEditor(name: string) {
  const model = getScriptModel(name);
  if (model) {
    pineEditor?.setModel(model);
    if (pineEditor) setEditorStatus(`Editing "${name}"`);
  }
}

function refreshDropdown() {
  scriptSelect.innerHTML = '';
  Object.keys(scripts).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    opt.selected = name === currentScriptName;
    scriptSelect.appendChild(opt);
  });
}

refreshDropdown();
loadScriptIntoEditor(currentScriptName);

scriptSelect.addEventListener('change', () => {
  window.clearTimeout(autosaveTimer);
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
      pineEditor?.focus();
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
    if (model) setPineCompileDiagnostics?.(model, null);
    window.clearConsoleDiagnostics?.(`pine:${name}`);
    return null;
  }
  const model = editorModels.get(name);
  if (model) setPineCompileDiagnostics?.(model, error);
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
    const editor = pineEditor;
    if (!editor) throw new Error('The Pine editor is not ready.');
    const source = editor.getValue();
    const [converterModule, pineTsRuntime] = await Promise.all([
      import('./pineVersionConverter.mjs'),
      import('pinets'),
    ]);
    const conversion = converterModule.convertPineScriptToV6(source);
    window.clearTimeout(autosaveTimer);
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

    isApplyingPineUpgrade = true;
    editor.setValue(conversion.source);
    isApplyingPineUpgrade = false;
    scripts[currentScriptName] = conversion.source;
    saveScriptsToStorage(scripts);
    setEditorStatus(`Upgraded Pine v${conversion.version} to v6, saved, and compiled "${currentScriptName}".`, 'success');
  } catch (error) {
    isApplyingPineUpgrade = false;
    const reason = error instanceof Error ? error.message : String(error);
    setEditorStatus(`Unable to upgrade script: ${reason}`, 'error');
  } finally {
    pineEditor?.updateOptions({ readOnly: false });
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
  pineEditor?.layout();
  pineEditor?.focus();
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
// 6. Chart & Theme Controls
// ---------------------------------------------------------------------------
const customTimeframeMenu = document.getElementById('custom-timeframe-menu') as HTMLDetailsElement;
const customTimeframeValue = document.getElementById('custom-timeframe-value') as HTMLInputElement;
const customTimeframeUnit = document.getElementById('custom-timeframe-unit') as HTMLSelectElement;
const timeframeHelp = document.getElementById('timeframe-help') as HTMLElement;
const applyTimeframeButton = document.getElementById('apply-custom-timeframe') as HTMLButtonElement;
const chartTypeSelect = document.getElementById('chart-type-select') as HTMLSelectElement;
const ctraderTimeframeMenu = document.getElementById('ctrader-timeframe-menu') as HTMLDetailsElement;
const ctraderTimeframeGrid = document.getElementById('ctrader-timeframe-grid') as HTMLElement;
function syncChartControls() {
  const timeframe = workspace.chart.market.timeframe ?? '60';
  customTimeframeMenu.querySelector('summary')!.textContent = formatTimeframeLabel(timeframe);
  syncTimeframeInput(timeframe);
  const style = workspace.chart.renderer.get('priceStyle');
  const styleLabel = typeof style === 'string' && style !== 'candles'
    ? (style === 'heikinashi' ? `Heikin ${formatTimeframeLabel(timeframe)}` : style[0].toUpperCase() + style.slice(1))
    : formatTimeframeLabel(timeframe);
  ctraderTimeframeMenu.querySelector('summary')!.textContent = styleLabel;
  const rendererConfig = workspace.chart.renderer.getConfig() as { chartTypes?: Record<string, { brickPips?: string | number; customBrickPips?: number }> } | null;
  const persistedPips = Number(rendererConfig?.chartTypes?.[String(style)]?.customBrickPips || rendererConfig?.chartTypes?.[String(style)]?.brickPips || 0);
  for (const button of ctraderTimeframeGrid.querySelectorAll<HTMLButtonElement>('button[data-style]')) {
    const activePips = persistedPips > 0 ? persistedPips : selectedPipsByCell.get(workspace.active.id) ?? 5;
    const selected = button.dataset.style === style && (button.dataset.pips ? Number(button.dataset.pips) === activePips : button.dataset.timeframe === timeframe);
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  if (typeof style === 'string' && Array.from(chartTypeSelect.options).some(option => option.value === style)) chartTypeSelect.value = style;
}
function syncTimeframeInput(timeframe: string) {
  const input = timeframeInputState(timeframe);
  if (!input) return;
  customTimeframeValue.value = String(input.value);
  customTimeframeUnit.value = input.unit;
}
function formatTimeframeLabel(timeframe: string): string {
  const tickMatch = /^T([1-9]\d{0,4})$/i.exec(timeframe);
  if (tickMatch) return `${tickMatch[1]}T`;
  if (/^\d+$/.test(timeframe)) {
    const minutes = Number(timeframe);
    if (minutes % 1440 === 0) return `${minutes / 1440}D`;
    if (minutes % 60 === 0) return `${minutes / 60}h`;
    return `${minutes}m`;
  }
  return ({ D: '1D', W: '1W', M: '1M' } as Record<string, string>)[timeframe] ?? timeframe;
}

async function setChartStyle(cell: ReturnType<typeof workspace.cell> | undefined, style: string): Promise<void> {
  if (!cell) return;
  const chart = cell.chart;
  if ((style === 'renko' || style === 'range')
    && chart.market.symbol?.startsWith('MT5:')
    && (chart.market.timeframe ?? '').toUpperCase() !== 'T1') {
    const actualTimeframe = await applyTimeframe(chart, 'T1');
    if (actualTimeframe !== 'T1') {
      throw new Error(`Could not switch to tick input for ${style}; the chart is still showing ${formatTimeframeLabel(actualTimeframe)}.`);
    }
  }
  chart.renderer.set('priceStyle', style);
}

function updateChartStyleHelp(cell: ReturnType<typeof workspace.cell> | undefined, style: string): void {
  delete timeframeHelp.dataset.state;
  if (style === 'renko' || style === 'range') {
    timeframeHelp.textContent = cell?.chart.market.symbol?.startsWith('MT5:')
      ? `${style === 'renko' ? 'Renko' : 'Range'} uses MT5 one-tick input for more accurate price sequencing.`
      : `${style === 'renko' ? 'Renko' : 'Range'} uses this feed’s OHLC bars; intrabar price order is estimated without raw ticks.`;
  } else {
    timeframeHelp.textContent = '';
  }
}

type PeriodChoice = { label: string; timeframe?: string; style: string; pips?: number; disabled?: boolean };
const standardPeriods: PeriodChoice[] = [
  ['1 minute', '1'], ['2 minutes', '2'], ['3 minutes', '3'], ['4 minutes', '4'], ['5 minutes', '5'], ['6 minutes', '6'], ['7 minutes', '7'], ['8 minutes', '8'], ['10 minutes', '10'], ['15 minutes', '15'], ['20 minutes', '20'], ['30 minutes', '30'], ['45 minutes', '45'], ['1 hour', '60'], ['2 hours', '120'], ['3 hours', '180'], ['4 hours', '240'], ['6 hours', '360'], ['8 hours', '480'], ['12 hours', '720'], ['1 day', 'D'], ['1 week', 'W'],
].map(([label, timeframe]) => ({ label, timeframe, style: 'candles' }));
const pipSizes = [
  1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 30, 35, 40, 45, 50, 80, 100, 150,
  200, 300, 500, 800, 1000, 1200, 1500, 1800, 2000, 2500, 3000,
];
const tickSizes = [
  1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 250, 300,
  400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000,
];
const selectedPipsByCell = new Map<string, number>();

function addPeriodColumn(title: string, prefix: string, choices: PeriodChoice[]) {
  const column = document.createElement('section'); column.className = 'ctrader-timeframe-column';
  const heading = document.createElement('h3'); heading.textContent = title;
  const list = document.createElement('div'); list.className = 'ctrader-timeframe-list';
  for (const choice of choices) {
    const button = document.createElement('button'); button.type = 'button'; button.disabled = Boolean(choice.disabled);
    button.dataset.style = choice.style; if (choice.timeframe) button.dataset.timeframe = choice.timeframe; if (choice.pips) button.dataset.pips = String(choice.pips);
    const key = document.createElement('kbd'); key.textContent = choice.pips ? `${prefix}${choice.pips}` : prefix;
    button.append(key, document.createTextNode(choice.pips ? `${choice.pips} pips` : choice.label));
    button.addEventListener('click', async () => {
      const cell = workspace.cell(workspace.active.id); if (!cell) return;
      if (choice.timeframe?.startsWith('T') && !cell.chart.market.symbol?.startsWith('MT5:')) {
        timeframeHelp.textContent = 'Tick bars are currently supported for connected MetaTrader 5 symbols only.';
        timeframeHelp.dataset.state = 'error';
        return;
      }
      if (choice.timeframe) {
        try {
          const actualTimeframe = await applyTimeframe(cell.chart, choice.timeframe);
          if (actualTimeframe !== choice.timeframe) {
            timeframeHelp.textContent = `Could not load ${formatTimeframeLabel(choice.timeframe)} bars; the chart is still showing ${formatTimeframeLabel(actualTimeframe)}.`;
            timeframeHelp.dataset.state = 'error';
            return;
          }
          timeframeHelp.textContent = `Showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
          delete timeframeHelp.dataset.state;
        } catch (error) {
          timeframeHelp.textContent = `Could not load timeframe: ${error instanceof Error ? error.message : String(error)}`;
          timeframeHelp.dataset.state = 'error';
          return;
        }
      }
      if (choice.pips) {
        cell.chart.renderer.applyConfig({ chartTypes: { [choice.style]: { mode: 'pips', brickPips: String(choice.pips), customBrickPips: 0 } } });
        selectedPipsByCell.set(cell.id, choice.pips);
      }
      try {
        await setChartStyle(cell, choice.style);
      } catch (error) {
        timeframeHelp.textContent = error instanceof Error ? error.message : String(error);
        timeframeHelp.dataset.state = 'error';
        return;
      }
      updateChartStyleHelp(cell, choice.style);
      chartTypeSelect.value = choice.style;
      ctraderTimeframeMenu.open = false; syncChartControls();
    });
    list.append(button);
  }
  column.append(heading, list); ctraderTimeframeGrid.append(column);
}

addPeriodColumn('Standard', 'M', standardPeriods);
addPeriodColumn('Tick', 'T', tickSizes.map(value => ({
  label: `${value} ticks`,
  timeframe: `T${value}`,
  style: 'candles',
})));
addPeriodColumn('Renko', 'R', pipSizes.map(pips => ({ label: `${pips} pips`, style: 'renko', pips })));
addPeriodColumn('Range', 'Ra', pipSizes.map(pips => ({ label: `${pips} pips`, style: 'range', pips })));
addPeriodColumn('Heikin Ashi', 'H', standardPeriods.map(item => ({ ...item, style: 'heikinashi' })));

applyTimeframeButton.addEventListener('click', async () => {
  const amount = Number(customTimeframeValue.value);
  const unit = customTimeframeUnit.value;
  if (!Number.isSafeInteger(amount) || amount < 1) {
    timeframeHelp.textContent = 'Enter a positive whole number.';
    return;
  }

  const targetCell = workspace.cell(workspace.active.id);
  if (!targetCell) {
    timeframeHelp.textContent = 'Could not find the active chart.';
    return;
  }
  let timeframe: string;
  if (unit === 'ticks') {
    if (!targetCell.chart.market.symbol?.startsWith('MT5:')) {
      timeframeHelp.textContent = 'Tick bars are currently supported for connected MetaTrader 5 symbols only.';
      timeframeHelp.dataset.state = 'error';
      return;
    }
    if (amount > 10_000) {
      timeframeHelp.textContent = 'Choose no more than 10,000 ticks per bar.';
      timeframeHelp.dataset.state = 'error';
      return;
    }
    timeframe = `T${amount}`;
  } else {
    const multiplier = unit === 'hours' ? 60 : unit === 'days' ? 1440 : 1;
    const maxMinutes = unit === 'days' ? 30 * 1440 : unit === 'hours' ? 24 * 60 : 1440;
    const minutes = amount * multiplier;
    if (!Number.isSafeInteger(minutes) || minutes > maxMinutes) {
      timeframeHelp.textContent = `Choose an interval no larger than ${unit === 'days' ? '30 days' : unit === 'hours' ? '24 hours' : '1,440 minutes'}.`;
      return;
    }
    timeframe = unit === 'days' && amount === 1 ? 'D' : String(minutes);
  }
  applyTimeframeButton.disabled = true;
  timeframeHelp.textContent = 'Loading timeframe…';
  try {
    const actualTimeframe = await applyTimeframe(targetCell.chart, timeframe);
    syncChartControls();
    if (actualTimeframe !== timeframe) {
      timeframeHelp.textContent = `Timeframe change did not complete. The chart is still showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
      timeframeHelp.dataset.state = 'error';
    } else {
      timeframeHelp.textContent = `Showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
      delete timeframeHelp.dataset.state;
      customTimeframeMenu.open = false;
    }
  } catch (error) {
    syncChartControls();
    timeframeHelp.textContent = `Could not load timeframe: ${error instanceof Error ? error.message : String(error)}`;
    timeframeHelp.dataset.state = 'error';
  } finally {
    applyTimeframeButton.disabled = false;
  }
});

const replayMenu = document.getElementById('replay-menu') as HTMLDetailsElement;
const replayFrom = document.getElementById('replay-from') as HTMLInputElement;
const replaySpeed = document.getElementById('replay-speed') as HTMLSelectElement;
const replayStatus = document.getElementById('replay-status') as HTMLElement;
const replayStart = document.getElementById('replay-start') as HTMLButtonElement;
const replayStep = document.getElementById('replay-step') as HTMLButtonElement;
const replayPlayPause = document.getElementById('replay-play-pause') as HTMLButtonElement;
const replayStop = document.getElementById('replay-stop') as HTMLButtonElement;

function openReplayControls(): void {
  replayMenu.open = true;
  replayMenu.querySelector<HTMLElement>('summary')?.focus();
}

function localDateTimeInputValue(timestamp: number): string {
  const date = new Date(timestamp);
  const localTime = new Date(timestamp - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 16);
}

async function startReplayAt(from: number, cellId?: string): Promise<void> {
  if (!Number.isFinite(from)) {
    replayStatus.textContent = 'Choose a valid replay start date and time.';
    return;
  }
  replayFrom.value = localDateTimeInputValue(from);
  replayStart.disabled = true;
  replayStatus.textContent = 'Preparing replay…';
  replayActive = true;
  try {
    await workspace.replay.start(cellId ? { from, cell: cellId } : { from });
    replayStatus.textContent = 'Replay paused. Step through bars or start playback.';
  } catch (error) {
    replayStatus.textContent = `Could not start replay: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    replayActive = workspace.replay.state.active;
    replayStart.disabled = false;
    syncReplayControls();
  }
}

function syncReplayControls() {
  const state = workspace.replay.state;
  replayMenu.dataset.active = String(state.active);
  replayStep.disabled = !state.active || state.remaining === 0;
  replayPlayPause.disabled = !state.active || state.remaining === 0;
  replayPlayPause.textContent = state.playing ? 'Pause' : 'Play';
  replayStop.disabled = !state.active;
  if (state.active && state.cursorTime != null) {
    replayStatus.textContent = `${state.remaining} bars remaining · ${new Date(state.cursorTime).toLocaleString()}`;
  } else if (!replayStatus.textContent.startsWith('Could not')) {
    replayStatus.textContent = 'Choose a starting time, then start replay.';
  }
}

replayMenu.addEventListener('toggle', () => {
  if (!replayMenu.open || replayFrom.value) return;
  const bounds = workspace.replay.bounds;
  if (!bounds) {
    replayStatus.textContent = 'No replayable chart history is loaded yet.';
    return;
  }
  const timeframe = workspace.chart.market.timeframe ?? '60';
  const suggestedStart = Math.max(bounds.first, bounds.last - timeframeToMs(timeframe) * 50);
  replayFrom.value = localDateTimeInputValue(suggestedStart);
});
replayStart.addEventListener('click', async () => {
  const from = new Date(replayFrom.value).getTime();
  await startReplayAt(from);
});
replayStep.addEventListener('click', () => {
  if (!workspace.replay.step()) replayStatus.textContent = 'No more bars to replay.';
  syncReplayControls();
});
replayPlayPause.addEventListener('click', () => {
  const state = workspace.replay.state;
  if (state.playing) workspace.replay.pause();
  else workspace.replay.play(Number(replaySpeed.value));
  syncReplayControls();
});
replaySpeed.addEventListener('change', () => {
  if (workspace.replay.state.playing) {
    workspace.replay.play(Number(replaySpeed.value));
  }
});
replayStop.addEventListener('click', () => {
  replayActive = false;
  workspace.replay.stop();
  syncReplayControls();
});
for (const event of ['replay:start', 'replay:step', 'replay:play', 'replay:pause', 'replay:end'] as const) {
  workspace.replay.on(event, () => {
    replayActive = workspace.replay.state.active;
    syncReplayControls();
  });
}
syncReplayControls();
chartTypeSelect.addEventListener('change', () => {
  const cell = workspace.cell(workspace.active.id);
  if (!cell) return;
  void setChartStyle(cell, chartTypeSelect.value).then(() => {
    updateChartStyleHelp(cell, chartTypeSelect.value);
    syncChartControls();
  }).catch(error => {
    timeframeHelp.textContent = error instanceof Error ? error.message : String(error);
    timeframeHelp.dataset.state = 'error';
    syncChartControls();
  });
});
const marketChangeListeners = new Map<string, () => void>();
const loadedBarListeners = new Map<string, Array<() => void>>();
const loadedBarCounts = new Map<string, { loaded: number; target: number }>();
const loadedBarsLabel = document.getElementById('bottom-loaded-bars');
const barCountFormatter = new Intl.NumberFormat();

function renderLoadedBarCount(): void {
  if (!loadedBarsLabel) return;
  const cellId = workspace.active?.id;
  const entry = cellId ? loadedBarCounts.get(cellId) : undefined;
  if (!entry) {
    loadedBarsLabel.textContent = 'Bars: loading…';
    loadedBarsLabel.title = 'Chart history is loading.';
    return;
  }
  const loaded = barCountFormatter.format(entry.loaded);
  const target = Math.max(0, entry.target);
  loadedBarsLabel.textContent = target > entry.loaded
    ? `Bars: ${loaded} / ${barCountFormatter.format(target)}`
    : `Bars: ${loaded}`;
  loadedBarsLabel.title = `${loaded} chart bars loaded${target > entry.loaded ? ` of ${barCountFormatter.format(target)} requested` : ''}.`;
}

function setLoadedBarCount(cellId: string, loaded: number, target?: number): void {
  const safeLoaded = Math.max(0, Math.floor(loaded));
  const existing = loadedBarCounts.get(cellId);
  const chart = workspace.cell(cellId)?.chart;
  loadedBarCounts.set(cellId, {
    loaded: safeLoaded,
    target: Math.max(safeLoaded, Math.floor(target ?? existing?.target ?? chart?.market.bars ?? safeLoaded)),
  });
  if (workspace.active?.id === cellId) renderLoadedBarCount();
}

function watchCellLoadedBars(cellId: string): void {
  if (loadedBarListeners.has(cellId)) return;
  const cell = workspace.cell(cellId);
  if (!cell) return;
  const target = Math.max(0, Number(cell.chart.market.bars) || 0);
  setLoadedBarCount(cellId, 0, target);
  loadedBarListeners.set(cellId, [
    cell.chart.on('load:end', event => setLoadedBarCount(cellId, event.bars, Number(cell.chart.market.bars) || event.bars)),
    cell.chart.on('history:progress', event => setLoadedBarCount(cellId, event.loaded, event.target)),
    cell.chart.on('history:complete', event => setLoadedBarCount(cellId, event.barsLoaded, Number(cell.chart.market.bars) || event.barsLoaded)),
  ]);
}

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
  watchCellLoadedBars(cell.id);
}
workspace.on('cell:created', event => {
  watchCellMarketChanges(event.id);
  watchCellLoadedBars(event.id);
});
workspace.on('cell:destroyed', event => {
  marketChangeListeners.get(event.id)?.();
  marketChangeListeners.delete(event.id);
  loadedBarListeners.get(event.id)?.forEach(dispose => dispose());
  loadedBarListeners.delete(event.id);
  loadedBarCounts.delete(event.id);
  renderLoadedBarCount();
});
workspace.chart.on('priceStyle:change', event => {
  if (Array.from(chartTypeSelect.options).some(option => option.value === event.to)) {
    chartTypeSelect.value = event.to;
  }
});
workspace.on('cell:active', () => {
  syncChartControls();
  renderLoadedBarCount();
});
renderLoadedBarCount();
syncChartControls();

const chartLayoutSelect = document.getElementById('chart-layout-select') as HTMLSelectElement;
chartLayoutSelect.value = workspace.layout.id;
chartLayoutSelect.addEventListener('change', () => workspace.setLayout(chartLayoutSelect.value));
workspace.on('layout:changed', event => { chartLayoutSelect.value = event.layout; });

const chartGroupColorSelect = document.getElementById('chart-group-color') as HTMLSelectElement;
const chartGroupIndicator = document.getElementById('chart-group-indicator') as HTMLSpanElement | null;
const groupColorHex: Record<string, string> = { red: '#ef4444', blue: '#3b82f6', green: '#22c55e', yellow: '#eab308', purple: '#a855f7' };

function updateTopGroupIndicator(group: string) {
  // The compact top bar no longer renders a separate group swatch. Keep this
  // optional so its absence can never abort application startup and prevent all
  // following toolbar handlers (tabs, workspace, theme and settings) registering.
  if (!chartGroupIndicator) return;
  if (group && groupColorHex[group]) {
    chartGroupIndicator.style.backgroundColor = groupColorHex[group];
    chartGroupIndicator.style.border = 'none';
  } else {
    chartGroupIndicator.style.backgroundColor = 'transparent';
    chartGroupIndicator.style.border = '1px dashed #64748b';
  }
}

function paintCellGroup(cellId: string) {
  const group = groupByCellId[cellId] ?? '';
  const color = group ? (groupColorHex[group] ?? '') : '';
  const cell = workspace.cell(cellId);
  if (cell) {
    if (color) {
      cell.host.style.setProperty('--vela-cell-group-color', color);
      cell.host.dataset.groupColor = group;
    } else {
      cell.host.style.removeProperty('--vela-cell-group-color');
      delete cell.host.dataset.groupColor;
    }
  }
}

async function setCellGroup(cellId: string, newGroup: string) {
  const targetCell = workspace.cell(cellId);
  if (!targetCell) return;

  const oldGroup = groupByCellId[cellId] ?? '';
  groupByCellId[cellId] = newGroup;

  // When joining a color group, copy all settings from an existing chart in that group
  if (newGroup && newGroup !== oldGroup) {
    const existing = workspace.cells().find(c => c.id !== cellId && groupByCellId[c.id] === newGroup);
    if (existing) {
      // 1. Copy Asset (Symbol) ONLY — DO NOT copy timeframe! Each chart has its own timeframe.
      const sourceSymbol = existing.chart.market.symbol;
      if (sourceSymbol && sourceSymbol !== targetCell.chart.market.symbol) {
        await targetCell.chart.setMarket({
          symbol: sourceSymbol,
        });
      }

      // 2. Copy Chart Style & Renderer Config
      try {
        const sourceConfig = existing.chart.renderer.getConfig();
        if (sourceConfig) {
          targetCell.chart.renderer.applyConfig(sourceConfig);
        }
      } catch (err) {
        console.warn('Could not copy renderer config:', err);
      }

      // 3. Copy Indicators
      try {
        for (const ind of existing.chart.indicators()) {
          if (ind.source) {
            const existingInd = targetCell.chart.indicators().find(t => t.id === ind.id);
            if (existingInd) {
              if (existingInd.source !== ind.source) await existingInd.updateCode(ind.source);
            } else {
              await targetCell.chart.runIndicator(ind.source, {
                id: ind.id,
                language: 'pine',
                title: ind.title,
              });
            }
          } else if (ind.nativeType && !targetCell.chart.presentNativeIndicators().includes(ind.nativeType)) {
            targetCell.chart.addNativeIndicator(ind.nativeType);
          }
        }
        for (const targetInd of targetCell.chart.indicators()) {
          if (targetInd.source && !existing.chart.indicators().some(i => i.id === targetInd.id)) {
            targetInd.remove();
          } else if (targetInd.nativeType && !existing.chart.presentNativeIndicators().includes(targetInd.nativeType)) {
            targetInd.remove();
          }
        }
        // 4. Copy Drawings
        try {
          if (existing.chart.drawings) {
            const drawingsJson = existing.chart.drawings.toJSON();
            if (drawingsJson && Array.isArray(drawingsJson) && drawingsJson.length > 0) {
              targetCell.chart.drawings.fromJSON(drawingsJson);
            }
          }
        } catch (err) {
          console.warn('Could not copy drawings to grouped cell:', err);
        }
      } catch (err) {
        console.warn('Could not copy indicators to grouped cell:', err);
      }
    }
  }

  paintCellGroup(cellId);

  if (workspace.active?.id === cellId) {
    chartGroupColorSelect.value = newGroup;
    updateTopGroupIndicator(newGroup);
  }

  syncGroupSettings();
  cellControlsManager?.updateAll();
  persistCellGroupState();
  renderChartTabs();
}

function syncGroupSettings() {
  const syncGroups: Record<string, string> = {};
  for (const [id, grp] of Object.entries(groupByCellId)) {
    if (grp) syncGroups[id] = grp;
  }
  workspace.sync.set('symbol', syncGroups);
  workspace.sync.set('timeframe', false); // Never sync timeframe — charts keep independent timeframes
  workspace.sync.set('style', syncGroups);
  workspace.sync.set('drawings', syncGroups);
  if (propagatingGroupState) return;
  propagatingGroupState = true;
  try {
    const cells = workspace.cells();
    const groupedCells = new Map<string, typeof cells>();
    for (const cell of cells) {
      const group = groupByCellId[cell.id] ?? '';
      if (!group) continue;
      const members = groupedCells.get(group) ?? [];
      members.push(cell);
      groupedCells.set(group, members);
    }
    for (const members of groupedCells.values()) {
      const source = members.find(cell => cell.id === workspace.active?.id) ?? members[0];
      for (const target of members) {
        if (target.id === source.id) continue;
        for (const indicator of source.chart.indicators()) {
          if (indicator.source) {
            const existing = target.chart.indicators().find(item => item.id === indicator.id);
            if (existing) {
              if (existing.source !== indicator.source) void existing.updateCode(indicator.source);
            } else void target.chart.runIndicator(indicator.source, { id: indicator.id, language: 'pine', title: indicator.title });
          } else if (indicator.nativeType && !target.chart.presentNativeIndicators().includes(indicator.nativeType)) {
            target.chart.addNativeIndicator(indicator.nativeType);
          }
        }
        for (const indicator of target.chart.indicators()) {
          if (indicator.source && !source.chart.indicators().some(item => item.id === indicator.id)) indicator.remove();
          else if (indicator.nativeType && !source.chart.presentNativeIndicators().includes(indicator.nativeType)) indicator.remove();
        }
      }
    }
  } finally {
    propagatingGroupState = false;
  }
}

function persistCellGroupState() {
  workspace.context().stateChanged();
}

const cellControlsManager = new ChartCellControlsManager({
  getWorkspace: () => workspace,
  getGroupForCell: (cellId: string) => groupByCellId[cellId] ?? '',
  onSetCellGroup: (cellId: string, group: string) => setCellGroup(cellId, group),
});
chartGridHost.addEventListener('click', event => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const symbolButton = target.closest<HTMLElement>('.vela-widget-symbol, .vela-mb-symbol');
  if (!symbolButton) return;
  const activeCell = workspace.active;
  if (!activeCell) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  cellControlsManager.openSymbolPickerForCell(activeCell.id, symbolButton);
}, true);

function keyboardTargetAcceptsText(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"], .monaco-editor, [role="textbox"], button, [role="button"]'));
}

// Open the same Indicators action exposed in the chart top bar. Space remains
// available to text controls and buttons, where it has its normal native meaning.
document.addEventListener('keydown', event => {
  if (event.code !== 'Space' || event.repeat || event.altKey || event.ctrlKey || event.metaKey
    || keyboardTargetAcceptsText(event.target)) return;
  const indicatorsButton = [...document.querySelectorAll<HTMLButtonElement>('.vela-widget-action-left, .vela-widget-action')]
    .find(button => button.textContent?.trim() === 'Indicators');
  if (!indicatorsButton || indicatorsButton.disabled) return;
  event.preventDefault();
  indicatorsButton.click();
});

// Startup: default group is empty (no grouping) unless restored from profile
for (const cell of workspace.cells()) {
  const chartState = restoredWorkspaceState?.charts?.find((entry: { id: string }) => entry.id === cell.id);
  const savedGroup = chartState?.ext?.['vela.chartGroup'];
  groupByCellId[cell.id] = savedGroup && typeof savedGroup === 'object' && 'color' in savedGroup
    ? String(savedGroup.color)
    : '';
  paintCellGroup(cell.id);
  cellControlsManager.mountCell(cell.id);
}

const activeCellId = workspace.active?.id;
const initialGroup = activeCellId ? (groupByCellId[activeCellId] ?? '') : '';
chartGroupColorSelect.value = initialGroup;
updateTopGroupIndicator(initialGroup);

chartGroupColorSelect.addEventListener('change', () => {
  if (!workspace.active) return;
  void setCellGroup(workspace.active.id, chartGroupColorSelect.value);
});

workspace.on('cell:active', event => {
  const grp = groupByCellId[event.id] ?? '';
  chartGroupColorSelect.value = grp;
  updateTopGroupIndicator(grp);
  cellControlsManager.updateAll();
  syncGroupSettings();
});

workspace.on('cell:created', event => {
  groupByCellId[event.id] ??= '';
  paintCellGroup(event.id);
  cellControlsManager.mountCell(event.id);
  cellControlsManager.updateAll();
  syncGroupSettings();
});

workspace.on('cell:destroyed', event => {
  cellControlsManager.unmountCell(event.id);
  delete groupByCellId[event.id];
  cellControlsManager.updateAll();
  syncGroupSettings();
  renderChartTabs();
});

syncGroupSettings();
cellControlsManager.updateAll();

const chartTabsBar = document.getElementById('chart-tabs-bar') as HTMLElement;
const chartTabsList = document.getElementById('chart-tabs-list') as HTMLElement;
const chartTabsToggle = document.getElementById('chart-tabs-toggle') as HTMLButtonElement;
const chartTabsAdd = document.getElementById('chart-tabs-add') as HTMLButtonElement;

function chartTabTimeframe(timeframe: string | undefined): string {
  if (!timeframe) return '1h';
  if (timeframe === '60') return '1h';
  if (timeframe === 'D' || timeframe === '1D' || timeframe === '1440') return '1D';
  if (timeframe === 'W' || timeframe === '1W' || timeframe === '10080') return '1W';
  const minutes = Number(timeframe);
  return Number.isFinite(minutes) && minutes >= 60 && minutes % 60 === 0 ? `${minutes / 60}h` : timeframe;
}

function persistChartTabsPreference(): void {
  localStorage.setItem('omega_chart_tabs_enabled', String(chartTabsEnabled));
  localStorage.setItem('omega_chart_tabs_count', String(chartTabCount));
  localStorage.setItem('omega_chart_tabs_previous_layout', chartTabsPreviousLayout);
  workspace.context().stateChanged();
}

function renderChartTabs(): void {
  if (!chartTabsBar || !chartTabsList || !chartTabsToggle || !chartTabsAdd) return;
  const tabsMode = chartTabsEnabled && isChartTabsLayout(workspace.layout.id);
  chartTabsBar.hidden = !tabsMode;
  chartTabsToggle.setAttribute('aria-pressed', String(tabsMode));
  chartTabsToggle.classList.toggle('active', tabsMode);
  chartTabsToggle.textContent = tabsMode ? 'Hide tabs' : 'Chart tabs';
  chartLayoutSelect.disabled = tabsMode;
  chartLayoutSelect.title = tabsMode ? 'Disable Chart tabs to change the grid layout.' : '';
  chartGridHost.classList.toggle('omega-tabs-mode', tabsMode);

  for (const cell of workspace.cells()) {
    if (tabsMode && cell.id === workspace.active?.id) cell.host.dataset.omegaTabActive = 'true';
    else delete cell.host.dataset.omegaTabActive;
  }
  if (!tabsMode) {
    chartTabsList.replaceChildren();
    return;
  }

  const cells = workspace.cells().slice(0, chartTabCount);
  const fragment = document.createDocumentFragment();
  for (const [index, cell] of cells.entries()) {
    const tab = document.createElement('div');
    tab.className = 'chart-tab';
    tab.role = 'tab';
    const active = cell.id === workspace.active?.id;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const group = groupByCellId[cell.id] ?? '';
    tab.title = `Chart ${index + 1}: ${cell.chart.market.symbol || 'Chart'} · ${chartTabTimeframe(cell.chart.market.timeframe)}${group ? ` · ${group} group` : ''}`;
    const swatch = document.createElement('span');
    swatch.className = 'chart-tab-group';
    if (group && groupColorHex[group]) {
      swatch.style.backgroundColor = groupColorHex[group];
      swatch.style.borderStyle = 'solid';
      swatch.style.borderColor = groupColorHex[group];
    }
    const label = document.createElement('span');
    label.className = 'chart-tab-label';
    label.textContent = `${cell.chart.market.symbol || `Chart ${index + 1}`} · ${chartTabTimeframe(cell.chart.market.timeframe)}`;
    const activate = document.createElement('button');
    activate.className = 'chart-tab-activate';
    activate.type = 'button';
    activate.tabIndex = active ? 0 : -1;
    activate.append(swatch, label);
    activate.addEventListener('click', () => workspace.setActiveCell(cell.id));
    tab.append(activate);
    if (chartTabCount > 1) {
      const close = document.createElement('button');
      close.className = 'chart-tab-close';
      close.type = 'button';
      close.title = `Close chart ${index + 1}`;
      close.setAttribute('aria-label', `Close chart ${index + 1}`);
      close.textContent = '×';
      close.addEventListener('click', event => {
        event.stopPropagation();
        closeChartTab(cell.id);
      });
      tab.append(close);
    }
    fragment.append(tab);
  }
  chartTabsList.replaceChildren(fragment);
  chartTabsAdd.disabled = chartTabCount >= OMEGA_TABS_MAX;
  chartTabsAdd.title = chartTabsAdd.disabled ? 'Maximum of 8 chart tabs' : 'Open another chart tab';
}

function setChartTabsEnabled(enabled: boolean): void {
  if (enabled === chartTabsEnabled && (enabled ? isChartTabsLayout(workspace.layout.id) : !isChartTabsLayout(workspace.layout.id))) {
    renderChartTabs();
    return;
  }
  if (enabled) {
    if (!isChartTabsLayout(workspace.layout.id)) {
      chartTabsPreviousLayout = workspace.layout.id;
      chartTabCount = Math.max(chartTabCount, workspace.cells().length);
    }
    chartTabsEnabled = true;
    workspace.setLayout(chartTabsLayoutId(chartTabCount));
  } else {
    chartTabsEnabled = false;
    workspace.setLayout(chartTabsPreviousLayout || '1');
  }
  persistChartTabsPreference();
  renderChartTabs();
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function addChartTab(): void {
  if (!chartTabsEnabled) setChartTabsEnabled(true);
  if (chartTabCount >= OMEGA_TABS_MAX) return;
  chartTabCount += 1;
  workspace.setLayout(chartTabsLayoutId(chartTabCount));
  const cell = workspace.cells()[chartTabCount - 1];
  if (cell) workspace.setActiveCell(cell.id);
  persistChartTabsPreference();
  renderChartTabs();
}

function closeChartTab(cellId: string): void {
  if (!chartTabsEnabled || chartTabCount <= 1) return;
  const cells = workspace.cells();
  const closingCell = workspace.cell(cellId);
  const lastCell = cells[chartTabCount - 1];
  if (!closingCell || !lastCell) return;
  if (closingCell.id !== lastCell.id) workspace.swapCells(closingCell.id, lastCell.id);
  chartTabCount -= 1;
  workspace.setLayout(chartTabsLayoutId(chartTabCount));
  const nextActive = workspace.cells()[Math.min(cells.indexOf(closingCell), chartTabCount - 1)] ?? workspace.cells()[0];
  if (nextActive) workspace.setActiveCell(nextActive.id);
  persistChartTabsPreference();
  renderChartTabs();
}

chartTabsToggle.addEventListener('click', () => setChartTabsEnabled(!chartTabsEnabled));
chartTabsAdd.addEventListener('click', addChartTab);
workspace.on('cell:active', renderChartTabs);
workspace.on('cell:created', renderChartTabs);
renderChartTabs();

initializeVisualBacktest(
  workspace as any,
  () => {
    const originalCell = workspace.active;
    addChartTab();
    const testCell = workspace.active;
    if (!testCell || testCell.id === originalCell.id) return null;
    testCell.host.dataset.omegaVisualBacktest = 'true';
    renderChartTabs();
    return testCell as any;
  },
  () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('.vela-widget-action-left, .vela-widget-action')]
      .find(item => item.textContent?.trim() === 'Indicators');
    button?.click();
  },
  () => document.getElementById('editor-toggle-btn')?.click(),
);

function initializePaperTradeDrag() {
  const widget = document.getElementById('chart-paper-trade-controls');
  const handle = document.getElementById('paper-trade-drag-handle');
  const coordinateRoot = document.getElementById('app-container');
  if (!widget || !handle || !coordinateRoot) return;

  const STORAGE_KEY = 'omega-paper-trade-pos';
  const getCoordinateSpace = () => {
    const rect = coordinateRoot.getBoundingClientRect();
    return {
      left: rect.left,
      top: rect.top,
      scaleX: coordinateRoot.offsetWidth > 0 ? rect.width / coordinateRoot.offsetWidth : 1,
      scaleY: coordinateRoot.offsetHeight > 0 ? rect.height / coordinateRoot.offsetHeight : 1,
    };
  };
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      const pos = JSON.parse(saved);
      if (typeof pos.x === 'number' && typeof pos.y === 'number') {
        const { scaleX, scaleY } = getCoordinateSpace();
        const legacyPosition = pos.coordinateSpace !== 'app';
        widget.style.position = 'fixed';
        widget.style.left = `${legacyPosition ? pos.x / scaleX : pos.x}px`;
        widget.style.top = `${legacyPosition ? pos.y / scaleY : pos.y}px`;
        widget.style.transform = 'none';
      }
    } catch {}
  }

  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let scaleX = 1;
  let scaleY = 1;
  let initialLeft = 0;
  let initialTop = 0;
  let pointerId: number | null = null;

  const startDrag = (e: PointerEvent) => {
    const target = e.target;
    // The complete non-interactive part of the compact panel is a drag zone.
    // Do not hijack normal controls such as quantity, Buy, Sell or settings.
    if (target instanceof Element && target.closest('button, input, select, textarea, a, label')) return;
    if (e.button !== 0 || isDragging) return;
    isDragging = true;
    pointerId = e.pointerId;
    const rect = widget.getBoundingClientRect();
    const coordinateSpace = getCoordinateSpace();
    scaleX = coordinateSpace.scaleX || 1;
    scaleY = coordinateSpace.scaleY || 1;
    widget.style.position = 'fixed';
    widget.style.transform = 'none';
    initialLeft = (rect.left - coordinateSpace.left) / scaleX;
    initialTop = (rect.top - coordinateSpace.top) / scaleY;
    widget.style.left = `${initialLeft}px`;
    widget.style.top = `${initialTop}px`;
    startX = e.clientX;
    startY = e.clientY;
    try { widget.setPointerCapture(e.pointerId); } catch { /* global listeners below remain reliable */ }
    e.preventDefault();
    e.stopPropagation();
  };
  widget.addEventListener('pointerdown', startDrag);

  const moveDrag = (e: PointerEvent) => {
    if (!isDragging || e.pointerId !== pointerId) return;
    const coordinateSpace = getCoordinateSpace();
    const dx = (e.clientX - startX) / scaleX;
    const dy = (e.clientY - startY) / scaleY;
    const minLeft = (10 - coordinateSpace.left) / scaleX;
    const minTop = (40 - coordinateSpace.top) / scaleY;
    const maxLeft = (window.innerWidth - coordinateSpace.left) / scaleX - widget.offsetWidth - 10;
    const maxTop = (window.innerHeight - coordinateSpace.top) / scaleY - widget.offsetHeight - 10;
    const newLeft = Math.max(minLeft, Math.min(maxLeft, initialLeft + dx));
    const newTop = Math.max(minTop, Math.min(maxTop, initialTop + dy));
    widget.style.left = `${newLeft}px`;
    widget.style.top = `${newTop}px`;
    e.preventDefault();
  };

  const stopDrag = (e?: PointerEvent) => {
    if (!isDragging || (e && e.pointerId !== pointerId)) return;
    isDragging = false;
    if (pointerId !== null) {
      try { widget.releasePointerCapture(pointerId); } catch { /* pointer may already be released */ }
    }
    pointerId = null;
    const rect = widget.getBoundingClientRect();
    const coordinateSpace = getCoordinateSpace();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      x: (rect.left - coordinateSpace.left) / coordinateSpace.scaleX,
      y: (rect.top - coordinateSpace.top) / coordinateSpace.scaleY,
      coordinateSpace: 'app',
    }));
  };

  // Listen on the window rather than only on the handle. This remains reliable
  // through chart canvas interactions, lost pointer capture and multi-monitor drags.
  window.addEventListener('pointermove', moveDrag, { passive: false });
  window.addEventListener('pointerup', stopDrag);
  window.addEventListener('pointercancel', stopDrag);
  window.addEventListener('blur', () => stopDrag());
}

initializePaperTradeDrag();

async function runWorkspaceProfileAction(button: HTMLButtonElement, action: () => Promise<void>) {
  if (button.disabled) return;
  button.disabled = true;
  try {
    await action();
  } finally {
    button.disabled = false;
  }
}

document.getElementById('workspace-save-profile')!.addEventListener('click', async () => {
  const button = document.getElementById('workspace-save-profile') as HTMLButtonElement;
  await runWorkspaceProfileAction(button, async () => {
  const name = (document.getElementById('workspace-profile-name') as HTMLInputElement).value.trim();
  const state = JSON.stringify(workspace.getState());
  try {
    if (window.velaWorkspaceFiles) {
      const result = await window.velaWorkspaceFiles.saveProfile(name, state);
      if (result.canceled) {
        workspace.toast('Workspace save canceled.', 'info');
      } else {
        workspace.toast(`Workspace saved${result.path ? `: ${result.path}` : '.'}`, 'success');
      }
      return;
    }
    if (!name) { workspace.toast('Enter a workspace name first.', 'error'); return; }
    localStorage.setItem(`vela-profile:${name}`, state);
    workspace.toast(`Workspace "${name}" saved.`, 'success');
  } catch (error) {
    workspace.toast(error instanceof Error ? error.message : String(error), 'error');
  }
  });
});

document.getElementById('workspace-load-profile')!.addEventListener('click', async () => {
  const button = document.getElementById('workspace-load-profile') as HTMLButtonElement;
  await runWorkspaceProfileAction(button, async () => {
  try {
    if (window.velaWorkspaceFiles) {
      const result = await window.velaWorkspaceFiles.loadProfile();
      if (result.canceled) {
        workspace.toast('Workspace load canceled.', 'info');
      } else if (result.state) {
        applyWorkspaceState(ensureWorkspaceScriptLedger(JSON.parse(result.state)));
        workspace.toast(`Workspace loaded${result.path ? `: ${result.path}` : '.'}`, 'success');
      }
      return;
    }
    const name = (document.getElementById('workspace-profile-name') as HTMLInputElement).value.trim();
    const state = name ? localStorage.getItem(`vela-profile:${name}`) : null;
    if (!state) { workspace.toast('Workspace profile not found.', 'error'); return; }
    applyWorkspaceState(ensureWorkspaceScriptLedger(JSON.parse(state)));
  } catch (error) {
    workspace.toast(error instanceof Error ? error.message : String(error), 'error');
  }
  });
});

function applyWorkspaceState(state: unknown) {
  workspace.applyState(state);
  syncChartControls();
  chartLayoutSelect.value = workspace.layout.id;
}

function ensureWorkspaceScriptLedger(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { charts?: unknown }).charts)) return value;
  const document = value as { charts: unknown[] };
  return {
    ...document,
    charts: document.charts.map(chart => {
      if (!chart || typeof chart !== 'object' || Array.isArray(chart)) return chart;
      const entry = chart as { ext?: unknown };
      const ext = entry.ext && typeof entry.ext === 'object' && !Array.isArray(entry.ext)
        ? entry.ext as Record<string, unknown>
        : {};
      return {
        ...entry,
        ext: {
          ...ext,
          'omega.scriptIndicators': Array.isArray(ext['omega.scriptIndicators']) ? ext['omega.scriptIndicators'] : [],
        },
      };
    }),
  };
}

workspace.on('state:changed', () => {
  const state = workspace.getState();
  chartLayoutSelect.value = workspace.layout.id;
  void state;
});

const themeMenu = document.getElementById('theme-menu') as HTMLDetailsElement;
const themeChoices = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]'));

function updateThemeUI(theme: OmegaTheme) {
  const baseTheme = theme === 'high-contrast' ? 'light' : theme;
  document.documentElement.dataset.theme = baseTheme;
  document.body.dataset.theme = baseTheme;
  document.documentElement.dataset.themeVariant = theme === 'high-contrast' ? 'high-contrast' : '';
  document.body.dataset.themeVariant = theme === 'high-contrast' ? 'high-contrast' : '';
  document.documentElement.style.colorScheme = baseTheme;
  themeMenu.dataset.active = 'true';
  for (const choice of themeChoices) {
    const selected = choice.dataset.themeChoice === theme;
    choice.setAttribute('aria-checked', String(selected));
    choice.classList.toggle('selected', selected);
  }
  document.body.style.backgroundColor = 'var(--omega-bg)';
}

function setTheme(theme: OmegaTheme) {
  const changed = theme !== currentTheme;
  currentTheme = theme;
  localStorage.setItem('vela_theme', currentTheme);
  updateThemeUI(currentTheme);
  refreshMarketFlowStyles();
  try {
    workspace.setTheme(currentTheme === 'high-contrast' ? HIGH_CONTRAST_THEME : currentTheme);
  } catch (error) {
    console.error('Could not apply the selected theme to the chart workspace:', error);
  }
  try {
    setPineEditorTheme?.(currentTheme === 'dark' ? 'dark' : 'light');
  } catch (error) {
    console.error('Could not apply the selected theme to the Pine editor:', error);
  }
  if (changed) workspace.context().stateChanged();
}

updateThemeUI(currentTheme);
function selectThemeFromMenu(event: Event) {
  const target = event.target;
  const choice = target instanceof Element
    ? target.closest<HTMLButtonElement>('[data-theme-choice]')
    : null;
  if (!choice || !themeMenu.contains(choice)) return;
  event.preventDefault();
  event.stopPropagation();
  const themeChoice = choice.dataset.themeChoice;
  const theme: OmegaTheme = themeChoice === 'high-contrast' ? 'high-contrast' : themeChoice === 'light' ? 'light' : 'dark';
  setTheme(theme);
  themeMenu.open = false;
}
// Delegate from the menu instead of relying on individual popup buttons; this
// remains reliable when Electron retargets a click from a native <details> menu.
themeMenu.addEventListener('click', selectThemeFromMenu);

// Native <details> menus do not consistently close on an outside click across
// Electron versions, so make the toolbar menu behave like every other popup.
document.addEventListener('pointerdown', event => {
  if (themeMenu.open && event.target instanceof Node && !themeMenu.contains(event.target)) {
    themeMenu.open = false;
  }
}, true);
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && themeMenu.open) {
    themeMenu.open = false;
    (themeMenu.querySelector('summary') as HTMLElement | null)?.focus();
  }
});

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

document.getElementById('top-chart-settings')!.addEventListener('click', event => {
  event.preventDefault();
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
});

// Keep the chart's right-click menu useful for the actions traders reach for
// while working on the plot. These actions deliberately reuse the same paths as
// the toolbar and Settings, so there is one source of truth for each command.
registerWidgetAction({
  id: 'omega-context-cancel-pending-paper-order',
  target: 'context:body',
  label: 'Cancel pending paper order',
  order: -21,
  when: context => context.pointer?.paneKind === 'price'
    && Number.isFinite(context.pointer.price)
    && hasPendingPaperOrderAtPrice(context.chart, context.pointer?.price),
  run: context => {
    if (!cancelPendingPaperOrderAtPrice(context.chart, context.pointer?.price)) {
      context.toast('No pending paper order was found at that price.', 'error');
    }
  },
});
registerWidgetAction({
  id: 'omega-context-add-pending-paper-order',
  target: 'context:body',
  label: 'Add pending paper order…',
  order: -20,
  when: context => context.pointer?.paneKind === 'price'
    && Number.isFinite(context.pointer.price)
    && Number(context.pointer.price) > 0
    && Boolean(context.symbol)
    && Boolean(context.chart.data.resolve(context.symbol)),
  run: context => openPendingOrderDialog(context.chart, context.pointer?.price),
});
registerWidgetAction({
  id: 'omega-context-show-real-volumes',
  target: 'context:body',
  label: 'Show real volumes',
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
  order: 120,
  run: context => {
    context.chart.renderer.openSettings('Canvas');
  },
});
registerWidgetAction({
  id: 'omega-context-theme-light',
  target: 'context:body',
  label: 'Switch to Light theme',
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

// Electron keeps the main window hidden until all core UI wiring and the first
// workspace chart are ready, so users never see controls assembling in stages.
setStartupStatus('Loading charts and finalizing your workspace…');
let startupTimeout: number | undefined;
const startupReady = Promise.all(workspace.cells().map(async cell => {
  await cell.chart.ready();
  await cell.chart.historyComplete();
})).then(() => true).catch(error => {
  console.error('Chart startup readiness failed:', error);
  return false;
});
const fullStartupTimeout = new Promise<false>(resolve => {
  startupTimeout = window.setTimeout(() => resolve(false), 30_000);
});
const chartsReady = await Promise.race([startupReady, fullStartupTimeout]);
window.clearTimeout(startupTimeout);
if (!chartsReady) {
  setStartupStatus('Market data is still connecting. The platform will continue loading it in the background.');
  console.warn('The startup screen is closing while chart data continues to load.');
} else {
  setStartupStatus('Workspace ready');
}
await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
startupScreen?.setAttribute('data-state', 'leaving');
window.setTimeout(() => startupScreen?.remove(), 300);
window.velaApp?.ready();
