import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renkoPipsForTimeframe,
  rangePipsForTimeframe,
  isRenkoOrRangeTimeframe,
  resolveInstrumentPipSize,
  buildRenkoBars,
  buildRangeBars,
  averageTrueRange,
  isAtrRenkoTimeframe,
} from './renkoRangeBars.ts';

test('identifies Renko and Range timeframes correctly', () => {
  assert.equal(isAtrRenkoTimeframe('RATR'), true);
  assert.equal(isAtrRenkoTimeframe('R5'), false);
  assert.equal(renkoPipsForTimeframe('R5'), 5);
  assert.equal(renkoPipsForTimeframe('R1'), 1);
  assert.equal(renkoPipsForTimeframe('r20'), 20);
  assert.equal(renkoPipsForTimeframe('R100'), 100);
  assert.equal(renkoPipsForTimeframe('5'), null);
  assert.equal(renkoPipsForTimeframe('T100'), null);
  assert.equal(renkoPipsForTimeframe('R0'), null);

  assert.equal(rangePipsForTimeframe('RG5'), 5);
  assert.equal(rangePipsForTimeframe('rg10'), 10);
  assert.equal(rangePipsForTimeframe('RANGE25'), 25);
  assert.equal(rangePipsForTimeframe('5'), null);
  assert.equal(rangePipsForTimeframe('RG0'), null);

  assert.equal(isRenkoOrRangeTimeframe('R5'), true);
  assert.equal(isRenkoOrRangeTimeframe('RG10'), true);
  assert.equal(isRenkoOrRangeTimeframe('60'), false);
});

test('calculates the locked ATR Renko size from exactly 600 one-minute true ranges', () => {
  const bars = Array.from({ length: 600 }, (_, index) => ({
    time: 1_700_000_000_000 + index * 60_000,
    open: 100 + index * 0.1,
    high: 101 + index * 0.1,
    low: 99 + index * 0.1,
    close: 100.5 + index * 0.1,
  }));
  assert.equal(averageTrueRange(bars, 600), 2);
  assert.equal(averageTrueRange(bars.slice(1), 600), null);
});

test('resolves instrument pip sizes for FX and non-FX symbols', () => {
  assert.equal(resolveInstrumentPipSize('EURUSD', 0.00001, 5), 0.0001);
  assert.equal(resolveInstrumentPipSize('USDJPY', 0.001, 3), 0.01);
  assert.equal(resolveInstrumentPipSize('US30', 1.0, 1), 1.0);
  assert.equal(resolveInstrumentPipSize('BTCUSD', 0.01, 2), 0.01);
  assert.equal(resolveInstrumentPipSize('GBPUSD'), 0.0001);
});

