let armedIbkrAccountId: string | null = null;

export function armPineIbkrAutoTrading(accountId: string): void {
  if (!accountId.toLowerCase().startsWith('ibkr:')) {
    throw new Error('Automatic Pine strategy trading can only be armed for an IBKR account.');
  }
  armedIbkrAccountId = accountId;
  document.dispatchEvent(new CustomEvent('omega:pine-ibkr-auto-trading-state-changed'));
}

export function disarmPineIbkrAutoTrading(): void {
  if (!armedIbkrAccountId) return;
  armedIbkrAccountId = null;
  document.dispatchEvent(new CustomEvent('omega:pine-ibkr-auto-trading-state-changed'));
}

export function isPineIbkrAutoTradingArmed(accountId: string): boolean {
  return Boolean(armedIbkrAccountId && armedIbkrAccountId.toLowerCase() === accountId.toLowerCase());
}

export function getPineIbkrAutoTradingAccountId(): string | null {
  return armedIbkrAccountId;
}