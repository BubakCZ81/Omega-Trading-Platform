# Pine beginner tutorial

OMEGA runs Pine-style scripts through PineTS. Monaco's completions and reference panel use OMEGA's curated catalog. The supported surface is useful for indicators and local strategy backtests, but it is not a claim of full TradingView compatibility.

## Create an indicator

Open the Pine editor, create a script, and try:

```pine
//@version=6
indicator("EMA Pair", overlay=true)

fastLength = input.int(9, "Fast EMA", minval=1)
slowLength = input.int(21, "Slow EMA", minval=2)

fast = ta.ema(close, fastLength)
slow = ta.ema(close, slowLength)

plot(fast, "Fast EMA", color=color.aqua)
plot(slow, "Slow EMA", color=color.orange)
```

Save and add the script to the chart. The two inputs let you adjust the calculation without editing the code. If a method or argument is unfamiliar, type its namespace (for example `ta.`), inspect completion details, or search for it in the Pine reference panel. Hover help and diagnostics may identify supported signatures and syntax problems.

## Turn it into a strategy for a local backtest

Replace the indicator declaration and add entry/exit logic:

```pine
//@version=6
strategy("EMA Cross Example", overlay=true, initial_capital=10000)

fastLength = input.int(9, "Fast EMA", minval=1)
slowLength = input.int(21, "Slow EMA", minval=2)
fast = ta.ema(close, fastLength)
slow = ta.ema(close, slowLength)

if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("Long")

plot(fast, "Fast EMA", color=color.aqua)
plot(slow, "Slow EMA", color=color.orange)
```

Run the visual/local backtest on the intended symbol and timeframe. Verify that the chart has enough bars for both averages and that the tester reports entries and exits at plausible times. The local broker emulator does not submit broker orders. Results are sensitive to data quality, fill assumptions, fees, spread, slippage, and timeframe.

## Diagnose common problems

- **No trades:** check that the source is declared with `strategy(...)`, the selected history includes a crossover, and the script is applied to the chart/backtest.
- **Values are `na` initially:** many indicators need a warm-up period. Load more history or reduce the input length for a diagnostic run.
- **Unknown method or wrong arguments:** check the [current TA coverage list](PINE-TECHNICAL-ANALYSIS.md) and the reference panel. PineTS accepts only the version of the API shipped with this project.
- **A compile error:** read the editor's diagnostic and line/column first; fix one issue, re-run, then confirm the script still produces the intended signal.
- **A backtest looks too good:** include realistic costs and test other periods and symbols. A backtest is not a forecast and does not establish scalper readiness.

## Before considering broker automation

Do not treat a strategy signal or simulated fill as permission to trade. Broker execution has separate account, feed, order, protection, and reconciliation requirements. Read the [strategy execution safety contract](STRATEGY-EXECUTION.md); the current Pine strategy routes are not verified as production-safe unattended execution.
