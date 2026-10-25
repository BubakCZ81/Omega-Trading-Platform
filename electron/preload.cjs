const { contextBridge, ipcRenderer } = require('electron');

let pendingPineOpenScript = null;
const pineOpenScriptCallbacks = new Set();
ipcRenderer.on('pine-editor:open-script', (_event, script) => {
  if (pineOpenScriptCallbacks.size === 0) pendingPineOpenScript = script;
  else for (const callback of pineOpenScriptCallbacks) callback(script);
});

contextBridge.exposeInMainWorld('velaApp', {
  ready: () => ipcRenderer.send('app:ready'),
  getZoomFactor: () => ipcRenderer.invoke('app:get-zoom-factor'),
  setZoomFactor: (factor) => ipcRenderer.invoke('app:set-zoom-factor', factor),
});

contextBridge.exposeInMainWorld('velaBroker', {
  listBrokers: () => ipcRenderer.invoke('broker:list'),
  connectReadOnly: (brokerId, credentials) => ipcRenderer.invoke('broker:connect-read-only', { brokerId, credentials }),
  fetchSnapshot: () => ipcRenderer.invoke('broker:fetch-snapshot'),
  authorizeCTrader: (credentials) => ipcRenderer.invoke('ctrader:authorize', credentials),
  selectCTraderAccount: (accountId) => ipcRenderer.invoke('ctrader:select-account', accountId),
  subscribeCTraderSymbol: (symbolId) => ipcRenderer.invoke('ctrader:subscribe-symbol', symbolId),
  placeDemoCTraderMarketOrder: (order) => ipcRenderer.invoke('ctrader:place-demo-market-order', order),
  reconcileCTraderAccount: () => ipcRenderer.invoke('ctrader:reconcile-account'),
  onCTraderQuote: (callback) => {
    const listener = (_event, quote) => callback(quote);
    ipcRenderer.on('ctrader:quote', listener);
    return () => ipcRenderer.removeListener('ctrader:quote', listener);
  },
  disconnect: () => ipcRenderer.invoke('broker:disconnect'),
});

contextBridge.exposeInMainWorld('velaMt5', {
  connect: (pythonExecutable) => ipcRenderer.invoke('mt5:connect', pythonExecutable),
  symbols: () => ipcRenderer.invoke('mt5:symbols'),
  bars: (request) => ipcRenderer.invoke('mt5:bars', request),
  quote: (ticker) => ipcRenderer.invoke('mt5:quote', { ticker }),
  ticks: (request) => ipcRenderer.invoke('mt5:ticks', request),
  marketBook: (ticker) => ipcRenderer.invoke('mt5:market-book', ticker),
  info: (ticker) => ipcRenderer.invoke('mt5:info', ticker),
  disconnect: () => ipcRenderer.invoke('mt5:disconnect'),
});

contextBridge.exposeInMainWorld('velaAlpaca', {
  connect: (credentials) => ipcRenderer.invoke('alpaca:connect', credentials),
  status: () => ipcRenderer.invoke('alpaca:status'),
  bars: (request) => ipcRenderer.invoke('alpaca:bars', request),
  assets: () => ipcRenderer.invoke('alpaca:assets'),
  subscribe: (ticker, timeframe) => ipcRenderer.invoke('alpaca:subscribe', { ticker, timeframe }),
  unsubscribe: (subscriptionId) => ipcRenderer.invoke('alpaca:unsubscribe', subscriptionId),
  onBar: (callback) => {
    const listener = (_event, bar) => callback(bar);
    ipcRenderer.on('alpaca:bar', listener);
    return () => ipcRenderer.removeListener('alpaca:bar', listener);
  },
  onStatus: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('alpaca:status', listener);
    return () => ipcRenderer.removeListener('alpaca:status', listener);
  },
  disconnect: () => ipcRenderer.invoke('alpaca:disconnect'),
});

contextBridge.exposeInMainWorld('velaWorkspaceFiles', {
  load: () => ipcRenderer.invoke('workspace:load'),
  save: (state) => ipcRenderer.invoke('workspace:save', state),
  saveProfile: (name, state) => ipcRenderer.invoke('workspace:save-profile', { name, state }),
  loadProfile: () => ipcRenderer.invoke('workspace:load-profile'),
});

contextBridge.exposeInMainWorld('velaNews', {
  search: (symbol) => ipcRenderer.invoke('news:search', symbol),
  open: (url) => ipcRenderer.invoke('news:open', url),
});

contextBridge.exposeInMainWorld('velaAi', {
  providers: () => ipcRenderer.invoke('ai:providers'),
  saveKey: (provider, apiKey) => ipcRenderer.invoke('ai:save-key', { provider, apiKey }),
  clearKey: (provider) => ipcRenderer.invoke('ai:clear-key', provider),
  testKey: (provider, apiKey) => ipcRenderer.invoke('ai:test-key', { provider, apiKey }),
  complete: (request) => ipcRenderer.invoke('ai:complete', request),
});

contextBridge.exposeInMainWorld('velaPineExport', {
  save: (name, source) => ipcRenderer.invoke('pine:export', { name, source }),
});

contextBridge.exposeInMainWorld('velaPineEditorWindow', {
  open: () => ipcRenderer.invoke('pine-editor:open-window'),
  openScript: (name, source) => ipcRenderer.invoke('pine-editor:open-script', { name, source }),
  openDocked: () => ipcRenderer.send('pine-editor:open-docked'),
  onOpenDocked: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('pine-editor:open-docked', listener);
    return () => ipcRenderer.removeListener('pine-editor:open-docked', listener);
  },
  publishScriptUpdate: (script) => ipcRenderer.send('pine-editor:script-updated', script),
  onScriptUpdated: (callback) => {
    const listener = (_event, script) => callback(script);
    ipcRenderer.on('pine-editor:script-updated', listener);
    return () => ipcRenderer.removeListener('pine-editor:script-updated', listener);
  },
  publishScriptResult: (result) => ipcRenderer.send('pine-editor:script-result', result),
  onScriptResult: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on('pine-editor:script-result', listener);
    return () => ipcRenderer.removeListener('pine-editor:script-result', listener);
  },
  onOpenScript: (callback) => {
    pineOpenScriptCallbacks.add(callback);
    if (pendingPineOpenScript) {
      const script = pendingPineOpenScript;
      pendingPineOpenScript = null;
      callback(script);
    }
    return () => pineOpenScriptCallbacks.delete(callback);
  },
});
