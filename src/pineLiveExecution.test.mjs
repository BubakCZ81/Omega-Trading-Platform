import assert from 'node:assert/strict';
import test from 'node:test';

let selectedAccount = 'mt5:12345@Demo-Server';
let placedOrders = [];
let closedPositions = [];
let ibkrOrders = [];
let quantowerOrders = [];
let saxoOrders = [];
let placeOrderResult = { status: 'filled', result: { position: 1001, volume: 0.5 } };

globalThis.localStorage = {
  getItem: key => key === 'omega.selected-trading-account' ? selectedAccount : null,
};
globalThis.document = { dispatchEvent() {} };
globalThis.window = {
  velaMt5: {
    tradingStatus: async () => ({
      connected: true,
      tradingAllowed: true,
      terminalTradingAllowed: true,
      accountTradingAllowed: true,
      accountMode: 'demo',
      accountLogin: '12345',
      server: 'Demo-Server',
    }),
    placeOrder: async request => {
      placedOrders.push(request);
      return placeOrderResult;
    },
    closePosition: async request => {
      closedPositions.push(request);
      return { status: 'filled' };
    },
  },
  velaIbkr: {
    placeOrder: async request => {
      ibkrOrders.push(request);
      return { status: 'submitted', orderId: ibkrOrders.length, quantity: request.quantity, quoteTimeMsc: Date.now(), protected: false };
    },
  },
  velaQuantower: {
    accounts: async () => [{ id: 'account-1' }],
    placeOrder: async request => {
      quantowerOrders.push(request);
      return { status: 'submitted', orderId: quantowerOrders.length };
    },
  },
  velaSaxo: {
    placeOrder: async request => {
      saxoOrders.push(request);
      return { status: 'submitted', orderId: saxoOrders.length };
    },
  },
};

const { submitPineLiveFill } = await import('./pineLiveExecution.ts');
const { armPineMt5AutoTrading, disarmPineMt5AutoTrading } = await import('./pineStrategyAutoTrading.ts');
const { armPineIbkrAutoTrading, disarmPineIbkrAutoTrading } = await import('./pineIbkrAutoTrading.ts');
const { armPineQuantowerAutoTrading, disarmPineQuantowerAutoTrading } = await import('./pineQuantowerAutoTrading.ts');
const { armPineSaxoAutoTrading, disarmPineSaxoAutoTrading } = await import('./pineSaxoAutoTrading.ts');

test('MT5 Pine strategy orders require auto-trading opt-in and submit a filled strategy order', async () => {
  disarmPineMt5AutoTrading();
  placedOrders = [];
  const protection = { stopLoss: 1.09, takeProfit: 1.12 };
  await assert.rejects(
    submitPineLiveFill(selectedAccount, 'MT5:EURUSD', 'BUY', 0.5, 'pine-trade-1', 'open', protection),
    /not armed/,
  );
  assert.equal(placedOrders.length, 0);

  armPineMt5AutoTrading(selectedAccount);
  assert.equal(await submitPineLiveFill(selectedAccount, 'MT5:EURUSD', 'BUY', 0.5, 'pine-trade-1', 'open', protection), 'filled');
  assert.equal(placedOrders.length, 1);
  assert.equal(placedOrders[0].symbol, 'EURUSD');
  assert.equal(placedOrders[0].side, 'BUY');
  assert.equal(placedOrders[0].stopLoss, protection.stopLoss);
  assert.equal(placedOrders[0].takeProfit, protection.takeProfit);
});

test('MT5 Pine strategy closes use tracked broker tickets and non-fills are surfaced', async () => {
  closedPositions = [];
  await submitPineLiveFill(selectedAccount, 'EURUSD', 'BUY', 0.5, 'pine-trade-1', 'close');
  assert.equal(closedPositions[0].positionTicket, '1001');
  assert.equal(closedPositions[0].side, 'BUY');

  placeOrderResult = { status: 'rejected', result: { comment: 'rejected' } };
  const protection = { stopLoss: 1.09, takeProfit: 1.12 };
  await assert.rejects(submitPineLiveFill(selectedAccount, 'EURUSD', 'SELL', 0.25, 'pine-trade-2', 'open', protection), /returned rejected/);
  placeOrderResult = { status: 'filled', result: { position: 1002, volume: 0.5 } };
  disarmPineMt5AutoTrading();
});

