export interface LoadedCandle {
  time: number;
  high: number;
  low: number;
  close: number;
}

function timeValue(value: unknown): number {
  if (typeof value === 'string' && !value.trim()) return NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return typeof value === 'string' ? Date.parse(value) : NaN;
}

function readCandle(value: unknown): LoadedCandle | null {
  if (Array.isArray(value)) {
    const [time, , high, low, close] = value;
    const candle = { time: timeValue(time), high: Number(high), low: Number(low), close: Number(close) };
    return Number.isFinite(candle.time) && Number.isFinite(candle.high)
      && Number.isFinite(candle.low) && Number.isFinite(candle.close)
      && candle.high >= candle.low ? candle : null;
  }
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const key of keys) {
      if (row[key] !== undefined && row[key] !== null) return row[key];
    }
    return undefined;
  };
  const candle = {
    time: timeValue(pick('time', 'timestamp', 'ts', 't', 'date')),
    high: Number(pick('high', 'h')),
    low: Number(pick('low', 'l')),
    close: Number(pick('close', 'c')),
  };
  return Number.isFinite(candle.time) && Number.isFinite(candle.high)
    && Number.isFinite(candle.low) && Number.isFinite(candle.close)
    && candle.high >= candle.low ? candle : null;
}

function candleRows(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['data', 'bars', 'candles', 'history']) {
    if (Array.isArray(record[key])) return record[key] as unknown[];
  }
  return [];
}

export function readLoadedCandleBars(source: unknown): LoadedCandle[] {
  return mergeLoadedCandleBars([], candleRows(source).flatMap(row => {
    const candle = readCandle(row);
    return candle ? [candle] : [];
  }));
}

export function mergeLoadedCandleBars(
  existing: readonly LoadedCandle[],
  incoming: readonly LoadedCandle[],
  limit = 50,
): LoadedCandle[] {
  const byTime = new Map<number, LoadedCandle>();
  for (const candle of [...existing, ...incoming]) {
    if ([candle.time, candle.high, candle.low, candle.close].every(Number.isFinite)
      && candle.high >= candle.low) byTime.set(candle.time, candle);
  }
  return [...byTime.values()]
    .sort((left, right) => left.time - right.time)
    .slice(-Math.max(0, Math.floor(limit)));
}

export function calculateAtr14(bars: readonly LoadedCandle[]): number | null {
  if (bars.length < 15) return null;
  const slice = bars.slice(-15);
  const trueRanges: number[] = [];
  for (let index = 1; index < slice.length; index += 1) {
    const current = slice[index];
    const previous = slice[index - 1];
    trueRanges.push(Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close),
    ));
  }
  if (trueRanges.length < 14) return null;
  let atr = trueRanges.slice(0, 14).reduce((sum, range) => sum + range, 0) / 14;
  for (let index = 14; index < trueRanges.length; index += 1) {
    atr = (atr * 13 + trueRanges[index]) / 14;
  }
  return atr;
}
