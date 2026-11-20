import { reportCaughtError } from './diagnostics.ts';
import {
  armPineIbkrAutoTrading,
  disarmPineIbkrAutoTrading,
  getPineIbkrAutoTradingAccountId,
} from './pineIbkrAutoTrading.ts';

interface IbkrStatus {
  connected: boolean;
  host: string;
  port: number;
  environment: 'paper' | 'live';
  accounts: string[];
}

interface IbkrBridge {
  connect(config: { host: string; port: number; clientId: number; environment: 'paper' | 'live' }): Promise<IbkrStatus>;
  status(): Promise<IbkrStatus>;
  quote(symbol: string): Promise<{ bid: number; ask: number; timeMsc: number; minTick: number; contract: { secType: string; currency: string; multiplier: string } }>;
  armStrategyTrading(request: { accountId: string; armed: boolean }): Promise<{ armed: boolean; accountId: string | null }>;
  placeOrder(request: {
    accountId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    quantity: number;
    stopLoss?: number;
    takeProfit?: number;
    source: 'manual' | 'pine';
    confirmed?: boolean;
    intentId?: string;
  }): Promise<{ status: string; orderId: number; quantity: number; quoteTimeMsc: number; protected: boolean }>;
  disconnect(): Promise<boolean>;
}

declare global {
  interface Window { velaIbkr?: IbkrBridge; }
}

const modal = document.getElementById('ibkr-feed-modal');
const openButton = document.getElementById('ibkr-feed-toggle');
const closeButton = document.getElementById('ibkr-feed-close');
const connectButton = document.getElementById('ibkr-feed-connect') as HTMLButtonElement | null;
const disconnectButton = document.getElementById('ibkr-feed-disconnect') as HTMLButtonElement | null;
const environmentSelect = document.getElementById('ibkr-environment') as HTMLSelectElement | null;
const hostInput = document.getElementById('ibkr-host') as HTMLInputElement | null;
const portInput = document.getElementById('ibkr-port') as HTMLInputElement | null;
const clientIdInput = document.getElementById('ibkr-client-id') as HTMLInputElement | null;
const statusElement = document.getElementById('ibkr-feed-status');
const accountsHost = document.getElementById('ibkr-account-list');
const autoTradingToggle = document.getElementById('ibkr-pine-auto-trading') as HTMLInputElement | null;
const autoTradingStatus = document.getElementById('ibkr-pine-auto-trading-status');
let connectedAccountIds: string[] = [];

function showStatus(message: string, state: 'info' | 'success' | 'error' = 'info'): void {
  if (!statusElement) return;
  statusElement.textContent = message;
  statusElement.dataset.state = state;
}

function showAutoTradingStatus(message: string, state: 'info' | 'success' | 'error' = 'info'): void {
  if (!autoTradingStatus) return;
  autoTradingStatus.textContent = message;
  autoTradingStatus.dataset.state = state;
}

function openModal(): void {
  if (!modal) return;
  modal.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  openButton?.focus();
}

function closeModal(): void {
  if (!modal) return;
  modal.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  openButton?.focus();
}

function selectedIbkrAccountId(): string | null {
  const selected = localStorage.getItem('omega.selected-trading-account') ?? '';
  return selected.toLowerCase().startsWith('ibkr:') ? selected.slice('ibkr:'.length) : null;
}

