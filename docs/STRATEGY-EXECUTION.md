# Strategy execution safety contract

## Current implementation

The desktop app has Pine strategy auto-trading routes for MT5, Quantower, IBKR, and Saxo. Each route is gated by a provider-specific, account-bound opt-in that resets on app restart; MT5 also requires its separate live-order session to be armed. Quantower market entries use the bridge’s order API. Manage SL/TP in Quantower. Omega can close a Pine position when the bridge returns a position ID for its fill. Manual broker orders are a separate path. Replay bars update the strategy ledger but are now explicitly blocked from submitting live strategy fills; the standalone visual backtester runs a local simulation.

Each newly detected live strategy fill now pauses at a chart-level confirm/cancel preview that expires after 30 seconds. It shows the Pine fill price as a simulated reference and warns that confirmation sends a broker market order. For entries, Pine-provided stop/target levels are preferred; missing levels come from Omega's configured protection settings. The preview does not replace broker-side validation.

These are implemented order routes, not a verified production execution service. Strategy position tracking is held in renderer memory, and the renderer does not pass a durable, provider-verified intent with confirmed-bar provenance or restart reconciliation. The Pine strategy snapshot contract does not guarantee stop-loss/take-profit values; if Pine does not provide both, the preview uses Omega's configured protection. Entries are blocked if valid protection cannot be prepared, and the MT5 live-order gate independently requires a stop-loss. Quantower entries remain blocked because its bridge cannot attach broker-side protection. The MT5 bridge has provenance/protection/reconciliation operations and unit tests, but the renderer's Pine strategy route does not use those operations. Do not treat previews or opt-in controls as proof that an adapter satisfies the safety requirements below.

The demo integration audit connected to both available accounts. A minimum-size cTrader demo order was opened with stop-loss and take-profit protection and then closed by its exact position id. No live-money order was sent. The MT5 demo connection and quote stream worked; the known PepperstoneUK server-time offset is now normalized for quote, history, and tick paths, with UTC/DST tests and read-only checks confirming chronological M1 bars and a recent tick. No MT5 order round-trip has been performed. See the [scalper-readiness audit](SCALPER-READINESS.md) for the exact results.

## Required provider guarantees

Before enabling unattended real-money strategy orders, each provider adapter must independently verify:

- The selected account identity and trading permission when armed and immediately before every broker operation.
- A confirmed, fresh live event. Historical/backfilled data, forming bars, replay, visual backtests, and paper sources must be refused by the execution boundary, not merely by UI state.
- Symbol, tick, volume-step, and order-size constraints, plus broker-side protective stop/target requirements for every new position.
- Strategy-tagged position inventory, exact-ticket closes, partial-fill detection, and broker-history reconciliation using an idempotency key.
- Ambiguous order outcomes as `unknown`, with no blind resend; unresolved intents must block new strategy orders.
- Durable position/order state that can be reconciled after app restart.

Reversals must close first, verify the broker is flat, then submit a protected opposite entry. Any partial or uncertain close must block the opposite entry.

## Remaining integration gaps

The current Pine runtime exposes calculated strategy ledgers, not trusted broker intents with independently verified live-bar provenance. The current renderer tracks positions in memory and has no persisted strategy-intent journal or restart reconciliation contract. A replay-state guard is present, but that alone does not establish trusted live-feed provenance or prevent every historical/backfill source from reaching the order route. Provider demo integration, protective-order enforcement, and failure/restart reconciliation must be verified before calling unattended live scalping safe.

The cTrader test covered the manual demo adapter only; it does not validate Pine strategy automation. The new Pine strategy confirmation UI and execution safeguards have automated tests, but have not been exercised against a broker. The known PepperstoneUK MT5 server-time offset is now normalized for quote, history, and tick paths, and read-only live checks confirmed chronological M1 bars and a recent tick. No MT5 order round-trip has been performed, other MT5 server families remain unverified, and the renderer still lacks durable strategy state and restart reconciliation. Do not weaken the freshness guard or enable unattended MT5 strategy automation.