test('IBKR Pine strategy fills require opt-in and close only tracked quantities', async () => {
  selectedAccount = 'ibkr:DU123456';
  ibkrOrders = [];
  disarmPineIbkrAutoTrading();
  const protection = { stopLoss: 1.09, takeProfit: 1.12 };
  await assert.rejects(submitPineLiveFill(selectedAccount, 'IBKR:EURUSD', 'BUY', 0.01, 'ibkr-pine-1', 'open', protection), /not armed/);
  assert.equal(ibkrOrders.length, 0);

  armPineIbkrAutoTrading(selectedAccount);
  assert.equal(await submitPineLiveFill(selectedAccount, 'IBKR:EURUSD', 'BUY', 0.01, 'ibkr-pine-1', 'open', protection), 'submitted');
  assert.equal(ibkrOrders[0].symbol, 'EURUSD');
  assert.equal(ibkrOrders[0].source, 'pine');
  assert.equal(ibkrOrders[0].stopLoss, protection.stopLoss);
  await submitPineLiveFill(selectedAccount, 'EURUSD', 'BUY', 0.01, 'ibkr-pine-1', 'close');
  assert.equal(ibkrOrders[1].side, 'SELL');
  assert.equal(ibkrOrders[1].quantity, 0.01);
  await assert.rejects(submitPineLiveFill(selectedAccount, 'EURUSD', 'BUY', 0.01, 'ibkr-pine-2', 'close'), /no tracked position/);
  disarmPineIbkrAutoTrading();
});

test('Quantower Pine entries require chart confirmation and a connected selected account', async () => {
  selectedAccount = 'quantower:account-1';
  quantowerOrders = [];
  disarmPineQuantowerAutoTrading();
  const protection = { stopLoss: 5000, takeProfit: 5100 };
  await assert.rejects(
    submitPineLiveFill(selectedAccount, 'Quantower:ES', 'BUY', 1, 'quantower-pine-1', 'open', protection),
    /not armed/,
  );
  assert.equal(quantowerOrders.length, 0);

  armPineQuantowerAutoTrading(selectedAccount);
  await assert.rejects(
    submitPineLiveFill(selectedAccount, 'Quantower:ES', 'BUY', 1, 'quantower-pine-1', 'open', protection),
    /Confirm the Quantower Pine order/,
  );
  await assert.rejects(
    submitPineLiveFill(selectedAccount, 'Quantower:ES', 'BUY', 1, 'quantower-pine-missing', 'close', { confirmed: true }),
    /no tracked position/,
  );
  assert.equal(quantowerOrders.length, 0);
  assert.equal(await submitPineLiveFill(selectedAccount, 'Quantower:ES', 'BUY', 1, 'quantower-pine-1', 'open', { confirmed: true }), 'submitted');
  assert.deepEqual(quantowerOrders, [{ accountId: 'account-1', symbol: 'ES', side: 'BUY', quantity: 1 }]);
  disarmPineQuantowerAutoTrading();
});

test('Saxo Pine strategy orders require opt-in and forward explicit protection', async () => {
  selectedAccount = 'saxo:account-1';
  saxoOrders = [];
  disarmPineSaxoAutoTrading();
  const protection = { stopLoss: 1.09, takeProfit: 1.12 };
  await assert.rejects(
    submitPineLiveFill(selectedAccount, 'SAXO:EURUSD', 'BUY', 10_000, 'saxo-pine-1', 'open', protection),
    /not armed/,
  );
  assert.equal(saxoOrders.length, 0);

  armPineSaxoAutoTrading(selectedAccount);
  assert.equal(
    await submitPineLiveFill(selectedAccount, 'SAXO:EURUSD', 'BUY', 10_000, 'saxo-pine-1', 'open', protection),
    'submitted',
  );
  assert.equal(saxoOrders[0].accountKey, 'account-1');
  assert.equal(saxoOrders[0].source, 'pine');
  assert.equal(saxoOrders[0].stopLoss, protection.stopLoss);
  await submitPineLiveFill(selectedAccount, 'EURUSD', 'BUY', 10_000, 'saxo-pine-1', 'close');
  assert.equal(saxoOrders[1].side, 'SELL');
  disarmPineSaxoAutoTrading();
});

test('Pine strategy entries without a stop-loss are blocked before broker calls', async () => {
  selectedAccount = 'ibkr:DU123456';
  quantowerOrders = [];
  ibkrOrders = [];
  await assert.rejects(
    submitPineLiveFill(selectedAccount, 'AAPL', 'BUY', 1, 'pine-missing-stop', 'open'),
    /positive strategy stop-loss is required/,
  );
  assert.equal(ibkrOrders.length, 0);
  assert.equal(quantowerOrders.length, 0);
});
