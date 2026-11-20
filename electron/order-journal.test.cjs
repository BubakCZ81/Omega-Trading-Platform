'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { OrderJournal, readJournal } = require('./order-journal.cjs');
const { submitMt5Order } = require('./live-orders.cjs');

function temporaryJournal(clock) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'omega-order-journal-'));
  const journal = new OrderJournal({ directory, clock });
  return { directory, journal };
}

function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true });
}

test('records an intent and its transitions, and reopens the same state', () => {
  const { directory, journal } = temporaryJournal(() => Date.parse('2026-10-26T10:00:00.000Z'));
  try {
    const entry = journal.begin({
      accountId: 'demo-1',
      environment: 'demo',
      symbolId: '42',
      side: 'BUY',
      volume: 0.5,
      stopLoss: 100,
    });
    journal.transition(entry.id, 'sent', { attempt: 1 });
    journal.transition(entry.id, 'protected', { positionId: 'position-1' });

    const recent = journal.recent(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].id, entry.id);
    assert.equal(recent[0].status, 'protected');
    assert.equal(recent[0].data.volume, 0.5);
    assert.deepEqual(recent[0].details, { positionId: 'position-1' });
    assert.deepEqual(journal.openEntries(), []);
    assert.deepEqual(journal.verify(), {
      ok: true,
      integrity: true,
      tailTruncated: false,
      repairedTail: false,
      records: 3,
    });
    journal.close();

    const reopened = new OrderJournal({ directory });
    try {
      assert.equal(reopened.recent(10)[0].status, 'protected');
      assert.equal(reopened.verify().ok, true);
      assert.deepEqual(reopened.openEntries(), []);
    } finally {
      reopened.close();
    }
  } finally {
    removeDirectory(directory);
  }
});

test('keeps unresolved entries visible for reconciliation', () => {
  const { directory, journal } = temporaryJournal();
  try {
    const sent = journal.begin({ accountId: 'a', symbolId: '1', side: 'BUY', volume: 1, stopLoss: 9 });
    journal.transition(sent.id, 'sent');
    const unknown = journal.begin({ accountId: 'a', symbolId: '1', side: 'SELL', volume: 1, stopLoss: 11 });
    journal.transition(unknown.id, 'sent');
    journal.transition(unknown.id, 'unknown', { error: 'socket closed' });

    assert.deepEqual(journal.openEntries().map((entry) => entry.status).sort(), ['sent', 'unknown']);
  } finally {
    journal.close();
    removeDirectory(directory);
  }
});

test('rejects a duplicate intent id', () => {
  const { directory, journal } = temporaryJournal();
  try {
    journal.begin({ id: 'fixed-id', accountId: 'a', symbolId: '1', side: 'BUY', volume: 1, stopLoss: 9 });
    assert.throws(
      () => journal.begin({ id: 'fixed-id', accountId: 'a', symbolId: '1', side: 'BUY', volume: 1, stopLoss: 9 }),
      /already exists/,
    );
  } finally {
    journal.close();
    removeDirectory(directory);
  }
});

test('fsync failure poisons the journal and prevents another MT5 send', async () => {
  const { directory, journal } = temporaryJournal();
  const originalFsyncSync = fs.fsyncSync;
  const intent = {
    id: '123e4567-e89b-42d3-a456-426614174000',
    accountId: 'demo-1',
    symbolId: 'EURUSD',
    side: 'BUY',
    volume: 0.01,
    stopLoss: 1.05,
  };
  let placeOrderCalls = 0;
  try {
    fs.fsyncSync = () => {
      throw new Error('simulated fsync failure');
    };
    assert.throws(() => journal.begin(intent), /simulated fsync failure/);
    fs.fsyncSync = originalFsyncSync;

    assert.equal(journal.verify().ok, false);
    assert.throws(() => journal.begin({ ...intent, id: '123e4567-e89b-42d3-a456-426614174001' }), /integrity check/);
    await assert.rejects(
      submitMt5Order({
        request: {
          intentId: intent.id,
          symbol: intent.symbolId,
          side: intent.side,
          volume: intent.volume,
          stopLoss: intent.stopLoss,
        },
        armed: true,
        maxVolume: 0.01,
        mt5: {
          async placeOrder() {
            placeOrderCalls += 1;
            return { status: 'filled' };
          },
        },
        journal,
      }),
      /integrity check/,
    );
    assert.equal(placeOrderCalls, 0);
    assert.equal(journal.records.length, 0);
    journal.close();

    const reopened = new OrderJournal({ directory });
    try {
      assert.equal(reopened.verify().ok, true);
      assert.equal(reopened.openEntries().length, 1);
    } finally {
      reopened.close();
    }
  } finally {
    fs.fsyncSync = originalFsyncSync;
    if (!journal.closed) journal.close();
    removeDirectory(directory);
  }
});

