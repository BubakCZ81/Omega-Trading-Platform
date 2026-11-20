import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export function openChartSettingsWindow(
  chart: VelaWorkspace['chart'],
  section = 'Canvas',
): void {
  chart.renderer.openSettings(section);
}
