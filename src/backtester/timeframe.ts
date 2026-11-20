export function normalizeBacktestTimeframe(value: string): string {
  const timeframe = value.trim();
  if (/^\d+$/.test(timeframe)) return `${timeframe}m`;
  const tickMatch = /^T(\d+)$/i.exec(timeframe);
  if (tickMatch) return `${tickMatch[1]}t`;
  if (/^[DWM]$/i.test(timeframe)) return `1${timeframe.toUpperCase()}`;
  return timeframe;
}
