const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_ACTIVE_HISTORY_JOBS = 4;
const MAX_PENDING_HISTORY_JOBS = 64;
const HISTORY_PROVIDERS = new Set(['alpaca', 'ctrader', 'mt5', 'quantower']);

function createMarketDataWindow({ BrowserWindow, ipcMain, devServerUrl, isDev, observeProcess }) {
  const title = 'Omega Data Loader';
  const url = isDev
    ? new URL('market-data.html', devServerUrl + '/').href
    : pathToFileURL(path.join(__dirname, '../dist/market-data.html')).href;
  const pending = new Map();
  const shared = new Map();
  const active = new Set();
  const callers = new WeakSet();
  let window = null;
  let ready = false;
  let nextId = 0;

  function isRunner(event) {
    return window && !window.isDestroyed() && event.sender === window.webContents
      && event.senderFrame === event.sender.mainFrame && event.senderFrame?.url === url;
  }

  function drain() {
    if (!ready) return;
    for (const [id, job] of pending) {
      if (active.size >= MAX_ACTIVE_HISTORY_JOBS) break;
      if (active.has(id)) continue;
      active.add(id);
      window.webContents.send('market-history:run', { id, source: job.sender.id, request: job.request });
    }
  }

  function finish(id, response) {
    const job = pending.get(id);
    if (!job) return;
    pending.delete(id);
    shared.delete(job.key);
    // A timed-out or discarded caller cannot release a slot while the worker is
    // still doing the work. Only a reply or a worker restart frees it.
    clearTimeout(job.timer);
    if (response.error) job.reject(new Error(response.error));
    else job.resolve(response.result);
  }

  function stop(error = 'Omega Data Loader was stopped.') {
    const current = window;
    window = null;
    ready = false;
    active.clear();
    for (const id of pending.keys()) finish(id, { error });
    if (current && !current.isDestroyed()) current.destroy();
  }

  function start() {
    const current = new BrowserWindow({
      title,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'market-data-preload.cjs'),
        partition: 'omega-data-loader',
        backgroundThrottling: false,
        additionalArguments: [`--omega-process-name=${title}`],
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    window = current;
    observeProcess(current, title);
    current.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    current.webContents.on('will-navigate', event => event.preventDefault());
    current.webContents.on('render-process-gone', () => {
      if (window === current) stop('Omega Data Loader exited while loading history.');
    });
    current.on('closed', () => {
      if (window === current) stop();
    });
    void current.loadURL(url).catch(() => {
      if (window === current) stop('Omega Data Loader could not start.');
    });
  }

  ipcMain.on('market-history:ready', event => {
    if (!isRunner(event) || ready) return;
    ready = true;
    drain();
  });
  ipcMain.on('market-history:result', (event, response) => {
    if (!isRunner(event) || !response || !active.delete(response.id)) return;
    finish(response.id, response);
    drain();
  });

  function load(sender, request) {
    if (!HISTORY_PROVIDERS.has(request?.provider)
      || typeof request.ticker !== 'string' || typeof request.timeframe !== 'string'
      || !request.range || typeof request.range !== 'object' || Array.isArray(request.range)) {
      throw new Error('Invalid market history request.');
    }
    const { provider, ticker, timeframe, range, connection, symbol } = request;
    const key = JSON.stringify([sender.id, provider, ticker, timeframe, range.from, range.to,
      range.limit, range.session, connection, symbol]);
    const duplicate = shared.get(key);
    if (duplicate) return duplicate;
    if (pending.size >= MAX_PENDING_HISTORY_JOBS) {
      throw new Error('Omega Data Loader is busy. Try loading history again shortly.');
    }
    if (!window) start();
    if (!callers.has(sender)) {
      callers.add(sender);
      const source = sender.id;
      sender.once('destroyed', () => {
        for (const [id, job] of pending) {
          if (job.sender !== sender) continue;
          if (active.has(id)) job.reject(new Error('The chart closed while loading history.'));
          else finish(id, { error: 'The chart closed while loading history.' });
        }
        if (ready) window.webContents.send('market-history:release', source);
      });
    }
    const id = ++nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!ready) stop('Omega Data Loader did not start in time.');
        else if (active.has(id)) stop('Omega Data Loader timed out and will restart on the next request.');
        else finish(id, { error: 'Market history request timed out while waiting in the queue.' });
      }, 120_000);
      pending.set(id, { key, timer, sender, request, resolve, reject });
    });
    shared.set(key, result);
    drain();
    return result;
  }

  return { isRunner, load, stop };
}

module.exports = { createMarketDataWindow };
