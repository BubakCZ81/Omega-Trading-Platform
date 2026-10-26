import type { VelaWorkspace } from '@luxalgo/vela/workspace';

interface ChartSettingsActionsOptions {
  workspace: VelaWorkspace;
  openReplayControls(): void;
}

export function initializeChartSettingsActions(options: ChartSettingsActionsOptions): {
  openChartSettings(): void;
} {
  const { workspace, openReplayControls } = options;

  function installSettingsActionButtons(): void {
    const settingsDialog = document.querySelector<HTMLElement>('.vela-dialog--settings');
    const resetButton = settingsDialog?.querySelector<HTMLButtonElement>('button.vela-sd-btn');
    const footer = resetButton?.parentElement;
    if (!footer || footer.querySelector('[data-omega-settings-action]')) return;

    const makeButton = (label: string, action: () => void) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'vela-sd-btn';
      button.textContent = label;
      button.dataset.omegaSettingsAction = label;
      button.addEventListener('click', action);
      footer.insertBefore(button, resetButton);
    };
    makeButton('Replay', openReplayControls);
    makeButton('Check for updates', () => document.getElementById('check-updates')?.click());
  }

  new MutationObserver(records => {
    const settingsWasInserted = records.some(record => [...record.addedNodes].some(node =>
      node instanceof Element && (node.matches('.vela-dialog--settings') || Boolean(node.querySelector('.vela-dialog--settings'))),
    ));
    if (settingsWasInserted) requestAnimationFrame(installSettingsActionButtons);
  }).observe(document.body, { childList: true, subtree: true });

  function openChartSettings(): void {
    const activeChart = workspace.active?.chart ?? workspace.chart;
    try {
      activeChart.renderer.setSettingsVisibility({ hidden: [] });
      activeChart.renderer.openSettings();
      requestAnimationFrame(installSettingsActionButtons);
    } catch (error) {
      console.error('Could not open chart settings:', error);
      workspace.toast('Could not open chart settings. Please try again.', 'error');
    }
  }

  return { openChartSettings };
}
