let armedMt5AccountId: string | null = null;

export function armPineMt5AutoTrading(accountId: string): void {
  if (!accountId.toLowerCase().startsWith('mt5:')) {
    throw new Error('Automatic Pine strategy trading can only be armed for an MT5 account.');
  }
  armedMt5AccountId = accountId;
  document.dispatchEvent(new CustomEvent('omega:pine-auto-trading-state-changed'));
}

export function disarmPineMt5AutoTrading(): void {
  if (!armedMt5AccountId) return;
  armedMt5AccountId = null;
  document.dispatchEvent(new CustomEvent('omega:pine-auto-trading-state-changed'));
}

export function isPineMt5AutoTradingArmed(accountId: string): boolean {
  return Boolean(armedMt5AccountId && armedMt5AccountId.toLowerCase() === accountId.toLowerCase());
}

export function getPineMt5AutoTradingAccountId(): string | null {
  return armedMt5AccountId;
}