import type { InputValue, OHLCV } from './platform/index.ts';

export type TrendlineSide = 'upper' | 'lower';

export interface AutoTrendlineSettings {
  lookback: number;
  strength: number;
  minimumSeparation: number;
}

export interface TrendlinePivot {
  index: number;
  price: number;
}

function boundedInteger(value: InputValue | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

export function normalizeAutoTrendlineSettings(
  inputs: Record<string, InputValue>,
): AutoTrendlineSettings {
  return {
    lookback: boundedInteger(inputs.lookback, 300, 30, 5000),
    strength: boundedInteger(inputs.strength, 5, 2, 30),
    minimumSeparation: boundedInteger(inputs.minimumSeparation, 8, 1, 500),
  };
}

export function findConfirmedPivots(
  bars: readonly OHLCV[],
  side: TrendlineSide,
  settings: AutoTrendlineSettings,
): TrendlinePivot[] {
  const end = bars.length - settings.strength - 1;
  const start = Math.max(settings.strength, bars.length - settings.lookback);
  const pivots: TrendlinePivot[] = [];

  for (let index = start; index < end; index += 1) {
    const price = side === 'upper' ? bars[index].high : bars[index].low;
    let confirmed = true;
    for (let offset = 1; offset <= settings.strength; offset += 1) {
      const before = side === 'upper' ? bars[index - offset].high : bars[index - offset].low;
      const after = side === 'upper' ? bars[index + offset].high : bars[index + offset].low;
      if (side === 'upper' ? price <= before || price < after : price >= before || price > after) {
        confirmed = false;
        break;
      }
    }
    if (!confirmed) continue;

    const pivot = { index, price };
    const previous = pivots[pivots.length - 1];
    if (!previous || index - previous.index >= settings.minimumSeparation) {
      pivots.push(pivot);
    } else if (side === 'upper' ? price >= previous.price : price <= previous.price) {
      pivots[pivots.length - 1] = pivot;
    }
  }
  return pivots;
}

export function findAutoTrendline(
  bars: readonly OHLCV[],
  side: TrendlineSide,
  settings: AutoTrendlineSettings,
): { first: TrendlinePivot; second: TrendlinePivot } | null {
  const pivots = findConfirmedPivots(bars, side, settings);
  for (let secondIndex = pivots.length - 1; secondIndex > 0; secondIndex -= 1) {
    const second = pivots[secondIndex];
    for (let firstIndex = secondIndex - 1; firstIndex >= 0; firstIndex -= 1) {
      const first = pivots[firstIndex];
      const correctSlope = side === 'upper'
        ? second.price < first.price
        : second.price > first.price;
      if (correctSlope) return { first, second };
    }
  }
  return null;
}
