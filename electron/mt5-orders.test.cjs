'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { OrderJournal } = require('./order-journal.cjs');
const { getMt5LiveOrderLimits, submitMt5Order, validateMt5OrderRequest } = require('./live-orders.cjs');

const initialVolumeLimit = process.env.OMEGA_MT5_MAX_ORDER_VOLUME;
delete process.env.OMEGA_MT5_MAX_ORDER_VOLUME;
test.after(() => {
  if (initialVolumeLimit === undefined) delete process.env.OMEGA_MT5_MAX_ORDER_VOLUME;
  else process.env.OMEGA_MT5_MAX_ORDER_VOLUME = initialVolumeLimit;
});

const intentId = 'c46840df-ec30-4dda-8fe7-fc4cb25dd27a';
const validOrder = {
  intentId,
  symbol: 'EURUSD',
  side: 'BUY',
  volume: 0.01,
  stopLoss: 1.09,
  takeProfit: 1.12,
};

function withJournal(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-live-order-'));
  const journal = new OrderJournal({ directory });
  return Promise.resolve(run(journal)).finally(() => {
    journal.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
}

test('validates required live order intent fields and normalizes side', () => {
  assert.equal(validateMt5OrderRequest({ ...validOrder, side: ' buy ' }).side, 'BUY');
  assert.throws(() => validateMt5OrderRequest({ ...validOrder, side: 'SHORT' }), /BUY or SELL/);
  assert.throws(() => validateMt5OrderRequest({ ...validOrder, stopLoss: 0 }), /stop-loss/);
  assert.throws(() => validateMt5OrderRequest({ ...validOrder, stopLoss: undefined }), /stop-loss is required/);
  assert.throws(() => validateMt5OrderRequest({ ...validOrder, intentId: 'not-an-id' }), /intent id/);
  assert.equal(getMt5LiveOrderLimits().maxVolume, 1000);
  assert.throws(() => validateMt5OrderRequest({ ...validOrder, volume: 1000.01 }), /configured 1000-lot live-order limit/);
});

test('supports an explicit volume cap and fails closed on invalid configuration', () => {
  const previous = process.env.OMEGA_MT5_MAX_ORDER_VOLUME;
  try {
    process.env.OMEGA_MT5_MAX_ORDER_VOLUME = '0.03';
    assert.deepEqual(getMt5LiveOrderLimits(), { maxVolume: 0.03, source: 'environment' });
    assert.equal(validateMt5OrderRequest({ ...validOrder, volume: 0.03 }).volume, 0.03);
    assert.throws(() => validateMt5OrderRequest({ ...validOrder, volume: 0.04 }), /configured 0.03-lot/);
    process.env.OMEGA_MT5_MAX_ORDER_VOLUME = '10000.01';
    assert.throws(() => getMt5LiveOrderLimits(), /no greater than 10000 lots/);
    process.env.OMEGA_MT5_MAX_ORDER_VOLUME = 'invalid';
    assert.throws(() => getMt5LiveOrderLimits(), /OMEGA_MT5_MAX_ORDER_VOLUME/);
  } finally {
    if (previous === undefined) delete process.env.OMEGA_MT5_MAX_ORDER_VOLUME;
    else process.env.OMEGA_MT5_MAX_ORDER_VOLUME = previous;
  }
});

test('refuses unarmed orders before journal writes or broker calls', async () => {
  await withJournal(async journal => {
    let calls = 0;
    await assert.rejects(
      submitMt5Order({ request: validOrder, armed: false, journal, mt5: { placeOrder: async () => { calls += 1; } } }),
      /not armed/,
    );
    assert.equal(calls, 0);
    assert.equal(journal.recent(10).length, 0);
  });
});

test('refuses to send when durable journal integrity is unavailable', async () => {
  let calls = 0;
  await assert.rejects(
    submitMt5Order({
      request: validOrder,
      armed: true,
      journal: {
        verify: () => ({ ok: false }),
        openEntries: () => [],
        begin() {},
        transition() {},
      },
      mt5: { placeOrder: async () => { calls += 1; } },
    }),
    error => error.phase === 'journal' && /integrity check/.test(error.message),
  );
  assert.equal(calls, 0);
});

test('refuses to send when a prior journal entry is unresolved', async () => {
  let calls = 0;
  await assert.rejects(
    submitMt5Order({
      request: validOrder,
      armed: true,
      journal: {
        verify: () => ({ ok: true }),
        openEntries: () => [{ id: 'existing', status: 'unknown' }],
        begin() {},
        transition() {},
      },
      mt5: { placeOrder: async () => { calls += 1; } },
    }),
    /unresolved journaled order/,
  );
  assert.equal(calls, 0);
});

test('records a successful MT5 order lifecycle as protected', async () => {
  await withJournal(async journal => {
    const result = await submitMt5Order({
      request: validOrder,
      armed: true,
      journal,
      mt5: { placeOrder: async order => ({ status: 'filled', retcode: 10009, side: order.side }) },
    });
    assert.equal(result.status, 'filled');
    assert.equal(result.journalStatus, 'protected');
    assert.equal(journal.get(intentId).status, 'protected');
    assert.equal(journal.openEntries().length, 0);
  });
});

test('records pre-send errors as rejected and uncertain send failures as reconciliation work', async () => {
  await withJournal(async journal => {
    const rejected = new Error('invalid stops');
    rejected.phase = 'pre-send';
    await assert.rejects(
      submitMt5Order({
        request: validOrder,
        armed: true,
        journal,
        mt5: { placeOrder: async () => { throw rejected; } },
      }),
      /invalid stops/,
    );
    assert.equal(journal.get(intentId).status, 'rejected');
    assert.equal(journal.openEntries().length, 0);
  });

  await withJournal(async journal => {
    await assert.rejects(
      submitMt5Order({
        request: validOrder,
        armed: true,
        journal,
        mt5: { placeOrder: async () => { throw new Error('bridge timed out'); } },
      }),
      /may have received order .*reconcile/,
    );
    assert.equal(journal.get(intentId).status, 'unknown');
    assert.equal(journal.openEntries().length, 1);
    await assert.rejects(
      submitMt5Order({
        request: { ...validOrder, intentId: '9c19cd72-d931-4f4a-bcb5-e5fb260f0488' },
        armed: true,
        journal,
        mt5: { placeOrder: async () => ({ status: 'filled' }) },
      }),
      /unresolved journaled order/,
    );
  });
});
