const { app, BrowserWindow, ipcMain, dialog, shell, screen, utilityProcess } = require('electron');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');

// Opt into high-DPI support before the app is ready so window frames, native
// menus, and renderer process scaling respect the Windows display scaling.
app.commandLine.appendSwitch('high-dpi-support', '1', 'true');
app.commandLine.appendSwitch('enable-monitor-feature-detection', '1', 'true');
const path = require('path');
const fsSync = require('node:fs');
const fs = require('fs/promises');
const { OrderJournal } = require('./order-journal.cjs');
const { Mt5Bridge, validateBarsRequest } = require('./mt5.cjs');
const { Mt5TickStreamSubscriptions } = require('./mt5-tick-streams.cjs');
const { submitMt5Order } = require('./live-orders.cjs');
const { IbkrBridge } = require('./ibkr.cjs');
const { CTraderMcpClient } = require('./ctrader-mcp.cjs');
const { SaxoBridge } = require('./saxo.cjs');
const { Mt5LiveOrderGate } = require('./live-order-gate.cjs');
const { buildBrokerTradingCapabilities } = require('./broker-capabilities.cjs');
const { SafeguardsSettingsStore } = require('./safeguards-settings.cjs');
const { AlpacaMarketData } = require('./alpaca.cjs');
const { searchYahooNews, safeNewsLink } = require('./news.cjs');
const { isTrustedAppDocument: isTrustedPageUrl } = require('./trusted-pages.cjs');
const { BetaTelemetry } = require('./beta-telemetry.cjs');
const { LocalAiAssistant } = require('./local-ai.cjs');
const { LlamaCppManager } = require('./llama-cpp.cjs');
const { createRuntimeCleanup } = require('./runtime-cleanup.cjs');
const { TickBarService } = require('./tick-bar-service.cjs');
const { createMarketDataWindow } = require('./market-data-window.cjs');

const devServerUrl = process.env.OMEGA_DEV_SERVER_URL || `http://127.0.0.1:${process.env.OMEGA_DEV_PORT || '5173'}`;
const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

