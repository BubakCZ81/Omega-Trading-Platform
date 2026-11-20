import { reportCaughtError } from './diagnostics.ts';
import type { OHLCV } from '@luxalgo/vela';

export {};

interface BrokerPosition {
  symbol: string;
  quantity: number;
  marketValue?: number;
  assetClass?: string;
}

interface BrokerAccount {
  name: string;
  currency: string;
  equity: number;
  cash?: number;
  environment?: 'live' | 'paper';
  positions: BrokerPosition[];
}

interface BrokerSnapshot {
  broker: string;
  fetchedAt: string;
  accounts: BrokerAccount[];
}

interface BrokerBridge {
  connectReadOnly(brokerId: string, credentials: Record<string, string>): Promise<BrokerSnapshot>;
  saveAlpacaCredentials?(credentials: { apiKey: string; apiSecret: string }): Promise<{ configured: boolean }>;
  hasSavedAlpacaCredentials?(): Promise<boolean>;
  placeAlpacaOrder?(request: { symbol: string; side: string; notional: number }): Promise<{ id: string; status: string } | null>;
  fetchSnapshot(): Promise<BrokerSnapshot>;
  fetchHistoricalBars(request: {
    symbol: string;
    timeframe: '1m' | '5m' | '15m' | '1h' | '1d';
    from: number;
    to: number;
    limit: number;
  }): Promise<OHLCV[] | null>;
  disconnect(): Promise<boolean>;
}

declare global {
  interface Window {
	velaBroker?: BrokerBridge;
  }
}

const modal = document.getElementById('broker-modal');
const openButton = document.getElementById('broker-toggle');
const closeButton = document.getElementById('broker-close');
const setupNote = document.getElementById('broker-setup-note');
const apiKeyInput = document.getElementById('alpaca-api-key') as HTMLInputElement | null;
const apiSecretInput = document.getElementById('alpaca-api-secret') as HTMLInputElement | null;
const connectButton = document.getElementById('broker-connect') as HTMLButtonElement | null;
const saveCredentialsButton = document.getElementById('broker-save-credentials') as HTMLButtonElement | null;
const refreshButton = document.getElementById('broker-refresh') as HTMLButtonElement | null;
const disconnectButton = document.getElementById('broker-disconnect') as HTMLButtonElement | null;
const status = document.getElementById('broker-status');
const alpacaOrderForm = document.getElementById('alpaca-order-form') as HTMLFormElement | null;
const accountsHost = document.getElementById('broker-accounts');

let activeBrokerId: string | null = null;
let providerTransitionRevision = 0;
let alpacaCredentialStateLoaded = false;

function setStatus(message: string, isError = false) {
  if (!status) return;
  status.textContent = message;
  status.dataset.state = isError ? 'error' : 'info';
}