test('buildRenkoBars forms continuation bricks and 2x reversal bricks with wicks', () => {
  const pipSize = 0.0001;
  const brickPips = 5; // boxSize = 0.0005
  const baseTime = 1_700_000_000_000;

  // Simulate price moving from 1.1000 up to 1.1015 (3 up bricks), then dipping to 1.1002 (pullback),
  // then reversing down to 1.0995 (reversal requires 2x = 0.0010 below 1.1015 => <= 1.1005)
  const sourceBars = [
    { time: baseTime, open: 1.1000, high: 1.1006, low: 1.0999, close: 1.1005, volume: 10 },
    { time: baseTime + 60_000, open: 1.1005, high: 1.1012, low: 1.1004, close: 1.1010, volume: 10 },
    { time: baseTime + 120_000, open: 1.1010, high: 1.1017, low: 1.1009, close: 1.1015, volume: 10 },
    // Dip that doesn't trigger reversal (needs <= 1.1005)
    { time: baseTime + 180_000, open: 1.1015, high: 1.1016, low: 1.1008, close: 1.1009, volume: 10 },
    // Reversal plunge down to 1.1000 (crosses 1.1005 reversal threshold)
    { time: baseTime + 240_000, open: 1.1009, high: 1.1010, low: 1.0998, close: 1.1000, volume: 10 },
  ];

  const bricks = buildRenkoBars(sourceBars, brickPips, pipSize);
  assert.ok(bricks.length >= 4, `Expected at least 4 bricks, got ${bricks.length}`);

  // First 3 bricks should be UP bricks of size 0.0005
  assert.equal(bricks[0].open, 1.1000);
  assert.equal(bricks[0].close, 1.1005);
  assert.ok(bricks[0].high >= 1.1005, 'Upper wick on brick 0');
  assert.ok(bricks[0].low <= 1.1000, 'Lower wick on brick 0');

  assert.equal(bricks[1].open, 1.1005);
  assert.equal(bricks[1].close, 1.1010);

  assert.equal(bricks[2].open, 1.1010);
  assert.equal(bricks[2].close, 1.1015);
  assert.equal(bricks[2].high, bricks[2].close, 'Up brick has no same-direction overshoot wick');

  // Next completed brick should be a REVERSAL brick (DOWN)
  // Previous close was 1.1015. Reversal 2x boxSize drops by 0.0010 to 1.1005.
  // Reversal open is at previous open (1.1010), close at 1.1005
  const reversalBrick = bricks[3];
  assert.equal(reversalBrick.open, 1.1010);
  assert.equal(reversalBrick.close, 1.1005);
  assert.ok(reversalBrick.close < reversalBrick.open, 'Reversal brick is bearish');

  // Verify timestamps are strictly increasing
  for (let index = 1; index < bricks.length; index += 1) {
    assert.ok(bricks[index].time > bricks[index - 1].time, `Time must be strictly increasing at index ${index}`);
  }
});

test('does not turn a same-direction multi-brick overshoot into a giant wick', () => {
  const bars = [{ time: 1_700_000_000_000, open: 1.1000, high: 1.1020, low: 1.1000, close: 1.1020, volume: 10 }];
  const bricks = buildRenkoBars(bars, 5, 0.0001);
  assert.equal(bricks[0].high, bricks[0].close, 'first completed up brick has no same-direction wick');
  assert.equal(bricks[1].high, bricks[1].close, 'follow-on up brick has no inherited wick');
  assert.equal(bricks[2].high, bricks[2].close, 'each later brick retains only its body range');
});

test('buildRangeBars ensures every completed bar spans exactly the range size', () => {
  const pipSize = 0.0001;
  const rangePips = 10; // rangeSize = 0.0010
  const baseTime = 1_700_000_000_000;

  const sourceBars = [
    { time: baseTime, open: 1.1000, high: 1.1012, low: 1.0995, close: 1.1008, volume: 50 },
    { time: baseTime + 60_000, open: 1.1008, high: 1.1025, low: 1.1005, close: 1.1022, volume: 50 },
    { time: baseTime + 120_000, open: 1.1022, high: 1.1024, low: 1.1008, close: 1.1010, volume: 50 },
  ];

  const bars = buildRangeBars(sourceBars, rangePips, pipSize);
  assert.ok(bars.length >= 2, `Expected range bars, got ${bars.length}`);

  // Check all completed bars (all except forming last bar)
  for (let index = 0; index < bars.length - 1; index += 1) {
    const bar = bars[index];
    const span = Number((bar.high - bar.low).toFixed(6));
    assert.equal(span, 0.0010, `Completed range bar ${index} must span exactly 0.0010`);

    if (bar.close >= bar.open) {
      // Bullish bar: Close must be at High
      assert.equal(bar.close, bar.high, 'Bullish range bar close is at High');
      assert.ok(bar.low <= bar.open, 'Bullish range bar has lower wick');
    } else {
      // Bearish bar: Close must be at Low
      assert.equal(bar.close, bar.low, 'Bearish range bar close is at Low');
      assert.ok(bar.high >= bar.open, 'Bearish range bar has upper wick');
    }

    // Verify next bar opened at this bar's close
    const nextBar = bars[index + 1];
    assert.equal(nextBar.open, bar.close, `Bar ${index + 1} open must equal bar ${index} close`);
  }

  // Strictly increasing times
  for (let index = 1; index < bars.length; index += 1) {
    assert.ok(bars[index].time > bars[index - 1].time, `Time strictly increasing at index ${index}`);
  }
});

