/**
 * Omega's own market-data contract.
 *
 * This is the seam that keeps broker integration portable. Every broker adapter
 * (MetaTrader 5, cTrader, and Alpaca) implements THIS interface,
 * not the charting library's. The library is then just one consumer of it, reached
 * through `src/platform/index.ts`.
 *
 * Why it matters: the charting library can be replaced — or a second one supported
 * side by side — without touching a single broker adapter, because adapters no longer
 * name library types.
 */

import type { DataProvider as VelaDataProvider } from '@luxalgo/vela';

/** One candle. `time` is the bar's OPEN time in epoch milliseconds. */
export interface Bar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** A bounded fetch window. Every field is optional; providers apply their own defaults. */
export interface BarRange {
  from?: number;
  to?: number;
  limit?: number;
  /** Trading session the chart is showing (`'regular'` | `'extended'`) where it matters. */
  session?: string;
}

export interface MarketQuote {
  bid: number;
  ask: number;
  timeMsc?: number;
}

/** One instrument a provider can serve. */
export interface SymbolDescriptor {
  ticker: string;
  description?: string;
  type?: string;
  /** Connection-aware picker group, such as `US Futures` or `Forex`. */
  group?: string;
  /** Listing-venue prefix (`NASDAQ`, `NYSE`) or the provider's own (`MT5`, `CTRADER`). */
  prefix?: string;
  /** Owning provider name; the charting layer annotates this. */
  provider?: string;
}

/** What a provider is able to do, so callers never need provider-specific checks. */
export interface ProviderCapabilities {
  enumerate: boolean;
  stream: boolean;
  symbolInfo: boolean;
}

/** Provider metadata. */
export interface ProviderInfo {
  name: string;
  displayName?: string;
  supportedTimeframes?: readonly string[];
  capabilities: ProviderCapabilities;
}

/**
 * A market-data source for one venue.
 *
 * `getBars` is the only required member; everything else is a capability the caller
 * uses when present and works around when absent. This mirrors the shape the charting
 * library expects, so an Omega provider is accepted by it unchanged — that equivalence
 * is asserted below, at compile time.
 */
export interface MarketDataProvider {
  getBars(ticker: string, timeframe: string, range: BarRange): Promise<Bar[]>;
  getQuote?(ticker: string): Promise<MarketQuote>;
  info?(): ProviderInfo;
  listSymbols?(): Promise<SymbolDescriptor[]>;
  subscribe?(ticker: string, timeframe: string, onBar: (bar: Bar) => void, opts?: { session?: string }): () => void;
  configure?(config: unknown): void;
}

/**
 * Compile-time guard: every Omega provider must stay acceptable to the charting library.
 *
 * If a future version of the library changes its provider seam, this alias fails to
 * typecheck — in this one file — instead of failing at runtime inside a broker adapter.
 */
export type ProviderAcceptedByChartingLibrary = MarketDataProvider extends VelaDataProvider ? true : never;
