interface TradingAccountChoice {
  id: string;
  label: string;
  mode: string;
  detail: string;
}

const LOCAL_DEMO_ACCOUNT: TradingAccountChoice = {
  id: 'local-demo',
  label: 'DEMO · Local account',
  mode: 'DEMO',
  detail: 'Local account',
};
const TRADING_ACCOUNT_STORAGE_KEY = 'omega.selected-trading-account';

export function initializeTradingAccounts(): void {
  const connectionLatency = document.getElementById('connection-latency');
  const tradingAccountMode = document.getElementById('trading-account-mode');
  const tradingAccountDetail = document.getElementById('trading-account-detail');
  const tradingAccountSelect = document.getElementById('trading-account-select') as HTMLSelectElement | null;
  const availableTradingAccounts = new Map<string, TradingAccountChoice>([[LOCAL_DEMO_ACCOUNT.id, LOCAL_DEMO_ACCOUNT]]);

  const selectTradingAccount = (id: string, persist = true): void => {
    const account = availableTradingAccounts.get(id) ?? LOCAL_DEMO_ACCOUNT;
    if (tradingAccountSelect) tradingAccountSelect.value = account.id;
    if (tradingAccountMode) tradingAccountMode.textContent = account.mode;
    if (tradingAccountDetail) tradingAccountDetail.textContent = account.detail;
    if (persist) localStorage.setItem(TRADING_ACCOUNT_STORAGE_KEY, account.id);
    document.dispatchEvent(new CustomEvent('omega:trading-account-selected', {
      detail: {
        id: account.id,
        provider: account.id.includes(':') ? account.id.slice(0, account.id.indexOf(':')).toLowerCase() : '',
      },
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
    selectTradingAccount(availableTradingAccounts.has(selected) ? selected : LOCAL_DEMO_ACCOUNT.id, false);
  };

  tradingAccountSelect?.addEventListener('change', () => selectTradingAccount(tradingAccountSelect.value));
  document.addEventListener('omega:trading-account-available', event => {
    const account = (event as CustomEvent<TradingAccountChoice>).detail;
    if (!account?.id || !account.label || !account.mode || !account.detail) return;
    availableTradingAccounts.set(account.id, account);
    renderTradingAccounts();
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
