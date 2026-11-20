# Omega UI agent index

Source-navigation map for buttons, labels, icons, panels, windows, dialogs and their UI
locations. `index.html` defines most static controls; behavior is usually in the module listed
below. Vela-generated controls are indexed by their action/panel IDs rather than static HTML.

`src/uiInventory.ts` captures visible elements in the active app window, including their live
pixel positions, to `userData/ui-inventory.json`. It does not enumerate closed dialogs or other
standalone windows automatically. `docs/UI-MAP.md` is a dated viewport snapshot; open the relevant
window and recapture its inventory before using it as a position reference.

## How to use this index

1. Search this file for the visible button/text label, selector/ID, or name of the UI area.
2. Use the matching row to identify where that control appears and open its owning source file(s).
3. After every UI change, update this index so labels, positions, ordering, and source locations stay current.

Dark blue, Soft light, Solarized Dark and Solarized Light share button positions and ordering;
palette colors vary by theme. Responsive layouts may use compact visible labels while retaining
the full accessible control name.

## Find by UI area

| UI area | Where it appears | Start here |
|---|---|---|
| App startup and shell | Startup screen, chart viewport, app overlays; when no saved workspace exists, loads the bundled Solarized Dark BTC/USDT default and local demo account | `index.html` (`#omega-startup-screen`, `#app-container`, `#chart-wrapper`); `User_Workspaces/default.json`; `electron/main.cjs` (first-run fallback/profile copy); `src/main.ts`, `src/tradingAccounts.ts` |
| Global toolbar | Top row: workspace, timeframe, layout/group, theme, settings, replay, account | `index.html` (`#top-toolbar`); `src/topPanel.ts`, `src/themeControls.ts`, `src/chartTimeframeControls.ts`, `src/replayControls.ts`, `src/tradingAccounts.ts`; layout CSS in `src/styles.css` |
| Chart header and tools | Per-chart symbol/actions; drawing rail at left | `src/main.ts` (Vela workspace config); `src/chartToolsRail.ts`, `src/chartTopbarActions.ts`, `src/autoTrendlines.ts`, `src/favoriteDrawingTools.ts`; layout/theme in `src/styles.css` |
| Chart overlays and trading | Quick Trade, order-entry panel, chart status and trading-session labels | `src/quickTradeToggle.ts`, `src/chartPaperTrading.ts`, `src/rightTradingPane.html`, `src/rightTradingPanel.ts`, `src/tradingSessions.ts` |
| Bottom toolbar and panels | Pine Editor, Broker, Data Feeds, Watchlist, Trades, Trade History, consoles | `index.html` (`#bottom-bar`); `src/bottomPanel.ts`, `src/editorDrawer.ts`, `src/watchlist.ts`, `src/chartPaperTrading.ts`, `src/diagnostics.ts` |
| Docked Pine Editor | Bottom-docked editor, AI/docs panes, console | `src/editorDrawer.ts`, `src/pineScriptControls.ts`, `src/pineEditorLifecycle.ts`, `src/pineAiAssistant.ts`, `src/pineReferencePanel.ts`; markup/styles in `index.html`, `src/styles.css` |
| Standalone Pine Editor | Separate full-window editor, assistant, docs and console | `pine-editor.html`; `src/pineEditorStandalone.ts`, `src/pineEditorStandalone.css`, `src/pineEditorNext.ts` |
| Visual Backtesting | Standalone backtest window and its chart/results | `visual-backtest.html`; `src/backtester/omegaBacktester.tsx`, `src/backtester/BacktestWindow.tsx`, `src/backtester/backtester.css` |
| Indicator Browser | Search, categories, saved Pine scripts, context actions, result cards/details | Embedded modal in `index.html` (`#indicator-browser-modal`); `src/indicatorBrowser.ts`; standalone catalog window in `indicator-browser.html`, `src/indicatorBrowserWindow.ts` |
| Other dialogs and menus | Script creation, update notice, chart settings/context menus, broker/feed dialogs | `index.html`; `src/pineDialog.ts`, `src/updateChecker.ts`, `src/chartSettingsActions.ts`, `src/chartContextActions.ts`, `src/brokerPanel.ts`, `src/mt5Feed.ts`, `src/quantowerFeed.ts` |

