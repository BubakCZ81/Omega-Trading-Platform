let armedQuantowerAccountId: string | null = null;

export function armPineQuantowerAutoTrading(accountId: string): void {
  if (!accountId.toLowerCase().startsWith('quantower:') || accountId.toLowerCase() === 'quantower:local') {
    throw new Error('Automatic Pine strategy trading can only be armed for a connected Quantower account.');
  }
  armedQuantowerAccountId = accountId;
  document.dispatchEvent(new CustomEvent('omega:pine-quantower-auto-trading-state-changed'));
}

export function disarmPineQuantowerAutoTrading(): void {
  if (!armedQuantowerAccountId) return;
  armedQuantowerAccountId = null;
  document.dispatchEvent(new CustomEvent('omega:pine-quantower-auto-trading-state-changed'));
}

export function isPineQuantowerAutoTradingArmed(accountId: string): boolean {
  return Boolean(armedQuantowerAccountId && armedQuantowerAccountId.toLowerCase() === accountId.toLowerCase());
}

export function getPineQuantowerAutoTradingAccountId(): string | null {
  return armedQuantowerAccountId;
}
