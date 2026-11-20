# OMEGA beginner guide

OMEGA is a desktop charting and trading workspace. Use it to inspect market data, write and test Pine-style scripts, and practise with simulation before considering broker execution. A successful build, a visible quote, or a profitable historical test does not prove that a live order route is safe or profitable.

## First session

1. Install Node.js 22 or later and run `npm install` in the project folder.
2. Start the development desktop with `npm run desktop`, or use the packaged desktop build provided for your platform.
3. Open a chart and choose the intended symbol and timeframe. Confirm the symbol's broker/feed source; similar ticker names can refer to different instruments.
4. Load enough historical data for the indicators or strategy you want to test. OMEGA's historical chart data is candle-based; live quote/tick updates depend on the selected feed and its connection.
5. Add built-in indicators or open the Pine editor to create your own. The editor provides completion, reference, hover help, and diagnostics for the supported subset.

## Practise safely

- Start with a visual/local backtest or a paper-trading account. Check that the selected account is explicitly identified as simulated before placing any order.
- Inspect the strategy's entries, exits, size, fees, and protective levels. A backtest fill is simulated and is not a broker acknowledgement.
- Keep any live-order arming or automation controls off while learning. Never assume that a data connection is also an order connection.
- Verify quote freshness, spread, symbol mapping, order-size increments, and stop/target behavior with the broker's own demo environment before relying on an adapter.

## Where to learn more

- [Pine indicator and strategy tutorial](PINE-BEGINNER-TUTORIAL.md)
- [Supported Pine technical-analysis methods](PINE-TECHNICAL-ANALYSIS.md)
- [Strategy execution safety contract](STRATEGY-EXECUTION.md)
- [UI map](UI-MAP.md) and [panel index](PANEL-INDEX.md)

## Current compatibility boundary

OMEGA uses PineTS for script execution and a curated reference catalog for Monaco. The catalog matches the 68 `ta.*` methods in the installed PineTS package, but this is not full TradingView Pine Script compatibility. Individual language features and broker integrations can still have limitations; consult the execution guide and test the exact script on representative data.
