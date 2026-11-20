import { runSafeguardScenarios, type SafeguardScenario } from './safeguardScenarios';
import { reportCaughtError } from './diagnostics.ts';
import { isQuickTradeEnabled, setQuickTradeEnabled } from './quickTradeToggle';

interface SafeguardSettings {
  version: 1;
  maxMt5OrderVolume: number;
  maxSdkOrderNotional: number;
}

interface SafeguardProvider {
  id: string;
  displayName: string;
  supportsBars: boolean;
  sdkOrderApiAvailable: boolean;
  supportedOrderEnvironments: string[];
  detail: string;
  appTradingStatus: 'manual-market-orders';
  appConnectionStatus: 'read-only';
}

interface SafeguardsSnapshot {
  settings: SafeguardSettings;
  source: 'default' | 'environment' | 'stored';
  mt5Binding: { login: string; server: string } | null;
  hardGuards: string[];
  providers: SafeguardProvider[];
}

interface SafeguardsBridge {
  get(): Promise<SafeguardsSnapshot>;
  save(settings: Pick<SafeguardSettings, 'maxMt5OrderVolume' | 'maxSdkOrderNotional'>): Promise<{
    settings: SafeguardSettings;
    source: 'stored';
    armed: false;
  }>;
}

declare global {
  interface Window {
    velaSafeguards?: SafeguardsBridge;
  }
}

