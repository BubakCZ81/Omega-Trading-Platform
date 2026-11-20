export const MIN_TRADES_PANE_HEIGHT = 140;
export const MIN_CHART_STAGE_HEIGHT = 120;
export const DEFAULT_TRADES_PANE_HEIGHT = 280;

export function maxTradesPaneHeight(
  viewportHeight: number,
  chartWrapperHeight: number,
  toolbarHeight: number,
): number {
  const availableForPane = chartWrapperHeight - toolbarHeight - MIN_CHART_STAGE_HEIGHT;
  return Math.max(
    MIN_TRADES_PANE_HEIGHT,
    Math.min(Math.round(viewportHeight * 0.65), availableForPane),
  );
}

export function clampTradesPaneHeight(height: number, maximum: number): number {
  if (!Number.isFinite(height) || !Number.isFinite(maximum)) return MIN_TRADES_PANE_HEIGHT;
  return Math.min(Math.max(MIN_TRADES_PANE_HEIGHT, maximum), Math.max(MIN_TRADES_PANE_HEIGHT, Math.round(height)));
}
