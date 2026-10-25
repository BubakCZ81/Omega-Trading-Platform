# Omega 2.7.0

Omega is a Windows desktop charting and Pine Script development platform built
with Electron, TypeScript, and Vite.

## Install for traders

Traders install only the generated `Omega-Setup-<version>.exe`. The installer
contains Electron, the Broker SDK, all production dependencies, and the MT5
bridge. Node.js, npm, Rust, Python, and any source files are not required to
run Omega.

## Development only: run from source

Install Node.js 20 or newer. Then, from this directory:

```powershell
npm install
npm run desktop
```

To create the self-contained Windows installer, run:

```powershell
npm run package:win
```

## Pine Editor AI

The AI assistant is available in the installed Electron app for Gemini, Groq,
OpenRouter, Anthropic, Cohere, DeepSeek, Mistral, and Together AI. API keys are
encrypted for the current Windows user with Windows Data Protection (DPAPI).
The assistant sends the prompt and current Pine script to the provider you
select. A browser preview does not have access to the desktop bridge or its
encrypted key store, so AI requests are intentionally unavailable there.

## cTrader market data

The installed Electron app can connect to cTrader accounts for read-only chart
history and live quotes. Create a cTrader Open API application and enter its
Client ID and Client Secret in the Broker panel. Configure the application's
redirect URL as `http://127.0.0.1:17863/ctrader/callback`. Omega opens cTrader's
official authorization page in the system browser; cTrader ID sign-in, including
Google, is available there when enabled for the account. Linked live and demo
accounts are listed after authorization.

The app encrypts the Open API credentials and tokens for the current Windows
user with DPAPI. Select an account, then choose a symbol and use **Use selected
symbol on chart** to load its history and live updates. The cTrader connection
requests accounts-only access and does not place trades.

MetaTrader 5 integration additionally requires a local MT5 terminal and a
compatible Python installation. The MT5 bridge is included under `electron/`
and is bundled with the Electron application.

## Trading scope

Paper trades and pending paper orders are local simulations. Alpaca, MetaTrader
5, and cTrader provide market data; the cTrader connection is read-only. This
project does not certify live-trading readiness.
