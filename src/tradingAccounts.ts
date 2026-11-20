import { getChartAccountStatus } from './tradingAccountStatus';

interface TradingAccountChoice {
  id: string;
  label: string;
  mode: string;
  detail: string;
}

const LOCAL_DEMO_ACCOUNT: TradingAccountChoice = {
  id: 'local-demo',
  label: 'DEMO-25000 USD',
  mode: 'DEMO',
  detail: 'Local account',
};
const TRADING_ACCOUNT_STORAGE_KEY = 'omega.selected-trading-account';

export function initializeTradingAccounts(): void {
  const connectionLatency = document.getElementById('connection-latency');
  const tradingAccountStatus = document.getElementById('trading-account-status');
  const tradingAccountMode = document.getElementById('trading-account-mode');
  const tradingAccountDetail = document.getElementById('trading-account-detail');
  const tradingAccountSelect = document.getElementById('trading-account-select') as HTMLSelectElement | null;
  const availableTradingAccounts = new Map<string, TradingAccountChoice>([[LOCAL_DEMO_ACCOUNT.id, LOCAL_DEMO_ACCOUNT]]);
  let selectedAccountMode = getChartAccountStatus(LOCAL_DEMO_ACCOUNT.id, LOCAL_DEMO_ACCOUNT.mode);

  const renderChartAccountMode = (): void => {
    document.querySelectorAll<HTMLElement>('.vela-widget-bottombar').forEach(bar => {
      const timezoneButton = bar.querySelector<HTMLElement>('.vela-bb-tz');
      if (!timezoneButton) return;
      let modeLabel = bar.querySelector<HTMLElement>('.omega-account-mode-label');
      if (!modeLabel) {
        modeLabel = document.createElement('span');
        modeLabel.className = 'omega-account-mode-label';
        timezoneButton.insertAdjacentElement('afterend', modeLabel);
      }
      modeLabel.textContent = `Trading: ${selectedAccountMode}`;
      modeLabel.setAttribute('aria-label', `Selected trading account mode: ${selectedAccountMode}`);
      modeLabel.dataset.accountState = selectedAccountMode.toLowerCase().replaceAll(' ', '-');
    });
  };

  const chartBarsObserver = new MutationObserver(records => {
    const chartBarAdded = records.some(record => [...record.addedNodes].some(node => (
      node instanceof Element
      && (node.matches('.vela-widget-bottombar') || Boolean(node.querySelector('.vela-widget-bottombar')))
    )));
    if (chartBarAdded) renderChartAccountMode();
  });
  chartBarsObserver.observe(document.body, { childList: true, subtree: true });
  // The account selector stays in the application's fixed upper-right chrome.
  // It must not move into Vela's per-chart topbar when tabs or layouts rebuild.
  tradingAccountStatus?.classList.add('trading-account-status--top-right');

  /**
   * `notify` exists because rendering used to be indistinguishable from choosing.
   *
   * renderTradingAccounts() runs whenever an account becomes available or unavailable, and it
   * used to call this with notification enabled - so a render dispatched
   * `omega:trading-broker-exclusive`, which made the MT5 feed disconnect, which dispatched
   * `omega:trading-account-unavailable`, which rendered again. That loop called
   * `mt5:disconnect` eighty thousand times a minute and pulled the connection down the moment
   * it succeeded. Rendering now only paints the selector; only an explicit choice notifies.
   */
  const selectTradingAccount = (id: string, persist = true, notify = true): void => {
    const account = availableTradingAccounts.get(id) ?? LOCAL_DEMO_ACCOUNT;
    selectedAccountMode = getChartAccountStatus(account.id, account.mode);
    if (tradingAccountSelect) tradingAccountSelect.value = account.id;
    if (tradingAccountMode) tradingAccountMode.textContent = account.mode;
    if (tradingAccountDetail) tradingAccountDetail.textContent = account.detail;
    renderChartAccountMode();
    if (persist) localStorage.setItem(TRADING_ACCOUNT_STORAGE_KEY, account.id);
    if (!notify) return;
    const provider = account.id.includes(':') ? account.id.slice(0, account.id.indexOf(':')).toLowerCase() : '';
    // The account selector is the single switch for broker connectivity: choosing an
    // account must leave exactly that broker connected, so every other feed stands down.
    if (provider) {
      document.dispatchEvent(new CustomEvent('omega:trading-broker-exclusive', { detail: provider }));
    }
    document.dispatchEvent(new CustomEvent('omega:trading-account-selected', {
      detail: { id: account.id, provider },
    }));
  };

  const renderTradingAccounts = (): void => {
    if (!tradingAccountSelect) return;
    const selected = localStorage.getItem(TRADING_ACCOUNT_STORAGE_KEY) || LOCAL_DEMO_ACCOUNT.id;
    tradingAccountSelect.replaceChildren(...[...availableTradingAccounts.values()].map(account => {
      const option = document.createElement('option');
      option.value = account.id;
      option.textContent = account.label;
      return option;
    }));
    selectTradingAccount(availableTradingAccounts.has(selected) ? selected : LOCAL_DEMO_ACCOUNT.id, false, false);
  };

  let autoSelectTimer: number | undefined;
  const scheduleConnectedAccountSelection = (connectedAccountId: string): void => {
    if (autoSelectTimer !== undefined) window.clearTimeout(autoSelectTimer);
    autoSelectTimer = window.setTimeout(() => {
      autoSelectTimer = undefined;
      const selectedId = tradingAccountSelect?.value ?? LOCAL_DEMO_ACCOUNT.id;
      const savedId = localStorage.getItem(TRADING_ACCOUNT_STORAGE_KEY) ?? LOCAL_DEMO_ACCOUNT.id;
      // A newly connected price feed must not turn simulator orders into broker orders.
      if (savedId === LOCAL_DEMO_ACCOUNT.id) return;
      const separator = connectedAccountId.indexOf(':');
      const providerPrefix = separator > 0 ? connectedAccountId.slice(0, separator + 1).toLowerCase() : '';
      const connectedAccounts = [...availableTradingAccounts.keys()].filter(id =>
        id !== LOCAL_DEMO_ACCOUNT.id && (!providerPrefix || id.toLowerCase().startsWith(providerPrefix)),
      );
      const target = connectedAccounts.includes(savedId)
        ? savedId
        : connectedAccounts.includes(selectedId)
          ? selectedId
          : connectedAccounts[0] ?? '';
      if (target) selectTradingAccount(target, true, true);
    }, 0);
  };

  tradingAccountSelect?.addEventListener('change', () => selectTradingAccount(tradingAccountSelect.value));
  const accountLabel = tradingAccountStatus?.querySelector<HTMLElement>('.trading-account-label');
  if (accountLabel) accountLabel.textContent = 'Account';
  document.addEventListener('omega:trading-account-available', event => {
    const account = (event as CustomEvent<TradingAccountChoice>).detail;
    if (!account?.id || !account.label || !account.mode || !account.detail) return;
    availableTradingAccounts.set(account.id, account);
    renderTradingAccounts();
    scheduleConnectedAccountSelection(account.id);
  });
  document.addEventListener('omega:trading-account-unavailable', event => {
    const id = (event as CustomEvent<string>).detail;
    if (!id || id === LOCAL_DEMO_ACCOUNT.id) return;
    availableTradingAccounts.delete(id);
    renderTradingAccounts();
  });
  document.addEventListener('omega:trading-broker-disconnected', event => {
    const brokerId = (event as CustomEvent<string>).detail;
    if (!brokerId) return;
    for (const id of availableTradingAccounts.keys()) {
      if (id.startsWith(`${brokerId}:`)) availableTradingAccounts.delete(id);
    }
    renderTradingAccounts();
  });
  renderTradingAccounts();

  document.addEventListener('omega:connection-latency', event => {
    const milliseconds = (event as CustomEvent<number>).detail;
    if (!connectionLatency || !Number.isFinite(milliseconds)) return;
    connectionLatency.textContent = `Server: ${Math.round(milliseconds)} ms`;
    connectionLatency.dataset.quality = milliseconds < 100 ? 'good' : milliseconds < 300 ? 'warning' : 'poor';
  });
}
