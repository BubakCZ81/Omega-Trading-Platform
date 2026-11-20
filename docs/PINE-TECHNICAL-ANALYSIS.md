# Pine technical-analysis coverage

Omega's PineTS runtime exposes all 67 `ta.*` built-ins in the [TradingView Pine v6 reference](https://www.tradingview.com/pine-script-reference/v6/). The editor also documents the PineTS helper `ta.param` under PineTS Extensions.

Pine v6 built-ins

`ta.accdist`, `ta.alma`, `ta.atr`, `ta.barssince`, `ta.bb`, `ta.bbw`, `ta.cci`, `ta.change`, `ta.cmo`, `ta.cog`, `ta.correlation`, `ta.cross`, `ta.crossover`, `ta.crossunder`, `ta.cum`, `ta.dev`, `ta.dmi`, `ta.ema`, `ta.falling`, `ta.highest`, `ta.highestbars`, `ta.hma`, `ta.iii`, `ta.kc`, `ta.kcw`, `ta.linreg`, `ta.lowest`, `ta.lowestbars`, `ta.macd`, `ta.max`, `ta.median`, `ta.mfi`, `ta.min`, `ta.mode`, `ta.mom`, `ta.nvi`, `ta.obv`, `ta.percentile_linear_interpolation`, `ta.percentile_nearest_rank`, `ta.percentrank`, `ta.pivot_point_levels`, `ta.pivothigh`, `ta.pivotlow`, `ta.pvi`, `ta.pvt`, `ta.range`, `ta.rci`, `ta.rising`, `ta.rma`, `ta.roc`, `ta.rsi`, `ta.sar`, `ta.sma`, `ta.stdev`, `ta.stoch`, `ta.supertrend`, `ta.swma`, `ta.tr`, `ta.tsi`, `ta.valuewhen`, `ta.variance`, `ta.vwap`, `ta.vwma`, `ta.wad`, `ta.wma`, `ta.wpr`, and `ta.wvad`.

Use `ta.accdist`, `ta.iii`, `ta.nvi`, `ta.obv`, `ta.pvi`, `ta.pvt`, `ta.wad`, and `ta.wvad` as series variables. `ta.tr` and `ta.vwap` are available as both series and function calls.

The regression tests compare the runtime names with the editor catalog and execute a representative calculation for every built-in on OHLCV data. Full numerical parity with TradingView across all overloads and inputs remains unverified. When upgrading PineTS, review the documented signatures and update the tests for any new built-ins.
