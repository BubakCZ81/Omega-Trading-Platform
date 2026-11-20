let armedSaxoAccountId: string | null = null;

export function armPineSaxoAutoTrading(accountId: string): void {
  if (!accountId.toLowerCase().startsWith('saxo:')) {
    throw new Error('Automatic Pine strategy trading can only be armed for a Saxo account.');
  }
  armedSaxoAccountId = accountId;
  document.dispatchEvent(new CustomEvent('omega:pine-saxo-auto-trading-state-changed'));
}

export function disarmPineSaxoAutoTrading(): void {
  if (!armedSaxoAccountId) return;
  armedSaxoAccountId = null;
  document.dispatchEvent(new CustomEvent('omega:pine-saxo-auto-trading-state-changed'));
}

export function isPineSaxoAutoTradingArmed(accountId: string): boolean {
  return Boolean(armedSaxoAccountId && armedSaxoAccountId.toLowerCase() === accountId.toLowerCase());
}

export function getPineSaxoAutoTradingAccountId(): string | null {
  return armedSaxoAccountId;
}
