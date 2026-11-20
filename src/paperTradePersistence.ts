export interface PaperTradeStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ParsedPaperTrades<T> {
  trades: T[];
  invalidCount: number;
}

export function parsePaperTrades<T>(
  raw: string,
  isTrade: (value: unknown) => value is T,
): ParsedPaperTrades<T> {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('Saved paper-trade state is not an array.');
  const trades = parsed.filter(isTrade);
  return { trades, invalidCount: parsed.length - trades.length };
}

export function preservePaperTradeState(
  storage: PaperTradeStorage,
  key: string,
  raw: string,
  timestamp = Date.now(),
): string {
  const recoveryPrefix = `${key}.recovery-${timestamp}`;
  let recoveryKey = recoveryPrefix;
  let suffix = 1;
  while (storage.getItem(recoveryKey) !== null) {
    recoveryKey = `${recoveryPrefix}-${suffix++}`;
  }
  storage.setItem(recoveryKey, raw);
  return recoveryKey;
}
