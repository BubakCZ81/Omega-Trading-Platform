import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = {
  dispatchEvent() {},
};

const {
  armPineMt5AutoTrading,
  disarmPineMt5AutoTrading,
  getPineMt5AutoTradingAccountId,
  isPineMt5AutoTradingArmed,
} = await import('./pineStrategyAutoTrading.ts');

test('automatic Pine strategy execution is opt-in and bound to the armed MT5 account', () => {
  disarmPineMt5AutoTrading();
  assert.equal(getPineMt5AutoTradingAccountId(), null);
  armPineMt5AutoTrading('mt5:12345@Demo-Server');
  assert.equal(isPineMt5AutoTradingArmed('MT5:12345@demo-server'), true);
  assert.equal(isPineMt5AutoTradingArmed('mt5:67890@Demo-Server'), false);
  disarmPineMt5AutoTrading();
  assert.equal(isPineMt5AutoTradingArmed('mt5:12345@Demo-Server'), false);
});

test('automatic Pine strategy execution cannot be armed for the local demo account', () => {
  assert.throws(() => armPineMt5AutoTrading('local-demo'), /only be armed for an MT5 account/);
});