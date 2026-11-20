import { timeframeToMs } from './platform/index.ts';
import type { MarketSwitch, Vela } from './platform';

export const DEFAULT_RESET_CHART_CANDLES = 100;
export const MAX_RESET_CHART_CANDLES = 200;

export function parseResetChartCandleCount(value: unknown): number | null {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : Number.NaN;
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_RESET_CHART_CANDLES
    ? parsed
    : null;
}

interface OmegaChart extends Vela {
  setVisibleBarCount?: (count: number) => number;
  setMarket(next: MarketSwitch & { reload?: boolean }): Promise<void>;
}

export function resetChartView(chart: Vela, maxBars: number): number {
  const count = parseResetChartCandleCount(maxBars) ?? DEFAULT_RESET_CHART_CANDLES;
  chart.renderer.set('autoScale', true);
  const setVisibleBarCount = (chart as OmegaChart).setVisibleBarCount;
  if (typeof setVisibleBarCount === 'function') return setVisibleBarCount.call(chart, count);

  const bounds = chart.replay.bounds;
  if (!bounds || !Number.isFinite(bounds.first) || !Number.isFinite(bounds.last) || bounds.last <= bounds.first) return 0;
  const timeframe = chart.market.timeframe ?? '60';
  const isEventBased = /^(?:R\d+|RG\d+|RANGE\d+|RATR|T\d+)$/i.test(timeframe);
  const requestedBars = Math.max(0, Math.floor(Number(chart.market.bars) || 0));
  const intervalMs = isEventBased && requestedBars > 1
    ? (bounds.last - bounds.first) / (requestedBars - 1)
    : timeframeToMs(timeframe);
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return 0;

  const availableBars = Math.max(1, Math.floor((bounds.last - bounds.first) / intervalMs) + 1);
  const visibleBars = Math.min(count, availableBars);
  chart.setVisibleRange({
    from: bounds.last - intervalMs * (visibleBars - 0.5),
    to: bounds.last + intervalMs * 0.5,
  });
  return visibleBars;
}

export function refreshChart(chart: Vela): Promise<void> {
  return (chart as OmegaChart).setMarket({ reload: true });
}
