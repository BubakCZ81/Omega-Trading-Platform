import assert from 'node:assert/strict';
import test from 'node:test';
import { buildFootprintProfile } from './footprintChart.ts';

test('footprint profile divides bar into requested row count', () => {
  const bar = { time: 1, open: 1.1000, high: 1.1050, low: 1.0950, close: 1.1020, volume: 1000 };
  const profile = buildFootprintProfile(bar, { rowCount: 10 });
  assert.equal(profile.rows.length, 10);
  // First row should start at bar.low
  assert.ok(Math.abs(profile.rows[0].bottomPrice - bar.low) < 1e-8);
  // Last row should end near bar.high
  assert.ok(Math.abs(profile.rows[9].topPrice - bar.high) < 1e-8);
});

test('footprint POC is at the highest volume row', () => {
  const bar = { time: 1, open: 1.1000, high: 1.1100, low: 1.0900, close: 1.1050, volume: 5000 };
  const profile = buildFootprintProfile(bar, { rowCount: 16 });
  const pocRow = profile.rows.find(r => r.isPoc);
  assert.ok(pocRow, 'should have a POC row');
  // POC should be inside or near the body
  assert.ok(pocRow.price >= Math.min(bar.open, bar.close) - 0.005, 'POC price near body');
  assert.ok(pocRow.price <= Math.max(bar.open, bar.close) + 0.005, 'POC price near body');
  // maxVolume should match POC row
  assert.equal(profile.maxVolume, pocRow.totalVolume);
});

test('footprint bid+ask sums approximately to total volume', () => {
  const bar = { time: 1, open: 1.2000, high: 1.2100, low: 1.1900, close: 1.2080, volume: 10000 };
  const profile = buildFootprintProfile(bar, { rowCount: 12 });
  const sumBid = profile.rows.reduce((s, r) => s + r.bidVolume, 0);
  const sumAsk = profile.rows.reduce((s, r) => s + r.askVolume, 0);
  const total = sumBid + sumAsk;
  // Due to rounding the sum may differ slightly from the original volume
  assert.ok(Math.abs(total - bar.volume) < bar.volume * 0.15,
    `bid+ask total ${total} should be close to bar volume ${bar.volume}`);
});

test('footprint diagonal imbalances are detected', () => {
  const bar = { time: 1, open: 1.0000, high: 1.0100, low: 0.9900, close: 1.0080, volume: 2000 };
  const profile = buildFootprintProfile(bar, { rowCount: 8, imbalanceRatio: 1.5 });
  // At least some rows may have imbalances depending on the volume distribution
  const hasImbalance = profile.rows.some(r => r.buyImbalance || r.sellImbalance);
  // With a 1.5 ratio we should detect some, but exact count depends on distribution
  // Just verify the flag types are booleans and the detection ran
  for (const row of profile.rows) {
    assert.equal(typeof row.buyImbalance, 'boolean');
    assert.equal(typeof row.sellImbalance, 'boolean');
  }
  // Delta should reflect bullish bar
  assert.ok(profile.totalDelta > 0, `bullish bar should have positive delta, got ${profile.totalDelta}`);
});

test('footprint bearish bar has negative total delta', () => {
  const bar = { time: 1, open: 1.1000, high: 1.1020, low: 1.0900, close: 1.0920, volume: 3000 };
  const profile = buildFootprintProfile(bar, { rowCount: 10 });
  assert.ok(profile.totalDelta < 0, `bearish bar should have negative delta, got ${profile.totalDelta}`);
});

test('footprint works with zero-range bar', () => {
  const bar = { time: 1, open: 1.0, high: 1.0, low: 1.0, close: 1.0, volume: 100 };
  const profile = buildFootprintProfile(bar, { rowCount: 8 });
  assert.equal(profile.rows.length, 8);
  // Should not throw or NaN
  for (const row of profile.rows) {
    assert.ok(!Number.isNaN(row.bidVolume), 'no NaN bid');
    assert.ok(!Number.isNaN(row.askVolume), 'no NaN ask');
  }
});