async function loadAlpacaCredentialState() {
  const bridge = window.velaBroker;
  if (!bridge) {
	setStatus('Alpaca access requires the Omega desktop app and its broker bridge.', true);
	return;
  }
  if (!apiKeyInput || !apiSecretInput || !setupNote) {
	reportCaughtError('broker:initialize', new Error('Alpaca credential fields are missing.'), 'The Alpaca connection panel could not initialize.');
	return;
  }
  try {
	const saved = await bridge.hasSavedAlpacaCredentials?.() ?? false;
	if (saved) {
	  apiKeyInput.placeholder = 'Saved · leave blank to reuse';
	  apiSecretInput.placeholder = 'Saved · leave blank to reuse';
	  setupNote.textContent = 'Encrypted Alpaca credentials are saved on this device. Leave both fields blank to reuse them, or enter a new pair to replace them.';
	  if (saveCredentialsButton) saveCredentialsButton.textContent = 'Replace saved credentials';
	} else {
	  apiKeyInput.placeholder = 'Paste Alpaca API Key ID';
	  apiSecretInput.placeholder = 'Paste Alpaca Secret Key';
	  setupNote.textContent = 'Use credentials from your Alpaca paper or live account. Select the matching environment when creating the keys.';
	  if (saveCredentialsButton) saveCredentialsButton.textContent = 'Save credentials';
	}
	alpacaCredentialStateLoaded = true;
	if (!activeBrokerId) setStatus('Enter both Alpaca keys and connect, or save them encrypted on this device.');
  } catch (error) {
	reportCaughtError('broker:saved-key-check', error, 'Could not check for saved Alpaca credentials.');
	setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function renderSnapshot(snapshot: BrokerSnapshot) {
  if (!accountsHost) return;
  accountsHost.replaceChildren();
  if (alpacaOrderForm) {
    const environment = snapshot.accounts[0]?.environment;
    alpacaOrderForm.hidden = snapshot.accounts.length !== 1 || (environment !== 'live' && environment !== 'paper')
      || !window.velaBroker?.placeAlpacaOrder;
  }
  if (!snapshot.accounts.length) {
	const empty = document.createElement('p');
	empty.textContent = 'The broker returned no accounts.';
	accountsHost.append(empty);
	return;
  }

	for (const account of snapshot.accounts) {
		document.dispatchEvent(new CustomEvent('omega:trading-account-available', {
		  detail: {
			id: `${snapshot.broker}:${account.name}`,
			label: `${snapshot.broker} · ${account.name}`,
			mode: (account.environment ?? 'connected').toUpperCase(),
			detail: 'Alpaca market orders are available in the Broker panel.',
		  },
		}));
		const card = document.createElement('section');
	card.className = 'broker-account';
	const heading = document.createElement('div');
	heading.className = 'broker-account-heading';
	const name = document.createElement('strong');
	name.textContent = account.name || 'Broker account';
	const environment = document.createElement('span');
	environment.textContent = account.environment ?? 'account';
	heading.append(name, environment);

	const equity = document.createElement('p');
	equity.className = 'broker-equity';
	equity.textContent = `Equity: ${new Intl.NumberFormat(undefined, { style: 'currency', currency: account.currency || 'USD' }).format(account.equity)}`;
	card.append(heading, equity);

	if (account.cash !== undefined) {
	  const cash = document.createElement('p');
	  cash.className = 'broker-account-detail';
	  cash.textContent = `Cash: ${new Intl.NumberFormat(undefined, { style: 'currency', currency: account.currency || 'USD' }).format(account.cash)}`;
	  card.append(cash);
	}

	const positionsTitle = document.createElement('strong');
	positionsTitle.className = 'broker-positions-title';
	positionsTitle.textContent = `Open positions (${account.positions.length})`;
	card.append(positionsTitle);
	if (!account.positions.length) {
	  const noPositions = document.createElement('p');
	  noPositions.className = 'broker-account-detail';
	  noPositions.textContent = 'No open positions reported.';
	  card.append(noPositions);
	} else {
	  const positions = document.createElement('ul');
	  positions.className = 'broker-position-list';
	  for (const position of account.positions.slice(0, 50)) {
		const item = document.createElement('li');
		const marketValue = position.marketValue === undefined
		  ? ''
		  : ` · ${new Intl.NumberFormat(undefined, { style: 'currency', currency: account.currency || 'USD' }).format(position.marketValue)}`;
		item.textContent = `${position.symbol}: ${position.quantity}${marketValue}`;
		positions.append(item);
	  }
	  card.append(positions);
	}
	accountsHost.append(card);
  }

  const fetched = document.createElement('p');
  fetched.className = 'broker-account-detail';
  fetched.textContent = `Updated ${new Date(snapshot.fetchedAt).toLocaleString()}. Trade placement is not available from this panel.`;
  accountsHost.append(fetched);
}

async function connectReadOnly() {
	const bridge = window.velaBroker;
  if (!bridge || !connectButton || !apiKeyInput || !apiSecretInput) return;
  const credentials = { apiKey: apiKeyInput.value.trim(), apiSecret: apiSecretInput.value.trim() };

  if (Boolean(credentials.apiKey) !== Boolean(credentials.apiSecret)) {
	setStatus('Enter both the Alpaca API Key ID and Secret Key, or leave both blank to use saved credentials.', true);
	(credentials.apiKey ? apiSecretInput : apiKeyInput).focus();
	return;
  }
  if (!credentials.apiKey && !credentials.apiSecret) {
    try {
		if (!await bridge.hasSavedAlpacaCredentials?.()) {
		setStatus('Enter both Alpaca keys and click Connect, or enter them and click Save credentials first.', true);
		apiKeyInput.focus();
        return;
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
      return;
    }
  }

  connectButton.disabled = true;
	document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'alpaca' }));
  const requestRevision = providerTransitionRevision;
	activeBrokerId = null;
  accountsHost?.replaceChildren();
  if (alpacaOrderForm) alpacaOrderForm.hidden = true;
  if (refreshButton) refreshButton.hidden = true;
  if (disconnectButton) disconnectButton.hidden = true;
	setStatus('Connecting to Alpaca…');
  try {
	const startedAt = performance.now();
	const snapshot = await bridge.connectReadOnly('alpaca', credentials);
	if (requestRevision !== providerTransitionRevision) return;
	document.dispatchEvent(new CustomEvent('omega:connection-latency', { detail: performance.now() - startedAt }));
	activeBrokerId = 'alpaca';
	renderSnapshot(snapshot);
	document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'alpaca' }));
	setStatus('Connected to Alpaca. Saved encrypted credentials will be reused on this device.');
	if (refreshButton) refreshButton.hidden = false;
	if (disconnectButton) disconnectButton.hidden = false;
  } catch (error) {
	if (requestRevision === providerTransitionRevision) {
	  setStatus(error instanceof Error ? error.message : String(error), true);
	}
  } finally {
	apiKeyInput.value = '';
	apiSecretInput.value = '';
	connectButton.disabled = false;
  }
}

