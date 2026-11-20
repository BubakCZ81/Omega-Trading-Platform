import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.document = {
  dispatchEvent() {},
};

const {
  armPineQuantowerAutoTrading,
  disarmPineQuantowerAutoTrading,
  getPineQuantowerAutoTradingAccountId,
  isPineQuantowerAutoTradingArmed,
} = await import('./pineQuantowerAutoTrading.ts');

test('Quantower Pine strategy arming is explicit and bound to the selected connected account', () => {
  disarmPineQuantowerAutoTrading();
  assert.equal(getPineQuantowerAutoTradingAccountId(), null);
  armPineQuantowerAutoTrading('quantower:account-1');
  assert.equal(isPineQuantowerAutoTradingArmed('QUANTOWER:ACCOUNT-1'), true);
  assert.equal(isPineQuantowerAutoTradingArmed('quantower:account-2'), false);
  disarmPineQuantowerAutoTrading();
  assert.equal(isPineQuantowerAutoTradingArmed('quantower:account-1'), false);
});

test('Quantower Pine strategy arming rejects data-only and non-Quantower accounts', () => {
  assert.throws(() => armPineQuantowerAutoTrading('quantower:local'), /connected Quantower account/);
  assert.throws(() => armPineQuantowerAutoTrading('ibkr:DU123456'), /connected Quantower account/);
});
