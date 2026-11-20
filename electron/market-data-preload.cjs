const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('omegaHistoryRunner', {
  alpacaBars: request => ipcRenderer.invoke('broker:fetch-bars', request),
  mt5Bars: request => ipcRenderer.invoke('mt5:bars', request),
  mt5Info: ticker => ipcRenderer.invoke('mt5:info', ticker),
  tickBars: request => ipcRenderer.invoke('market-data:tick-bars', request),
  cTraderData: (tool, args) => ipcRenderer.invoke('ctrader:market-data', tool, args),
  quantowerBars: request => ipcRenderer.invoke('quantower:bars', request),
  listen: run => ipcRenderer.on('market-history:run', async (_event, { id, source, request }) => {
    try {
      const result = await run(source, request);
      ipcRenderer.send('market-history:result', { id, result });
    } catch (error) {
      ipcRenderer.send('market-history:result', { id, error: error?.message || String(error) });
    }
  }),
  ready: () => ipcRenderer.send('market-history:ready'),
  release: callback => ipcRenderer.on('market-history:release', (_event, source) => callback(source)),
});