/** Starts the same Alpaca connection flow as the Broker panel, using only
 * credentials already encrypted by Electron on this device. */
export async function autoConnectSavedAlpaca(): Promise<boolean> {
  const bridge = window.velaBroker;
  if (!bridge?.hasSavedAlpacaCredentials) return false;
  try {
    if (!await bridge.hasSavedAlpacaCredentials()) return false;
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connecting', { detail: 'alpaca' }));
    setStatus('Connecting to saved Alpaca account…');
    const startedAt = performance.now();
    const snapshot = await bridge.connectReadOnly('alpaca', {});
    activeBrokerId = 'alpaca';
    renderSnapshot(snapshot);
    document.dispatchEvent(new CustomEvent('omega:connection-latency', { detail: performance.now() - startedAt }));
    document.dispatchEvent(new CustomEvent('omega:trading-broker-connected', { detail: 'alpaca' }));
    if (refreshButton) refreshButton.hidden = false;
    if (disconnectButton) disconnectButton.hidden = false;
    setStatus('Connected to saved Alpaca account.');
    const firstAccount = snapshot.accounts[0]?.name;
    const accountId = firstAccount ? `alpaca:${firstAccount}` : '';
    const accountSelect = document.getElementById('trading-account-select') as HTMLSelectElement | null;
    if (accountSelect && accountId) {
      accountSelect.value = accountId;
      accountSelect.dispatchEvent(new Event('change'));
    }
    return true;
  } catch (error) {
    activeBrokerId = null;
    setStatus(`Saved Alpaca auto-connect failed: ${error instanceof Error ? error.message : String(error)}`, true);
    window.velaDiagnostics?.record({
      source: 'broker-autoconnect', type: 'connection', name: 'alpaca', status: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function saveAlpacaCredentials() {
	if (!window.velaBroker || !saveCredentialsButton || !apiKeyInput || !apiSecretInput) return;
  const apiKey = apiKeyInput.value.trim();
  const apiSecret = apiSecretInput.value.trim();
  if (!apiKey || !apiSecret) {
    setStatus('Enter both Alpaca API credentials before saving.', true);
    return;
  }
  if (!window.velaBroker.saveAlpacaCredentials) {
    setStatus('Encrypted Alpaca credential storage is unavailable in this app version.', true);
    return;
  }
  saveCredentialsButton.disabled = true;
  setStatus('Encrypting and saving Alpaca credentials…');
  try {
    await window.velaBroker.saveAlpacaCredentials({ apiKey, apiSecret });
	apiKeyInput.value = '';
	apiSecretInput.value = '';
	apiKeyInput.placeholder = 'Saved · leave blank to reuse';
	apiSecretInput.placeholder = 'Saved · leave blank to reuse';
	if (setupNote) setupNote.textContent = 'Encrypted Alpaca credentials are saved on this device. Leave both fields blank to reuse them, or enter a new pair to replace them.';
	if (saveCredentialsButton) saveCredentialsButton.textContent = 'Replace saved credentials';
	setStatus('Alpaca credentials are encrypted and saved on this Windows device. Leave both fields blank next time and click Connect to Alpaca.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    saveCredentialsButton.disabled = false;
  }
}

async function refreshSnapshot() {
  if (!window.velaBroker || !activeBrokerId || !refreshButton) return;
  refreshButton.disabled = true;
  setStatus('Refreshing account data…');
  try {
	const startedAt = performance.now();
	renderSnapshot(await window.velaBroker.fetchSnapshot());
	document.dispatchEvent(new CustomEvent('omega:connection-latency', { detail: performance.now() - startedAt }));
	setStatus('Account data refreshed.');
  } catch (error) {
	setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
	refreshButton.disabled = false;
  }
}

async function disconnect() {
  if (!window.velaBroker) return;
  try {
	const disconnectedBrokerId = activeBrokerId;
	await window.velaBroker.disconnect();
	activeBrokerId = null;
	accountsHost?.replaceChildren();
    if (alpacaOrderForm) alpacaOrderForm.hidden = true;
	if (refreshButton) refreshButton.hidden = true;
	if (disconnectButton) disconnectButton.hidden = true;
	if (disconnectedBrokerId) document.dispatchEvent(new CustomEvent('omega:trading-broker-disconnected', { detail: disconnectedBrokerId }));
	setStatus('Disconnected. No credentials were saved.');
  } catch (error) {
	setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function openModal() {
	if (modal) modal.hidden = false;
  modal?.classList.add('open');
  modal?.setAttribute('aria-hidden', 'false');
  if (!alpacaCredentialStateLoaded) void loadAlpacaCredentialState();
}
function closeModal() {
	if (modal) modal.hidden = true;
  modal?.classList.remove('open');
  modal?.setAttribute('aria-hidden', 'true');
  openButton?.focus();
}

document.addEventListener('omega:bottom-panel:broker-toggle', openModal);
document.addEventListener('omega:alpaca-order-form', event => {
  openModal();
  if (!alpacaOrderForm || alpacaOrderForm.hidden) return;
  const { symbol, side } = (event as CustomEvent<{ symbol: string; side: string }>).detail;
  const symbolInput = alpacaOrderForm.querySelector<HTMLInputElement>('[name="symbol"]');
  const sideInput = alpacaOrderForm.querySelector<HTMLSelectElement>('[name="side"]');
  if (symbolInput) symbolInput.value = /^[A-Z][A-Z0-9.-]{0,19}$/i.test(symbol) ? symbol.toUpperCase() : '';
  if (sideInput) sideInput.value = side;
  alpacaOrderForm.querySelector<HTMLInputElement>('[name="notional"]')?.focus();
});
closeButton?.addEventListener('click', closeModal);
alpacaOrderForm?.addEventListener('submit', async event => {
  event.preventDefault();
  const bridge = window.velaBroker;
  const button = alpacaOrderForm.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (!bridge?.placeAlpacaOrder || !button || button.disabled) return;
  const fields = new FormData(alpacaOrderForm);
  button.disabled = true;
  try {
    const result = await bridge.placeAlpacaOrder({
      symbol: String(fields.get('symbol') ?? '').trim().toUpperCase(),
      side: String(fields.get('side') ?? ''),
      notional: Number(fields.get('notional')),
    });
    setStatus(result ? `Alpaca order ${result.id}: ${result.status}.` : 'Order cancelled.', result?.status === 'rejected');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    button.disabled = false;
  }
});
connectButton?.addEventListener('click', () => void connectReadOnly());
saveCredentialsButton?.addEventListener('click', () => void saveAlpacaCredentials());
refreshButton?.addEventListener('click', () => void refreshSnapshot());
disconnectButton?.addEventListener('click', () => void disconnect());
document.addEventListener('omega:trading-broker-connecting', event => {
  providerTransitionRevision += 1;
  const nextBrokerId = (event as CustomEvent<string>).detail;
  if (!nextBrokerId) return;
  activeBrokerId = null;
  accountsHost?.replaceChildren();
  if (alpacaOrderForm) alpacaOrderForm.hidden = true;
  if (refreshButton) refreshButton.hidden = true;
  if (disconnectButton) disconnectButton.hidden = true;
});
