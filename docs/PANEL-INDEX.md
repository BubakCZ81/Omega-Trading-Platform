# Panel names

Panels are named by **where they are**, not by a number. Say the name and exactly one panel
changes.

Variables live in `src/styles.css` — dark theme in `:root` and light in
`body[data-theme="light"]`.

## Dark values today

| Name | Where it is | What is in it | Variable | Value |
|------|-------------|---------------|----------|-------|
| **topHigh** | first row from the top | Workspace, Save, Load, Timeframe, LAYOUT, GROUP, Theme, Settings, Tab View, Size, ZOOM, EXTRA, Replay, Visual Backtest, Account | `--panel-top-high-bg` | `#151f2c` |
| **topLow** | second row from the top on compact windows | bell, Trading Panel, Time & Sales, Depth, Data, Objects | `--panel-top-low-bg` | `#192635` |
| **chartTopLeft** | the chart's own top-left strip | **AAPL · Indicators · ⭐** | `--panel-chart-top-left-bg` | `#151f2c` |
| **bottomHigh** | first strip from the bottom | Pine Editor, Broker, Data Feeds, Watchlist, Trades, Trade History, Console, Debug Console, Loaded Bars, Live, **clock/UTC**, latency, P/L | `--panel-bottom-high-bg` | `#151f2c` |
| **bottomLow** | below bottomHigh, when open | editor drawer, console panels, Trades pane, Broker and Data Feeds dialogs | `--panel-bottom-low-bg` | `#151f2c` |
| **sideLeft** | left edge of the chart | vertical drawing-tool rail and chart-side Watchlist pane | `--panel-side-left-bg` | `#151f2c` |
| **raised** | inside any panel | buttons, inputs, selects | `--panel-raised-bg` | `#202d3c` |

The canvas behind everything is `--omega-bg` (`#0d1420`).

## Visual hierarchy

The dark theme uses neutral graphite-navy surfaces and text. Blue marks selected navigation
and focus, green/red remain reserved for market direction and order side, and amber is limited
to risk or warning states. On compact windows the global control strip scrolls horizontally
while account/data-feed actions stay in a separate row; at wider sizes the toolbar stays on one
line.

## Why the naming matters

The charting library emits **one statusline per pane**. A rule written against
`.vela-statusline` repaints every pane header inside the chart at once, which is why the
"make the AAPL bar lighter" request previously repainted the in-chart panels instead.
`chartTopLeft` is isolated with `:has(.vela-sl-symbol)` — only the strip carrying the symbol
matches it.

## Not yet wired

- **topLow** and **sideLeft** currently inherit the panel colour; their variables exist but no
  rule reads them yet, because both are composed by the charting library and their containers
  need confirming.
- **bottomLow** covers several different panels that share one variable for now.
