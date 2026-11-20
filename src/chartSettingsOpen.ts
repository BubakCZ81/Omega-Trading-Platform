interface OpenChartSettingsOptions<T> {
  initialChart: T;
  ready(chart: T): Promise<void>;
  currentChart(): T;
  open(chart: T): void;
  isOpen(): boolean;
}

export async function openChartSettingsWithRetry<T>(options: OpenChartSettingsOptions<T>): Promise<void> {
  const { initialChart, ready, currentChart, open, isOpen } = options;
  const wasOpen = isOpen();
  let firstError: unknown;
  try {
    open(initialChart);
  } catch (error) {
    firstError = error;
    console.error('Initial chart settings open failed; retrying after chart readiness:', error);
  }
  if (wasOpen || isOpen()) return;

  await ready(initialChart);
  const retryChart = currentChart();
  open(retryChart);
  if (!isOpen()) {
    const detail = firstError instanceof Error ? ` Initial attempt: ${firstError.message}` : '';
    throw new Error(`Settings dialog did not open after the chart became ready.${detail}`);
  }
}
