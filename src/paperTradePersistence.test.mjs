import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePaperTrades, preservePaperTradeState } from './paperTradePersistence.ts';

function createStorage(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
  };
}

test('malformed trade records are counted and valid trades can still be recovered', () => {
  const valid = { id: 'trade-1' };
  assert.deepEqual(parsePaperTrades(JSON.stringify([valid, null, { id: 2 }]), value => (
    !!value && typeof value === 'object' && typeof value.id === 'string'
  )), { trades: [valid], invalidCount: 2 });
});

test('invalid saved trade state is preserved verbatim in a recovery record', () => {
  const storage = createStorage();
  const raw = '[{"id":"trade-1"},broken';

  assert.throws(() => parsePaperTrades(raw, () => true));
  const key = preservePaperTradeState(storage, 'omega-paper-trades-v1', raw, 123);

  assert.equal(key, 'omega-paper-trades-v1.recovery-123');
  assert.equal(storage.getItem(key), raw);
});

test('recovery records do not overwrite an existing backup', () => {
  const previous = 'previous original data';
  const storage = createStorage({ 'omega-paper-trades-v1.recovery-123': previous });

  const key = preservePaperTradeState(storage, 'omega-paper-trades-v1', 'new original data', 123);

  assert.equal(key, 'omega-paper-trades-v1.recovery-123-1');
  assert.equal(storage.getItem('omega-paper-trades-v1.recovery-123'), previous);
  assert.equal(storage.getItem(key), 'new original data');
});

test('an array is required for saved paper-trade state', () => {
  assert.throws(() => parsePaperTrades('{}', () => true), /not an array/);
});
