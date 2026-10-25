const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const { pathToFileURL } = require('url');
const { CTraderIntegration } = require('./ctrader.cjs');
const { Mt5Bridge, validateBarsRequest } = require('./mt5.cjs');
const { AlpacaMarketData } = require('./alpaca.cjs');
const { searchYahooNews, safeNewsLink } = require('./news.cjs');
const { LocalAiAssistant } = require('./local-ai.cjs');

let mainWindow = null;
let pineEditorWindow = null;
let splashWindow = null;
let startupFallbackTimer = null;
let activeBroker = null;
let brokerSdk = null;
let localAiAssistant = null;
let platformZoomFactor = 1;
const MIN_PLATFORM_ZOOM = 0.75;
const MAX_PLATFORM_ZOOM = 1.5;
const cTrader = new CTraderIntegration({ openExternal: (url) => shell.openExternal(url) });
const mt5BridgeScript = app.isPackaged
  ? path.join(process.resourcesPath, 'mt5_bridge.py')
  : path.join(__dirname, 'mt5_bridge.py');
const mt5 = new Mt5Bridge({ scriptPath: mt5BridgeScript });
const alpaca = new AlpacaMarketData({
  safeStorage: require('electron').safeStorage,
  storagePath: path.join(app.getPath('userData'), 'alpaca-market-data.json'),
});

cTrader.on('quote', (quote) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('ctrader:quote', quote);
});
alpaca.on('bar', (bar) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('alpaca:bar', bar);
});
alpaca.on('status', (state) => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('alpaca:status', state);
});

function getBrokerSdk() {
  brokerSdk ??= require('@luxalgo/broker-sdk');
  return brokerSdk;
}

function assertTrustedBrokerRequest(event) {
  const trustedWindow = [mainWindow, pineEditorWindow].find(window => window && !window.isDestroyed() && event.sender === window.webContents);
  if (!trustedWindow || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Broker access is available only to the application window.');
  }
  const url = event.senderFrame.url;
  const appFileUrl = pathToFileURL(path.join(__dirname, '../dist/index.html')).href;
  const isDevUrl = /^http:\/\/(localhost|127\.0\.0\.1):5173(?:\/|$)/.test(url);
  if (!url.startsWith(appFileUrl) && !isDevUrl) throw new Error('Broker access is blocked for this page.');
}

function assertTrustedWorkspaceRequest(event) {
  assertTrustedBrokerRequest(event);
}

function dialogOwnerFor(event) {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (senderWindow && !senderWindow.isDestroyed()) return senderWindow;
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
}

function workspaceFileName(name) {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/[. ]+$/g, '')
    .trim();
  return cleaned || 'omega-workspace';
}

function getLocalAiAssistant() {
  localAiAssistant ??= new LocalAiAssistant({
    safeStorage: require('electron').safeStorage,
    storagePath: path.join(app.getPath('userData'), 'ai-api-keys.json'),
  });
  return localAiAssistant;
}

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
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

ipcMain.handle('workspace:load', async (event) => {
  assertTrustedWorkspaceRequest(event);
  return loadWorkspaceState();
});

ipcMain.handle('workspace:save', async (event, state) => {
  assertTrustedWorkspaceRequest(event);
  if (typeof state !== 'string' || state.length > 25_000_000) throw new Error('Invalid workspace state.');
  const parsed = JSON.parse(state);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.charts)) throw new Error('Invalid workspace document.');
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
  const result = await dialog.showSaveDialog(dialogOwnerFor(event), {
    title: 'Save Chart Workspace',
    defaultPath: `${workspaceFileName(name)}.json`,
    filters: [{ name: 'Omega workspace', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  const parsed = JSON.parse(request.state);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.charts)) throw new Error('Invalid workspace document.');
  await fs.writeFile(result.filePath, request.state, 'utf8');
  return { canceled: false, path: result.filePath };
});

ipcMain.handle('workspace:load-profile', async (event) => {
  assertTrustedWorkspaceRequest(event);
  const result = await dialog.showOpenDialog(dialogOwnerFor(event), {
    title: 'Load Chart Workspace',
    properties: ['openFile'],
    filters: [{ name: 'Omega workspace', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const state = await fs.readFile(result.filePaths[0], 'utf8');
  const parsed = JSON.parse(state);
  if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.charts)) throw new Error('Selected file is not a valid Vela workspace.');
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

ipcMain.handle('ai:providers', async (event) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().configuredProviders();
});

ipcMain.handle('ai:save-key', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid AI key request.');
  return getLocalAiAssistant().saveKey(request.provider, request.apiKey);
});

ipcMain.handle('ai:clear-key', async (event, provider) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().clearKey(provider);
});

ipcMain.handle('ai:test-key', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid AI key test request.');
  return getLocalAiAssistant().testKey(request.provider, request.apiKey);
});

