import type { OHLCV } from './platform/index.ts';
import type { BarRange, SymbolDescriptor } from './platform/marketData.ts';

export interface HistoryRequest {
  provider: 'mt5' | 'alpaca' | 'ctrader' | 'quantower';
  ticker: string;
  timeframe: string;
  range: BarRange;
  connection?: number;
  symbol?: SymbolDescriptor;
}

export interface HistoryResult {
  bars: OHLCV[];
  atrRenkoPips?: number;
}

declare global {
  interface Window {
    omegaMarketData?: { load(request: HistoryRequest): Promise<HistoryResult> };
  }
}

export function desktopHistory() {
  return typeof window === 'undefined' ? undefined : window.omegaMarketData;
}

let connectionSequence = 0;

export function nextHistoryConnection(): number {
  return ++connectionSequence;
}
