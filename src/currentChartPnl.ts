export interface ChartPnlTrade {
  cellId: string;
  currency: string;
}

export interface ChartPnlSummary {
  text: string;
  state: 'zero' | 'positive' | 'negative';
}

export function summarizeCurrentChartPnl<T extends ChartPnlTrade>(
  trades: Iterable<T>,
  currentCellId: string,
  calculate: (trade: T) => number | null,
  format: (amount: number, currency: string) => string,
): ChartPnlSummary {
  const totals = new Map<string, number>();
  for (const trade of trades) {
    if (trade.cellId !== currentCellId) continue;
    const pnl = calculate(trade);
    if (pnl === null || !Number.isFinite(pnl)) continue;
    totals.set(trade.currency, (totals.get(trade.currency) ?? 0) + pnl);
  }
  if (totals.size === 0) return { text: 'P/L: $0.00', state: 'zero' };
  const entries = [...totals];
  const net = entries.reduce((sum, [, amount]) => sum + amount, 0);
  return {
    text: entries.map(([currency, amount]) => `P/L: ${format(amount, currency)}`).join(' · '),
    state: net > 0 ? 'positive' : net < 0 ? 'negative' : 'zero',
  };
}
