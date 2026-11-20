import {
  armPineSaxoAutoTrading,
  disarmPineSaxoAutoTrading,
} from './pineSaxoAutoTrading';

interface SaxoAccount {
  accountKey: string;
  accountId: string;
  currency: string;
  accountType: string;
  active: boolean;
  fractionalOrderEnabled: boolean;
}

interface SaxoStatus {
  connected: boolean;
  environment: 'sim' | 'live' | null;
  accounts: SaxoAccount[];
  expiresAt: number | null;
  armedStrategyAccountKey: string | null;
}

interface SaxoInstrument {
  uic: number;
  assetType: string;
  symbol: string;
  description: string;
  currency: string;
  minTick?: number;
  contractSize?: number;
  minimumTradeSize?: number;
  amountDecimals?: number;
  fractionalOrderEnabled: boolean;
}

interface SaxoBridge {
  connect(config: { appKey: string; environment: 'sim' | 'live' }): Promise<SaxoStatus>;
  status(): Promise<SaxoStatus>;
  quote(accountKey: string, symbol: string): Promise<{
    symbol: string;
    bid: number;
    ask: number;
    timeMsc: number | null;
    delayedByMinutes: number;
    marketState: string;
    instrument: SaxoInstrument;
  }>;
  placeOrder(request: {
    accountKey: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    stopLoss?: number;
    takeProfit?: number;
    source: 'manual' | 'pine';
    confirmed?: boolean;
    intentId: string;
  }): Promise<{ status: string; orderId: string; quantity: number; protected: boolean; duplicate?: boolean }>;
  disconnect(): Promise<boolean>;
  armStrategyTrading(request: { accountKey: string; armed: boolean }): Promise<{ armed: boolean; accountKey: string }>;
}

declare global {
  interface Window { velaSaxo?: SaxoBridge; }
}

