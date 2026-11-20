import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCTraderLots } from './ctraderTrading.ts';

const constraints = { lotSize: 100_000, minVolume: 1_000, maxVolume: 10_000_000, volumeStep: 1_000 };

test('validates lots against cTrader unit limits and returns the exact unit volume', () => {
  assert.deepEqual(validateCTraderLots(0.01, constraints), { lots: 0.01, volumeInUnits: 1_000 });
  assert.deepEqual(validateCTraderLots(0.02, constraints), { lots: 0.02, volumeInUnits: 2_000 });
});

test('allows exact fractional unit volumes when they align with the symbol step', () => {
  const fractionalUnitConstraints = { lotSize: 1, minVolume: 0.01, maxVolume: 10_000, volumeStep: 0.01 };
  assert.deepEqual(validateCTraderLots(0.01, fractionalUnitConstraints), { lots: 0.01, volumeInUnits: 0.01 });
  assert.throws(() => validateCTraderLots(0.015, fractionalUnitConstraints), /not aligned to the symbol step/);
});

test('rejects lot values that convert below or above symbol volume limits', () => {
  assert.throws(() => validateCTraderLots(0.001, constraints), /outside the symbol limits/);
  assert.throws(() => validateCTraderLots(101, constraints), /outside the symbol limits/);
});

test('rejects volumes that do not align with the symbol step without rounding', () => {
  assert.throws(() => validateCTraderLots(0.015, constraints), /not aligned to the symbol step/);
});

test('rejects invalid constraints and nonpositive lot values', () => {
  assert.throws(() => validateCTraderLots(0, constraints), /lot quantity must be a positive/);
  assert.throws(() => validateCTraderLots(0.01, { ...constraints, volumeStep: 0 }), /volume step must be a positive/);
});

test('reports symbol limits before attempting an unsafe numeric conversion', () => {
  assert.throws(() => validateCTraderLots(1_000_000_000_000, constraints), /outside the symbol limits/);
});

test('rejects unit volumes that exceed JavaScript safe integer precision', () => {
  const largeConstraints = { lotSize: 100_000, minVolume: 1_000, maxVolume: 1e20, volumeStep: 1_000 };
  assert.throws(() => validateCTraderLots(1e14, largeConstraints), /positive, safe volume in units/);
});
