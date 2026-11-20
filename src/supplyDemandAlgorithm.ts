import type { InputValue, OHLCV } from './platform/index.ts';

export type SupplyDemandSide = 'supply' | 'demand';
export type SupplyDemandBasis = 'wick' | 'body';

export interface SupplyDemandSettings {
  swingStrength: number;
  atrPeriod: number;
  departureAtr: number;
  confirmationWindow: number;
  maxZones: number;
  zoneBasis: SupplyDemandBasis;
  removeInvalidated: boolean;
  showLabels: boolean;
}

export interface SupplyDemandZone {
  side: SupplyDemandSide;
  pivotIndex: number;
  pivotTime: number;
  top: number;
  bottom: number;
  invalidated: boolean;
}

function boundedInteger(value: InputValue | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback;
}

export function normalizeSupplyDemandSettings(
  inputs: Record<string, InputValue>,
): SupplyDemandSettings {
  return {
    swingStrength: boundedInteger(inputs.swingStrength, 4, 2, 30),
    atrPeriod: boundedInteger(inputs.atrPeriod, 14, 2, 200),
    departureAtr: typeof inputs.departureAtr === 'number' && Number.isFinite(inputs.departureAtr)
      ? Math.max(0.1, Math.min(5, inputs.departureAtr))
      : 0.8,
    confirmationWindow: boundedInteger(inputs.confirmationWindow, 12, 1, 100),
    maxZones: boundedInteger(inputs.maxZones, 5, 1, 20),
    zoneBasis: inputs.zoneBasis === 'body' ? 'body' : 'wick',
    removeInvalidated: typeof inputs.removeInvalidated === 'boolean' ? inputs.removeInvalidated : true,
    showLabels: typeof inputs.showLabels === 'boolean' ? inputs.showLabels : true,
  };
}

function isPivot(bars: readonly OHLCV[], index: number, strength: number, side: SupplyDemandSide): boolean {
  const price = side === 'supply' ? bars[index].high : bars[index].low;
  for (let offset = 1; offset <= strength; offset += 1) {
    const before = side === 'supply' ? bars[index - offset].high : bars[index - offset].low;
    const after = side === 'supply' ? bars[index + offset].high : bars[index + offset].low;
    if (side === 'supply' ? price <= before || price < after : price >= before || price > after) return false;
  }
  return true;
}

function averageTrueRange(bars: readonly OHLCV[], endIndex: number, period: number): number {
  const start = Math.max(0, endIndex - period + 1);
  let total = 0;
  let count = 0;
  for (let index = start; index <= endIndex; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1]?.close ?? bar.close;
    total += Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
    count += 1;
  }
  return count ? total / count : 0;
}

function zoneBounds(bar: OHLCV, side: SupplyDemandSide, basis: SupplyDemandBasis): { top: number; bottom: number } {
  if (basis === 'body') {
    return { top: Math.max(bar.open, bar.close), bottom: Math.min(bar.open, bar.close) };
  }
  return side === 'supply'
    ? { top: bar.high, bottom: Math.max(bar.open, bar.close) }
    : { top: Math.max(bar.open, bar.close), bottom: bar.low };
}

function zonesForSide(
  bars: readonly OHLCV[],
  side: SupplyDemandSide,
  settings: SupplyDemandSettings,
): SupplyDemandZone[] {
  const zones: SupplyDemandZone[] = [];
  const strength = settings.swingStrength;

  for (let pivotIndex = strength; pivotIndex < bars.length - strength; pivotIndex += 1) {
    if (!isPivot(bars, pivotIndex, strength, side)) continue;
    const pivot = bars[pivotIndex];
    const { top, bottom } = zoneBounds(pivot, side, settings.zoneBasis);
    if (top <= bottom) continue;

    const firstConfirmation = pivotIndex + strength;
    const lastConfirmation = Math.min(
      bars.length - 1,
      firstConfirmation + settings.confirmationWindow - 1,
    );
    let confirmedAt = -1;

    for (let index = firstConfirmation; index <= lastConfirmation; index += 1) {
      const bar = bars[index];
      const invalidated = side === 'supply' ? bar.close > top : bar.close < bottom;
      if (invalidated) break;

      const displacement = side === 'supply' ? pivot.high - bar.close : bar.close - pivot.low;
      const atr = averageTrueRange(bars, index, settings.atrPeriod);
      if (atr > 0 && displacement >= atr * settings.departureAtr) {
        confirmedAt = index;
        break;
      }
    }

    if (confirmedAt < 0) continue;
    const invalidated = bars.slice(confirmedAt + 1).some(bar =>
      side === 'supply' ? bar.close > top : bar.close < bottom,
    );
    if (invalidated && settings.removeInvalidated) continue;
    zones.push({
      side,
      pivotIndex,
      pivotTime: pivot.time,
      top,
      bottom,
      invalidated,
    });
  }

  return zones.slice(-settings.maxZones);
}

export function findSupplyDemandZones(
  bars: readonly OHLCV[],
  settings: SupplyDemandSettings,
): SupplyDemandZone[] {
  if (bars.length < settings.swingStrength * 2 + 1) return [];
  return [
    ...zonesForSide(bars, 'supply', settings),
    ...zonesForSide(bars, 'demand', settings),
  ].sort((a, b) => a.pivotIndex - b.pivotIndex);
}
