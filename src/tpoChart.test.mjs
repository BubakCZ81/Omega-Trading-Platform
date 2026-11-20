import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTapProfile } from './tpoChart.ts';

const levels = [
  { price: 1.0990, durationMs: 1_000 },
  { price: 1.1010, durationMs: 6_000 },
  { price: 1.1030, durationMs: 3_000 },
];

test('buildTapProfile divides tick-derived time into specified row count brackets', () => {
  const bar = {
    time: 1_700_000_000_000,
    open: 1.1000,
    high: 1.1040,
    low: 1.0980,
    close: 1.1020,
    volume: 1000,
  };

  const profile = buildTapProfile(bar, levels, { rowCount: 16 });
  assert.equal(profile.brackets.length, 16);
  assert.equal(profile.high, 1.1040);
  assert.equal(profile.low, 1.0980);
});

test('buildTapProfile identifies the longest elapsed-time row as POC', () => {
  const bar = {
    time: 1_700_000_000_000,
    open: 1.1000,
    high: 1.1050,
    low: 1.0950,
    close: 1.1010,
    volume: 500,
  };

  const profile = buildTapProfile(bar, levels, { rowCount: 20 });
  const pocBrackets = profile.brackets.filter(bracket => bracket.isPoc);

  assert.equal(pocBrackets.length, 1, 'Exactly one POC bracket must be designated');
  assert.equal(pocBrackets[0].durationMs, profile.maxDurationMs, 'POC bracket must have max elapsed time');
  assert.ok(pocBrackets[0].inValueArea, 'POC must be inside the Value Area');
  assert.ok(profile.pocPrice >= bar.low && profile.pocPrice <= bar.high, 'POC price is within bar range');
});

test('buildTapProfile calculates Value Area from elapsed milliseconds', () => {
  const bar = {
    time: 1_700_000_000_000,
    open: 1.1000,
    high: 1.1080,
    low: 1.0920,
    close: 1.1030,
    volume: 1500,
  };

  const profile = buildTapProfile(bar, levels, { rowCount: 18, valueAreaPct: 70 });
  const vaBrackets = profile.brackets.filter(bracket => bracket.inValueArea);
  const vaDuration = vaBrackets.reduce((sum, b) => sum + b.durationMs, 0);

  assert.ok(vaDuration >= profile.totalDurationMs * 0.70, `Value Area must encompass >= 70% of elapsed time (got ${vaDuration}/${profile.totalDurationMs})`);
  assert.ok(profile.vahPrice > profile.valPrice, 'VAH must be higher than VAL');
  assert.ok(profile.vahPrice <= bar.high, 'VAH must be <= bar High');
  assert.ok(profile.valPrice >= bar.low, 'VAL must be >= bar Low');
});