function renderAccounts(status?: IbkrStatus): void {
  const ids = status?.accounts ?? connectedAccountIds;
  if (accountsHost) {
    accountsHost.replaceChildren();
    for (const accountId of ids) {
      const row = document.createElement('div');
      row.className = 'ibkr-account-row';
      const name = document.createElement('strong');
      name.textContent = accountId;
      const detail = document.createElement('small');
      detail.textContent = accountId.toUpperCase().startsWith('DU') ? 'Paper account' : 'Live account';
      row.append(name, detail);
      accountsHost.append(row);
    }
  }
  const armed = getPineIbkrAutoTradingAccountId();
  if (armed && armed.toLowerCase() !== `ibkr:${selectedIbkrAccountId() ?? ''}`.toLowerCase()) {
    const accountId = armed.slice('ibkr:'.length);
    disarmPineIbkrAutoTrading();
    void window.velaIbkr?.armStrategyTrading({ accountId, armed: false }).catch(error => {
      reportCaughtError('ibkr:strategy-disarm', error, 'Could not disarm IBKR Pine strategy previews after the selected account changed.');
    });
    showAutoTradingStatus('Pine strategy previews were disarmed because the selected account changed. Arm them again for the intended IBKR account.');
  } else {
    const isArmed = Boolean(armed);
    if (autoTradingToggle) {
      autoTradingToggle.checked = isArmed;
      autoTradingToggle.disabled = !ids.includes(selectedIbkrAccountId() ?? '');
    }
    showAutoTradingStatus(isArmed
      ? `Pine strategy order previews are enabled for ${armed}. Confirm each order; entries use Pine protection or Omega's configured SL/TP.`
      : 'IBKR Pine strategy order previews are off. They must be enabled again after an app restart or account change.', isArmed ? 'success' : 'info');
  }
}

function removeAccounts(): void {
  disarmPineIbkrAutoTrading();
  for (const accountId of connectedAccountIds) {
    document.dispatchEvent(new CustomEvent('omega:trading-account-unavailable', { detail: `ibkr:${accountId}` }));
  }
  connectedAccountIds = [];
  if (accountsHost) accountsHost.replaceChildren();
  if (autoTradingToggle) { autoTradingToggle.checked = false; autoTradingToggle.disabled = true; }
  showAutoTradingStatus('Automatic IBKR Pine strategy trading is off.');
}

async function disconnect(): Promise<void> {
  const bridge = window.velaIbkr;
  if (!bridge) return;
  try {
    await bridge.disconnect();
    removeAccounts();
    if (disconnectButton) disconnectButton.hidden = true;
    if (connectButton) connectButton.hidden = false;
    document.dispatchEvent(new CustomEvent('omega:trading-broker-disconnected', { detail: 'ibkr' }));
    showStatus('Disconnected from TWS / IB Gateway.');
  } catch (error) {
    showStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

async function connect(): Promise<void> {
  const bridge = window.velaIbkr;
  if (!bridge || !environmentSelect || !hostInput || !portInput || !clientIdInput) {
    showStatus('IBKR connection controls are unavailable in this app window.', 'error');
    return;
  }
  const environment: 'paper' | 'live' = environmentSelect.value === 'live' ? 'live' : 'paper';
  const config = {
    environment,
    host: hostInput.value.trim(),
    port: Number(portInput.value),
    clientId: Number(clientIdInput.value),
  };
  if (connectButton) connectButton.disabled = true;
  document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'ibkr' }));
  showStatus(`Connecting to ${environment} TWS / IB Gateway at ${config.host}:${config.port}…`);
  try {
    const startedAt = performance.now();
    const status = await bridge.connect(config);
    connectedAccountIds = status.accounts;
    for (const accountId of connectedAccountIds) {
      const mode = accountId.toUpperCase().startsWith('DU') ? 'PAPER' : 'LIVE';
      document.dispatchEvent(new CustomEvent('omega:trading-account-available', {
        detail: {
          id: `ibkr:${accountId}`,
          label: `IBKR · ${accountId}`,
          mode,
          detail: `${status.host}:${status.port} · TWS / IB Gateway`,
        },
      }));
    }
    document.dispatchEvent(new CustomEvent('omega:connection-latency', { detail: performance.now() - startedAt }));
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'ibkr' }));
    if (disconnectButton) disconnectButton.hidden = false;
    if (connectButton) connectButton.hidden = true;
    showStatus(`Connected to TWS / IB Gateway. ${connectedAccountIds.length} managed account(s) available.`, 'success');
    renderAccounts(status);
  } catch (error) {
    removeAccounts();
    showStatus(error instanceof Error ? error.message : String(error), 'error');
  } finally {
    if (connectButton) connectButton.disabled = false;
  }
}

