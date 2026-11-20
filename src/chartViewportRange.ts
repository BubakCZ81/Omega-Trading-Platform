export interface TimeRange {
  from: number;
  to: number;
}

export function isAwayFromLatest(
  visibleRange: TimeRange | null,
  latestBarTime: number | null,
  intervalMs: number,
): boolean {
  if (!visibleRange || latestBarTime == null
    || !Number.isFinite(visibleRange.from) || !Number.isFinite(visibleRange.to)
    || !Number.isFinite(latestBarTime) || visibleRange.to <= visibleRange.from) return false;
  const intervalThreshold = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs * 2 : 0;
  const threshold = Math.max(intervalThreshold, (visibleRange.to - visibleRange.from) * 0.08);
  return latestBarTime - visibleRange.to > threshold;
}

export function rangeEndingAtLatest(visibleRange: TimeRange | null, latestBarTime: number): TimeRange | null {
  if (!visibleRange || !Number.isFinite(latestBarTime)) return null;
  const span = visibleRange.to - visibleRange.from;
  if (!Number.isFinite(span) || span <= 0) return null;
  return { from: latestBarTime - span, to: latestBarTime };
}
