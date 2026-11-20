/**
 * cTrader-style Renko and Range bar calculations with full wick support.
 *
 * In cTrader, Renko and Range are bar periods (timeframes) that feed real OHLCV
 * bars to the candlestick renderer, rather than visual overlays on time-based charts:
 *
 * 1. Renko:
 *    - Brick size S = brickPips * pipSize
 *    - Continuation: Price moves >= S in the current direction.
 *    - Reversal: Price moves >= 2 * S in the opposite direction (cTrader standard).
 *    - Wicks: Upper and lower excursions during the brick's formation are recorded
 *      in high and low, giving true cTrader-style wicks.
 *
 * 2. Range:
 *    - Range size R = rangePips * pipSize
 *    - Completion: A bar completes as soon as High - Low >= R.
 *    - Bullish breakout: Close = Low + R (High = Close, lower wick = Open - Low).
 *    - Bearish breakout: Close = High - R (Low = Close, upper wick = High - Open).
 *    - Next bar opens immediately at the previous bar's Close.
 */

import type { OHLCV } from '@luxalgo/vela';
import { inferPipSize } from './pipSize.ts';

export interface RenkoRangeOptions {
  maxBars?: number;
}

/** Check if a timeframe string represents Renko pips (e.g. 'R5', 'R10'). */
export function renkoPipsForTimeframe(timeframe: string): number | null {
  const match = /^R([1-9]\d{0,3})$/i.exec(timeframe.trim());
  if (!match) return null;
  const pips = Number(match[1]);
  return Number.isSafeInteger(pips) && pips >= 1 && pips <= 3000 ? pips : null;
}

/** `RATR` locks a Renko box to the average true range of the latest 600 M1 bars. */
export function isAtrRenkoTimeframe(timeframe: string): boolean {
  return timeframe.trim().toUpperCase() === 'RATR';
}

/**
 * The fixed box size for ATR Renko. This is a simple average of true ranges,
 * not a rolling value: callers calculate it once per chart session and retain it.
 */
export function averageTrueRange(bars: readonly OHLCV[], lookback = 600): number | null {
  const sample = bars.filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)).slice(-lookback);
  if (sample.length < lookback) return null;
  let sum = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const bar = sample[index];
    const previousClose = index > 0 ? sample[index - 1].close : bar.open;
    sum += Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  }
  const atr = sum / sample.length;
  return Number.isFinite(atr) && atr > 0 ? atr : null;
}

/** Check if a timeframe string represents Range pips (e.g. 'RG5', 'RG10', 'RANGE5'). */
export function rangePipsForTimeframe(timeframe: string): number | null {
  const match = /^(?:RG|RANGE)([1-9]\d{0,3})$/i.exec(timeframe.trim());
  if (!match) return null;
  const pips = Number(match[1]);
  return Number.isSafeInteger(pips) && pips >= 1 && pips <= 3000 ? pips : null;
}

/** Check if a timeframe is any Renko or Range period. */
export function isRenkoOrRangeTimeframe(timeframe: string): boolean {
  return isAtrRenkoTimeframe(timeframe) || renkoPipsForTimeframe(timeframe) !== null || rangePipsForTimeframe(timeframe) !== null;
}

/** Resolve effective pip size for a symbol, taking broker metadata into account. */
export function resolveInstrumentPipSize(symbol: string, minTick?: unknown, digits?: unknown): number {
  const numDigits = typeof digits === 'number' && Number.isFinite(digits) ? digits : undefined;
  const numMinTick = typeof minTick === 'number' && Number.isFinite(minTick) && minTick > 0 ? minTick : undefined;
  const normalizedSymbol = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const isIndex = /^(?:US30|US100|US500|US2000|NAS100|USTEC|SPX500|SP500|DE40|GER40|DAX40|UK100|JP225|AUS200|HK50|EU50|STOXX50|DJI|DJ30|WS30)/.test(normalizedSymbol);
  // Some MT5 index symbols quote tenths (for example US30 at point=0.1),
  // while the Renko size menu is expressed in whole index points (pips).
  if (isIndex && numMinTick !== undefined && numMinTick < 1 && numDigits !== undefined && numDigits <= 2) {
    return numMinTick * 10;
  }
  if (numDigits !== undefined && numMinTick !== undefined) {
    if (numDigits === 3 || numDigits === 5) return numMinTick * 10;
    return numMinTick;
  }
  return inferPipSize(symbol) ?? 0.0001;
}

interface InternalBrick {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  direction: 1 | -1;
}

/**
 * Builds wick-enabled Renko bricks from the ordered source-price path.
 * Each completed brick requires 1x box size for continuation and 2x box size for reversal.
 */