ipcMain.handle('ai:complete', async (event, request) => {
  assertTrustedWorkspaceRequest(event);
  return getLocalAiAssistant().complete(request);
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
  return [...getBrokerSdk().listBrokers().map(({ id, displayName, credentials, readOnlySetup }) => ({
    id,
    displayName,
    credentials,
    readOnlySetup,
  })), {
    id: 'ctrader',
    displayName: 'cTrader Open API',
    credentials: [
      { key: 'clientId', label: 'Open API Client ID', secret: false },
      { key: 'clientSecret', label: 'Open API Client Secret', secret: true },
    ],
    readOnlySetup: 'First create a cTrader Open API app and use its Client ID and Client Secret here (redirect URI: http://127.0.0.1:17863/ctrader/callback). Then Omega opens cTrader ID sign-in in your system browser; use Google there only if cTrader offers it for your account. Omega never accepts your Google/cTrader password.',
  }];
});

ipcMain.handle('broker:connect-read-only', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request.brokerId !== 'string' || !request.credentials || typeof request.credentials !== 'object') {
    throw new Error('Choose a broker and enter its required credentials.');
  }
  if (request.brokerId === 'ctrader') throw new Error('Use the cTrader authorization flow for this broker.');

  const sdk = getBrokerSdk();
  const brokerInfo = sdk.listBrokers().find(({ id }) => id === request.brokerId);
  if (!brokerInfo) throw new Error('That broker is not supported by the installed SDK.');

  const credentials = {};
  for (const field of brokerInfo.credentials) {
    const value = request.credentials[field.key];
    if (typeof value !== 'string' || !value.trim() || value.length > 4096) {
      throw new Error(`Enter a valid value for ${field.label}.`);
    }
    credentials[field.key] = value.trim();
  }

  activeBroker = null;
  await cTrader.disconnect();
  const connection = sdk.connect({ broker: brokerInfo.id, credentials });
  const snapshot = await connection.fetchSnapshot();
  activeBroker = connection;
  return toBrokerSnapshot(snapshot);
});

ipcMain.handle('ctrader:authorize', async (event, credentials) => {
  assertTrustedBrokerRequest(event);
  activeBroker = null;
  await cTrader.disconnect();
  if (!credentials || typeof credentials.clientId !== 'string' || typeof credentials.clientSecret !== 'string'
    || (credentials.allowTrading !== undefined && typeof credentials.allowTrading !== 'boolean')) {
    throw new Error('Enter the cTrader Open API Client ID and Client Secret.');
  }
  return cTrader.authorize(credentials);
});

ipcMain.handle('ctrader:select-account', async (event, accountId) => {
  assertTrustedBrokerRequest(event);
  if (typeof accountId !== 'string' || !accountId) throw new Error('Choose a cTrader account.');
  return cTrader.selectAccount(accountId);
});

ipcMain.handle('ctrader:subscribe-symbol', async (event, symbolId) => {
  assertTrustedBrokerRequest(event);
  if (typeof symbolId !== 'string' || !symbolId) throw new Error('Choose a cTrader symbol.');
  return cTrader.subscribeSymbol(symbolId);
});

ipcMain.handle('ctrader:place-demo-market-order', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid demo order request.');
  return cTrader.placeDemoMarketOrder(request);
});

ipcMain.handle('ctrader:reconcile-account', async (event) => {
  assertTrustedBrokerRequest(event);
  return cTrader.reconcileActiveAccount();
});

ipcMain.handle('broker:fetch-snapshot', async (event) => {
  assertTrustedBrokerRequest(event);
  if (!activeBroker) throw new Error('Connect to a broker first.');
  return toBrokerSnapshot(await activeBroker.fetchSnapshot());
});

ipcMain.handle('broker:disconnect', (event) => {
  assertTrustedBrokerRequest(event);
  activeBroker = null;
  return cTrader.disconnect().then(() => true);
});

ipcMain.handle('mt5:connect', async (event, pythonExecutable) => {
  assertTrustedBrokerRequest(event);
  return mt5.connect(pythonExecutable);
});