## Main platform controls

| Label / control | Selector or stable ID | Location and owner |
|---|---|---|
| Workspace name, Save, Load | `#workspace-profile-name`, `#workspace-save-profile`, `#workspace-load-profile` | Global toolbar, workspace group — first-run profile `User_Workspaces/default.json`; profile controls `src/workspaceProfiles.ts` |
| Timeframe and custom interval | `#ctrader-timeframe-menu`, `#ctrader-timeframe-grid`, `#chart-type-select`, `#custom-timeframe-menu`, `#apply-custom-timeframe` | Global toolbar dropdown — `src/chartTimeframeControls.ts` |
| Layout and chart group | `#chart-layout-select`, `#chart-group-color`, `#chart-group-indicator` | Global toolbar — `src/main.ts`, `src/layoutMap.ts`, `src/chartGroups.ts` |
| Theme | `#theme-menu`, `[data-theme-choice]` | Global toolbar dropdown — `src/themeControls.ts`; theme rules in `src/styles.css` |
| Settings and chart tabs | `#top-chart-settings`, `#chart-tabs-toggle`, `#chart-tabs-add` | Global toolbar / chart-tab strip — `src/chartSettingsOpen.ts`, `src/chartTabs.ts` |
| Zoom | `#platform-zoom-out`, `#platform-zoom-in`, `#platform-zoom-value` | Global toolbar — `src/main.ts` |
| Replay | `#replay-menu`, `#replay-from`, `#replay-speed`, `#replay-start`, `#replay-step`, `#replay-play-pause`, `#replay-stop` | Global toolbar dropdown — `src/replayControls.ts` |
| Visual Backtest launcher | `#visual-backtest-toggle` | Global toolbar — `src/topPanel.ts`; standalone window bridge in `src/main.ts` and `src/backtester/omegaBacktester.tsx` |
| Data Feeds and account | `#local-feeds-toggle`, `#trading-account-select`, `#trading-account-status` | Toolbar right/account area; default `local-demo` account is simulated — `src/bottomPanel.ts`, `src/tradingAccounts.ts` |
| Public demo market data | `binance:BTCUSDT` in the default profile; BTC and ETH symbols are preloaded into the watchlist | Binance public candles/live updates with Coinbase public-data fallback; no key or login, internet required; real crypto prices, orders remain simulated — `User_Workspaces/default.json`, `src/main.ts`, `src/watchlist.ts`, `src/platform/index.ts` |
| Update notice | `#update-info-modal`, `#update-info-close`, `#update-info-message` | App overlay/dialog — `src/updateChecker.ts` |

## Chart header, rails and overlays