export function buildRenkoBars(
  sourceBars: readonly OHLCV[],
  brickPips: number,
  pipSize: number,
  options: RenkoRangeOptions = {},
): OHLCV[] {
  if (sourceBars.length === 0) return [];
  const boxSize = brickPips * pipSize;
  if (!Number.isFinite(boxSize) || boxSize <= 0) return [];

  const maxBars = Math.max(10, options.maxBars ?? 50_000);
  const bricks: InternalBrick[] = [];

  let anchor = sourceBars[0].open;
  let direction: 1 | -1 | 0 = 0;
  let lastTime = -1;

  // Track forming brick extremes for wick calculation
  let runningHigh = anchor;
  let runningLow = anchor;
  let runningVolume = 0;

  const processPrice = (price: number, time: number, volumeSlice: number) => {
    runningHigh = Math.max(runningHigh, price);
    runningLow = Math.min(runningLow, price);
    runningVolume += volumeSlice;

    // Safety brake
    let iteration = 0;
    while (iteration++ < 200 && bricks.length < maxBars) {
      if (direction === 0) {
        // Initial brick: price must move 1x boxSize up or down from initial anchor
        if (price >= anchor + boxSize) {
          direction = 1;
          const open = anchor;
          const close = anchor + boxSize;
          const brickTime = Math.max(time, lastTime + 1);
          lastTime = brickTime;
          bricks.push({
            time: brickTime,
            open,
            high: close,
            low: Math.min(runningLow, open),
            close,
            volume: runningVolume,
            direction: 1,
          });
          anchor = close;
          runningHigh = close;
          runningLow = close;
          runningVolume = 0;
        } else if (price <= anchor - boxSize) {
          direction = -1;
          const open = anchor;
          const close = anchor - boxSize;
          const brickTime = Math.max(time, lastTime + 1);
          lastTime = brickTime;
          bricks.push({
            time: brickTime,
            open,
            high: Math.max(runningHigh, open),
            low: close,
            close,
            volume: runningVolume,
            direction: -1,
          });
          anchor = close;
          runningHigh = close;
          runningLow = close;
          runningVolume = 0;
        } else {
          break;
        }
      } else if (direction === 1) {
        // Current direction is UP:
        // 1. Continuation: price >= anchor + boxSize (anchor is previous close)
        if (price >= anchor + boxSize) {
          const open = anchor;
          const close = anchor + boxSize;
          const brickTime = Math.max(time, lastTime + 1);
          lastTime = brickTime;
          bricks.push({
            time: brickTime,
            open,
            high: close,
            low: Math.min(runningLow, open),
            close,
            volume: runningVolume,
            direction: 1,
          });
          anchor = close;
          runningHigh = close;
          runningLow = close;
          runningVolume = 0;
        }
        // 2. Reversal (cTrader requires 2x box size drop from previous close):
        else if (price <= anchor - 2 * boxSize) {
          const open = anchor - boxSize; // Previous brick's open
          const close = anchor - 2 * boxSize;
          const brickTime = Math.max(time, lastTime + 1);
          lastTime = brickTime;
          bricks.push({
            time: brickTime,
            open,
            high: Math.max(runningHigh, open),
            low: close,
            close,
            volume: runningVolume,
            direction: -1,
          });
          direction = -1;
          anchor = close;
          runningHigh = close;
          runningLow = close;
          runningVolume = 0;
        } else {
          break;
        }
      } else {
        // Current direction is DOWN:
        // 1. Continuation: price <= anchor - boxSize
        if (price <= anchor - boxSize) {
          const open = anchor;
          const close = anchor - boxSize;
          const brickTime = Math.max(time, lastTime + 1);
          lastTime = brickTime;
          bricks.push({
            time: brickTime,
            open,
            high: Math.max(runningHigh, open),
            low: close,
            close,
            volume: runningVolume,
            direction: -1,
          });
          anchor = close;
          runningHigh = close;
          runningLow = close;
          runningVolume = 0;
        }
        // 2. Reversal (cTrader requires 2x box size rally from previous close):
        else if (price >= anchor + 2 * boxSize) {
          const open = anchor + boxSize; // Previous brick's open
          const close = anchor + 2 * boxSize;
          const brickTime = Math.max(time, lastTime + 1);
          lastTime = brickTime;
          bricks.push({
            time: brickTime,
            open,
            high: close,
            low: Math.min(runningLow, open),
            close,
            volume: runningVolume,
            direction: 1,
          });
          direction = 1;
          anchor = close;
          runningHigh = close;
          runningLow = close;
          runningVolume = 0;
        } else {
          break;
        }
      }
    }
  };

  for (const bar of sourceBars) {
    if (bricks.length >= maxBars) break;
    const volSlice = (bar.volume ?? 0) / 4;
    // Approximate intra-bar path: Open -> Low -> High -> Close (if bull), Open -> High -> Low -> Close (if bear)
    if (bar.close >= bar.open) {
      processPrice(bar.open, bar.time, volSlice);
      processPrice(bar.low, bar.time, volSlice);
      processPrice(bar.high, bar.time, volSlice);
      processPrice(bar.close, bar.time, volSlice);
    } else {
      processPrice(bar.open, bar.time, volSlice);
      processPrice(bar.high, bar.time, volSlice);
      processPrice(bar.low, bar.time, volSlice);
      processPrice(bar.close, bar.time, volSlice);
    }
  }

  // Include active forming brick if there are pending price moves
  if (bricks.length > 0) {
    const lastBar = sourceBars.at(-1);
    if (lastBar) {
      const formingTime = Math.max(lastBar.time, lastTime + 1);
      const open = anchor;
      const close = lastBar.close;
      bricks.push({
        time: formingTime,
        open,
        high: Math.max(runningHigh, open, close),
        low: Math.min(runningLow, open, close),
        close,
        volume: runningVolume,
        direction: close >= open ? 1 : -1,
      });
    }
  }

  return bricks.map(({ direction: _dir, ...bar }) => bar);
}