ipcMain.handle('mt5:bars', async (event, request) => {
  assertTrustedBrokerRequest(event);
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

ipcMain.handle('mt5:market-book', async (event, ticker) => {
  assertTrustedBrokerRequest(event);
  return mt5.marketBook(ticker);
});

ipcMain.handle('mt5:symbols', async (event) => {
  assertTrustedBrokerRequest(event);
  return mt5.symbols();
});

ipcMain.handle('mt5:info', async (event, ticker) => {
  assertTrustedBrokerRequest(event);
  if (typeof ticker !== 'string' || !ticker.trim() || ticker.length > 100) throw new Error('Enter a valid MetaTrader symbol.');
  return mt5.request('info', { ticker: ticker.trim() });
});

ipcMain.handle('mt5:disconnect', async (event) => {
  assertTrustedBrokerRequest(event);
  return mt5.disconnect();
});

ipcMain.handle('alpaca:connect', async (event, credentials) => {
  assertTrustedBrokerRequest(event);
  if (credentials !== undefined && (!credentials || typeof credentials !== 'object' || Array.isArray(credentials))) {
    throw new Error('Invalid Alpaca credentials.');
  }
  return alpaca.connect(credentials ?? {});
});

ipcMain.handle('alpaca:status', async (event) => {
  assertTrustedBrokerRequest(event);
  return alpaca.status();
});

ipcMain.handle('alpaca:bars', async (event, request) => {
  assertTrustedBrokerRequest(event);
  return alpaca.bars(request);
});

ipcMain.handle('alpaca:assets', async (event) => {
  assertTrustedBrokerRequest(event);
  return alpaca.assets();
});

ipcMain.handle('alpaca:subscribe', async (event, request) => {
  assertTrustedBrokerRequest(event);
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid Alpaca subscription.');
  return alpaca.subscribe(request.ticker, request.timeframe);
});

ipcMain.handle('alpaca:unsubscribe', async (event, subscriptionId) => {
  assertTrustedBrokerRequest(event);
  if (typeof subscriptionId !== 'string') throw new Error('Invalid Alpaca subscription.');
  return alpaca.unsubscribe(subscriptionId);
});

ipcMain.handle('alpaca:disconnect', async (event) => {
  assertTrustedBrokerRequest(event);
  return alpaca.disconnect();
});

function closeSplash() {
  if (startupFallbackTimer) {
    clearTimeout(startupFallbackTimer);
    startupFallbackTimer = null;
  }
  if (splashWindow && !splashWindow.isDestroyed()) splashWindow.destroy();
  splashWindow = null;
}

function normalizePlatformZoom(value) {
  const zoom = Number(value);
  if (!Number.isFinite(zoom)) return 1;
  return Math.round(Math.min(MAX_PLATFORM_ZOOM, Math.max(MIN_PLATFORM_ZOOM, zoom)) * 100) / 100;
}

ipcMain.handle('app:get-zoom-factor', (event) => {
  assertTrustedWorkspaceRequest(event);
  return platformZoomFactor;
});

ipcMain.handle('app:set-zoom-factor', (event, value) => {
  assertTrustedWorkspaceRequest(event);
  if (!mainWindow || event.sender !== mainWindow.webContents) return platformZoomFactor;
  platformZoomFactor = normalizePlatformZoom(value);
  return platformZoomFactor;
});

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
  createSplashWindow();
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    title: 'Omega Trading Desktop Terminal',
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
  win.on('closed', () => {
    closeSplash();
    activeBroker = null;
    void cTrader.disconnect();
    void mt5.disconnect();
    void alpaca.disconnect();
    mainWindow = null;
  });

  // If running in development, load the Vite dev server
  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';

  if (isDev) {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html'));
  }
  win.webContents.once('did-fail-load', showMainWindow);
  startupFallbackTimer = setTimeout(showMainWindow, 20000);
}

function createPineEditorWindow() {
  if (pineEditorWindow && !pineEditorWindow.isDestroyed()) {
    pineEditorWindow.focus();
    return true;
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    title: 'Omega Pine Editor',
    backgroundColor: '#17202c',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  });
  pineEditorWindow = win;
  win.on('closed', () => { pineEditorWindow = null; });

  const isDev = !app.isPackaged && process.env.NODE_ENV !== 'production';
  if (isDev) {
    void win.loadURL('http://localhost:5173/pine-editor.html');
  } else {
    void win.loadFile(path.join(__dirname, '../dist/pine-editor.html'));
  }
  return true;
}

ipcMain.handle('pine-editor:open-window', (event) => {
  assertTrustedWorkspaceRequest(event);
  return createPineEditorWindow();
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

ipcMain.on('pine-editor:open-docked', (event) => {
  if (!pineEditorWindow || event.sender !== pineEditorWindow.webContents) return;
  pineEditorWindow.close();
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pine-editor:open-docked');
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

app.on('before-quit', () => {
  void mt5.disconnect();
  void cTrader.disconnect();
  void alpaca.disconnect();
});