| Label / icon / panel | Stable ID or selector | Location and owner |
|---|---|---|
| Symbol, Indicators, favorite tools, Pine Editor | Vela actions `symbol`, `indicators`, `omega-favorite-drawing-tools`, `omega-pine-editor` | Chart topbar, left group — Vela-native actions; Omega registration in `src/favoriteDrawingTools.ts`, `src/pineScriptControls.ts` |
| Auto Upper/Lower Trendline | `omega-auto-upper-trendline`, `omega-auto-lower-trendline` | Sidebar actions in the left Tools rail — `src/autoTrendlines.ts` |
| Auto Supply & Demand Zones | `omega-supply-demand-zones` | Sidebar action and chart overlay — `src/supplyDemandZones.ts`, `src/supplyDemandAlgorithm.ts` |
| Data Window | Vela panel `vela-widget-panel-dataWindow` | Bottom-anchored section of the left Tools rail; sidebar panel buttons are excluded from generic `[data-panel-id]` drag positioning in `src/styles.css` — `src/chartToolsRail.ts` |
| Trading Panel, Object Tree, Time & Sales, Depth of Market, Alerts | Vela IDs `vela-widget-panel-omega-trading-panel`, `vela-widget-panel-objects`, `vela-widget-panel-omega-time-sales`, `vela-widget-panel-omega-dom`, `vela-widget-alerts` | Chart topbar right group, in this order; native dock toggles are moved from the panel group by `placeMarketFlowButtonsAfterTradingPanel`; Trading Panel uses compact `Trade` label below 56.25rem, with full accessible name retained — `src/tradingPanel.ts`, `src/chartToolsRail.ts`, `src/styles.css`; icon in `src/chartTopbarActions.ts`; market panels in `src/marketFlowPane.ts` |
| Object Tree, Time & Sales, Depth of Market rail launchers | Vela sidebar IDs `objects`, `omega-time-sales`, `omega-dom` | Their duplicate left-rail launchers are hidden after their existing topbar panel buttons are placed — `src/chartToolsRail.ts`, `src/styles.css` |
| Screenshot | Vela ID `vela-widget-screenshot` | Chart topbar right group after the panel controls — `src/chartTopbarActions.ts` |
| Chart drawing tools and sidebar actions | `.vela-ws-toolbar`, `.vela-dtb`, `.vela-sidebar` | Compact vertical left rail: drawing tools are content-sized, sidebar actions follow directly underneath, and the Data Window stays bottom-anchored; geometry is theme-independent — `src/chartToolsRail.ts`, `src/styles.css` |
| Quick Trade | `#chart-paper-trade-controls`, `#paper-trade-lots`, `#paper-trade-buy`, `#paper-trade-sell`, `#paper-trade-settings-btn` | Floating chart controls — `src/quickTradeToggle.ts`, `src/chartPaperTrading.ts` |
| Right Trading Panel | Vela side panel `omega-trading-panel`; body `#omega-trading-pane`, `#omega-tp-buy`, `#omega-tp-sell`, `#omega-tp-trade`, `#omega-tp-lots`, `#omega-tp-sl`, `#omega-tp-tp` | Docked chart column shrinks the chart to preserve the price axis; the bundled default workspace opens it and Vela persists its open/width state — contribution `src/tradingPanel.ts`, template `src/rightTradingPane.html`, behavior `src/chartPaperTrading.ts`, `src/rightTradingPanel.ts` |
| Chart status, P/L and session | `.vela-statusline`, `.omega-chart-pnl`, `#trading-session-status` | Chart cell / chart overlay — `src/chartCellControls.ts`, `src/chartPaperTrading.ts`, `src/tradingSessions.ts` |
| Chart menus and settings | Vela context menus; `.vela-dialog--settings` | Chart/axis right-click menus and settings dialog — `src/chartContextActions.ts`, `src/chartSettingsActions.ts`, `src/chartRendererSettings.ts` |
| Return to latest | Chart edge return-to-latest control | Chart viewport — `src/chartReturnToLatest.ts` |

## Bottom toolbar and platform panels

| Tab / panel | Selector | Location and owner |
|---|---|---|
| Pine Editor | `#editor-toggle-btn`, `#editor-drawer` | Bottom toolbar and docked editor — `src/editorDrawer.ts` |
| Broker, Data Feeds | `#broker-toggle`, `#local-feeds-toggle`, `#broker-modal`, `#local-feeds-modal` | Bottom toolbar / chooser dialogs — `src/bottomPanel.ts`, `src/brokerPanel.ts` |
| Watchlist | `#watchlist-toggle`, `#watchlist-panel`, `#watchlist-search`, `#watchlist-list` | Bottom toolbar / watchlist pane — `src/watchlist.ts` |
| Trades, Trade History | `#open-trades-toggle`, `#trade-history-toggle`, `#paper-open-trades-modal`, `#paper-trade-history-modal` | Bottom toolbar / paper-trading panes — `src/chartPaperTrading.ts` |
| Console, Debug Console | `#activity-console-toggle`, `#diagnostics-console-toggle`, `#activity-console` | Bottom toolbar / app console overlay — `src/bottomPanel.ts`, `src/diagnostics.ts` |
| MT5 feed and live order | `#mt5-feed-modal`, `#mt5-live-order-panel`, `#mt5-live-order-form`, `#mt5-order-journal` | Feed/order panel — `src/mt5Feed.ts` |
| Quantower feed and order | `#quantower-feed-modal`, `#quantower-live-order-panel`, `#quantower-live-order-form` | Feed/order panel — `src/quantowerFeed.ts`, `src/main.ts` |
| Execution safeguards | `#safeguards-settings-modal`, `#safeguards-provider-list`, `#safeguards-scenario-results` | Safeguards dialog — `src/safeguardsPanel.ts` |
| Market flow and news | Vela side panels `omega-time-sales`, `omega-dom`, `omega-news` | Chart side panels — `src/marketFlowPane.ts`, `src/newsPanel.ts` |
| Strategy backtest panel | Vela side panel `backtest` | Chart side panel — `src/backtestPanel.ts` |