export function initializeSafeguardsPanel(): void {
  const modal = document.getElementById('safeguards-settings-modal');
  const closeButton = document.getElementById('safeguards-settings-close');
  const status = document.getElementById('safeguards-settings-status');
  const binding = document.getElementById('safeguards-mt5-binding');
  const guards = document.getElementById('safeguards-hard-guards');
  const providers = document.getElementById('safeguards-provider-list');
  const volumeInput = document.getElementById('safeguards-max-mt5-volume') as HTMLInputElement | null;
  const notionalInput = document.getElementById('safeguards-max-sdk-notional') as HTMLInputElement | null;
  const saveButton = document.getElementById('safeguards-save') as HTMLButtonElement | null;
  const runButton = document.getElementById('safeguards-run-scenarios') as HTMLButtonElement | null;
  const quickTradeEnabled = document.getElementById('safeguards-quick-trade-enabled') as HTMLInputElement | null;
  const results = document.getElementById('safeguards-scenario-results');
  if (!modal || !closeButton || !status || !binding || !guards || !providers
    || !volumeInput || !notionalInput || !saveButton || !runButton || !quickTradeEnabled || !results) return;

  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.dataset.state = isError ? 'error' : 'info';
  };
  const renderScenarios = (scenarios: SafeguardScenario[]) => {
    results.replaceChildren();
    for (const scenario of scenarios) {
      const row = document.createElement('article');
      row.className = 'safeguards-scenario';
      row.dataset.state = scenario.passed ? 'passed' : 'failed';
      const heading = document.createElement('strong');
      heading.textContent = `${scenario.passed ? 'PASS' : 'FAIL'} · ${scenario.scenario}`;
      const detail = document.createElement('span');
      detail.textContent = `${scenario.provider.toUpperCase()} · ${scenario.outcome}`;
      row.append(heading, detail);
      results.append(row);
    }
  };
  const load = async () => {
    if (!window.velaSafeguards) {
      setStatus('Execution settings are available in the Omega desktop app only.', true);
      return;
    }
    setStatus('Loading execution settings and Broker SDK capabilities…');
    try {
      const snapshot = await window.velaSafeguards.get();
      volumeInput.value = String(snapshot.settings.maxMt5OrderVolume);
      notionalInput.value = String(snapshot.settings.maxSdkOrderNotional);
      quickTradeEnabled.checked = isQuickTradeEnabled();
      binding.textContent = snapshot.mt5Binding
        ? `MT5 live-order session is armed for ${snapshot.mt5Binding.login} @ ${snapshot.mt5Binding.server}. Saving a volume-cap change disarms it.`
        : 'MT5 live orders require explicit session arming for the connected account.';
      guards.replaceChildren();
      for (const guard of snapshot.hardGuards) {
        const item = document.createElement('li');
        item.textContent = guard;
        guards.append(item);
      }
      providers.replaceChildren();
      for (const provider of snapshot.providers) {
        const card = document.createElement('article');
        card.className = 'safeguards-provider';
        const heading = document.createElement('strong');
        heading.textContent = provider.displayName;
        const capability = document.createElement('span');
        capability.textContent = provider.sdkOrderApiAvailable
          ? `SDK order API: ${provider.supportedOrderEnvironments.join(', ')}`
          : 'SDK order API: unavailable';
        const appStatus = document.createElement('span');
        appStatus.textContent = 'Omega app: confirmed market orders in the Alpaca Broker panel';
        const detail = document.createElement('small');
        detail.textContent = provider.detail;
        card.append(heading, capability, appStatus, detail);
        providers.append(card);
      }
      setStatus(`Execution settings loaded (${snapshot.source}). The MT5 per-order volume cap is enforced; the maximum allowed cap is 20 lots.`);
    } catch (error) {
      reportCaughtError('safeguards:load', error, 'Could not load persisted safeguards settings.');
      setStatus(error instanceof Error ? error.message : String(error), true);
    }
  };
  const open = () => {
    modal.hidden = false;
    modal.setAttribute('aria-hidden', 'false');
    window.dispatchEvent(new Event('omega:platform-fit-request'));
    void load();
  };
  const close = () => {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
    window.dispatchEvent(new Event('omega:platform-fit-request'));
  };

  closeButton.addEventListener('click', close);
  document.addEventListener('omega:open-safeguards', open);
  document.addEventListener('omega:quick-trade-state-changed', event => {
    quickTradeEnabled.checked = (event as CustomEvent<{ enabled: boolean }>).detail.enabled;
  });
  quickTradeEnabled.addEventListener('change', () => {
    setQuickTradeEnabled(quickTradeEnabled.checked);
    setStatus(quickTradeEnabled.checked
    ? 'Chart Quick Trade controls enabled. MT5 orders require a selected, connected account, explicit live-session arming, and confirmation.'
      : 'Chart Quick Trade controls disabled.');
  });
  modal.addEventListener('click', event => {
    if (event.target === modal) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !modal.hidden) close();
  });

  saveButton.addEventListener('click', async () => {
    if (!window.velaSafeguards) return;
    if (!volumeInput.reportValidity() || !notionalInput.reportValidity()) return;
    saveButton.disabled = true;
    setStatus('Saving safeguards to the local Omega user profile…');
    try {
      await window.velaSafeguards.save({
        maxMt5OrderVolume: Number(volumeInput.value),
        maxSdkOrderNotional: Number(notionalInput.value),
      });
      document.dispatchEvent(new Event('omega:mt5-live-disarmed'));
      setStatus('Execution settings saved. The MT5 live-order session is disarmed and must be explicitly armed again.');
      await load();
    } catch (error) {
      reportCaughtError('safeguards:save', error, 'Could not save safeguards settings.');
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      saveButton.disabled = false;
    }
  });

  runButton.addEventListener('click', async () => {
    if (!volumeInput.reportValidity() || !notionalInput.reportValidity()) return;
    runButton.disabled = true;
    setStatus('Running deterministic offline scenarios against an in-memory mock broker. No credentials or broker connections are used.');
    try {
      const scenarios = await runSafeguardScenarios({
        maxMt5OrderVolume: Number(volumeInput.value),
        maxSdkOrderNotional: Number(notionalInput.value),
      });
      renderScenarios(scenarios);
      const passed = scenarios.filter(scenario => scenario.passed).length;
      setStatus(`Offline scenarios: ${passed}/${scenarios.length} passed. All simulated submissions use a local mock only; nothing is sent to any broker.`, passed !== scenarios.length);
    } catch (error) {
      reportCaughtError('safeguards:scenarios', error, 'Could not run offline safeguards scenarios.');
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      runButton.disabled = false;
    }
  });
}