export function initializeIbkrFeed(): void {
  if (!window.velaIbkr) return;
  openButton?.addEventListener('click', openModal);
  closeButton?.addEventListener('click', closeModal);
  modal?.addEventListener('click', event => { if (event.target === modal) closeModal(); });
  connectButton?.addEventListener('click', () => void connect());
  disconnectButton?.addEventListener('click', () => void disconnect());

  let currentDefaultPort = '7497';
  environmentSelect?.addEventListener('change', () => {
    if (!portInput) return;
    const nextDefaultPort = environmentSelect.value === 'live' ? '7496' : '7497';
    if (portInput.value === currentDefaultPort) portInput.value = nextDefaultPort;
    currentDefaultPort = nextDefaultPort;
  });

  autoTradingToggle?.addEventListener('change', async () => {
    const bridge = window.velaIbkr;
    const accountId = selectedIbkrAccountId();
    if (!bridge || !accountId) {
      if (autoTradingToggle) autoTradingToggle.checked = false;
      showAutoTradingStatus('Select a connected IBKR account before enabling Pine strategy previews.', 'error');
      return;
    }
    autoTradingToggle.disabled = true;
    try {
      const result = await bridge.armStrategyTrading({ accountId, armed: autoTradingToggle.checked });
      if (result.armed) {
        armPineIbkrAutoTrading(`ibkr:${accountId}`);
        showAutoTradingStatus(`Pine strategy order previews are enabled for IBKR account ${accountId}. Confirm every order; existing strategy history is not replayed.`, 'success');
      } else {
        disarmPineIbkrAutoTrading();
        showAutoTradingStatus('IBKR Pine strategy order previews are off.');
      }
    } catch (error) {
      disarmPineIbkrAutoTrading();
      autoTradingToggle.checked = false;
      showAutoTradingStatus(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      renderAccounts();
    }
  });

  document.addEventListener('omega:trading-account-selected', event => {
    const selected = (event as CustomEvent<{ id?: string }>).detail?.id ?? '';
    const armed = getPineIbkrAutoTradingAccountId();
    if (armed && selected.toLowerCase() !== armed.toLowerCase()) renderAccounts();
  });
  document.addEventListener('omega:trading-account-unavailable', event => {
    if (String((event as CustomEvent<string>).detail ?? '').toLowerCase().startsWith('ibkr:')) renderAccounts();
  });
  document.addEventListener('omega:trading-broker-connecting', event => {
    if ((event as CustomEvent<string>).detail !== 'ibkr' && connectedAccountIds.length) void disconnect();
  });
  document.addEventListener('omega:trading-broker-exclusive', event => {
    if ((event as CustomEvent<string>).detail !== 'ibkr' && connectedAccountIds.length) void disconnect();
  });
  document.addEventListener('omega:trading-broker-disconnected', event => {
    if ((event as CustomEvent<string>).detail === 'ibkr') removeAccounts();
  });
  document.addEventListener('omega:pine-ibkr-auto-trading-state-changed', () => renderAccounts());
  document.addEventListener('omega:pine-live-order-result', event => {
    const detail = (event as CustomEvent<{ symbol?: string; side?: string; quantity?: number; action?: string; outcome?: string }>).detail;
    if (!detail?.symbol || !getPineIbkrAutoTradingAccountId()) return;
    const outcome = detail.outcome === 'filled' ? 'filled' : 'submitted to TWS';
    showAutoTradingStatus(`Pine strategy ${detail.action ?? 'order'} ${outcome}: ${detail.side ?? ''} ${detail.quantity ?? ''} ${detail.symbol}. Check TWS for final fill status.`, 'success');
  });
  document.addEventListener('omega:pine-live-order-error', event => {
    const detail = (event as CustomEvent<{ symbol?: string; error?: string }>).detail;
    if (!getPineIbkrAutoTradingAccountId()) return;
    showAutoTradingStatus(`IBKR Pine order failed${detail?.symbol ? ` for ${detail.symbol}` : ''}: ${detail?.error ?? 'Unknown order error.'}`, 'error');
  });
}