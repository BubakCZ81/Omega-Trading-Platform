# OMEGA Trading Desktop Platform

OMEGA is an Electron desktop trading workspace with a Vite/TypeScript renderer, multi-chart workspace, Pine editor, paper trading, and broker-specific data/execution adapters.

## Run and build

Requires Node.js 22 or later, npm, and (for the desktop shell) a supported Windows installation.

```powershell
npm install
npm run desktop
```

`npm run build` type-checks and builds the renderer. `npm run package:win` builds a Windows NSIS installer; it requires the project dependencies and a supported Windows build environment.

The Theme menu includes Dark blue, Soft light, Solarized Dark, and Solarized Light. The selection applies across the chart workspace, controls, and auxiliary windows. First launch loads the bundled `User_Workspaces\default.json` profile: Solarized Dark, BTC/USDT candles from Binance's public no-key feed, a local demo account, and the open paper-trading panel. Binance market data requires an internet connection and is real market data; orders remain in the local simulator. Manually saved workspace profiles go in Omega's per-user `Workspace\User_Workspaces` folder, which opens by default in save/load dialogs.

## Beginner guides

- [Start here](docs/BEGINNER-START-HERE.md) for the workspace, charts, and safe practice workflow.
- [Pine indicator and strategy tutorial](docs/PINE-BEGINNER-TUTORIAL.md) for editing, inputs, and local backtests.
- [Pine technical-analysis coverage](docs/PINE-TECHNICAL-ANALYSIS.md) lists the TA methods currently exposed by the installed PineTS runtime.
- [Strategy execution safety contract](docs/STRATEGY-EXECUTION.md) describes the current order-route limitations and requirements.
- [Scalper-readiness audit](docs/SCALPER-READINESS.md) records the verified demo-feed results and outstanding blockers.

## Broker connections

- **MetaTrader 5:** uses the locally installed MT5 terminal and a 64-bit Python interpreter with the `MetaTrader5` package. Manual chart orders require explicit session arming, a stop-loss, a confirmed preview, and an enforced per-order volume cap (maximum 20 lots). The order journal must be healthy and reconciled.
- **cTrader:** uses an external local MCP gateway at `http://127.0.0.1:9876/mcp/`; this repository contains the client, not the gateway. Live connectivity depends on that service being installed, running, and authenticated.
- **Quantower:** requires a separately installed local bridge at `http://127.0.0.1:17843`; OMEGA connects to that bridge but does not include or build its plugin.

Broker adapters have different capabilities; a configured feed does not imply that OMEGA can submit orders through it.

## Licensing note

OMEGA is licensed under the [GNU Affero General Public License, version 3 only](LICENSE.txt) (`AGPL-3.0-only`). The [Apache 2.0 license text](LICENSE-APACHE.txt) is retained for material originally released under those terms. Dependencies and bundled third-party material retain their respective licenses.
