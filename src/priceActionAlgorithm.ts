import type { DrawingLabel, DrawingLine, InputValue, OHLCV } from './platform/index.ts';
import { findConfirmedPivots } from './autoTrendlineAlgorithm.ts';

export interface CandlePatternSettings {
  lookback: number;
  wickBodyRatio: number;
  maxBodyRangeRatio: number;
  volumeFilter: boolean;
  volumeLookback: number;
  volumeMultiple: number;
}

export interface MarketStructureSettings {
  lookback: number;
  strength: number;
  minimumSeparation: number;
}

function boundedNumber(value: InputValue | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

function boundedInteger(value: InputValue | undefined, fallback: number, min: number, max: number): number {
  return Math.round(boundedNumber(value, fallback, min, max));
}

export function normalizeCandlePatternSettings(inputs: Record<string, InputValue>): CandlePatternSettings {
  return {
    lookback: boundedInteger(inputs.lookback, 300, 10, 2000),
    wickBodyRatio: boundedNumber(inputs.wickBodyRatio, 2, 1, 10),
    maxBodyRangeRatio: boundedNumber(inputs.maxBodyRangeRatio, 0.3, 0.05, 0.8),
    volumeFilter: typeof inputs.volumeFilter === 'boolean' ? inputs.volumeFilter : false,
    volumeLookback: boundedInteger(inputs.volumeLookback, 20, 2, 200),
    volumeMultiple: boundedNumber(inputs.volumeMultiple, 1.2, 0.1, 5),
  };
}

export function normalizeMarketStructureSettings(inputs: Record<string, InputValue>): MarketStructureSettings {
  return {
    lookback: boundedInteger(inputs.lookback, 300, 30, 2000),
    strength: boundedInteger(inputs.strength, 3, 2, 30),
    minimumSeparation: boundedInteger(inputs.minimumSeparation, 3, 1, 500),
  };
}

function validBar(bar: OHLCV): boolean {
  return [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)
    && bar.high >= Math.max(bar.open, bar.close)
    && bar.low <= Math.min(bar.open, bar.close)
    && bar.high > bar.low;
}

function hasVolumeConfirmation(
  bars: readonly OHLCV[],
  index: number,
  settings: CandlePatternSettings,
): boolean {
  if (!settings.volumeFilter) return true;
  const bar = bars[index];
  if (!Number.isFinite(bar.volume) || (bar.volume ?? 0) <= 0) return false;
  const start = Math.max(0, index - settings.volumeLookback);
  let total = 0;
  let count = 0;
  for (let cursor = start; cursor < index; cursor += 1) {
    const volume = bars[cursor].volume;
    if (Number.isFinite(volume) && (volume ?? 0) > 0) {
      total += volume!;
      count += 1;
    }
  }
  return count > 0 && bar.volume! >= (total / count) * settings.volumeMultiple;
}

function patternOnBar(bars: readonly OHLCV[], index: number, settings: CandlePatternSettings): {
  text: string;
  bullish: boolean | null;
} | null {
  const current = bars[index];
  if (!validBar(current) || !hasVolumeConfirmation(bars, index, settings)) return null;
  const range = current.high - current.low;
  const body = Math.abs(current.close - current.open);
  const bodyFloor = Math.max(range * 0.02, Number.EPSILON);
  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const bullish = current.close > current.open;
  const bearish = current.close < current.open;

  if (index > 0) {
    const previous = bars[index - 1];
    if (validBar(previous)) {
      const previousBullish = previous.close > previous.open;
      const previousBearish = previous.close < previous.open;
      if (previousBearish && bullish
        && current.open <= previous.close && current.close >= previous.open) {
        return { text: 'ENGULF ↑', bullish: true };
      }
      if (previousBullish && bearish
        && current.open >= previous.close && current.close <= previous.open) {
        return { text: 'ENGULF ↓', bullish: false };
      }
    }
  }

  if (body / range <= settings.maxBodyRangeRatio
    && lowerWick >= bodyFloor * settings.wickBodyRatio
    && upperWick <= Math.max(body * 0.75, range * 0.08)) {
    return { text: 'HAMMER', bullish: true };
  }
  if (body / range <= settings.maxBodyRangeRatio
    && upperWick >= bodyFloor * settings.wickBodyRatio
    && lowerWick <= Math.max(body * 0.75, range * 0.08)) {
    return { text: 'SHOOTING STAR', bullish: false };
  }
  if (body / range <= settings.maxBodyRangeRatio * 0.35) {
    return { text: 'DOJI', bullish: null };
  }
  return null;
}

export function findCandlePatternLabels(
  bars: readonly OHLCV[],
  settings: CandlePatternSettings,
  options: { live?: boolean; maximumLabels?: number } = {},
): DrawingLabel[] {
  const end = Math.max(0, bars.length - (options.live ? 1 : 0));
  const start = Math.max(0, end - settings.lookback);
  const labels: DrawingLabel[] = [];
  const maximumLabels = Math.max(1, Math.min(500, options.maximumLabels ?? 100));
  for (let index = start; index < end && labels.length < maximumLabels; index += 1) {
    const pattern = patternOnBar(bars, index, settings);
    if (!pattern) continue;
    const bar = bars[index];
    const location = pattern.bullish === true ? 'belowbar' : 'abovebar';
    labels.push({
      id: `candle-pattern-${bar.time}`,
      paneId: 'price',
      xloc: 'bar_index',
      x: index,
      y: pattern.bullish === true ? bar.low : bar.high,
      yloc: location,
      text: pattern.text,
      style: pattern.bullish === true ? 'label_up' : pattern.bullish === false ? 'label_down' : 'label_center',
      color: pattern.bullish === true ? '#26a69a' : pattern.bullish === false ? '#ef5350' : '#607d8b',
      textColor: '#ffffff',
      size: 'tiny',
      textAlign: 'center',
      fontFamily: 'default',
      tooltip: settings.volumeFilter
        ? `${pattern.text}. Closed candle; volume passed the configured average-volume filter. Pattern labels are descriptive, not predictions.`
        : `${pattern.text}. Closed candle pattern; descriptive only, not a prediction.`,
      overlay: true,
    });
  }
  return labels;
}

interface SwingPoint {
  index: number;
  price: number;
  side: 'upper' | 'lower';
}

export interface MarketStructureResult {
  labels: DrawingLabel[];
  lines: DrawingLine[];
}

function makeStructureLabel(
  id: string,
  index: number,
  price: number,
  text: string,
  aboveBar: boolean,
  bullish: boolean,
  tooltip: string,
): DrawingLabel {
  return {
    id,
    paneId: 'price',
    xloc: 'bar_index',
    x: index,
    y: price,
    yloc: aboveBar ? 'abovebar' : 'belowbar',
    text,
    style: aboveBar ? 'label_down' : 'label_up',
    color: bullish ? '#26a69a' : '#ef5350',
    textColor: '#ffffff',
    size: 'tiny',
    textAlign: 'center',
    fontFamily: 'default',
    tooltip,
    overlay: true,
  };
}

export function findMarketStructure(
  bars: readonly OHLCV[],
  settings: MarketStructureSettings,
  options: { live?: boolean; showSwings?: boolean; showBreaks?: boolean } = {},
): MarketStructureResult {
  const end = Math.max(0, bars.length - (options.live ? 1 : 0));
  const start = Math.max(0, end - settings.lookback);
  const windowBars = bars.slice(start, end);
  const localSettings = { ...settings, lookback: Math.max(settings.lookback, windowBars.length) };
  const highs = findConfirmedPivots(windowBars, 'upper', localSettings);
  const lows = findConfirmedPivots(windowBars, 'lower', localSettings);
  const pivotByConfirmation = new Map<number, SwingPoint[]>();
  for (const point of highs) {
    const at = point.index + settings.strength;
    const points = pivotByConfirmation.get(at) ?? [];
    points.push({ ...point, index: point.index + start, side: 'upper' });
    pivotByConfirmation.set(at, points);
  }
  for (const point of lows) {
    const at = point.index + settings.strength;
    const points = pivotByConfirmation.get(at) ?? [];
    points.push({ ...point, index: point.index + start, side: 'lower' });
    pivotByConfirmation.set(at, points);
  }

  const labels: DrawingLabel[] = [];
  const lines: DrawingLine[] = [];
  let previousHigh: SwingPoint | undefined;
  let previousLow: SwingPoint | undefined;
  let activeHigh: SwingPoint | undefined;
  let activeLow: SwingPoint | undefined;
  let trend: -1 | 0 | 1 = 0;
  let highBroken = false;
  let lowBroken = false;
  for (let index = 0; index < windowBars.length; index += 1) {
    for (const pivot of pivotByConfirmation.get(index) ?? []) {
      if (pivot.side === 'upper') {
        if (options.showSwings !== false) {
          const classification = previousHigh ? pivot.price > previousHigh.price ? 'HH' : 'LH' : 'SH';
          labels.push(makeStructureLabel(
            `structure-${pivot.side}-${bars[pivot.index].time}`,
            pivot.index,
            pivot.price,
            classification,
            true,
            false,
            `Confirmed swing high (${classification}); requires ${settings.strength} bars on each side.`,
          ));
        }
        previousHigh = pivot;
        activeHigh = pivot;
        highBroken = false;
      } else {
        if (options.showSwings !== false) {
          const classification = previousLow ? pivot.price > previousLow.price ? 'HL' : 'LL' : 'SL';
          labels.push(makeStructureLabel(
            `structure-${pivot.side}-${bars[pivot.index].time}`,
            pivot.index,
            pivot.price,
            classification,
            false,
            true,
            `Confirmed swing low (${classification}); requires ${settings.strength} bars on each side.`,
          ));
        }
        previousLow = pivot;
        activeLow = pivot;
        lowBroken = false;
      }
    }
    const bar = windowBars[index];
    if (!validBar(bar) || index === 0 || options.showBreaks === false) continue;
    const priorClose = windowBars[index - 1].close;
    const absoluteIndex = index + start;
    const brokeHigh = activeHigh && !highBroken && priorClose <= activeHigh.price && bar.close > activeHigh.price;
    const brokeLow = activeLow && !lowBroken && priorClose >= activeLow.price && bar.close < activeLow.price;
    if (brokeHigh && activeHigh) {
      const label = trend < 0 ? 'CHoCH ↑' : 'BOS ↑';
      lines.push({
        id: `structure-break-high-${bars[absoluteIndex].time}`,
        paneId: 'price',
        xloc: 'bar_index',
        x1: activeHigh.index,
        y1: activeHigh.price,
        x2: absoluteIndex,
        y2: activeHigh.price,
        extend: 'none',
        color: '#26a69a',
        invisible: false,
        width: 1,
        style: 'dashed',
        arrowLeft: false,
        arrowRight: false,
        overlay: true,
      });
      labels.push(makeStructureLabel(
        `structure-break-label-high-${bars[absoluteIndex].time}`,
        absoluteIndex,
        activeHigh.price,
        label,
        true,
        true,
        `Closed candle broke the confirmed swing high (${label}). A structure annotation, not a forecast.`,
      ));
      highBroken = true;
      trend = 1;
    } else if (brokeLow && activeLow) {
      const label = trend > 0 ? 'CHoCH ↓' : 'BOS ↓';
      lines.push({
        id: `structure-break-low-${bars[absoluteIndex].time}`,
        paneId: 'price',
        xloc: 'bar_index',
        x1: activeLow.index,
        y1: activeLow.price,
        x2: absoluteIndex,
        y2: activeLow.price,
        extend: 'none',
        color: '#ef5350',
        invisible: false,
        width: 1,
        style: 'dashed',
        arrowLeft: false,
        arrowRight: false,
        overlay: true,
      });
      labels.push(makeStructureLabel(
        `structure-break-label-low-${bars[absoluteIndex].time}`,
        absoluteIndex,
        activeLow.price,
        label,
        false,
        false,
        `Closed candle broke the confirmed swing low (${label}). A structure annotation, not a forecast.`,
      ));
      lowBroken = true;
      trend = -1;
    }
  }
  return { labels, lines };
}
