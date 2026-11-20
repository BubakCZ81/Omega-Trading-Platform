export interface ChartMt5TradingStatus {
  connected: boolean;
  tradingAllowed: boolean;
  terminalTradingAllowed: boolean;
  accountTradingAllowed: boolean;
  accountMode: 'demo' | 'contest' | 'real' | 'unknown';
  accountLogin: string;
  server: string;
}

export const MT5_QUOTE_MAX_AGE_MS = 30_000;

export function isFreshBrokerQuote(timeMsc: number, now = Date.now()): boolean {
  return Number.isFinite(timeMsc) && timeMsc > 0
    && Number.isFinite(now) && Math.abs(now - timeMsc) <= MT5_QUOTE_MAX_AGE_MS;
}

export const isFreshMt5Quote = isFreshBrokerQuote;

export function assertFreshMt5Quote(timeMsc: number, now = Date.now()): void {
  if (isFreshBrokerQuote(timeMsc, now)) return;
  if (!Number.isFinite(timeMsc) || timeMsc <= 0) {
    throw new Error('MT5 did not provide a timestamped quote. No order was sent; refresh prices in the connected terminal.');
  }
  if (timeMsc > now) {
    const aheadSeconds = Math.round((timeMsc - now) / 1000);
    throw new Error(`MT5 tick timestamp is ${aheadSeconds} seconds ahead of UTC. No order was sent; check the terminal server time and system clock.`);
  }
  const ageSeconds = Math.round(Math.abs(now - timeMsc) / 1000);
  throw new Error(`MT5 quote is stale; the last broker tick is ${ageSeconds} seconds old. No order was sent. Check that the market is open and MT5 is receiving live ticks.`);
}

export function alignMt5ProtectionPrices(
  side: 'buy' | 'sell',
  stopLoss: number,
  takeProfit: number,
  tickSize: number,
  digits: number,
): { stopLoss: number; takeProfit: number } {
  if (![stopLoss, takeProfit, tickSize, digits].every(Number.isFinite)
    || stopLoss <= 0 || takeProfit <= 0 || tickSize <= 0 || digits < 0) {
    throw new RangeError('MT5 stop-loss and take-profit prices require positive finite values and valid tick metadata.');
  }
  const align = (price: number, roundUp: boolean): number => {
    const ticks = price / tickSize;
    const alignedTicks = roundUp ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
    return Number((alignedTicks * tickSize).toFixed(Math.min(10, Math.floor(digits))));
  };
  return side === 'buy'
    ? { stopLoss: align(stopLoss, false), takeProfit: align(takeProfit, true) }
    : { stopLoss: align(stopLoss, true), takeProfit: align(takeProfit, false) };
}

export function assertSelectedMt5Account(
  status: ChartMt5TradingStatus,
  selectedAccountId: string | null,
): ChartMt5TradingStatus {
  if (!selectedAccountId?.toLowerCase().startsWith('mt5:')) {
    throw new Error('Select a connected MT5 account in the account selector before placing chart orders.');
  }
  if (!status.connected) throw new Error('The selected MT5 account is disconnected.');
  if (!status.terminalTradingAllowed) {
    throw new Error("MetaTrader 5 has 'Algo Trading' turned off. In your MT5 window, click the 'Algo Trading' button in the top toolbar (or press Ctrl+E) to allow trading.");
  }
  if (!status.accountTradingAllowed || !status.tradingAllowed) {
    throw new Error('The logged-in MT5 account does not currently permit trading (check if it is in investor/read-only mode or if trading is disabled by the broker).');
  }

  const connectedAccountId = `mt5:${status.accountLogin}@${status.server}`;
  if (connectedAccountId.toLowerCase() !== selectedAccountId.toLowerCase()) {
    throw new Error('The connected MT5 account does not match the account selected for chart trading.');
  }
  return status;
}