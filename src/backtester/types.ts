import type { OHLCV } from '@luxalgo/vela';

/** Backtester candles use Unix seconds at the UI boundary, as Vela does. */
export type CandleBar = OHLCV;
export type Timeframe = string;

export interface AssetInfo {
  symbol: string;
  name: string;
  category: string;
  price: number;
  change24h: number;
  spread: number;
  decimals: number;
  minTick: number;
}