## Pine Editor surfaces

| Controls / visible text | Selector(s) | Location and owner |
|---|---|---|
| Pine script, New/Save/Delete/Export, Add/Update to chart | `#script-select`, `#btn-new`, `#btn-save`, `#btn-delete`, `#btn-export-script`, `#btn-add-to-chart`, `#btn-update-chart` | Docked editor toolbar — `src/pineScriptControls.ts`, `src/pineEditorLifecycle.ts` |
| Editor size, standalone, close | `#btn-editor-fullscreen`, `#btn-open-standalone-editor`, `#btn-editor-dismiss` | Docked editor toolbar — `src/editorDrawer.ts`, `src/pineScriptControls.ts` |
| Code, assistant, docs | `#code-editor`, `#pine-ai-assistant`, `#pine-reference`, `#pine-ai-resize`, `#pine-reference-resize` | Editor workspace and resizable panes — `src/pineEditorNext.ts`, `src/pineAiAssistant.ts`, `src/pineReferencePanel.ts` |
| AI settings and composer | `#pine-ai-settings`, `#pine-ai-provider`, `#pine-ai-model`, `#pine-ai-prompt`, `#pine-ai-ask`, `#pine-ai-stop` | Assistant pane — `src/pineAiAssistant.ts` |
| Pine console | `#console-panel`, `#console-toggle-handle`, `#console-output`, `#console-activity-output` | Docked editor bottom — `src/editorDrawer.ts` |
| Standalone window shell/loading | `#pine-editor-app`, `#pine-editor-loading`, `#pine-editor-retry` | Full-window app/loading state — `pine-editor.html`, `src/pineEditorStandalone.ts` |
| Standalone toolbar and actions | `.pine-editor-toolbar`, `#new-script`, `#save-script`, `#delete-script`, `#export-script`, `#add-to-chart`, `#update-chart`, `#open-docked`, `#upgrade-to-v6` | Standalone editor toolbar — `pine-editor.html`, `src/pineEditorStandalone.ts` |
| Standalone assistant/docs/console | `#pine-ai-assistant`, `#pine-reference`, `#pine-reference-search`, `#pine-reference-list`, `#standalone-console-panel`, `#clear-console` | Full-window editor panes — `src/pineEditorStandalone.ts`, `src/pineAiAssistant.ts`, `src/pineReferencePanel.ts` |

## Visual Backtesting and Indicator Browser

| Window area | Selector / component | Source |
|---|---|---|
| Visual Backtest window root | `#visual-backtest-app` | `visual-backtest.html`, `src/backtester/omegaBacktester.tsx` |
| Asset, timeframe, date range, script and strategy settings | `BacktestWindow` | `src/backtester/BacktestWindow.tsx` |
| Load/run, replay, chart, range slider, trades, equity, statistics and export | `BacktestWindow` controls and result panes | `src/backtester/BacktestWindow.tsx`; behavior/styles `src/backtester/backtester.ts`, `src/backtester/backtester.css` |
| Indicator Browser search and close | `#search`, `#close` | `indicator-browser.html`, `src/indicatorBrowserWindow.ts` |
| Categories, results, detail and count | `#categories`, `#results`, `#indicator-browser-detail`, `#indicator-browser-count` | `src/indicatorBrowserWindow.ts`, `src/indicatorBrowser.ts` |
| Create Pine category | `#indicator-browser-create-category` | Embedded Indicator Browser header; creates and selects an empty saved category — `index.html`, `src/indicatorBrowser.ts`, `src/pineStorage.ts` |
| New Indicator | `#indicator-browser-create-script`, `#create-script` | Embedded or standalone Indicator Browser header; opens the standalone Pine Editor and triggers its existing `#new-script` action (with a browser-only popup fallback) — `indicator-browser.html`, `src/indicatorBrowser.ts`, `src/indicatorBrowserWindow.ts`, `electron/preload.cjs`, `electron/main.cjs`, `src/pineEditorStandalone.ts` |
| Saved-script/category context menu | Right-click a saved Pine script or select its `⋯` actions button; right-click a custom category | Delete script, move to category, rename category, delete category; the red `×` appears beside each deletable custom category; storage helpers in `src/pineStorage.ts`, menu actions in `src/indicatorBrowser.ts`, chart/editor cleanup in `src/pineScriptControls.ts` |

