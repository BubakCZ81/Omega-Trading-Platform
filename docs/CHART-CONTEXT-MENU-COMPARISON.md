# Chart context-menu comparison

This is a task-focused benchmark of the chart interactions in the platform comparison set, not an exhaustive inventory of every version or configuration. The most useful shared patterns are fast chart controls, context-aware trading, clear scale controls, drawing/indicator management, replay/history navigation, and access to chart settings.

| Platform | Relevant interaction pattern | Omega decision |
| --- | --- | --- |
| TradingView | Contextual chart and scale actions; drawing, alert, and chart-view workflows | Add price copying, preserve chart-specific actions, and separate task groups. |
| MetaTrader 5 | Trading and market-depth access alongside indicators, objects, templates, chart display, and properties | Keep order actions distinct from view/settings actions; do not overload the menu with every display toggle. |
| cTrader | Chart-centric trading, depth, indicator/drawing, and view controls | Keep price-related actions close to the pointer and make history navigation direct. |
| NinjaTrader | Chart Trader, data-series, indicator, drawing, and chart-property workflows | Keep order management and chart configuration in separate groups. |
| Sierra Chart | Dense study, drawing, trading, and chart-scale controls | Prefer concise groups over a long undivided list. |
| Quantower | Chart trading, DOM, studies, drawings, and chart/workspace configuration | Preserve the existing chart-context trading and settings actions. |
| Bookmap | Order-book/volume interaction, trading, replay, and view controls | Make navigation available without hiding the live chart behind a dialog. |
| ProRealTime | Chart trading, technical-analysis tools, drawing, and display controls | Keep the return-to-latest control visible in the chart, not only in a menu. |
| IBKR TWS | Trading, alerts, studies, and chart preferences | Avoid adding unsupported broker operations to chart menus. |
| TrendSpider | Technical-analysis, drawing, alert, and chart-view workflows | Keep analytical actions discoverable without adding expensive background features. |

## Resulting Omega behavior

- The chart-body menu groups price, trading, chart-view, tools/settings, and replay actions with separators. `Copy price` is only offered when the pointer is over the price pane.
- `Show latest candles` uses Omega's configured recent-candle count. Vela's built-in `Reset chart view` remains separate and frames the full loaded history.
- The price-axis menu already has native separators around scale modes, labels/levels, price-to-bar ratio, and settings. Preserve those native groups rather than duplicating their controls.
- When the visible window is materially behind the newest loaded bar, a right-pointing control appears at the chart's mid-right edge. It returns to the latest loaded bar while preserving the horizontal time span, and stays hidden during replay.

The return control operates on loaded chart history. It does not claim that a disconnected provider is live or fetch data on its own.
