'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { Mt5LiveOrderGate } = require('./live-order-gate.cjs');

function connectedStatus(overrides = {}) {
  return {
    connected: true,
    tradingAllowed: true,
    accountLogin: '123456',
    server: 'Demo Server',
    accountMode: 'demo',
    ...overrides,
  };
}

test('stays armed but rejects an order if the signed-in account changes after arming', async () => {
  let current = connectedStatus();
  let submitted = 0;
  const gate = new Mt5LiveOrderGate({
    getStatus: async () => current,
    submitOrder: async () => { submitted += 1; return { status: 'protected' }; },
  });
  assert.equal((await gate.arm(true)).armed, true);
  current = connectedStatus({ accountLogin: '654321' });

  const observed = await gate.status();
  assert.equal(observed.armed, true);
  await assert.rejects(gate.submit({}), /changed/);
  assert.equal(submitted, 0);
});

test('rechecks the armed account immediately before an order submission', async () => {
  let current = connectedStatus();
  let submitted = 0;
  const gate = new Mt5LiveOrderGate({
    getStatus: async () => current,
    submitOrder: async () => { submitted += 1; return { status: 'protected' }; },
  });
  await gate.arm(true);
  current = connectedStatus({ server: 'Different Server' });

  await assert.rejects(gate.submit({}), /changed/);
  assert.equal((await gate.status()).armed, true);
  assert.equal(submitted, 0);
});

test('stays armed when status omits account identity while live trading is armed', async () => {
  let current = connectedStatus();
  const gate = new Mt5LiveOrderGate({
    getStatus: async () => current,
    submitOrder: async () => ({ status: 'protected' }),
  });
  await gate.arm(true);
  current = connectedStatus({ accountLogin: '' });

  const observed = await gate.status();
  assert.equal(observed.armed, true);
});

test('rejects concurrent submissions instead of queueing a second live order', async () => {
  let releaseFirst;
  let submitted = 0;
  const gate = new Mt5LiveOrderGate({
    getStatus: async () => connectedStatus(),
    submitOrder: async () => {
      submitted += 1;
      await new Promise(resolve => { releaseFirst = resolve; });
      return { status: 'protected' };
    },
  });
  await gate.arm(true);
  const first = gate.submit({ intentId: 'first' });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(gate.submit({ intentId: 'second' }), /already in progress/);
  assert.equal(submitted, 1);
  releaseFirst();
  assert.equal((await first).status, 'protected');
  assert.equal(submitted, 1);
});

test('a confirmed chart order can enable trading after the terminal starts permitting it', async () => {
  let current = connectedStatus({ tradingAllowed: false, terminalTradingAllowed: false });
  const submissions = [];
  const gate = new Mt5LiveOrderGate({
    getStatus: async () => current,
    submitOrder: async (request, binding) => { submissions.push({ request, binding }); return { status: 'protected' }; },
  });
  const order = { confirmedAccountId: 'mt5:123456@Demo Server' };
  await assert.rejects(gate.arm(true), /Enable Algo Trading/);
  assert.equal(gate.binding(), null);
  await assert.rejects(gate.submit(order), /Enable Algo Trading/);
  assert.equal(submissions.length, 0);

  current = connectedStatus();
  await assert.rejects(gate.submit({ confirmedAccountId: 'mt5:654321@Demo Server' }), /does not match/);
  assert.equal(submissions.length, 0);
  assert.equal(gate.binding(), null);
  assert.equal((await gate.submit(order)).status, 'protected');
  assert.deepEqual(submissions[0].binding, { login: '123456', server: 'Demo Server' });
});

test('a provider disconnect cancels recovery while the terminal status is in flight', async () => {
  let resolveStatus;
  const gate = new Mt5LiveOrderGate({
    getStatus: () => new Promise(resolve => { resolveStatus = resolve; }),
    submitOrder: async () => assert.fail('Unexpected order submission'),
  });
  const order = gate.submit({ confirmedAccountId: 'mt5:123456@Demo Server' });
  gate.disarm();
  resolveStatus(connectedStatus());
  await assert.rejects(order, /session changed/);
  assert.equal(gate.binding(), null);
});