export function initializeSaxoFeed(): void {
  const bridge = window.velaSaxo;
  const modal = document.getElementById('saxo-feed-modal');
  const openButton = document.getElementById('saxo-feed-toggle');
  const closeButton = document.getElementById('saxo-feed-close');
  const connectButton = document.getElementById('saxo-feed-connect') as HTMLButtonElement | null;
  const disconnectButton = document.getElementById('saxo-feed-disconnect') as HTMLButtonElement | null;
  const appKeyInput = document.getElementById('saxo-app-key') as HTMLInputElement | null;
  const environmentInput = document.getElementById('saxo-environment') as HTMLSelectElement | null;
  const statusElement = document.getElementById('saxo-feed-status');
  const accountList = document.getElementById('saxo-account-list');
  const strategyToggle = document.getElementById('saxo-pine-auto-trading') as HTMLInputElement | null;
  const strategyStatus = document.getElementById('saxo-pine-auto-trading-status');
  if (!bridge || !modal || !openButton || !closeButton || !connectButton || !disconnectButton || !appKeyInput || !environmentInput || !statusElement || !accountList || !strategyToggle || !strategyStatus) return;

  let connected = false;
  let armedAccountId: string | null = null;
  const setStatus = (message: string, error = false): void => {
    statusElement.textContent = message;
    statusElement.dataset.state = error ? 'error' : 'info';
  };
  const closeModal = (): void => {
    modal.hidden = true;
    modal.setAttribute('aria-hidden', 'true');
  };
  const removeAccounts = (): void => {
    for (const option of document.querySelectorAll<HTMLOptionElement>('#trading-account-select option[value^="saxo:"]')) {
      document.dispatchEvent(new CustomEvent('omega:trading-account-unavailable', { detail: option.value }));
    }
  };
  const syncStrategyControl = (): void => {
    const selected = localStorage.getItem('omega.selected-trading-account') ?? '';
    strategyToggle.disabled = !connected || !selected.toLowerCase().startsWith('saxo:');
    strategyToggle.checked = Boolean(armedAccountId && selected.toLowerCase() === armedAccountId.toLowerCase());
  };
  const disarmStrategy = async (): Promise<void> => {
    const previousAccountId = armedAccountId;
    armedAccountId = null;
    disarmPineSaxoAutoTrading();
    strategyToggle.checked = false;
    strategyToggle.disabled = true;
    strategyStatus.textContent = 'Automatic Saxo Pine strategy trading is off.';
    if (previousAccountId) {
      await bridge.armStrategyTrading({ accountKey: previousAccountId.slice('saxo:'.length), armed: false });
    }
  };
  const renderAccounts = (result: SaxoStatus): void => {
    accountList.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = `Saxo ${result.environment === 'live' ? 'Live' : 'Simulation'} accounts`;
    accountList.append(heading);
    for (const account of result.accounts) {
      const row = document.createElement('p');
      row.textContent = `${account.accountId || account.accountKey} · ${account.currency || 'currency unavailable'} · ${account.accountType || 'account'}`;
      accountList.append(row);
      document.dispatchEvent(new CustomEvent('omega:trading-account-available', {
        detail: {
          id: `saxo:${account.accountKey}`,
          label: `Saxo · ${account.accountId || account.accountKey}`,
          mode: result.environment === 'live' ? 'LIVE' : 'DEMO',
          detail: `${result.environment === 'live' ? 'Live' : 'Simulation'} · ${account.currency || 'currency unavailable'}`,
        },
      }));
    }
    syncStrategyControl();
  };
  const disconnect = async (notify = true): Promise<void> => {
    if (!connected) return;
    connected = false;
    try {
      await disarmStrategy();
    } catch (error) {
      strategyStatus.textContent = `Saxo Pine arming was cleared locally, but the broker session could not be disarmed before disconnect: ${error instanceof Error ? error.message : String(error)}`;
      strategyStatus.dataset.state = 'error';
    }
    await bridge.disconnect();
    removeAccounts();
    accountList.replaceChildren();
    connectButton.hidden = false;
    disconnectButton.hidden = true;
    setStatus('Disconnected. Session tokens were cleared.');
    if (notify) document.dispatchEvent(new CustomEvent('omega:trading-broker-disconnected', { detail: 'saxo' }));
  };

  openButton.addEventListener('click', () => { modal.hidden = false; modal.setAttribute('aria-hidden', 'false'); });
  closeButton.addEventListener('click', closeModal);
  modal.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  connectButton.addEventListener('click', async () => {
    const appKey = appKeyInput.value.trim();
    const environment = environmentInput.value;
    if (!appKey) {
      appKeyInput.setAttribute('aria-invalid', 'true');
      setStatus('Enter your Saxo OpenAPI App Key.', true);
      return;
    }
    appKeyInput.removeAttribute('aria-invalid');
    connectButton.disabled = true;
    setStatus(`Starting Saxo ${environment === 'live' ? 'live' : 'simulation'} OAuth PKCE authorization…`);
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'saxo' }));
    try {
      const result = await bridge.connect({ appKey, environment: environment as 'sim' | 'live' });
      if (!result.connected || !result.accounts.length) throw new Error('Saxo did not return any active accounts.');
      connected = true;
      renderAccounts(result);
      connectButton.hidden = true;
      disconnectButton.hidden = false;
      armedAccountId = null;
      disarmPineSaxoAutoTrading();
      setStatus(`Connected to Saxo ${result.environment === 'live' ? 'Live' : 'Simulation'}; ${result.accounts.length} active account(s) available. Tokens remain in memory until disconnect or app exit.`);
      syncStrategyControl();
      document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'saxo' }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      connectButton.disabled = false;
    }
  });
  disconnectButton.addEventListener('click', () => {
    void disconnect().catch(error => setStatus(error instanceof Error ? error.message : String(error), true));
  });
  strategyToggle.addEventListener('change', async () => {
    const selected = localStorage.getItem('omega.selected-trading-account') ?? '';
    if (!connected || !selected.toLowerCase().startsWith('saxo:')) {
      strategyToggle.checked = false;
      syncStrategyControl();
      return;
    }
    const accountKey = selected.slice('saxo:'.length);
    strategyToggle.disabled = true;
    try {
      const result = await bridge.armStrategyTrading({ accountKey, armed: strategyToggle.checked });
      if (result.armed) {
        if (localStorage.getItem('omega.selected-trading-account')?.toLowerCase() !== selected.toLowerCase()) {
          await bridge.armStrategyTrading({ accountKey, armed: false });
          throw new Error('The selected Saxo account changed while Pine strategy trading was being armed.');
        }
        armedAccountId = selected;
        armPineSaxoAutoTrading(selected);
        strategyStatus.textContent = `Pine strategy order previews are enabled for Saxo account ${accountKey}. Confirm each order; entries use Pine protection or Omega's configured SL/TP.`;
        strategyStatus.dataset.state = 'success';
      } else {
        armedAccountId = null;
        disarmPineSaxoAutoTrading();
        strategyStatus.textContent = 'Saxo Pine strategy order previews are off.';
        strategyStatus.dataset.state = 'info';
      }
    } catch (error) {
      strategyToggle.checked = false;
      strategyStatus.textContent = error instanceof Error ? error.message : String(error);
      strategyStatus.dataset.state = 'error';
    } finally {
      syncStrategyControl();
    }
  });
  document.addEventListener('omega:trading-account-selected', () => {
    const selected = localStorage.getItem('omega.selected-trading-account') ?? '';
    if (armedAccountId && selected.toLowerCase() !== armedAccountId.toLowerCase()) {
      void disarmStrategy().catch(error => {
        strategyStatus.textContent = error instanceof Error ? error.message : String(error);
        strategyStatus.dataset.state = 'error';
      });
    }
    syncStrategyControl();
  });
  document.addEventListener('omega:pine-saxo-auto-trading-state-changed', syncStrategyControl);
  document.addEventListener('omega:trading-broker-connecting', event => {
    if ((event as CustomEvent<string>).detail !== 'saxo') void disconnect(false).catch(error => {
      console.error('Could not disconnect Saxo after a provider switch:', error);
    });
  });
  document.addEventListener('omega:trading-broker-exclusive', event => {
    if ((event as CustomEvent<string>).detail !== 'saxo') void disconnect(false).catch(error => {
      console.error('Could not disconnect Saxo after an account switch:', error);
    });
  });
}
