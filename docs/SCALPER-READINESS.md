# Scalper-readiness audit

## Verdict

OMEGA is **not verified scalper-ready** and must not be used for unattended automatic scalping. The audit verified local strategy calculations, one cTrader demo order round-trip, and read-only Pepperstone MT5 timestamp normalization. Strategy execution durability/provenance gaps, broker-side Pine-order verification, and sustained feed-quality checks remain open. This is a readiness assessment, not a prediction of profitability.

## Verified

- The complete project test suite passed: 413 tests. The Python MT5 bridge suite passed all 43 tests after timestamp normalization.
- `npm run build` passed, and the startup bundle-budget check passed.
- The installed PineTS package and Monaco's shared Pine editor reference both contain all 68 currently declared `ta.*` methods. Representative SMA, EMA, RSI, ATR, MACD, and Bollinger calculations ran through PineTS; a TA-crossover strategy produced a local backtest fill.
- Live Pine strategy fills now require an account-bound confirm/cancel preview, expire after 30 seconds, and show that the Pine fill price is simulated. Entry protection uses Pine stop/target levels when available and otherwise Omega's configured protection. Unit tests cover side mapping, protection fallback, and the strategy execution routes; no broker order was submitted for this check.
- cTrader MCP 2.0.0 connected to one demo account and exposed 1,719 symbols. EURUSD spot quotes changed during a six-sample polling check. A 0.01-lot EURUSD demo buy with 20-pip stop-loss and take-profit was accepted; the exact returned position was closed, protection fields were present, and the position was absent afterward.
- The Pepperstone MT5 demo account connected with trading enabled and exposed 1,722 symbols, including 56 crypto matches. EURUSD bid/ask values changed during the short poll. The bridge now converts known `PepperstoneUK-` server timestamps for quotes, freshness checks, history ranges/bars, tick queries, and stream cursors. A read-only live check returned 60 chronological normalized M1 bars, and the tick stream returned a recent normalized tick. No MT5 order was submitted.
- The MT5 timestamp conversion is scoped to the empirically verified PepperstoneUK server family; other MT5 server families are deliberately left unchanged. These short probes do not establish sustained latency, jitter, reconnect, or loss performance.

## Blocking findings

### MT5 normalization is not a verified execution round-trip

The previously observed PepperstoneUK server-time offset is now normalized in the bridge, with unit coverage for seasonal offsets and DST boundaries and a read-only live check of chronological M1 history and the tick stream. This does not verify broker order freshness end-to-end, broker-side protection, uncertain outcomes, or other MT5 server families. Do not bypass the order guard or infer live-order readiness from chart data alone.

### Pine strategy routes are not a durable execution service

The new confirmation preview reduces accidental dispatch, but the execution contract still lacks persistent strategy intent/position state and complete restart reconciliation. The renderer does not pass independently verified confirmed-bar provenance through every strategy route. A cTrader manual trade test does not prove that Pine automation can safely submit, reverse, or recover from uncertain/partial orders. See [Strategy execution safety contract](STRATEGY-EXECUTION.md).

### Visual Backtester requires a connected history provider

The page rendered its controls and built-in strategy list in a fresh browser preview. Since that preview had no connected feed bridge, attempting to run correctly showed “Choose a symbol from a connected data feed before loading history.” The worker/backtest path is covered by automated tests, but a full history-load-and-display run through the desktop's authenticated feed bridge was not completed in the browser.

### Feed timing is not yet a scalping service-level guarantee

The sampled cTrader quotes were polled through MCP and changed during the short sample, but no tick-sequence latency, loss, jitter, reconnect, or sustained-load target was measured. A few seconds of MT5 updates likewise do not establish reliable low-latency execution.

## Recommended exit criteria

1. Keep the known PepperstoneUK timestamp conversion covered by UTC/DST tests, verify any newly supported MT5 server family independently, and confirm completed/forming candle alignment during a sustained session.
2. Re-run a protected minimum-volume MT5 demo order, verify the broker-side stop/target, then close and reconcile the exact ticket. Test rejection, partial/unknown outcome, disconnect, and restart without blind retries.
3. Persist and reconcile Pine strategy intents/positions across app restarts, and enforce trusted live/confirmed provenance at the broker boundary for every provider.
4. Repair the visual backtester page and verify its loading, strategy selection, history loading, fill display, and error states in the browser.
5. Measure each provider's quote age, update latency, dropped/duplicate ticks, spread, and reconnect behavior over a sustained session against explicit acceptance thresholds.

Until these criteria pass, use OMEGA for charting and local/paper testing only, not for unattended scalping.