let mainWindow = null;
let pineEditorWindow = null;
let indicatorBrowserWindow = null;
let indicatorBrowserTarget = 'main';
let visualBacktestWindow = null;
let splashWindow = null;
let startupFallbackTimer = null;
let activeBroker = null;
let alpacaOrderSession = null;
let alpacaSubmitting = false;
let brokerSdk = null;
let providerConnectionRevision = 0;
let diagnosticsWindow = null;
const diagnosticsEntries = [];
const DIAGNOSTICS_LIMIT = 2_000;
const DIAGNOSTICS_FILE_LIMIT = 10 * 1024 * 1024;
/** Identical events inside this window are counted instead of written. */
const DIAGNOSTIC_DEDUPE_MS = 60_000;
const diagnosticDedupe = new Map();
const diagnosticsFile = path.join(app.getPath('userData'), 'diagnostics.jsonl');
const diagnosticsReady = fs.readFile(diagnosticsFile, 'utf8').then(contents => {
  for (const line of contents.split(/\r?\n/).filter(Boolean).slice(-DIAGNOSTICS_LIMIT)) {
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry.time !== 'string') continue;
      diagnosticsEntries.push({
        time: boundedText(entry.time, 40),
        source: boundedText(entry.source, 32),
        type: boundedText(entry.type, 32),
        name: boundedText(entry.name, 120),
        target: boundedText(entry.target, 160),
        status: boundedText(entry.status, 16),
        message: boundedText(entry.message, 400),
        durationMs: Number.isFinite(entry.durationMs) ? Math.max(0, Math.round(entry.durationMs)) : undefined,
      });
    } catch (error) {
      console.warn('Skipping an invalid Omega diagnostic log entry:', error instanceof Error ? error.name : 'Unknown error');
    }
  }
  diagnosticsEntries.sort((left, right) => left.time.localeCompare(right.time));
}).catch(error => {
  if (error?.code !== 'ENOENT') console.error('Could not load the previous Omega diagnostic log:', error);
});
let diagnosticsWriteQueue = diagnosticsReady;
let orderJournal = null;
try {
  orderJournal = new OrderJournal({ directory: path.join(app.getPath('userData'), 'trading') });
} catch (error) {
  console.error('Could not open the Omega order journal:', error);
}
// Verify the order journal at boot: a corrupted or truncated tail must be reported before
// the operator relies on it, not discovered later while reconciling a bad trade.
if (orderJournal) {
  try {
    const integrity = orderJournal.verify();
    appendDiagnostic({
      source: 'electron-main',
      type: 'trading',
      name: 'order-journal-boot-check',
      status: integrity && integrity.ok === false ? 'error' : 'ok',
      message: JSON.stringify(integrity),
    });
  } catch (error) {
    appendDiagnostic({
      source: 'electron-main',
      type: 'trading',
      name: 'order-journal-boot-check',
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

const mt5BridgeScript = app.isPackaged
  ? path.join(process.resourcesPath, 'mt5_bridge.py')
  : path.join(__dirname, 'mt5_bridge.py');
const mt5 = new Mt5Bridge({ scriptPath: mt5BridgeScript });
const tickDataProviders = new Map([
  ['mt5', {
    getTicks: request => mt5.ticks(request),
    subscribeTicks: (ticker, onTicks) => mt5.subscribeTicks(ticker, onTicks),
  }],
]);
const tickBarSubscribers = new Map();
const tickBarService = new TickBarService({
  utilityProcess,
  scriptPath: path.join(__dirname, 'tick-bar-process.cjs'),
  fetchTicks: (provider, request) => {
    const adapter = tickDataProviders.get(provider);
    if (!adapter) throw new Error(`The ${provider || 'selected'} datafeed does not provide raw tick history.`);
    return adapter.getTicks(request);
  },
  onBar: (subscriptionId, bar) => {
    const subscriber = tickBarSubscribers.get(subscriptionId);
    if (subscriber && !subscriber.sender.isDestroyed()) {
      subscriber.sender.send('market-data:tick-bar-stream', { subscriptionId, bar });
    }
  },
});
const footprintTickWorker = new Worker(path.join(__dirname, 'footprint-tick-worker.cjs'), {
  workerData: { directory: path.join(app.getPath('userData'), 'footprint-ticks') },
});
let footprintRequestSequence = 0;
const pendingFootprintRequests = new Map();
footprintTickWorker.on('message', message => {
  if (message?.type === 'fetch-ticks') {
    mt5.ticks(message.request).then(
      ticks => footprintTickWorker.postMessage({ type: 'fetch-ticks-result', id: message.id, ticks }),
      error => footprintTickWorker.postMessage({
        type: 'fetch-ticks-result',
        id: message.id,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return;
  }
  if (message?.type !== 'profiles-result') return;
  const pending = pendingFootprintRequests.get(message.id);
  if (!pending) return;
  pendingFootprintRequests.delete(message.id);
  if (message.error) pending.reject(new Error(message.error));
  else pending.resolve(message.profiles);
});
footprintTickWorker.on('error', error => {
  for (const pending of pendingFootprintRequests.values()) pending.reject(error);
  pendingFootprintRequests.clear();
});
footprintTickWorker.on('exit', code => {
  if (code === 0) return;
  const error = new Error(`Footprint worker stopped unexpectedly (exit ${code}).`);
  for (const pending of pendingFootprintRequests.values()) pending.reject(error);
  pendingFootprintRequests.clear();
});
function requestFootprintProfiles(request) {
  footprintRequestSequence += 1;
  const id = `profiles-${footprintRequestSequence}`;
  return new Promise((resolve, reject) => {
    pendingFootprintRequests.set(id, { resolve, reject });
    footprintTickWorker.postMessage({ type: 'profiles-request', id, request });
  });
}
function requestFootprintLiveProfile(request) {
  footprintRequestSequence += 1;
  const id = `live-profile-${footprintRequestSequence}`;
  return new Promise((resolve, reject) => {
    pendingFootprintRequests.set(id, { resolve, reject });
    footprintTickWorker.postMessage({ type: 'live-profile-request', id, request });
  });
}
const localAiAssistant = new LocalAiAssistant({
  safeStorage: require('electron').safeStorage,
  storagePath: path.join(app.getPath('userData'), 'pine-ai-keys.json'),
  localConfigPath: path.join(app.getPath('userData'), 'pine-ai-local.json'),
});
const llamaCpp = new LlamaCppManager({
  configPath: path.join(app.getPath('userData'), 'llama-cpp.json'),
  runtimeDirectory: process.env.OMEGA_LLAMA_RUNTIME || 'D:\\PINESTUDIO\\llama-cuda12',
  modelDirectory: process.env.OMEGA_GGUF_DIRECTORY || 'D:\\Programy\\AI\\MODELY',
});
const mt5TickStreamSubscriptions = new Mt5TickStreamSubscriptions();
const tickBarStreamSubscriptions = new Mt5TickStreamSubscriptions();
const safeguardsSettings = new SafeguardsSettingsStore({ directory: path.join(app.getPath('userData'), 'trading') });
const mt5LiveOrderGate = new Mt5LiveOrderGate({
  getStatus: () => mt5.status(),
  submitOrder: (request, expectedAccount) => {
    const settings = safeguardsSettings.read().settings;
    return submitMt5Order({
      request,
      armed: true,
      expectedAccount,
      maxVolume: settings.maxMt5OrderVolume,
      mt5,
      journal: orderJournal,
    });
  },
});


const alpaca = new AlpacaMarketData({
  safeStorage: require('electron').safeStorage,
  storagePath: path.join(app.getPath('userData'), 'alpaca-market-data.json'),
});
const ibkr = new IbkrBridge();
const ctrader = new CTraderMcpClient();
const saxo = new SaxoBridge({ openExternal: url => shell.openExternal(url) });

// Fan Alpaca's native WebSocket bars into the trusted workspace renderer. The
// chart adapter subscribes per chart/timeframe and the main process keeps the
// provider credentials and socket isolated from the page.
alpaca.on('bar', bar => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('broker:market-bar', bar);
});

function boundedText(value, limit = 240) {
  return typeof value === 'string' ? value.replace(/[\r\n\t]+/g, ' ').slice(0, limit) : undefined;
}

function safeDiagnosticMessage(value) {
  if (typeof value !== 'string') return undefined;
  return boundedText(value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/((?:api[_ -]?(?:key|secret)|authorization|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*)["']?[^,\s"'&]+/gi, '$1[REDACTED]')
    .replace(/([?&](?:api[_-]?key|api[_-]?secret|token|access_token|refresh_token|signature|authorization)=)[^&\s]+/gi, '$1[REDACTED]'), 400);
}

function buildDiagnosticEntry(record) {
  return {
    time: new Date().toISOString(),
    source: boundedText(record?.source, 32) || 'app',
    type: boundedText(record?.type, 32) || 'event',
    name: boundedText(record?.name, 120),
    target: boundedText(record?.target, 160),
    status: boundedText(record?.status, 16),
    message: safeDiagnosticMessage(record?.message),
    durationMs: Number.isFinite(record?.durationMs) ? Math.max(0, Math.round(record.durationMs)) : undefined,
  };
}

// Collapse identical events. A disconnected feed used to emit one entry per poll, per
// chart, forever — which is how the diagnostics file grew without bound and how the
// console became unreadable. Repeats inside the window are counted, not written, and the
// next entry of that kind says how many were suppressed. Returns false when the entry is
// a repeat that should not be recorded.
function dedupeEntry(entry) {
  const dedupeKey = `${entry.source}|${entry.type}|${entry.name}|${entry.status}|${entry.message}`;
  const now = Date.now();
  const previous = diagnosticDedupe.get(dedupeKey);
  if (previous && now - previous.at < DIAGNOSTIC_DEDUPE_MS) {
    previous.suppressed += 1;
    return false;
  }
  const suppressed = previous ? previous.suppressed : 0;
  diagnosticDedupe.set(dedupeKey, { at: now, suppressed: 0 });
  while (diagnosticDedupe.size > 500) {
    const oldest = diagnosticDedupe.keys().next();
    if (oldest.done) break;
    diagnosticDedupe.delete(oldest.value);
  }
  if (suppressed > 0) {
    entry.message = `${entry.message} (repeated ${suppressed}× within ${Math.round(DIAGNOSTIC_DEDUPE_MS / 1000)}s)`;
  }
  return true;
}

// Rotates the diagnostics file to `.1` once it has reached its size limit.
async function rotateIfNeeded() {
  const current = await fs.stat(diagnosticsFile).catch(error => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!current || current.size < DIAGNOSTICS_FILE_LIMIT) return;
  const rotated = `${diagnosticsFile}.1`;
  await fs.rm(rotated, { force: true });
  await fs.rename(diagnosticsFile, rotated);
}

async function persistEntry(entry) {
  await fs.mkdir(path.dirname(diagnosticsFile), { recursive: true });
  await rotateIfNeeded();
  await fs.appendFile(diagnosticsFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

function appendDiagnostic(record, persist = true) {
  const entry = buildDiagnosticEntry(record);
  if (!dedupeEntry(entry)) return entry;
  diagnosticsEntries.push(entry);
  if (diagnosticsEntries.length > DIAGNOSTICS_LIMIT) diagnosticsEntries.splice(0, diagnosticsEntries.length - DIAGNOSTICS_LIMIT);
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) diagnosticsWindow.webContents.send('diagnostics:entry', entry);

  if (!persist) return entry;
  diagnosticsWriteQueue = diagnosticsWriteQueue
    .then(() => persistEntry(entry))
    .catch(error => {
      console.error('Could not persist Omega diagnostic event:', error);
    });
  return entry;
}

function appendFatalDiagnostic(record) {
  const entry = appendDiagnostic(record, false);
  try {
    fsSync.mkdirSync(path.dirname(diagnosticsFile), { recursive: true });
    fsSync.appendFileSync(diagnosticsFile, `${JSON.stringify(entry)}\n`, 'utf8');
  } catch (error) {
    console.error('Could not persist fatal Omega diagnostic event:', error);
  }
}

let betaTelemetry = new BetaTelemetry({
  baseUrl: process.env.OMEGA_BETA_TELEMETRY_URL,
  queuePath: path.join(app.getPath('userData'), 'beta-crash-queue.json'),
  getAccessToken: () => null,
  getConsent: () => false,
  appVersion: app.getVersion(),
  platform: process.platform,
});

function reportApplicationCrash(reason, error, stack) {
  void betaTelemetry.reportCrash({
    reason,
    error,
    stack,
    consoleEntries: diagnosticsEntries.slice(-200),
  }).then((result) => {
    if (result.status !== 'disabled' && result.status !== 'not-configured') {
      appendDiagnostic({
        source: 'electron-main',
        type: 'telemetry',
        name: 'crash-report',
        status: result.status,
        message: 'Crash report delivery result; no report content is logged.',
      });
    }
  }).catch(() => {
    appendDiagnostic({
      source: 'electron-main',
      type: 'telemetry',
      name: 'crash-report',
      status: 'error',
      message: 'Crash report delivery failed; trading operations were not affected.',
    });
  });
}

if (orderJournal) {
  const unresolved = orderJournal.openEntries();
  appendDiagnostic({
    source: 'electron-main',
    type: 'trading',
    name: 'order-journal',
    status: unresolved.length ? 'error' : 'ok',
    message: unresolved.length
      ? `${unresolved.length} unresolved order(s) require reconciliation in the connected broker before new orders.`
      : 'Order journal ready.',
  });
} else {
  appendDiagnostic({
    source: 'electron-main',
    type: 'trading',
    name: 'order-journal',
    status: 'error',
    message: 'Order journal unavailable; orders will not be durably recorded.',
  });
}

process.on('uncaughtExceptionMonitor', (error, origin) => {
  appendFatalDiagnostic({
    source: 'electron-main',
    type: 'process',
    name: 'uncaught-exception',
    status: 'error',
    message: `${origin}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
  });
});

// A bug in the main process must never take the whole platform down: log it and keep
// serving IPC, because order handling, the journal and every broker bridge live here.
process.on('uncaughtException', (error) => {
  appendFatalDiagnostic({
    source: 'electron-main',
    type: 'process',
    name: 'uncaught-exception-recovered',
    status: 'error',
    message: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
  reportApplicationCrash('main-process-uncaught-exception', error);
  console.error('Uncaught exception in the main process (kept alive):', error);
});

process.on('unhandledRejection', (reason) => {
  appendFatalDiagnostic({
    source: 'electron-main',
    type: 'process',
    name: 'unhandled-rejection',
    status: 'error',
    message: reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason),
  });
  reportApplicationCrash(
    'main-process-unhandled-rejection',
    reason instanceof Error ? reason : new Error(String(reason)),
  );
  console.error('Unhandled promise rejection in the main process:', reason);
});

function describeBarFetch(request, bars) {
  if (!request || typeof request !== 'object') return 'Invalid Alpaca history request metadata.';
  if (bars === null) return 'No bars returned: there is no active Alpaca history connection.';
  if (!Array.isArray(bars)) return `Invalid bars response: expected an array, received ${typeof bars}.`;
  const isoTime = value => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : 'invalid timestamp';
  };
  const symbol = typeof request.symbol === 'string' ? request.symbol.trim().toUpperCase() : 'unknown symbol';
  const timeframe = typeof request.timeframe === 'string' ? request.timeframe.trim() : 'unknown timeframe';
  const first = Number.isFinite(bars[0]?.time) ? isoTime(bars[0].time) : null;
  const lastBar = bars[bars.length - 1];
  const last = Number.isFinite(lastBar?.time) ? isoTime(lastBar.time) : null;
  const requestFrom = Number.isFinite(request.from) ? isoTime(request.from) : 'unspecified';
  const requestTo = Number.isFinite(request.to) ? isoTime(request.to) : 'unspecified';
  const returnedRange = first && last ? `, ${first} to ${last}` : '';
  return `${symbol} ${timeframe}: ${bars.length} bars for ${requestFrom} to ${requestTo}${returnedRange}`;
}

function createDiagnosticsWindow() {
  if (diagnosticsWindow && !diagnosticsWindow.isDestroyed()) {
    diagnosticsWindow.show();
    diagnosticsWindow.focus();
    return true;
  }

  const win = new BrowserWindow({
    width: 1040,
    height: 680,
    minWidth: 720,
    minHeight: 420,
    title: 'Omega Diagnostic Console',
    backgroundColor: '#101720',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  diagnosticsWindow = win;
  win.on('closed', () => {
    appendDiagnostic({ source: 'electron-main', type: 'window', name: 'diagnostics.closed' });
    if (diagnosticsWindow === win) diagnosticsWindow = null;
  });

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Omega Diagnostic Console</title>
  <style>
    :root{color-scheme:dark;font:13px/1.4 "Segoe UI",sans-serif;background:#101720;color:#e6edf5}
    *{box-sizing:border-box}body{margin:0;height:100vh;display:flex;flex-direction:column}
    header{display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid #2b3746;background:#17212e}
    h1{font-size:15px;margin:0}.hint{color:#9aabba;font-size:11px;flex:1}
    button{background:#26364a;color:#e6edf5;border:1px solid #43566e;border-radius:4px;padding:6px 10px;cursor:pointer}
    #rows{overflow:auto;flex:1;padding:6px 10px;font:12px/1.45 Consolas,monospace}
    .row{display:grid;grid-template-columns:155px 100px 115px 1fr;gap:10px;padding:4px 6px;border-bottom:1px solid #202c39;white-space:pre-wrap;overflow-wrap:anywhere}
    .time,.source{color:#93a7bd}.status{color:#7dd3a5}.error{color:#ff7b86}
    footer{padding:7px 12px;color:#9aabba;border-top:1px solid #2b3746;font-size:11px;overflow-wrap:anywhere}
  </style></head><body><header><h1>Omega Diagnostic Console</h1><span class="hint">Local clicks, dialogs, window lifecycle, and IPC method trace. Entries populate live in background.</span><button id="pause" title="Stop autoscrolling to inspect logs while new entries keep populating in background">Pause autoscroll</button><button id="bottom">Scroll to bottom</button></header><main id="rows" aria-live="polite"></main><footer id="location">Loading local log location…</footer>
  <script>
    const rows=document.getElementById('rows');let following=true;let bufferedWhilePaused=0;const pauseBtn=document.getElementById('pause');
    function updatePauseBtn(){pauseBtn.textContent=following?'Pause autoscroll':(bufferedWhilePaused>0?'Resume autoscroll (+'+bufferedWhilePaused+' new)':'Resume autoscroll (live)');pauseBtn.style.color=following?'#e6edf5':'#ffc107';}
    function add(entry){const row=document.createElement('div');row.className='row';const time=document.createElement('span');time.className='time';time.textContent=entry.time||'';const source=document.createElement('span');source.className='source';source.textContent=entry.source||'';const method=document.createElement('span');method.textContent=[entry.type,entry.name].filter(Boolean).join(' · ');const detail=document.createElement('span');detail.className=entry.status==='error'?'error':'status';detail.textContent=[entry.status,entry.target,entry.message,Number.isFinite(entry.durationMs)?entry.durationMs+' ms':''].filter(Boolean).join(' · ');row.append(time,source,method,detail);rows.append(row);if(following){rows.scrollTop=rows.scrollHeight}else{bufferedWhilePaused++;updatePauseBtn();}}
    pauseBtn.addEventListener('click',()=>{following=!following;if(following){bufferedWhilePaused=0;rows.scrollTop=rows.scrollHeight;}updatePauseBtn();});
    document.getElementById('bottom').addEventListener('click',()=>{following=true;bufferedWhilePaused=0;updatePauseBtn();rows.scrollTop=rows.scrollHeight;});
    window.velaDiagnostics.getRecent().then(result=>{result.entries.forEach(add);document.getElementById('location').textContent='Saved locally: '+result.file;});
    window.velaDiagnostics.onEntry(add);
  </script></body></html>`;
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  appendDiagnostic({ source: 'electron-main', type: 'window', name: 'diagnostics.open' });
  return true;
}

const originalIpcHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, listener) => originalIpcHandle(channel, async (...args) => {
  if (String(channel).startsWith('diagnostics:')) return listener(...args);
  const event = args[0];
  const source = event?.sender === mainWindow?.webContents
    ? 'main-window'
    : event?.sender === pineEditorWindow?.webContents ? 'pine-editor'
      : event?.sender === visualBacktestWindow?.webContents ? 'visual-backtest'
        : 'renderer';
  const startedAt = Date.now();
  appendDiagnostic({ source, type: 'method', name: String(channel), status: 'start' });
  try {
    const result = await listener(...args);
    const barFetch = channel === 'broker:fetch-bars';
    const emptyBars = barFetch && (!Array.isArray(result) || result.length === 0);
    appendDiagnostic({
      source: 'electron-main',
      type: 'method',
      name: String(channel),
      status: emptyBars ? 'empty' : 'ok',
      message: barFetch ? describeBarFetch(args[1], result) : undefined,
      durationMs: Date.now() - startedAt,
    });
    return result;
  } catch (error) {
    appendDiagnostic({
      source: 'electron-main',
      type: 'method',
      name: String(channel),
      status: 'error',
      message: error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error',
      durationMs: Date.now() - startedAt,
    });
    throw error;
  }
});

ipcMain.on('diagnostics:event', (event, record) => {
  const trusted = [mainWindow, pineEditorWindow, visualBacktestWindow, diagnosticsWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trusted || event.senderFrame !== event.sender.mainFrame) return;
  appendDiagnostic(record);
});

ipcMain.handle('diagnostics:get-recent', async (event) => {
  const trusted = [mainWindow, pineEditorWindow, visualBacktestWindow, diagnosticsWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trusted || event.senderFrame !== event.sender.mainFrame) throw new Error('Diagnostics are available only to Omega windows.');
  await diagnosticsReady;
  return { entries: diagnosticsEntries, file: diagnosticsFile };
});

ipcMain.handle('diagnostics:open', (event) => {
  const trusted = [mainWindow, pineEditorWindow, visualBacktestWindow].some(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trusted || event.senderFrame !== event.sender.mainFrame) throw new Error('Diagnostics are available only to Omega windows.');
  return createDiagnosticsWindow();
});

app.on('browser-window-created', (_event, window) => {
  const title = window.getTitle() || 'Untitled window';
  appendDiagnostic({ source: 'electron-main', type: 'window', name: `created: ${title}` });
  for (const eventName of ['show', 'hide', 'focus', 'blur', 'minimize', 'restore', 'maximize', 'unmaximize', 'close']) {
    window.on(eventName, () => appendDiagnostic({
      source: 'electron-main',
      type: 'window',
      name: `${eventName}: ${title}`,
    }));
  }
  window.on('closed', () => appendDiagnostic({
    source: 'electron-main',
    type: 'window',
    name: `closed: ${title}`,
  }));
  window.on('unresponsive', () => appendDiagnostic({
    source: 'electron-main',
    type: 'window',
    name: `unresponsive: ${title}`,
    status: 'error',
  }));
  window.on('responsive', () => appendDiagnostic({
    source: 'electron-main',
    type: 'window',
    name: `responsive: ${title}`,
    status: 'ok',
  }));
  const rendererRecoveryTimes = [];
  window.webContents.on('render-process-gone', (_event, details) => {
    appendDiagnostic({
      source: 'electron-main',
      type: 'process',
      name: `renderer-gone: ${title}`,
      status: 'error',
      message: `reason=${details.reason}; exitCode=${details.exitCode}`,
    });
    reportApplicationCrash(
      'renderer-process-gone',
      new Error(`Renderer exited: reason=${details.reason}; exitCode=${details.exitCode}`),
    );
    // A dead renderer must not stay a dead window. Reload it, but bound the retries so a
    // renderer that always crashes cannot spin forever in a reload loop.
    const now = Date.now();
    rendererRecoveryTimes.push(now);
    while (rendererRecoveryTimes.length && now - rendererRecoveryTimes[0] > 60_000) rendererRecoveryTimes.shift();
    if (rendererRecoveryTimes.length > 3) {
      appendDiagnostic({
        source: 'electron-main',
        type: 'process',
        name: `renderer-recovery-abandoned: ${title}`,
        status: 'error',
        message: 'Renderer crashed more than three times in a minute; reloads were stopped to avoid a loop.',
      });
      return;
    }
    setTimeout(() => {
      if (!window.isDestroyed()) window.webContents.reload();
    }, 500);
  });
});

function getBrokerSdk() {
  brokerSdk ??= require('@luxalgo/broker-sdk');
  return brokerSdk;
}

async function disconnectAllConnections() {
  const revision = ++providerConnectionRevision;
  mt5LiveOrderGate.disarm();
  activeBroker = null;
  alpacaOrderSession = null;
  mt5TickStreamSubscriptions.stopAll();
  const disconnectors = [
    ['MetaTrader 5', () => mt5.disconnect()],
    ['Alpaca', () => alpaca.disconnect()],
    ['Interactive Brokers', () => ibkr.disconnect()],
    ['cTrader', () => ctrader.disconnect()],
    ['Saxo', () => saxo.disconnect()],
  ];
  const results = await Promise.allSettled(disconnectors.map(([, disconnect]) => disconnect()));
  const failures = results.flatMap((result, index) => {
    if (result.status === 'fulfilled') return [];
    const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
    appendDiagnostic({
      source: 'electron-main',
      type: 'lifecycle',
      name: `${disconnectors[index][0]} disconnect`,
      status: 'error',
      message: error.message,
    });
    return [error];
  });
  if (failures.length) throw new AggregateError(failures, 'One or more market-data providers could not disconnect cleanly.');
  return revision;
}

function createCleanupRuntime() {
  return createRuntimeCleanup({
    stopLocalModels: () => llamaCpp.stopAll(),
    cancelAiCompletions: () => localAiAssistant.cancelAllCompletions(),
    disconnectProviders: disconnectAllConnections,
  });
}
let cleanupRuntime = createCleanupRuntime();

function isTrustedAppDocument(rawUrl) {
  return isTrustedPageUrl(rawUrl, {
    devServerUrl,
    distDirectory: path.join(__dirname, '../dist'),
  });
}

function assertTrustedBrokerRequest(event) {
  const trustedWindow = [mainWindow, pineEditorWindow, visualBacktestWindow].find(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trustedWindow || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Broker access is available only to the application window.');
  }
  if (!isTrustedAppDocument(event.senderFrame.url)) throw new Error('Broker access is blocked for this page.');
}

function assertTrustedWorkspaceRequest(event) {
  assertTrustedBrokerRequest(event);
}

function assertTrustedPineEditorRequest(event) {
  const trustedWindow = [mainWindow, indicatorBrowserWindow]
    .find(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trustedWindow || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Pine Editor actions are available only from an application window.');
  }
  if (!isTrustedAppDocument(event.senderFrame.url)) throw new Error('Pine Editor actions are blocked for this page.');
}

function observeRendererProcess(window, name) {
  window.webContents.on('did-finish-load', () => {
    const pid = window.webContents.getOSProcessId();
    appendDiagnostic({ source: 'electron-main', type: 'process', name, status: 'ok', message: `PID ${pid}` });
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    appendDiagnostic({ source: 'electron-main', type: 'process', name, status: 'error', message: details.reason });
  });
}

function toolWindowPreferences(name) {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    additionalArguments: [`--omega-process-name=${name}`],
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
  };
}

const marketDataWindow = createMarketDataWindow({ BrowserWindow, ipcMain, devServerUrl, isDev, observeProcess: observeRendererProcess });

ipcMain.handle('market-history:load', (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (event.sender !== mainWindow?.webContents && event.sender !== visualBacktestWindow?.webContents) {
    throw new Error('Market history is available only to chart windows.');
  }
  return marketDataWindow.load(event.sender, request);
});

function assertTrustedHistoryRequest(event) {
  if (!marketDataWindow.isRunner(event)) assertTrustedBrokerRequest(event);
}

function dialogOwnerFor(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && !senderWindow.isDestroyed()) return senderWindow;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

// Parses a workspace JSON document and enforces its shape. Throws a JSON parse
// error or the caller-supplied message when the document is not a version 1
// workspace with a charts array. Returns the parsed object.
function validateWorkspaceDocument(state, invalidMessage) {
  const parsed = JSON.parse(state);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.charts)) {
    throw new Error(invalidMessage);
  }
  return parsed;
}

function workspaceFileName(name) {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'omega-workspace';
}

const omegaWorkspaceDirectory = () => path.join(app.getPath('userData'), 'Workspace');
const userWorkspacesDirectory = () => path.join(omegaWorkspaceDirectory(), 'User_Workspaces');
const defaultWorkspaceProfilePath = () => path.join(app.getAppPath(), 'User_Workspaces', 'default.json');
const workspaceStatePath = () => path.join(app.getPath('userData'), 'workspace.json');

async function loadWorkspaceState() {
  const target = workspaceStatePath();
  try {
    return await fs.readFile(target, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  const legacy = path.join(app.getPath('appData'), 'vela-desktop-app', 'workspace.json');
  if (legacy === target) return null;
  try {
    const state = await fs.readFile(legacy, 'utf8');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(legacy, target, fs.constants.COPYFILE_EXCL).catch(async (error) => {
      if (!error || error.code !== 'EEXIST') throw error;
      await fs.access(target);
    });
    return state;
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }

  let defaultState;
  try {
    defaultState = await fs.readFile(defaultWorkspaceProfilePath(), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  validateWorkspaceDocument(defaultState, 'The bundled default workspace is invalid.');
  await fs.mkdir(userWorkspacesDirectory(), { recursive: true });
  const userDefaultProfile = path.join(userWorkspacesDirectory(), 'default.json');
  await fs.copyFile(defaultWorkspaceProfilePath(), userDefaultProfile, fs.constants.COPYFILE_EXCL).catch(async (error) => {
    if (!error || error.code !== 'EEXIST') throw error;
    await fs.access(userDefaultProfile);
  });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(defaultWorkspaceProfilePath(), target, fs.constants.COPYFILE_EXCL).catch(async (error) => {
    if (!error || error.code !== 'EEXIST') throw error;
    await fs.access(target);
  });
  return defaultState;
}

ipcMain.handle('ai:providers', async event => { assertTrustedBrokerRequest(event); return localAiAssistant.configuredProviders(); });
ipcMain.handle('ai:save-key', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.saveKey(request?.provider, request?.apiKey);
});
ipcMain.handle('ai:clear-key', async (event, provider) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.clearKey(provider);
});
ipcMain.handle('ai:test-key', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.testKey(request?.provider, request?.apiKey);
});
ipcMain.handle('ai:local-config', async event => { assertTrustedBrokerRequest(event); return localAiAssistant.localConfig(); });
ipcMain.handle('ai:save-local-config', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.saveLocalConfig(request);
});
ipcMain.handle('ai:test-local-config', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.testLocalConfig(request);
});
ipcMain.handle('ai:ollama-run-model', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.runOllamaModel(request);
});
ipcMain.handle('ai:ollama-unload-model', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.unloadOllamaModel(request);
});
ipcMain.handle('ai:complete', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.complete(request);
});
ipcMain.handle('ai:cancel-completion', (event, requestId) => {
  assertTrustedBrokerRequest(event);
  return localAiAssistant.cancelCompletion(requestId);
});
ipcMain.handle('ai:llama-models', event => { assertTrustedBrokerRequest(event); return llamaCpp.listModels(); });
ipcMain.handle('ai:llama-status', async event => { assertTrustedBrokerRequest(event); return llamaCpp.status(); });
ipcMain.handle('ai:llama-start', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return llamaCpp.start(request?.role, request?.modelPath);
});
ipcMain.handle('ai:llama-stop', async (event, role) => { assertTrustedBrokerRequest(event); return llamaCpp.stop(role); });
ipcMain.handle('ai:llama-complete', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return llamaCpp.complete(request?.role, request);
});
ipcMain.handle('ai:llama-choose-folder', async event => {
  assertTrustedBrokerRequest(event);
  const owner = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(owner, { title: 'Choose the GGUF model folder', properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths[0]) return null;
  llamaCpp.saveModelDirectory(result.filePaths[0]);
  return llamaCpp.listModels();
});

ipcMain.handle('workspace:load', async (event) => {
  assertTrustedWorkspaceRequest(event);
  return loadWorkspaceState();
});

ipcMain.handle('workspace:save', async (event, state) => {
  assertTrustedWorkspaceRequest(event);
  if (typeof state !== 'string' || state.length > 25_000_000) throw new Error('Invalid workspace state.');
  validateWorkspaceDocument(state, 'Invalid workspace document.');
  await fs.mkdir(app.getPath('userData'), { recursive: true });
  const target = workspaceStatePath();
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, state, 'utf8');
  await fs.rename(temporary, target);
});

ipcMain.handle('workspace:save-profile', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (!request || typeof request.state !== 'string' || request.state.length > 25_000_000) throw new Error('Invalid workspace state.');
  const name = typeof request.name === 'string' ? request.name.trim().slice(0, 80) : '';
  await fs.mkdir(userWorkspacesDirectory(), { recursive: true });
  const result = await dialog.showSaveDialog(dialogOwnerFor(event), {
    title: 'Save Chart Workspace',
    defaultPath: path.join(userWorkspacesDirectory(), `${workspaceFileName(name)}.json`),
    filters: [{ name: 'Omega workspace', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  validateWorkspaceDocument(request.state, 'Invalid workspace document.');
  await fs.writeFile(result.filePath, request.state, 'utf8');
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('workspace:load-profile', async (event) => {
  assertTrustedWorkspaceRequest(event);
  await fs.mkdir(userWorkspacesDirectory(), { recursive: true });
  const result = await dialog.showOpenDialog(dialogOwnerFor(event), {
    title: 'Load Chart Workspace',
    defaultPath: userWorkspacesDirectory(),
    properties: ['openFile'],
    filters: [{ name: 'Omega workspace', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const state = await fs.readFile(result.filePaths[0], 'utf8');
  validateWorkspaceDocument(state, 'Selected file is not a valid Vela workspace.');
  return { canceled: false, state, path: result.filePaths[0] };
});

ipcMain.handle('pine:export', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (!request || typeof request.source !== 'string' || request.source.length > 2_000_000) {
    throw new Error('Invalid Pine script.');
  }
  const name = typeof request.name === 'string' ? request.name.trim().slice(0, 160) : 'pine-script';
  const result = await dialog.showSaveDialog(dialogOwnerFor(event), {
    title: 'Export Pine Script',
    defaultPath: `${workspaceFileName(name)}.pine`,
    filters: [{ name: 'Pine Script', extensions: ['pine'] }, { name: 'Text file', extensions: ['txt'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  await fs.writeFile(result.filePath, request.source, 'utf8');
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('news:search', async (event, symbol) => {
  assertTrustedWorkspaceRequest(event);
  return searchYahooNews(symbol);
});

ipcMain.handle('news:open', async (event, target) => {
  assertTrustedWorkspaceRequest(event);
  const url = safeNewsLink(target);
  if (!url) throw new Error('The news link is not a valid secure URL.');
  await shell.openExternal(url);
  return true;
});

function toBrokerSnapshot(snapshot) {
  return {
    broker: snapshot.broker,
    fetchedAt: snapshot.fetchedAt,
    accounts: snapshot.accounts.map((account) => ({
      name: account.name,
      currency: account.currency,
      equity: account.equity,
      cash: account.cash,
      environment: account.environment,
      positions: account.positions.map((position) => ({
        symbol: position.symbol,
        quantity: position.quantity,
        marketValue: position.marketValue,
        assetClass: position.assetClass,
      })),
    })),
  };
}

ipcMain.handle('broker:list', (event) => {
  assertTrustedBrokerRequest(event);
  return [...getBrokerSdk().listBrokers().filter(({ id }) => id === 'alpaca').map(({ id, displayName, credentials, readOnlySetup }) => ({
    id,
    displayName,
    credentials,
    readOnlySetup,
  }))];
});

ipcMain.handle('safeguards:get', (event) => {
  assertTrustedBrokerRequest(event);
  const { settings, source } = safeguardsSettings.read();
  return {
    settings,
    source,
    mt5Binding: mt5LiveOrderGate.binding(),
    hardGuards: [
      `MT5 live orders are capped at ${settings.maxMt5OrderVolume} lots per order.`,
      'Every MT5 live order requires a stop-loss and explicit account-bound session arming.',
      'Chart orders require confirmation; duplicate intents and unresolved journal entries are blocked.',
      'Live orders are blocked if the durable order journal is missing or fails integrity checks.',
    ],
    providers: buildBrokerTradingCapabilities(getBrokerSdk().listBrokers()),
  };
});

ipcMain.handle('safeguards:save', (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Enter valid safeguards settings.');
  }
  const settings = safeguardsSettings.write({
    maxMt5OrderVolume: request.maxMt5OrderVolume,
    maxSdkOrderNotional: request.maxSdkOrderNotional,
  });
  return { settings, source: 'stored', armed: Boolean(mt5LiveOrderGate.binding()) };
});

ipcMain.handle('broker:connect-read-only', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request.brokerId !== 'string' || !request.credentials || typeof request.credentials !== 'object') {
    throw new Error('Choose a broker and enter its required credentials.');
  }
  if (request.brokerId !== 'alpaca') throw new Error('Only Alpaca read-only account access is available through the Broker SDK.');
  const sdk = getBrokerSdk();
  const brokerInfo = sdk.listBrokers().find(({ id }) => id === request.brokerId);
  if (!brokerInfo) throw new Error('That broker is not supported by the installed SDK.');

  const suppliedCredentials = { ...request.credentials };
  if (request.brokerId === 'alpaca') {
    const apiKey = suppliedCredentials.apiKey;
    const apiSecret = suppliedCredentials.apiSecret;
    if (!apiKey && !apiSecret) {
      const saved = await alpaca.readBrokerCredentials();
      if (!saved) throw new Error('Enter and save the Alpaca API key ID and secret key first.');
      Object.assign(suppliedCredentials, saved);
    } else if (typeof apiKey !== 'string' || typeof apiSecret !== 'string' || !apiKey.trim() || !apiSecret.trim()) {
      throw new Error('Enter both Alpaca API credentials, or leave both blank to use the saved encrypted credentials.');
    }
  }

  const credentials = {};
  for (const field of brokerInfo.credentials) {
    const value = suppliedCredentials[field.key];
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
      throw new Error(`Enter a valid value for ${field.label}.`);
    }
    credentials[field.key] = value.trim();
  }

  const revision = await disconnectAllConnections();
  if (revision !== providerConnectionRevision) throw new Error('Broker connection was superseded by a newer provider request.');
  const connection = sdk.connect({ broker: brokerInfo.id, credentials });
  const snapshot = await connection.fetchSnapshot();
  if (revision !== providerConnectionRevision) throw new Error('Broker connection was superseded by a newer provider request.');
  if (brokerInfo.id === 'alpaca') {
    try {
      await alpaca.connect({ keyId: credentials.apiKey, secretKey: credentials.apiSecret });
    } catch (error) {
      // Keep the Broker SDK history/account connection usable if the optional
      // market-data WebSocket is unavailable. The chart adapter falls back to
      // its cancellable REST refresh loop when a stream subscription fails.
      console.warn('Alpaca live market stream unavailable; retaining Broker SDK history:', error instanceof Error ? error.message : String(error));
    }
    if (revision !== providerConnectionRevision) {
      await alpaca.disconnect();
      throw new Error('Broker connection was superseded by a newer provider request.');
    }
  }
  activeBroker = connection;
  const account = snapshot.accounts[0];
  if (snapshot.accounts.length === 1 && (account.environment === 'live' || account.environment === 'paper')) {
    alpacaOrderSession = { credentials, accountName: account.name, environment: account.environment };
  }
  return toBrokerSnapshot(snapshot);
});

ipcMain.handle('broker:place-alpaca-order', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (event.sender !== mainWindow?.webContents) throw new Error('Open the Alpaca order form in the main window.');
  const session = alpacaOrderSession;
  if (!session) throw new Error('Connect an Alpaca account with a verified paper or live environment first.');
  if (alpacaSubmitting) throw new Error('Another Alpaca order is already being reviewed.');
  const { symbol, side, notional } = request ?? {};
  if (typeof symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,19}$/.test(symbol)
    || !['buy', 'sell'].includes(side) || typeof notional !== 'number'
    || !Number.isFinite(notional) || notional <= 0) throw new Error('Enter a valid Alpaca symbol, side and dollar amount.');
  const validateNotional = () => {
    const max = safeguardsSettings.read().settings.maxSdkOrderNotional;
    if (notional > max) throw new Error(`Alpaca order amount exceeds the configured USD limit of ${max}.`);
  };
  validateNotional();
  alpacaSubmitting = true;
  try {
    const { connectTrading, LIVE_TRADING_ACKNOWLEDGEMENT } = require('@luxalgo/broker-sdk/orders');
    const live = session.environment === 'live';
    const confirmation = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Confirm Alpaca order',
      message: `Alpaca ${session.environment.toUpperCase()} · ${side.toUpperCase()} USD ${notional} of ${symbol}`,
      detail: `Account: ${session.accountName}. This market order has no attached stop-loss or take-profit.`,
      buttons: ['Cancel', live ? LIVE_TRADING_ACKNOWLEDGEMENT : 'Submit paper order'],
      defaultId: 0,
      cancelId: 0,
    });
    if (confirmation.response !== 1) return null;
    if (session !== alpacaOrderSession) throw new Error('The connected Alpaca account changed while confirming.');
    validateNotional();
    const trading = connectTrading({
      broker: 'alpaca',
      credentials: session.credentials,
      acknowledgeLiveTrading: live ? LIVE_TRADING_ACKNOWLEDGEMENT : undefined,
    });
    if (trading.environment !== session.environment) throw new Error('The Alpaca trading environment does not match the connected account.');
    return await trading.placeOrder({
      symbol, side, notional, type: 'market', clientOrderId: require('node:crypto').randomUUID(),
    });
  } finally {
    alpacaSubmitting = false;
  }
});

ipcMain.handle('broker:save-alpaca-credentials', async (event, credentials) => {
  assertTrustedBrokerRequest(event);
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) throw new Error('Enter valid Alpaca credentials.');
  return alpaca.saveBrokerCredentials(credentials);
});

ipcMain.handle('broker:has-saved-alpaca-credentials', async (event) => {
  assertTrustedBrokerRequest(event);
  return (await alpaca.status()).configured;
});

ipcMain.handle('ctrader:order-journal', (event) => {
  assertTrustedBrokerRequest(event);
  if (!orderJournal) {
    return { available: false, file: null, entries: [], open: [], integrity: { ok: false } };
  }
  return {
    available: true,
    file: orderJournal.file,
    entries: orderJournal.recent(100),
    open: orderJournal.openEntries(),
    integrity: orderJournal.verify(),
  };
});

ipcMain.handle('ctrader:resolve-order-intent', (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!orderJournal) throw new Error('The order journal is unavailable.');
  if (!request || typeof request.id !== 'string' || !request.id.trim()) {
    throw new Error('Choose a journaled order to resolve.');
  }
  const note = typeof request.note === 'string' ? request.note.slice(0, 500) : '';
  return orderJournal.resolve(request.id.trim(), { note });
});

ipcMain.handle('broker:fetch-snapshot', async (event) => {
  assertTrustedBrokerRequest(event);
  if (!activeBroker) throw new Error('Connect to a broker first.');
  return toBrokerSnapshot(await activeBroker.fetchSnapshot());
});

ipcMain.handle('broker:alpaca-quote', async (event, ticker) => {
  assertTrustedBrokerRequest(event);
  const session = alpacaOrderSession;
  if (!session || activeBroker?.broker !== 'alpaca') return null;
  if (typeof ticker !== 'string' || !/^[A-Z][A-Z0-9.-]{0,19}$/.test(ticker)) {
    throw new Error('Enter a valid Alpaca stock ticker.');
  }
  const url = new URL(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/quotes/latest`);
  url.searchParams.set('feed', 'iex');
  const response = await fetch(url, {
    headers: { 'APCA-API-KEY-ID': session.credentials.apiKey, 'APCA-API-SECRET-KEY': session.credentials.apiSecret },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`Alpaca quote request failed (${response.status}).`);
  const result = await response.json();
  if (session !== alpacaOrderSession || result.symbol !== ticker || !result.quote) return null;
  return { bid: result.quote.bp, ask: result.quote.ap, timeMsc: Date.parse(result.quote.t) };
});

ipcMain.handle('broker:fetch-bars', async (event, request) => {
  assertTrustedHistoryRequest(event);
  if (!activeBroker || activeBroker.broker !== 'alpaca' || typeof activeBroker.fetchBars !== 'function') return null;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid Alpaca history request.');
  }
  if (typeof request.symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,19}$/i.test(request.symbol.trim())) {
    throw new Error('Enter a valid Alpaca stock ticker.');
  }
  const timeframes = { '1': '1m', '1m': '1m', '5': '5m', '5m': '5m', '15': '15m', '15m': '15m', '60': '1h', '1h': '1h', D: '1d', '1D': '1d', '1d': '1d' };
  const timeframe = timeframes[String(request.timeframe).trim()];
  if (!timeframe) throw new Error(`The Alpaca Broker SDK does not support "${request.timeframe}" bars.`);
  const from = Number(request.from);
  const to = Number(request.to);
  const limit = request.limit === undefined ? 10_000 : Number(request.limit);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to) {
    throw new Error('Choose a valid Alpaca history date range.');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error('Alpaca Broker SDK history requests must be between 1 and 10,000 bars.');
  }
  return activeBroker.fetchBars(request.symbol.trim().toUpperCase(), { timeframe, from, to, limit });
});

ipcMain.handle('broker:subscribe-bars', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!activeBroker || activeBroker.broker !== 'alpaca') throw new Error('Connect Alpaca before subscribing to live bars.');
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid Alpaca stream subscription.');
  if (typeof request.symbol !== 'string' || !/^[A-Z][A-Z0-9.-]{0,19}$/i.test(request.symbol.trim())) throw new Error('Enter a valid Alpaca stock ticker.');
  if (typeof request.timeframe !== 'string' || request.timeframe.length > 12) throw new Error('Enter a valid Alpaca chart timeframe.');
  return alpaca.subscribe(request.symbol.trim().toUpperCase(), request.timeframe);
});

ipcMain.handle('broker:unsubscribe-bars', (event, id) => {
  assertTrustedBrokerRequest(event);
  if (typeof id !== 'string' || id.length > 128) return false;
  return alpaca.unsubscribe(id);
});

ipcMain.handle('broker:disconnect', async (event) => {
  assertTrustedBrokerRequest(event);
  await disconnectAllConnections();
  return true;
});

const QUANTOWER_BRIDGE_URL = 'http://127.0.0.1:17843';
const QUANTOWER_INSTALL_ROOT = process.env.OMEGA_QUANTOWER_ROOT || 'D:\\Programy\\Trading\\Quantower';
const QUANTOWER_START_CANDIDATES = [
  path.join(QUANTOWER_INSTALL_ROOT, 'TradingPlatform', 'v1.146.18', 'Starter.exe'),
  path.join(QUANTOWER_INSTALL_ROOT, 'TradingPlatform', 'Starter.exe'),
];
async function quantowerRequest(pathname, query = '', init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(`${QUANTOWER_BRIDGE_URL}${pathname}${query}`, { ...init, signal: controller.signal, headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(init.headers ?? {}) } });
    const body = await response.json();
    if (!response.ok || body?.error) throw new Error(body?.error || `Quantower bridge returned HTTP ${response.status}.`);
    return body;
  } finally { clearTimeout(timer); }
}
ipcMain.handle('quantower:start', async event => {
  assertTrustedBrokerRequest(event);
  try {
    await quantowerRequest('/health');
    return { started: false, alreadyRunning: true };
  } catch {
    const executable = QUANTOWER_START_CANDIDATES.find(candidate => fsSync.existsSync(candidate));
    if (!executable) throw new Error(`Quantower Starter.exe was not found under ${QUANTOWER_INSTALL_ROOT}.`);
    const child = spawn(executable, [], { cwd: path.dirname(executable), detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return { started: true, executable };
  }
});
ipcMain.handle('quantower:health', async event => { assertTrustedBrokerRequest(event); return quantowerRequest('/health'); });
ipcMain.handle('quantower:symbols', async event => { assertTrustedBrokerRequest(event); return quantowerRequest('/symbols'); });
ipcMain.handle('quantower:accounts', async event => { assertTrustedBrokerRequest(event); return quantowerRequest('/accounts'); });
ipcMain.handle('quantower:place-order', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid Quantower order request.');
  return quantowerRequest('/order', '', { method: 'POST', body: JSON.stringify(request) });
});
ipcMain.handle('quantower:close-position', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid Quantower close request.');
  return quantowerRequest('/close', '', { method: 'POST', body: JSON.stringify(request) });
});
ipcMain.handle('quantower:bars', async (event, request) => {
  assertTrustedHistoryRequest(event);
  if (!request || typeof request.symbol !== 'string' || typeof request.timeframe !== 'string') throw new Error('A Quantower symbol and timeframe are required.');
  return quantowerRequest('/bars', `?symbol=${encodeURIComponent(request.symbol)}&timeframe=${encodeURIComponent(request.timeframe)}&limit=${encodeURIComponent(String(request.limit ?? 500))}`);
});
ipcMain.handle('quantower:quote', async (event, symbol) => { assertTrustedBrokerRequest(event); return quantowerRequest('/quote', `?symbol=${encodeURIComponent(String(symbol || ''))}`); });
ipcMain.handle('quantower:trades', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request.symbol !== 'string') throw new Error('A Quantower symbol is required.');
  const after = Number.isSafeInteger(request.after) && request.after >= 0 ? request.after : 0;
  const limit = Number.isSafeInteger(request.limit) ? Math.max(1, Math.min(1000, request.limit)) : 250;
  return quantowerRequest('/trades', `?symbol=${encodeURIComponent(request.symbol)}&after=${after}&limit=${limit}`);
});
ipcMain.handle('quantower:market-book', async (event, symbol) => { assertTrustedBrokerRequest(event); return quantowerRequest('/market-book', `?symbol=${encodeURIComponent(String(symbol || ''))}`); });

// The renderer writes a map of what it actually rendered - element, id, classes, position,
// size, background colour and a text sample - so a panel can be identified by where it is
// instead of by guesswork. Read it back from userData/layout-map.json.
ipcMain.handle('layout:save-map', async (_event, payload) => {
  const isPicked = Boolean(payload && typeof payload === 'object' && payload.picked);
  const isInventory = Boolean(payload && typeof payload === 'object' && Array.isArray(payload.nodes));
  const fileName = isPicked ? 'panel-picked.json' : isInventory ? 'ui-inventory.json' : 'layout-map.json';
  const target = path.join(app.getPath('userData'), fileName);
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    fsSync.mkdirSync(path.dirname(target), { recursive: true });
    fsSync.writeFileSync(target, text, 'utf8');
    appendDiagnostic({ source: 'layout', type: 'debug', name: 'layout-map-saved', status: 'ok', message: target });
    return target;
  } catch (error) {
    appendDiagnostic({
      source: 'layout',
      type: 'debug',
      name: 'layout-map-save-failed',
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
});

ipcMain.handle('mt5:connect', async (event, pythonExecutable) => {  // The operator reported "nothing happens, just a spinner". The bridge itself connects in
  // well under a second when driven directly, so the stall is somewhere in this path. Each
  // step is recorded with a running duration, so the diagnostic log names the exact step
  // that never returns instead of leaving us to guess.
  const startedAt = Date.now();
  const note = (name, message, status = 'ok') => appendDiagnostic({
    source: 'mt5-connect',
    type: 'tracing',
    name,
    status,
    message,
    durationMs: Date.now() - startedAt,
  });
  try {
    note('ipc-received', `python=${pythonExecutable || '(default)'}`);
    assertTrustedBrokerRequest(event);
    note('trusted');
    const revision = await disconnectAllConnections();
    note('disconnected-others');
    if (revision !== providerConnectionRevision) throw new Error('MetaTrader connection was superseded by a newer provider request.');
    note('calling-bridge');
    const connection = await mt5.connect(pythonExecutable);
    note('bridge-returned', `${connection?.symbols?.length ?? 0} symbols`);
    if (revision !== providerConnectionRevision) throw new Error('MetaTrader connection was superseded by a newer provider request.');
    return connection;
  } catch (error) {
    note('failed', error instanceof Error ? error.message : String(error), 'error');
    throw error;
  }
});

ipcMain.handle('mt5:trading-status', async (event) => {
  assertTrustedBrokerRequest(event);
  const [status, limits] = await Promise.all([mt5LiveOrderGate.status(), Promise.resolve(safeguardsSettings.read())]);
  return {
    ...status,
    liveOrderLimits: {
      maxVolume: limits.settings.maxMt5OrderVolume,
      source: limits.source,
    },
  };
});

ipcMain.handle('mt5:arm-live', async (event, shouldArm) => {
  assertTrustedBrokerRequest(event);
  if (typeof shouldArm !== 'boolean') throw new Error('Choose whether live trading should be armed.');
  return mt5LiveOrderGate.arm(shouldArm);
});

ipcMain.handle('mt5:place-order', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return mt5LiveOrderGate.submit(request);
});

ipcMain.handle('mt5:close-position', async (event, request) => {
  assertTrustedBrokerRequest(event);
  const status = await mt5.status();
  return mt5.closePosition({
    ...(request ?? {}),
    expectedAccount: { login: status.accountLogin, server: status.server },
  });
});

ipcMain.handle('mt5:bars', async (event, request) => {
  assertTrustedHistoryRequest(event);
  return mt5.bars(validateBarsRequest(request));
});

ipcMain.handle('mt5:quote', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return mt5.quote(request);
});

ipcMain.handle('mt5:ticks', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return mt5.ticks(request);
});

ipcMain.handle('market-data:tick-bars', async (event, request) => {
  assertTrustedHistoryRequest(event);
  const provider = typeof request?.provider === 'string' ? request.provider.trim().toLowerCase() : '';
  if (!tickDataProviders.has(provider)) throw new Error(`The ${provider || 'selected'} datafeed does not provide raw tick history.`);
  return tickBarService.request({ ...request, provider });
});

function releaseTickBarSubscription(subscriptionId, sender) {
  const subscriber = tickBarSubscribers.get(subscriptionId);
  if (!subscriber || (sender && subscriber.sender !== sender)) return;
  tickBarSubscribers.delete(subscriptionId);
  tickBarService.unsubscribe(subscriptionId);
  tickBarStreamSubscriptions.release(subscriber.streamKey, subscriptionId);
}

ipcMain.handle('market-data:subscribe-tick-bars', async (event, request) => {
  assertTrustedBrokerRequest(event);
  const provider = typeof request?.provider === 'string' ? request.provider.trim().toLowerCase() : '';
  const ticker = typeof request?.ticker === 'string' ? request.ticker.trim() : '';
  const ticksPerBar = Number(request?.ticksPerBar);
  const subscriptionId = typeof request?.subscriptionId === 'string' ? request.subscriptionId.trim() : '';
  if (!provider || provider.length > 40 || !ticker || ticker.length > 100
    || !Number.isSafeInteger(ticksPerBar) || ticksPerBar < 1 || ticksPerBar > 10_000
    || !subscriptionId || subscriptionId.length > 128) {
    throw new Error('A valid tick-bar subscription is required.');
  }
  const adapter = tickDataProviders.get(provider);
  if (!adapter) throw new Error(`The ${provider} datafeed does not provide raw live ticks.`);
  if (tickBarSubscribers.has(subscriptionId)) throw new Error('Tick-bar subscription already exists.');
  const sender = event.sender;
  const streamKey = `${sender.id}:${provider}:${ticker}`;
  tickBarSubscribers.set(subscriptionId, { sender, provider, ticker, streamKey });
  try {
    await tickBarService.subscribe(subscriptionId, provider, ticker, ticksPerBar);
    await tickBarStreamSubscriptions.acquire(streamKey, subscriptionId, () => adapter.subscribeTicks(ticker, ticks => {
      for (const [id, subscriber] of tickBarSubscribers) {
        if (subscriber.streamKey === streamKey) tickBarService.pushTicks(id, ticks);
      }
    }));
    sender.once('destroyed', () => releaseTickBarSubscription(subscriptionId, sender));
    return true;
  } catch (error) {
    releaseTickBarSubscription(subscriptionId, sender);
    throw error;
  }
});

ipcMain.handle('market-data:unsubscribe-tick-bars', async (event, request) => {
  assertTrustedBrokerRequest(event);
  const provider = typeof request?.provider === 'string' ? request.provider.trim().toLowerCase() : '';
  const ticker = typeof request?.ticker === 'string' ? request.ticker.trim() : '';
  const subscriptionId = typeof request?.subscriptionId === 'string' ? request.subscriptionId.trim() : '';
  if (!provider || !ticker || !subscriptionId) throw new Error('A valid tick-bar subscription is required.');
  const subscriber = tickBarSubscribers.get(subscriptionId);
  if (subscriber && (subscriber.sender !== event.sender || subscriber.provider !== provider || subscriber.ticker !== ticker)) {
    throw new Error('Tick-bar subscription does not belong to this chart.');
  }
  releaseTickBarSubscription(subscriptionId, event.sender);
  return true;
});

ipcMain.handle('mt5:footprint-profiles', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return requestFootprintProfiles(request);
});

ipcMain.handle('mt5:footprint-live-profile', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return requestFootprintLiveProfile(request);
});

ipcMain.handle('mt5:subscribe-ticks', async (event, request) => {
  assertTrustedBrokerRequest(event);
  const ticker = typeof request?.ticker === 'string' ? request.ticker.trim() : '';
  const subscriptionId = typeof request?.subscriptionId === 'string' ? request.subscriptionId.trim() : '';
  if (!ticker || !subscriptionId) throw new Error('A valid MT5 ticker and tick-stream subscription ID are required.');
  const sender = event.sender;
  const streamKey = `${sender.id}:${ticker}`;
  await mt5TickStreamSubscriptions.acquire(streamKey, subscriptionId, () => mt5.subscribeTicks(ticker, ticks => {
    if (!sender.isDestroyed()) sender.send('mt5:tick-stream', { ticker, ticks });
  }));
  return true;
});

ipcMain.handle('mt5:unsubscribe-ticks', async (event, request) => {
  assertTrustedBrokerRequest(event);
  const ticker = typeof request?.ticker === 'string' ? request.ticker.trim() : '';
  const subscriptionId = typeof request?.subscriptionId === 'string' ? request.subscriptionId.trim() : '';
  if (!ticker || !subscriptionId) throw new Error('A valid MT5 ticker and tick-stream subscription ID are required.');
  const streamKey = `${event.sender.id}:${ticker}`;
  mt5TickStreamSubscriptions.release(streamKey, subscriptionId);
  return true;
});

ipcMain.handle('mt5:market-book', async (event, ticker) => {
  assertTrustedBrokerRequest(event);
  return mt5.marketBook(ticker);
});

ipcMain.handle('ibkr:connect', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Enter valid TWS / IB Gateway connection settings.');
  const revision = await disconnectAllConnections();
  if (revision !== providerConnectionRevision) throw new Error('IBKR connection was superseded by a newer provider request.');
  try {
    const status = await ibkr.connect(request);
    if (revision !== providerConnectionRevision) {
      await ibkr.disconnect();
      throw new Error('IBKR connection was superseded by a newer provider request.');
    }
    return status;
  } catch (error) {
    appendDiagnostic({ source: 'ibkr-connect', type: 'connection', name: 'tws-gateway', status: 'error', message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
});

ipcMain.handle('ibkr:status', event => { assertTrustedBrokerRequest(event); return ibkr.status(); });
ipcMain.handle('ibkr:quote', async (event, symbol) => {
  assertTrustedBrokerRequest(event);
  return ibkr.quote(symbol);
});
ipcMain.handle('ibkr:arm-strategy', (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request.accountId !== 'string') throw new Error('Select an IBKR account before changing Pine strategy trading.');
  return ibkr.armStrategyTrading(request.accountId, request.armed);
});
ipcMain.handle('ibkr:place-order', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return ibkr.placeOrder(request);
});
ipcMain.handle('ibkr:disconnect', async event => {
  assertTrustedBrokerRequest(event);
  return ibkr.disconnect();
});

ipcMain.handle('ctrader:connect', async event => {
  assertTrustedBrokerRequest(event);
  const revision = await disconnectAllConnections();
  if (revision !== providerConnectionRevision) throw new Error('cTrader MCP connection was superseded by a newer provider request.');
  try {
    const status = await ctrader.connect();
    if (revision !== providerConnectionRevision) {
      throw new Error('cTrader MCP connection was superseded by a newer provider request.');
    }
    return status;
  } catch (error) {
    await ctrader.disconnect();
    throw error;
  }
});

ipcMain.handle('ctrader:status', event => { assertTrustedBrokerRequest(event); return ctrader.status(); });
ipcMain.handle('ctrader:market-data', (event, toolName, argumentsObject) => {
  assertTrustedHistoryRequest(event);
  return ctrader.callMarketData(toolName, argumentsObject);
});
ipcMain.handle('ctrader:place-market-order', (event, request) => {
  assertTrustedBrokerRequest(event);
  return ctrader.placeMarketOrder(request);
});
ipcMain.handle('ctrader:disconnect', async event => {
  assertTrustedBrokerRequest(event);
  return ctrader.disconnect();
});

ipcMain.handle('saxo:connect', async (event, request) => {
  assertTrustedBrokerRequest(event);
  const revision = await disconnectAllConnections();
  if (revision !== providerConnectionRevision) throw new Error('Saxo connection was superseded by a newer provider request.');
  try {
    const status = await saxo.connect(request);
    if (revision !== providerConnectionRevision) {
      saxo.disconnect();
      throw new Error('Saxo connection was superseded by a newer provider request.');
    }
    return status;
  } catch (error) {
    saxo.disconnect();
    throw error;
  }
});

ipcMain.handle('saxo:status', event => { assertTrustedBrokerRequest(event); return saxo.status(); });
ipcMain.handle('saxo:quote', (event, accountKey, symbol) => {
  assertTrustedBrokerRequest(event);
  return saxo.quote(accountKey, symbol);
});
ipcMain.handle('saxo:place-order', (event, request) => {
  assertTrustedBrokerRequest(event);
  return saxo.placeOrder(request);
});
ipcMain.handle('saxo:arm-strategy', (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('Enter valid Saxo strategy trading settings.');
  return saxo.armStrategyTrading(request.accountKey, request.armed);
});
ipcMain.handle('saxo:disconnect', async event => {
  assertTrustedBrokerRequest(event);
  saxo.disconnect();
  return true;
});

ipcMain.handle('mt5:symbols', async (event) => {
  assertTrustedBrokerRequest(event);
  return mt5.symbols();
});

ipcMain.handle('mt5:info', async (event, ticker) => {
  assertTrustedHistoryRequest(event);
  if (typeof ticker !== 'string' || !ticker.trim() || ticker.length > 100) throw new Error('Enter a valid MetaTrader symbol.');
  return mt5.request('info', { ticker: ticker.trim() });
});

ipcMain.handle('mt5:disconnect', async (event) => {
  assertTrustedBrokerRequest(event);
  mt5LiveOrderGate.disarm();
  mt5TickStreamSubscriptions.stopAll();
  for (const [subscriptionId, subscriber] of tickBarSubscribers) {
    if (subscriber.provider === 'mt5') releaseTickBarSubscription(subscriptionId);
  }
  tickBarService.stop('mt5');
  return mt5.disconnect();
});

function closeSplash() {
  if (startupFallbackTimer) {
    clearTimeout(startupFallbackTimer);
    startupFallbackTimer = null;
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

function showMainWindow() {
  closeSplash();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
}

function createSplashWindow() {
  const splash = new BrowserWindow({
    width: 420,
    height: 230,
    frame: false,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: '#0b0e14',
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0e14;color:#e8edf5;font-family:Segoe UI,Arial,sans-serif}
    main{text-align:center}.mark{width:52px;height:52px;margin:0 auto 18px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#2962ff,#00a5ff);font-size:24px;font-weight:800;box-shadow:0 12px 34px #2962ff44}
    h1{margin:0;font-size:22px;letter-spacing:.04em}p{margin:8px 0 22px;color:#92a0b5;font-size:13px}.bar{width:170px;height:3px;margin:auto;overflow:hidden;border-radius:8px;background:#202938}.bar:after{content:'';display:block;width:45%;height:100%;border-radius:inherit;background:#3b82f6;animation:load 1.1s ease-in-out infinite}@keyframes load{from{transform:translateX(-110%)}to{transform:translateX(280%)}}
  </style></head><body><main><div class="mark">Ω</div><h1>OMEGA</h1><p>Preparing your trading workspace…</p><div class="bar"></div></main></body></html>`)}`);
  splashWindow = splash;
  splash.on('closed', () => { if (splashWindow === splash) splashWindow = null; });
}

function createWindow() {
  cleanupRuntime = createCleanupRuntime();
  createSplashWindow();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Omega Trading Terminal — RC_updated v0.1',
    backgroundColor: '#0b0e14',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  mainWindow = win;
  observeRendererProcess(win, 'Omega Chart');
  win.maximize();
  win.on('closed', () => {
    closeSplash();
    marketDataWindow.stop();
    activeBroker = null;
    alpacaOrderSession = null;
    // Auxiliary windows talk to the main window over IPC; they cannot work
    // without it, so close them instead of leaving orphaned, unresponsive
    // Pine Editor / Visual Backtest windows behind.
    for (const auxiliary of [pineEditorWindow, indicatorBrowserWindow, visualBacktestWindow, diagnosticsWindow]) {
      if (auxiliary && !auxiliary.isDestroyed()) auxiliary.close();
    }
    void cleanupRuntime().catch(error => {
      appendDiagnostic({
        source: 'electron-main',
        type: 'lifecycle',
        name: 'main-window resource cleanup',
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    });
    mainWindow = null;
  });

  // If running in development, load the Vite dev server
  if (isDev) {
    win.loadURL(devServerUrl);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  win.webContents.once('did-fail-load', showMainWindow);
  win.webContents.once('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('omega:platform-fit-request');
    }
  });
  // The renderer keeps its own startup screen visible. Reveal the native window
  // quickly instead of holding the whole app behind a splash while feeds connect.
  startupFallbackTimer = setTimeout(showMainWindow, 1200);
}

function createPineEditorWindow() {
  if (pineEditorWindow && !pineEditorWindow.isDestroyed()) {
    pineEditorWindow.focus();
    return true;
  }

  const title = 'Omega Pine Editor';
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title,
    backgroundColor: '#17202c',
    autoHideMenuBar: true,
    webPreferences: toolWindowPreferences(title),
  });
  pineEditorWindow = win;
  observeRendererProcess(win, title);
  win.on('closed', () => { pineEditorWindow = null; });

  if (isDev) {
    void win.loadURL(new URL('pine-editor.html', `${devServerUrl}/`).href);
  } else {
    void win.loadFile(path.join(__dirname, '../dist/pine-editor.html'));
  }
  return true;
}

function createIndicatorBrowserWindow(target = 'main') {
  indicatorBrowserTarget = target;
  if (indicatorBrowserWindow && !indicatorBrowserWindow.isDestroyed()) { indicatorBrowserWindow.focus(); return true; }
  const title = 'Omega Indicator Browser';
  const win = new BrowserWindow({
    width: 1080, height: 740, minWidth: 720, minHeight: 500,
    title, backgroundColor: '#131722', autoHideMenuBar: true,
    webPreferences: toolWindowPreferences(title),
  });
  win.center();
  indicatorBrowserWindow = win;
  observeRendererProcess(win, title);
  win.on('closed', () => { if (indicatorBrowserWindow === win) indicatorBrowserWindow = null; });
  if (isDev) void win.loadURL(new URL('indicator-browser.html', `${devServerUrl}/`).href); else void win.loadFile(path.join(__dirname, '../dist/indicator-browser.html'));
  return true;
}

function createVisualBacktestWindow() {
  if (visualBacktestWindow && !visualBacktestWindow.isDestroyed()) {
    visualBacktestWindow.focus();
    return true;
  }
  const title = 'Omega Visual Backtester';
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1000, minHeight: 680,
    title, backgroundColor: '#0b0e14', autoHideMenuBar: true,
    webPreferences: toolWindowPreferences(title),
  });
  visualBacktestWindow = win;
  observeRendererProcess(win, title);
  win.on('closed', () => {
    if (visualBacktestWindow === win) visualBacktestWindow = null;
    if (indicatorBrowserTarget === 'visual-backtest' && indicatorBrowserWindow && !indicatorBrowserWindow.isDestroyed()) {
      indicatorBrowserWindow.close();
    }
  });
  if (isDev) void win.loadURL(new URL('visual-backtest.html', `${devServerUrl}/`).href);
  else void win.loadFile(path.join(__dirname, '../dist/visual-backtest.html'));
  return true;
}

ipcMain.handle('visual-backtest:open-window', (event, config) => {
  assertTrustedWorkspaceRequest(event);
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  if (!config || typeof config.symbol !== 'string' || typeof config.timeframe !== 'string'
    || config.symbol.length > 80 || config.timeframe.length > 20
    || (config.provider !== undefined && typeof config.provider !== 'string')
    || (config.strategy !== undefined && (!config.strategy || typeof config.strategy !== 'object'
      || typeof config.strategy.title !== 'string' || typeof config.strategy.source !== 'string'
      || config.strategy.title.length > 160 || config.strategy.source.length > 100_000))) return false;
  createVisualBacktestWindow();
  if (!visualBacktestWindow || visualBacktestWindow.isDestroyed()) return false;
  const send = () => {
    if (visualBacktestWindow && !visualBacktestWindow.isDestroyed()) {
      visualBacktestWindow.webContents.send('visual-backtest:open-config', {
        symbol: config.symbol,
        timeframe: config.timeframe,
        provider: config.provider || '',
        strategy: config.strategy ? { title: config.strategy.title, source: config.strategy.source } : undefined,
      });
      visualBacktestWindow.focus();
    }
  };
  if (visualBacktestWindow.webContents.isLoading()) visualBacktestWindow.webContents.once('did-finish-load', send); else send();
  appendDiagnostic({ source: 'visual-backtest', type: 'window', name: 'opened', status: 'ok', message: `${config.symbol} ${config.timeframe}` });
  return true;
});

ipcMain.handle('pine-editor:open-window', (event) => {
  assertTrustedWorkspaceRequest(event);
  return createPineEditorWindow();
});

ipcMain.handle('pine-editor:new-script', event => {
  assertTrustedPineEditorRequest(event);
  createPineEditorWindow();
  if (!pineEditorWindow || pineEditorWindow.isDestroyed()) return false;
  const send = () => {
    if (!pineEditorWindow || pineEditorWindow.isDestroyed()) return;
    pineEditorWindow.webContents.send('pine-editor:new-script');
    pineEditorWindow.focus();
  };
  if (pineEditorWindow.webContents.isLoading()) pineEditorWindow.webContents.once('did-finish-load', send);
  else send();
  return true;
});

ipcMain.handle('indicator-browser:open-window', event => {
  assertTrustedWorkspaceRequest(event);
  const target = event.sender === mainWindow?.webContents ? 'main'
    : event.sender === visualBacktestWindow?.webContents ? 'visual-backtest' : null;
  if (!target) return false;
  return createIndicatorBrowserWindow(target);
});

ipcMain.on('indicator-browser:add', (event, entry) => {
  if (!indicatorBrowserWindow || event.sender !== indicatorBrowserWindow.webContents) return;
  if (!entry || typeof entry.name !== 'string' || typeof entry.url !== 'string'
    || entry.name.length > 160 || entry.url.length > 500
    || !/^\/indicators\/[A-Za-z0-9._/-]+$/.test(entry.url) || entry.url.includes('..')) return;
  const targetWindow = indicatorBrowserTarget === 'visual-backtest' ? visualBacktestWindow : mainWindow;
  if (!targetWindow || targetWindow.isDestroyed()) return;
  targetWindow.webContents.send('indicator-browser:add', {
    name: entry.name,
    url: entry.url,
    language: typeof entry.language === 'string' ? entry.language : 'pine',
  });
});

ipcMain.on('indicator-browser:close', event => {
  if (indicatorBrowserWindow && event.sender === indicatorBrowserWindow.webContents) indicatorBrowserWindow.close();
});

ipcMain.handle('pine-editor:open-script', (event, script) => {
  assertTrustedWorkspaceRequest(event);
  if (!mainWindow || event.sender !== mainWindow.webContents) return false;
  if (!script || typeof script.name !== 'string' || typeof script.source !== 'string'
    || script.name.length > 200 || script.source.length > 2_000_000) return false;
  createPineEditorWindow();
  if (!pineEditorWindow || pineEditorWindow.isDestroyed()) return false;
  const send = () => {
    if (pineEditorWindow && !pineEditorWindow.isDestroyed()) {
      pineEditorWindow.webContents.send('pine-editor:open-script', script);
      pineEditorWindow.focus();
    }
  };
  if (pineEditorWindow.webContents.isLoading()) pineEditorWindow.webContents.once('did-finish-load', send);
  else send();
  return true;
});

ipcMain.on('pine-editor:script-updated', (event, script) => {
  if (!pineEditorWindow || event.sender !== pineEditorWindow.webContents) return;
  if (!script || typeof script.name !== 'string' || typeof script.source !== 'string' || !['add', 'update'].includes(script.action) || script.name.length > 200 || script.source.length > 2_000_000) return;
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pine-editor:script-updated', script);
});

ipcMain.on('pine-editor:script-result', (event, result) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  if (!pineEditorWindow || pineEditorWindow.isDestroyed()) return;
  if (!result || typeof result.name !== 'string' || typeof result.message !== 'string'
    || !['add', 'update'].includes(result.action) || typeof result.ok !== 'boolean') return;
  pineEditorWindow.webContents.send('pine-editor:script-result', result);
});

ipcMain.on('app:ready', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return;
  showMainWindow();
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let providerShutdownComplete = false;
app.on('before-quit', event => {
  if (providerShutdownComplete) return;
  event.preventDefault();
  void cleanupRuntime()
    .catch(error => {
      console.error('Could not cleanly disconnect providers before shutdown:', error);
    })
    .finally(() => {
      marketDataWindow.stop();
      tickBarService.stop();
      providerShutdownComplete = true;
      app.quit();
    });
});
