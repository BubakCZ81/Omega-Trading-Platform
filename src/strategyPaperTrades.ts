import { createConfiguredProtectionLevels, type ProtectionConfig, type ProtectionLevels } from './paperTradeMath.ts';

export interface StrategyTradeSnapshot {
  id: string;
  side: 'long' | 'short';
  qty: number;
  entry: { time: number; price: number };
  exit?: { time: number; price: number };
  stopLoss?: number;
  takeProfit?: number;
  open: boolean;
  pnl?: number;
}

export interface InternalStrategyPaperTrade {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  qty: number;
  entryTime: number;
  entryPrice: number;
  exitTime?: number;
  exitPrice?: number;
  open: boolean;
  pnl?: number;
}

export function strategyBrokerEntrySide(side: 'long' | 'short'): 'BUY' | 'SELL' {
  return side === 'long' ? 'BUY' : 'SELL';
}

export function strategyBrokerOrderSide(side: 'long' | 'short', action: 'open' | 'close'): 'BUY' | 'SELL' {
  const entrySide = strategyBrokerEntrySide(side);
  if (action === 'open') return entrySide;
  return entrySide === 'BUY' ? 'SELL' : 'BUY';
}

export function resolvePineStrategyProtection(
  side: 'long' | 'short',
  entryPrice: number,
  minTick: number,
  pipSize: number,
  config: ProtectionConfig,
  atr14: number | null,
  strategyStopLoss?: number,
  strategyTakeProfit?: number,
): ProtectionLevels {
  const tradeSide = side === 'long' ? 'buy' : 'sell';
  const hasStrategyStopLoss = Number.isFinite(strategyStopLoss) && Number(strategyStopLoss) > 0;
  const hasStrategyTakeProfit = Number.isFinite(strategyTakeProfit) && Number(strategyTakeProfit) > 0;
  const configured = hasStrategyStopLoss && hasStrategyTakeProfit
    ? undefined
    : createConfiguredProtectionLevels(tradeSide, entryPrice, minTick, config, atr14, pipSize);
  const rawStopLoss = hasStrategyStopLoss ? Number(strategyStopLoss) : configured!.stopLoss;
  const rawTakeProfit = hasStrategyTakeProfit ? Number(strategyTakeProfit) : configured!.takeProfit;
  const align = (price: number, roundUp: boolean) => {
    const ticks = price / minTick;
    const alignedTicks = roundUp ? Math.ceil(ticks - 1e-9) : Math.floor(ticks + 1e-9);
    return Number((alignedTicks * minTick).toPrecision(15));
  };
  const stopLoss = align(rawStopLoss, tradeSide === 'sell');
  const takeProfit = align(rawTakeProfit, tradeSide === 'buy');
  const valid = tradeSide === 'buy'
    ? stopLoss < entryPrice && takeProfit > entryPrice
    : stopLoss > entryPrice && takeProfit < entryPrice;
  if (!valid) throw new RangeError('The strategy’s stop-loss or take-profit is on the wrong side of its entry price.');
  return { stopLoss, takeProfit };
}

/** Converts Vela's local strategy ledger into display-only paper trades. */
export function toInternalStrategyPaperTrades(strategyId: string, symbol: string, trades: readonly StrategyTradeSnapshot[]): InternalStrategyPaperTrade[] {
  return trades.flatMap(trade => {
    if (!trade.id || !Number.isFinite(trade.qty) || trade.qty <= 0
      || !Number.isFinite(trade.entry?.time) || !Number.isFinite(trade.entry?.price)) return [];
    const open = trade.open === true && !trade.exit;
    if (!open && (!trade.exit || !Number.isFinite(trade.exit.time) || !Number.isFinite(trade.exit.price))) return [];
    return [{
      id: `strategy:${strategyId}:${trade.id}`,
      symbol,
      side: trade.side === 'long' ? 'buy' : 'sell',
      qty: trade.qty,
      entryTime: trade.entry.time,
      entryPrice: trade.entry.price,
      exitTime: trade.exit?.time,
      exitPrice: trade.exit?.price,
      open,
      pnl: Number.isFinite(trade.pnl) ? trade.pnl : undefined,
    }];
  });
}