test('partial journal writes poison the instance before MT5 can be called', async () => {
  const { directory, journal } = temporaryJournal();
  const originalWriteSync = fs.writeSync;
  const intentId = '123e4567-e89b-42d3-a456-426614174002';
  let placeOrderCalls = 0;
  try {
    fs.writeSync = (fd, data, ...args) => {
      if (typeof data === 'string') return originalWriteSync(fd, data.slice(0, Math.ceil(data.length / 2)), ...args);
      return originalWriteSync(fd, data, ...args);
    };
    assert.throws(
      () => journal.begin({ id: intentId, accountId: 'demo-1', symbolId: 'EURUSD', side: 'BUY', volume: 0.01, stopLoss: 1.05 }),
      /write was incomplete/,
    );
    fs.writeSync = originalWriteSync;

    await assert.rejects(
      submitMt5Order({
        request: { intentId, symbol: 'EURUSD', side: 'BUY', volume: 0.01, stopLoss: 1.05 },
        armed: true,
        maxVolume: 0.01,
        mt5: {
          async placeOrder() {
            placeOrderCalls += 1;
            return { status: 'filled' };
          },
        },
        journal,
      }),
      /integrity check/,
    );
    assert.equal(placeOrderCalls, 0);
    assert.equal(journal.verify().ok, false);
  } finally {
    fs.writeSync = originalWriteSync;
    journal.close();
    removeDirectory(directory);
  }
});

test('ignores an incomplete final line left by a crash', () => {
  const { directory, journal } = temporaryJournal();
  const entry = journal.begin({ accountId: 'a', symbolId: '1', side: 'BUY', volume: 1, stopLoss: 9 });
  journal.transition(entry.id, 'protected');
  journal.close();

  fs.appendFileSync(path.join(directory, 'orders.jsonl'), '{"seq":3,"at":"2026-10-26T10:00:01.000Z"', 'utf8');

  const state = readJournal(path.join(directory, 'orders.jsonl'));
  assert.equal(state.tailTruncated, true);
  assert.equal(state.integrity, true);
  assert.equal(state.records.length, 2);

  const reopened = new OrderJournal({ directory });
  try {
    assert.deepEqual(reopened.verify(), {
      ok: true,
      integrity: true,
      tailTruncated: false,
      repairedTail: true,
      records: 2,
    });
    assert.equal(reopened.recent(10)[0].status, 'protected');

    const next = reopened.begin({ accountId: 'a', symbolId: '1', side: 'SELL', volume: 1, stopLoss: 11 });
    assert.equal(next.status, 'intent');
    reopened.transition(next.id, 'sent');
    assert.equal(readJournal(path.join(directory, 'orders.jsonl')).integrity, true);
  } finally {
    reopened.close();
    removeDirectory(directory);
  }
});

test('detects a modified record and refuses to append to a broken journal', () => {
  const { directory, journal } = temporaryJournal();
  journal.begin({ id: 'order-1', accountId: 'a', symbolId: '1', side: 'BUY', volume: 1, stopLoss: 9 });
  journal.transition('order-1', 'protected');
  journal.close();

  const file = path.join(directory, 'orders.jsonl');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const record = JSON.parse(lines[1]);
  record.status = 'rejected';
  lines[1] = JSON.stringify(record);
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

  const state = readJournal(file);
  assert.equal(state.integrity, false);

  const reopened = new OrderJournal({ directory });
  try {
    assert.equal(reopened.integrity, false);
    assert.throws(
      () => reopened.begin({ accountId: 'a', symbolId: '1', side: 'BUY', volume: 1, stopLoss: 9 }),
      /integrity check/,
    );
  } finally {
    reopened.close();
    removeDirectory(directory);
  }
});

test('resolves an open entry and refuses to resolve a settled one', () => {
  const { directory, journal } = temporaryJournal();
  try {
    const entry = journal.begin({ accountId: 'a', symbolId: '1', side: 'BUY', volume: 1, stopLoss: 9 });
    journal.transition(entry.id, 'sent');
    assert.equal(journal.openEntries().length, 1);

    const resolved = journal.resolve(entry.id, { note: 'checked in cTrader' });
    assert.equal(resolved.status, 'reconciled');
    assert.equal(journal.openEntries().length, 0);
    assert.throws(() => journal.resolve(entry.id), /already reconciled/);
  } finally {
    journal.close();
    removeDirectory(directory);
  }
});

test('refuses a record that is too large for the journal', () => {
  const { directory, journal } = temporaryJournal();
  try {
    assert.throws(
      () => journal.begin({ accountId: 'a', symbolId: '1', side: 'BUY', volume: 1, stopLoss: 9, note: 'x'.repeat(20_000) }),
      /too large/,
    );
  } finally {
    journal.close();
    removeDirectory(directory);
  }
});
