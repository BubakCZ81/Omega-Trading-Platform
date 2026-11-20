export const MAX_CHART_HISTORY_BARS = 200_000;

const HISTORY_PRELOAD_BATCH = 500;

export function historyPreloadTarget(
  range: { from: number; to: number },
  oldest: number,
  interval: number,
  loaded: number,
  requested: number,
): number | undefined {
  const margin = Math.max(interval * 5, (range.to - range.from) * 0.15);
  if (!Number.isFinite(margin) || range.from > oldest + margin) return;
  const target = Math.min(MAX_CHART_HISTORY_BARS, Math.max(loaded, requested) + HISTORY_PRELOAD_BATCH);
  if (target > requested && target > loaded) return target;
}
