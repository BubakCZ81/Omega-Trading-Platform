'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createMarketDataWindow } = require('./market-data-window.cjs');

test('deduplicates identical history loads, caps active work and rejects pending work on crash', async t => {
  const ipcMain = new EventEmitter();
  const sent = [];
  let runner;
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      runner = this;
      this.webContents = Object.assign(new EventEmitter(), {
        mainFrame: {}, setWindowOpenHandler() {},
        send(_channel, payload) { sent.push(payload); },
      });
    }
    isDestroyed() { return false; }
    destroy() { this.emit('closed'); }
    async loadURL(url) { this.webContents.mainFrame.url = url; }
  }
  const loader = createMarketDataWindow({
    BrowserWindow: FakeWindow, ipcMain, isDev: true, devServerUrl: 'http://localhost:5173', observeProcess() {},
  });
  t.after(() => loader.stop());
  const sender = Object.assign(new EventEmitter(), { id: 1 });
  const request = { provider: 'mt5', ticker: 'EURUSD', timeframe: '1', range: { limit: 500 } };
  const first = loader.load(sender, request);
  assert.equal(loader.load(sender, { ...request, range: { limit: 500 } }), first);
  const remaining = Promise.allSettled(Array.from({ length: 63 }, (_, index) =>
    loader.load(sender, { ...request, range: { limit: index + 1 } })));
  assert.throws(() => loader.load(sender, { ...request, ticker: 'GBPUSD' }), /busy/);

  const event = { sender: runner.webContents, senderFrame: runner.webContents.mainFrame };
  ipcMain.emit('market-history:ready', event);
  assert.equal(sent.length, 4);
  ipcMain.emit('market-history:result', event, { id: sent[0].id, result: { bars: [] } });
  assert.deepEqual(await first, { bars: [] });
  assert.equal(sent.length, 5);
  runner.webContents.emit('render-process-gone');
  assert.ok((await remaining).every(item => item.status === 'rejected'));
});