/**
 * Builds cTrader-style Range bars from source OHLCV bars.
 * Each completed bar has High - Low = rangeSize.
 * Bullish breakout: Close = High = Low + R (lower wick = Open - Low).
 * Bearish breakout: Close = Low = High - R (upper wick = High - Open).
 */
export function buildRangeBars(
  sourceBars: readonly OHLCV[],
  rangePips: number,
  pipSize: number,
  options: RenkoRangeOptions = {},
): OHLCV[] {
  if (sourceBars.length === 0) return [];
  const rangeSize = rangePips * pipSize;
  if (!Number.isFinite(rangeSize) || rangeSize <= 0) return [];

  const maxBars = Math.max(10, options.maxBars ?? 50_000);
  const bars: OHLCV[] = [];

  let open = sourceBars[0].open;
  let high = open;
  let low = open;
  let volume = 0;
  let lastTime = -1;

  const processTarget = (target: number, time: number, volSlice: number) => {
    volume += volSlice;
    let currentTarget = target;

    let iteration = 0;
    while (iteration++ < 200 && bars.length < maxBars) {
      high = Math.max(high, currentTarget);
      low = Math.min(low, currentTarget);

      if (high - low >= rangeSize) {
        // Check breakout direction: did price trigger high or low first?
        const isBullish = currentTarget >= low + rangeSize;
        let close: number;
        let barHigh: number;
        let barLow: number;

        if (isBullish) {
          barLow = low;
          close = barLow + rangeSize;
          barHigh = close;
        } else {
          barHigh = high;
          close = barHigh - rangeSize;
          barLow = close;
        }

        const barTime = Math.max(time, lastTime + 1);
        lastTime = barTime;

        bars.push({
          time: barTime,
          open,
          high: barHigh,
          low: barLow,
          close,
          volume,
        });

        // Next bar opens at the completed bar's close
        open = close;
        high = open;
        low = open;
        volume = 0;

        // Re-evaluate remainder of target against the new bar
        if (currentTarget === close) break;
      } else {
        break;
      }
    }
  };

  for (const bar of sourceBars) {
    if (bars.length >= maxBars) break;
    const volSlice = (bar.volume ?? 0) / 4;
    if (bar.close >= bar.open) {
      processTarget(bar.open, bar.time, volSlice);
      processTarget(bar.low, bar.time, volSlice);
      processTarget(bar.high, bar.time, volSlice);
      processTarget(bar.close, bar.time, volSlice);
    } else {
      processTarget(bar.open, bar.time, volSlice);
      processTarget(bar.high, bar.time, volSlice);
      processTarget(bar.low, bar.time, volSlice);
      processTarget(bar.close, bar.time, volSlice);
    }
  }

  // Include current forming range bar
  const lastBar = sourceBars.at(-1);
  if (lastBar) {
    const formingTime = Math.max(lastBar.time, lastTime + 1);
    bars.push({
      time: formingTime,
      open,
      high: Math.max(high, open, lastBar.close),
      low: Math.min(low, open, lastBar.close),
      close: lastBar.close,
      volume,
    });
  }

  return bars;
}