## Dialogs, text, icons and generated controls

| UI family | Find it at | Source |
|---|---|---|
| Create Pine script dialog | `#new-script-modal`, `#modal-script-name`, `#modal-script-category`, `#modal-cancel-btn`, `#modal-confirm-btn` | `index.html`, `src/pineDialog.ts`, `src/pineScriptManager.ts` |
| Paper-trade settings, confirmation and pending order | `#paper-trade-settings-modal`, `#paper-trade-confirm-open`, `#paper-pending-order-modal` | `src/chartPaperTrading.ts` |
| Dynamic broker/feed forms and status text | `#broker-modal`, `#mt5-feed-modal`, `#quantower-feed-modal` and descendants | `src/brokerPanel.ts`, `src/mt5Feed.ts`, `src/quantowerFeed.ts` |
| Dynamic chart-cell actions and labels | `.vela-statusline`, `.vela-cell-controls` | `src/chartCellControls.ts` |
| Drawing favorite buttons/icons | `omega-favorite-drawing-tools` action | `src/favoriteDrawingTools.ts`, `src/drawingToolFavorites.ts` |
| Dynamic indicator cards/actions | `#results` and card descendants | `src/indicatorBrowser.ts`, `src/indicatorBrowserWindow.ts` |
| Pine reference topic buttons and AI message actions | `#pine-reference-list`, `#pine-ai-history`, `#pine-ai-chat` | `src/pineReferencePanel.ts`, `src/pineAiAssistant.ts` |
| Icons | Vela action/panel IDs in the Chart section; inline SVG registered by indicator/action modules | Search the action ID in its owner module; theme/size rules are in `src/styles.css` or the standalone window stylesheet |
| Labels, status and empty states | Stable `#...status`, `#...title`, `#...message`, `aria-label` selectors in the owning markup | Static labels: `index.html`, `pine-editor.html`, standalone HTML; dynamic text: owner module in the table for its panel |

## Layout, theme and lookup rules

- **Theme-independent placement:** Dark blue, Soft light, Solarized Dark and Solarized Light use
  the same DOM, Vela sidebar composition (`src/chartToolsRail.ts`), and compact rail geometry
  (`src/styles.css`). The drawing tools are followed by the sidebar actions; Data Window remains
  bottom-anchored. The order and spacing do not change with theme.
- **Button typography:** Main app and standalone Pine Editor buttons use a shared bold baseline
  from `src/styles.css`; Visual Backtesting and Indicator Browser apply the same bold weight
  in their separate window styles. All four themes retain their own colors while button labels
  use the same bold weight.
  Theme-specific rules change colors and surfaces, not control order or position. Responsive
  viewport breakpoints may change layout in either theme.
- **Theme-specific appearance:** `body[data-theme]` and `body[data-theme-variant]` in
  `src/styles.css` apply shared palette tokens; `src/themeControls.ts` supplies the matching
  chart palette through `velaTheme()`. Refer to these for color differences, not alternate
  control placement.
- Main-platform positions, spacing and theme tokens: `src/styles.css`; page structure and static
  IDs: `index.html`.
- Standalone Pine styles: `src/pineEditorStandalone.css`; Backtester styles:
  `src/backtester/backtester.css`; Indicator Browser styles: `src/indicatorBrowserWindow.ts`.
- Shared theme state and main-window theme controls: `src/themeControls.ts`.
- Search this index for the visible text, accessible name, selector, Vela ID or panel name. If a
  control is generated at runtime, start from its family root above and inspect the named owner.
- `docs/UI-MAP.md` is a dated pixel snapshot, not an authoritative selector or source map.
