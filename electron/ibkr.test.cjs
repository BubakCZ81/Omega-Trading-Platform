'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { IbkrBridge, parseIbkrContract, validateIbkrConnectionConfig } = require('./ibkr.cjs');

const events = {
  connected: 'connected', disconnected: 'disconnected', managedAccounts: 'managedAccounts', nextValidId: 'nextValidId',
  error: 'error', contractDetails: 'contractDetails', contractDetailsEnd: 'contractDetailsEnd', tickPrice: 'tickPrice',
};

class FakeIbApi extends EventEmitter {
  constructor() {
    super();
    this.isConnected = false;
    this.orders = [];
    this.nextId = 40;
  }
  connect(clientId) {
    this.clientId = clientId;
    this.isConnected = true;
    queueMicrotask(() => this.emit('connected'));
  }
  disconnect() { this.isConnected = false; this.emit('disconnected'); }
  reqManagedAccts() { queueMicrotask(() => this.emit('managedAccounts', this.accountsList ?? 'DU123456')); }
  reqIds() { queueMicrotask(() => this.emit('nextValidId', this.nextId)); }
  reqContractDetails(id, contract) {
    queueMicrotask(() => {
      this.emit('contractDetails', id, { contract, minTick: 0.01 });
      this.emit('contractDetailsEnd', id);
    });
  }
  reqMarketDataType() {}
  reqMktData(id) {
    queueMicrotask(() => {
      this.emit('tickPrice', id, 1, 1.1);
      this.emit('tickPrice', id, 2, 1.2);
    });
  }
  cancelMktData() {}
  placeOrder(id, contract, order) { this.orders.push({ id, contract, order }); }
}

function makeBridge(accountsList) {
  let api;
  const bridge = new IbkrBridge({
    apiFactory: () => {
      api = new FakeIbApi();
      if (accountsList !== undefined) api.accountsList = accountsList;
      return api;
    },
    events,
    secTypes: { STK: 'STK', CASH: 'CASH', FUT: 'FUT' },
    actions: { BUY: 'BUY', SELL: 'SELL' },
    orderTypes: { MKT: 'MKT', LMT: 'LMT', STP: 'STP' },
  });
  return { bridge, getApi: () => api };
}

test('IBKR contracts support stocks, forex, and explicitly dated futures', () => {
  assert.deepEqual(parseIbkrContract('AAPL'), { symbol: 'AAPL', secType: 'STK', currency: 'USD', exchange: 'SMART', omegaKind: 'stock' });
  assert.deepEqual(parseIbkrContract('EUR/USD'), { symbol: 'EUR', secType: 'CASH', currency: 'USD', exchange: 'IDEALPRO', omegaKind: 'forex' });
  assert.deepEqual(parseIbkrContract('ES 202609@CME'), {
    symbol: 'ES', secType: 'FUT', currency: 'USD', exchange: 'CME', lastTradeDateOrContractMonth: '202609', omegaKind: 'future',
  });
  assert.throws(() => parseIbkrContract('ESM6'), /compact month code is ambiguous/);
});

test('IBKR connection defaults to local paper TWS and rejects remote hosts', () => {
  assert.deepEqual(validateIbkrConnectionConfig({}), { host: '127.0.0.1', port: 7497, clientId: 31, environment: 'paper' });
  assert.equal(validateIbkrConnectionConfig({ environment: 'live' }).port, 7496);
  assert.throws(() => validateIbkrConnectionConfig({ host: '192.0.2.1' }), /loopback/);
});

test('IBKR refuses to report connected when TWS provides no managed account', async () => {
  const { bridge } = makeBridge('');
  await assert.rejects(bridge.connect({ environment: 'paper' }), /did not report a managed account/);
});

test('IBKR manual order requires confirmation and submits a protected bracket for the selected account', async () => {
  const { bridge, getApi } = makeBridge();
  await bridge.connect({ environment: 'paper' });
  assert.deepEqual(bridge.status().accounts, ['DU123456']);
  await assert.rejects(bridge.placeOrder({ accountId: 'DU123456', symbol: 'AAPL', side: 'BUY', quantity: 2, source: 'manual' }), /Confirm the IBKR order preview/);
  const result = await bridge.placeOrder({
    accountId: 'DU123456', symbol: 'AAPL', side: 'BUY', quantity: 2, stopLoss: 0.9, takeProfit: 1.3,
    source: 'manual', confirmed: true, intentId: 'manual-order-1',
  });
  assert.equal(result.status, 'submitted');
  assert.equal(result.protected, true);
  assert.deepEqual(getApi().orders.map(({ id }) => id), [40, 41, 42]);
  assert.equal(getApi().orders[0].order.account, 'DU123456');
  assert.equal(getApi().orders[0].order.transmit, false);
  assert.equal(getApi().orders[2].order.transmit, true);
  await assert.rejects(bridge.placeOrder({
    accountId: 'DU123456', symbol: 'AAPL', side: 'BUY', quantity: 2, stopLoss: 0.9, takeProfit: 1.3,
    source: 'manual', confirmed: true, intentId: 'manual-order-1',
  }), /already submitted/);
  bridge.accounts.push('U123456');
  await assert.rejects(bridge.placeOrder({
    accountId: 'U123456', symbol: 'AAPL', side: 'BUY', quantity: 2, source: 'manual', confirmed: true, intentId: 'live-account-order',
  }), /appears to be live/);
  await bridge.disconnect();
});

test('IBKR Pine orders require account-bound opt-in and translate FX lots into base currency units', async () => {
  const { bridge, getApi } = makeBridge();
  await bridge.connect({ environment: 'paper' });
  await assert.rejects(bridge.placeOrder({ accountId: 'DU123456', symbol: 'EURUSD', side: 'BUY', quantity: 0.01, source: 'pine' }), /not armed/);
  bridge.armStrategyTrading('DU123456', true);
  const result = await bridge.placeOrder({ accountId: 'DU123456', symbol: 'EURUSD', side: 'BUY', quantity: 0.01, source: 'pine', intentId: 'pine-fill-1' });
  assert.equal(result.quantity, 1000);
  assert.equal(getApi().orders[0].order.totalQuantity, 1000);
  await bridge.disconnect();
});