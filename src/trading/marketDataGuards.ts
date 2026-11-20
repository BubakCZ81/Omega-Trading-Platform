/**
 * Guards for market data entering the money path.
 *
 * A broker or a feed can hand back nonsense: `NaN` prices, a bar whose high is below its
 * low, a quote with the ask under the bid, or an instrument priced at zero. Any of those
 * silently corrupts P&L, stop-loss distance or position sizing — and a corrupted number
 * in a trading platform is worse than a visible error.
 *
 * Everything here is pure: given a value, it answers "is this safe to trade on?" and, when
 * it is not, says exactly why. Callers can then drop the sample and keep the platform
 * running instead of propagating the bad number.
 */

export interface GuardResult<T> {
  ok: boolean;
  value?: T;
  reason?: string;
}

export interface QuoteLike {
  bid: number;
  ask: number;
}

export interface BarLike {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** Rejections are capped so a report cannot grow without bound. */
const MAX_REJECTIONS_KEPT = 50;
const rejections: { at: number; source: string; reason: string }[] = [];

function recordRejection(source: string, reason: string): void {
  rejections.push({ at: Date.now(), source, reason });
  if (rejections.length > MAX_REJECTIONS_KEPT) rejections.shift();
}

/** Recent rejections, newest last — surfaced in diagnostics so nothing fails silently. */
export function recentDataRejections(): readonly { at: number; source: string; reason: string }[] {
  return rejections;
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * A quote is usable when both sides are finite, positive, and the market is not crossed.
 * A crossed quote (ask < bid) is not a wide spread — it is a broken sample.
 */
export function guardQuote(quote: unknown, source = 'quote'): GuardResult<QuoteLike> {
  if (!quote || typeof quote !== 'object') {
    recordRejection(source, 'quote is missing');
    return { ok: false, reason: 'quote is missing' };
  }
  const { bid, ask } = quote as Record<string, unknown>;
  if (!finite(bid) || !finite(ask)) {
    recordRejection(source, 'bid or ask is not a finite number');
    return { ok: false, reason: 'bid or ask is not a finite number' };
  }
  if (bid <= 0 || ask <= 0) {
    recordRejection(source, 'bid or ask is not positive');
    return { ok: false, reason: 'bid or ask is not positive' };
  }
  if (ask < bid) {
    recordRejection(source, `crossed quote (bid ${bid} > ask ${ask})`);
    return { ok: false, reason: 'ask is below bid' };
  }
  return { ok: true, value: { bid, ask } };
}

/**
 * A bar is usable when time and prices are finite and positive, the extremes actually
 * bound the body, and volume (when present) is not negative.
 */
export function guardBar(bar: unknown, source = 'bar'): GuardResult<BarLike> {
  if (!bar || typeof bar !== 'object') {
    recordRejection(source, 'bar is missing');
    return { ok: false, reason: 'bar is missing' };
  }
  const candidate = bar as Record<string, unknown>;
  const { time, open, high, low, close } = candidate;
  if (![time, open, high, low, close].every(finite)) {
    recordRejection(source, 'bar contains a non-finite value');
    return { ok: false, reason: 'bar contains a non-finite value' };
  }
  const openPrice = open as number;
  const highPrice = high as number;
  const lowPrice = low as number;
  const closePrice = close as number;
  const prices = [openPrice, highPrice, lowPrice, closePrice];
  if (prices.some(price => price <= 0)) {
    recordRejection(source, 'bar contains a non-positive price');
    return { ok: false, reason: 'bar contains a non-positive price' };
  }
  if (highPrice < lowPrice) {
    recordRejection(source, `bar high ${highPrice} is below low ${lowPrice}`);
    return { ok: false, reason: 'high is below low' };
  }
  if (highPrice < Math.max(openPrice, closePrice) || lowPrice > Math.min(openPrice, closePrice)) {
    recordRejection(source, 'bar body is outside its own high/low');
    return { ok: false, reason: 'body is outside high/low' };
  }
  const volume = candidate.volume;
  if (volume !== undefined && (!finite(volume) || volume < 0)) {
    recordRejection(source, 'bar volume is invalid');
    return { ok: false, reason: 'bar volume is invalid' };
  }
  return {
    ok: true,
    value: {
      time: time as number,
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      ...(volume !== undefined ? { volume: volume as number } : {}),
    },
  };
}

/**
 * Filter a series down to the bars that pass the guards, newest sample wins on duplicate
 * open-time. Never throws, so a hostile series cannot break a chart.
 */
export function guardBars(bars: unknown, source = 'bars'): BarLike[] {
  if (!Array.isArray(bars)) {
    recordRejection(source, 'series is not an array');
    return [];
  }
  const byTime = new Map<number, BarLike>();
  for (const raw of bars) {
    const guarded = guardBar(raw, source);
    if (guarded.ok && guarded.value) byTime.set(guarded.value.time, guarded.value);
  }
  return [...byTime.values()].sort((left, right) => left.time - right.time);
}
