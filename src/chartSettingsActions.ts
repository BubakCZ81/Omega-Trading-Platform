import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { isOmegaTheme, OMEGA_THEME_CHOICES, type OmegaTheme } from './themeControls';
import { reapplyChartSettingsSections } from './chartRendererSettings';
import { MAX_RESET_CHART_CANDLES, parseResetChartCandleCount } from './chartReset';
import { openChartSettingsWindow } from './chartSettingsWindow';
import { reportCaughtError } from './diagnostics';
import { openChartSettingsWithRetry } from './chartSettingsOpen';

interface ChartSettingsActionsOptions {
  workspace: VelaWorkspace;
  openReplayControls(): void;
  getTheme(): OmegaTheme;
  setTheme(theme: OmegaTheme): void;
  getResetChartCandles(): number;
  setResetChartCandles(value: number): void;
  updatesEnabled?: boolean;
}

export function initializeChartSettingsActions(options: ChartSettingsActionsOptions): {
  openChartSettings(chart?: VelaWorkspace['chart']): Promise<void>;
} {
  const {
    workspace,
    openReplayControls,
    getTheme,
    setTheme,
    getResetChartCandles,
    setResetChartCandles,
    updatesEnabled = true,
  } = options;
  const resetChartSettingObservers = new WeakMap<HTMLElement, MutationObserver>();
  function installResetChartSetting(settingsDialog: HTMLElement): boolean {
    const pane = settingsDialog.querySelector<HTMLElement>('.vela-sd-pane');
    if (pane?.querySelector('[data-omega-reset-chart-setting]')) return true;
    const activeSection = pane && [...pane.children].find(child =>
      child instanceof HTMLElement && child.style.display === 'block',
    );
    if (!(pane instanceof HTMLElement) || !(activeSection instanceof HTMLElement)) return false;

    const section = document.createElement('section');
    section.className = 'omega-reset-chart-settings';
    section.dataset.omegaResetChartSetting = '';
    const title = document.createElement('strong');
    title.textContent = 'Reset chart';
    const description = document.createElement('span');
    description.textContent = 'Maximum candles in view';
    const label = document.createElement('label');
    const input = document.createElement('input');
    label.append(description, input);
    input.type = 'number';
    input.min = '1';
    input.max = String(MAX_RESET_CHART_CANDLES);
    input.step = '1';
    input.value = String(getResetChartCandles());
    input.setAttribute('aria-label', 'Maximum candles in view after resetting chart');
    input.addEventListener('change', () => {
      const value = parseResetChartCandleCount(input.value);
      if (value == null) {
        input.value = String(getResetChartCandles());
        input.setCustomValidity(`Enter a whole number from 1 to ${MAX_RESET_CHART_CANDLES}.`);
        input.reportValidity();
        return;
      }
      input.setCustomValidity('');
      setResetChartCandles(value);
    });
    section.append(title, label);
    activeSection.prepend(section);
    return true;
  }

  function ensureResetChartSetting(settingsDialog: HTMLElement): void {
    const observer = resetChartSettingObservers.get(settingsDialog);
    if (installResetChartSetting(settingsDialog)) {
      observer?.disconnect();
      resetChartSettingObservers.delete(settingsDialog);
      return;
    }
    if (observer) return;

    const paneObserver = new MutationObserver(() => ensureResetChartSetting(settingsDialog));
    paneObserver.observe(settingsDialog, { childList: true, subtree: true });
    resetChartSettingObservers.set(settingsDialog, paneObserver);
  }

  function installSettingsActionButtons(): void {
    const settingsDialog = document.querySelector<HTMLElement>('.vela-dialog--settings');
    if (settingsDialog) ensureResetChartSetting(settingsDialog);
    const resetButton = settingsDialog?.querySelector<HTMLButtonElement>('button.vela-sd-btn');
    const footer = resetButton?.parentElement;
    if (!footer || footer.querySelector('[data-omega-settings-action]')) return;

    // Theme is an application-wide setting; it belongs next to the other
    // settings actions instead of an extra toolbar menu.
    const themeField = document.createElement('label');
    themeField.className = 'omega-settings-theme';
    themeField.dataset.omegaSettingsAction = 'theme';
    const caption = document.createElement('span');
    caption.textContent = 'Theme';
    const select = document.createElement('select');
    select.setAttribute('aria-label', 'Colour theme');
    for (const [value, label] of OMEGA_THEME_CHOICES) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.appendChild(option);
    }
    select.value = getTheme();
    select.addEventListener('change', () => {
      const value = select.value;
      if (isOmegaTheme(value)) setTheme(value);
    });
    themeField.append(caption, select);
    footer.insertBefore(themeField, resetButton);

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
    if (updatesEnabled) {
      makeButton('Check for updates', () => {
        // Loaded on demand so the update checker stays an optional module.
        void import('./updateChecker')
          .then(module => module.checkForUpdates())
          .catch(error => console.error('Could not check for updates:', error));
      });
    }
  }

  function installSafeguardsCategoryEntry(): void {
    const settingsDialog = document.querySelector<HTMLElement>('.vela-dialog--settings');
    const activeTab = settingsDialog?.querySelector<HTMLElement>('.vela-sd-rail .vela-sd-tab.on');
    if (activeTab?.textContent?.trim() !== 'Safeguards') return;
    const pane = settingsDialog?.querySelector<HTMLElement>('.vela-sd-pane');
    const activeSection = pane && [...pane.children].find(child =>
      child instanceof HTMLElement && child.style.display === 'block',
    );
    if (!(activeSection instanceof HTMLElement)
      || activeSection.querySelector('[data-omega-safeguards-entry]')) return;

    const entry = document.createElement('section');
    entry.className = 'omega-safeguards-entry';
    entry.dataset.omegaSafeguardsEntry = '';
    const description = document.createElement('p');
    description.textContent = 'Review the account binding, hard order guards, provider capabilities, and deterministic offline scenarios.';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'vela-sd-btn';
    button.textContent = 'Open Safeguards controls';
    button.addEventListener('click', () => {
      document.dispatchEvent(new CustomEvent('omega:open-safeguards'));
    });
    entry.append(description, button);
    activeSection.append(entry);
  }

  const observedSettingsDialogs = new WeakSet<HTMLElement>();
  const observeSettingsDialog = (settingsDialog: HTMLElement): void => {
    if (observedSettingsDialogs.has(settingsDialog)) return;
    observedSettingsDialogs.add(settingsDialog);
    new MutationObserver(() => requestAnimationFrame(installSafeguardsCategoryEntry))
      .observe(settingsDialog, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style'],
      });
  };

  new MutationObserver(records => {
    const settingsWasInserted = records.some(record => [...record.addedNodes].some(node =>
      node instanceof Element && (node.matches('.vela-dialog--settings') || Boolean(node.querySelector('.vela-dialog--settings'))),
    ));
    if (!settingsWasInserted) return;
    requestAnimationFrame(() => {
      installSettingsActionButtons();
      installSafeguardsCategoryEntry();
      const settingsDialog = document.querySelector<HTMLElement>('.vela-dialog--settings');
      if (settingsDialog) observeSettingsDialog(settingsDialog);
    });
  }).observe(document.body, { childList: true, subtree: true });

  async function openChartSettings(chart?: VelaWorkspace['chart']): Promise<void> {
    try {
      const activeChart = chart ?? workspace.active?.chart ?? workspace.chart;
      const open = (target: VelaWorkspace['chart']) => {
        try {
          reapplyChartSettingsSections(target);
          target.renderer.setSettingsVisibility({ hidden: [] });
        } catch (error) {
          console.error('Could not prepare chart settings; opening the existing settings sections instead:', error);
        }
        openChartSettingsWindow(target);
      };
      await openChartSettingsWithRetry({
        initialChart: activeChart,
        ready: target => target.ready(),
        currentChart: () => chart ?? workspace.active?.chart ?? workspace.chart,
        open,
        isOpen: () => document.querySelector('.vela-dialog--settings') !== null,
      });
      requestAnimationFrame(installSettingsActionButtons);
      window.dispatchEvent(new Event('omega:platform-fit-request'));
    } catch (error) {
      console.error('Could not open chart settings:', error);
      workspace.toast('Could not open chart settings. Please try again.', 'error');
    }
  }

  return { openChartSettings };
}
