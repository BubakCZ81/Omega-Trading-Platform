/**
 * The platform boundary.
 *
 * This module is the ONLY place in Omega that is allowed to name the charting library.
 * Everything else imports from here, which means:
 *
 *   1. replacing the charting library becomes one adapter behind this file, not a
 *      rewrite across ~44 modules;
 *   2. an upgrade that breaks the library's API fails here, in one place;
 *   3. `scripts/check-platform-boundary.mjs` can enforce that the count of direct
 *      library imports never grows again.
 *
 * Add to this file deliberately: every symbol re-exported here becomes part of the
 * contract the rest of the application is allowed to depend on.
 */

export { registerLayout, VelaWorkspace } from '@luxalgo/vela/workspace';
export { BinanceProvider } from '@luxalgo/vela/providers/binance';
export { CoinbaseProvider } from '@luxalgo/vela/providers/coinbase';

export {
  createTheme,
  registerChartType,
  registerIcon,
  registerTheme,
  registerLegendAction,
  registerNativeIndicator,
  registerRendererLayer,
  registerSidePanel,
  registerStatePersistence,
  registerWidgetAction,
  sidePanels,
  timeframeToMs,
} from '@luxalgo/vela';

export type {
  DataProvider,
  DrawingLabel,
  DrawingLine,
  IndicatorHandle,
  InputSchema,
  InputValue,
  MarketSwitch,
  NativeIndicatorContext,
  OHLCV,
  ScriptingEngine,
  SidePanelHandle,
  StrategyState,
  StrategyTrade,
  SymbolDescriptor,
  SymbolInfo,
  UiTheme,
  Vela,
  VelaTheme,
  WidgetContext,
} from '@luxalgo/vela';

export type { RendererLayerArgs } from '@luxalgo/vela/plugin';

// Omega-owned market-data contract. Broker adapters target this, not the library.
export type {
  Bar,
  BarRange,
  MarketDataProvider,
  ProviderCapabilities,
  ProviderInfo,
  SymbolDescriptor as OmegaSymbolDescriptor,
} from './marketData';
