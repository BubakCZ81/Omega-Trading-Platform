import assert from 'node:assert/strict';
import test from 'node:test';
import {
  findSupplyDemandZones,
  normalizeSupplyDemandSettings,
} from './supplyDemandAlgorithm.ts';

const settings = {
  swingStrength: 1,
  atrPeriod: 2,
  departureAtr: 0.5,
  confirmationWindow: 3,
  maxZones: 5,
  zoneBasis: 'wick',
  removeInvalidated: true,
  showLabels: true,
};

function bars(rows) {
  return rows.map(([open, high, low, close], index) => ({
    time: index * 60_000,
    open,
    high,
    low,
    close,
    volume: 100,
  }));
}

test('marks a confirmed supply pivot only after an ATR-sized departure', () => {
  const candles = bars([
    [102, 106, 101, 103],
    [106, 108, 103, 107],
    [109, 110, 106, 108],
    [106, 109, 105, 107],
    [105, 108, 104, 106],
  ]);
  assert.deepEqual(findSupplyDemandZones(candles, settings), [{
    side: 'supply',
    pivotIndex: 2,
    pivotTime: 120_000,
    top: 110,
    bottom: 109,
    invalidated: false,
  }]);
});

test('marks a confirmed demand pivot after price departs upward', () => {
  const candles = bars([
    [106, 109, 104, 105],
    [104, 107, 102, 103],
    [101, 104, 100, 102],
    [104, 105, 101, 103],
    [104, 108, 103, 107],
  ]);
  assert.deepEqual(findSupplyDemandZones(candles, settings), [{
    side: 'demand',
    pivotIndex: 2,
    pivotTime: 120_000,
    top: 102,
    bottom: 100,
    invalidated: false,
  }]);
});

test('does not expose unconfirmed pivots or pivots without strong departure', () => {
  const unconfirmed = bars([
    [102, 106, 101, 103],
    [106, 108, 103, 107],
    [109, 110, 106, 108],
  ]);
  assert.deepEqual(findSupplyDemandZones(unconfirmed, settings), []);

  const weakDeparture = bars([
    [102, 106, 101, 103],
    [106, 108, 103, 107],
    [109, 110, 106, 108],
    [108, 109, 107, 108],
    [108, 109, 107, 108],
  ]);
  assert.deepEqual(findSupplyDemandZones(weakDeparture, { ...settings, departureAtr: 1.5 }), []);
});

test('removes close-invalidated zones or keeps them marked when configured', () => {
  const candles = bars([
    [102, 106, 101, 103],
    [106, 108, 103, 107],
    [109, 110, 106, 108],
    [106, 109, 105, 107],
    [105, 108, 104, 106],
    [111, 112, 103, 111],
  ]);

  assert.deepEqual(findSupplyDemandZones(candles, settings), []);
  assert.deepEqual(
    findSupplyDemandZones(candles, { ...settings, removeInvalidated: false }),
    [{
      side: 'supply',
      pivotIndex: 2,
      pivotTime: 120_000,
      top: 110,
      bottom: 109,
      invalidated: true,
    }],
  );
});

test('body boundaries and invalid settings use bounded defaults', () => {
  const candles = bars([
    [102, 106, 101, 103],
    [106, 108, 103, 107],
    [109, 110, 106, 108],
    [106, 109, 105, 107],
    [105, 108, 104, 106],
  ]);
  assert.equal(findSupplyDemandZones(candles, { ...settings, zoneBasis: 'body' })[0]?.bottom, 108);
  assert.deepEqual(normalizeSupplyDemandSettings({
    swingStrength: 0,
    atrPeriod: 999,
    departureAtr: Number.NaN,
    confirmationWindow: -1,
    maxZones: 100,
    zoneBasis: 'other',
    removeInvalidated: 'no',
    showLabels: 0,
  }), {
    swingStrength: 2,
    atrPeriod: 200,
    departureAtr: 0.8,
    confirmationWindow: 1,
    maxZones: 20,
    zoneBasis: 'wick',
    removeInvalidated: true,
    showLabels: true,
  });
});
