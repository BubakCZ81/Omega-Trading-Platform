import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DataProvider, OHLCV } from '@luxalgo/vela';
import { Mt5DataProvider } from '../mt5Feed';
import { QuantowerDataProvider } from '../quantowerFeed';
import { AlpacaDataProvider } from '../alpacaFeed';
import { applyThemeUi, isOmegaTheme } from '../themeControls';
import { BacktestWindow } from './BacktestWindow';
import type { AssetInfo, CandleBar, Timeframe } from './types';
import { resolveBacktestAssetSymbol } from './assetSelection';
import './backtester.css';

type LaunchConfig = { source?: string; symbol?: string; timeframe?: string; provider?: string; strategy?: { title: string; source: string } };
type FeedSet = { providers: Map<string, DataProvider>; assets: AssetInfo[]; selectedSymbol: string };
type Mt5Symbols = Parameters<Mt5DataProvider['setSymbols']>[0];
type QuantowerSymbols = Parameters<QuantowerDataProvider['setSymbols']>[0];
type AppBridge = {
  velaDesktop?: { closeCurrentWindow?: () => Promise<void> };
  velaBroker?: { fetchHistoricalBars?: (...args: any[]) => any };
  velaVisualBacktestWindow?: { onOpenConfig?: (callback: (config: LaunchConfig) => void) => () => void };
};

const FEED_SYMBOL_DISCOVERY_TIMEOUT_MS = 5_000;

function withFeedSymbolDiscoveryTimeout<T>(loadSymbols: () => Promise<T>, providerName: string): Promise<T> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(
      () => reject(new Error(`${providerName} symbol discovery timed out after ${FEED_SYMBOL_DISCOVERY_TIMEOUT_MS} ms.`)),
      FEED_SYMBOL_DISCOVERY_TIMEOUT_MS,
    );
  });
  return Promise.race([Promise.resolve().then(loadSymbols), timeout]).finally(() => {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  });
}

function bareSymbol(value: string): string { return value.includes(':') ? value.slice(value.indexOf(':') + 1) : value; }
function feedName(value: string): string { return value.includes(':') ? value.slice(0, value.indexOf(':')).toLowerCase() : ''; }
function asset(value: string, name: string, category: string): AssetInfo {
  return { symbol: value, name: name || value, category, price: 0, change24h: 0, spread: 0, decimals: 5, minTick: 0.00001 };
}

async function buildFeeds(current: string, preferredProvider: string): Promise<FeedSet> {
  const providers = new Map<string, DataProvider>();
  const assets: AssetInfo[] = [];
  const bridge = window as Window & AppBridge;
  const mt5 = (window as Window & { velaMt5?: any }).velaMt5;
  const discoveries: Promise<void>[] = [];
  if (mt5) {
    discoveries.push(withFeedSymbolDiscoveryTimeout<Mt5Symbols>(() => mt5.symbols(), 'MT5')
      .then(symbols => {
        const provider = new Mt5DataProvider(mt5);
        provider.setSymbols(symbols);
        providers.set('mt5', provider);
        for (const item of symbols) assets.push(asset(`MT5:${item.ticker}`, item.description || item.ticker, item.path || 'MT5'));
      })
      .catch(error => { console.warn('Backtester could not enumerate MT5 symbols:', error); }));
  }
  const quantower = (window as Window & { velaQuantower?: any }).velaQuantower;
  if (quantower) {
    discoveries.push(withFeedSymbolDiscoveryTimeout<QuantowerSymbols>(() => quantower.symbols(), 'Quantower')
      .then(symbols => {
        const provider = new QuantowerDataProvider(quantower);
        provider.setSymbols(symbols);
        providers.set('quantower', provider);
        for (const item of symbols) assets.push(asset(`QUANTOWER:${item.ticker}`, item.description || item.ticker, item.path || item.type || 'Quantower'));
      })
      .catch(error => { console.warn('Backtester could not enumerate Quantower symbols:', error); }));
  }
  await Promise.all(discoveries);
  if (bridge.velaBroker?.fetchHistoricalBars) {
    try {
      const provider = new AlpacaDataProvider(bridge.velaBroker as any);
      provider.setConnected(true);
      providers.set('alpaca', provider);
      for (const ticker of ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'JPM', 'V', 'WMT']) assets.push(asset(`ALPACA:${ticker}`, ticker, 'US equities'));
    } catch (error) { console.warn('Backtester could not initialize Alpaca history:', error); }
  }
  if (current && !resolveBacktestAssetSymbol(current, assets, preferredProvider)) {
    assets.unshift(asset(current, bareSymbol(current), preferredProvider || feedName(current) || 'Current chart'));
  }
  assets.sort((left, right) => left.category.localeCompare(right.category) || left.name.localeCompare(right.name));
  const selectedSymbol = resolveBacktestAssetSymbol(current, assets, preferredProvider) ?? current;
  const selected = assets.findIndex(item => item.symbol.toLowerCase() === selectedSymbol.toLowerCase());
  if (selected > 0) assets.unshift(...assets.splice(selected, 1));
  return { providers, assets, selectedSymbol };
}

function App({ config }: { config: LaunchConfig }) {
  const symbol = config.symbol || 'EURUSD';
  const timeframe = config.timeframe || '1m';
  const source = config.strategy?.source || config.source || '//@version=6\nstrategy("Backtest strategy", overlay=true)\n';
  const [feeds, setFeeds] = useState<FeedSet>({ providers: new Map(), assets: [asset(symbol, symbol, config.provider || 'Current chart')], selectedSymbol: symbol });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const applyStoredTheme = (theme: unknown) => applyThemeUi(isOmegaTheme(theme) ? theme : 'dark');
    applyStoredTheme(localStorage.getItem('omega:theme') || localStorage.getItem('vela_theme'));
    const onStorage = (event: StorageEvent) => {
      if (event.key === 'omega:theme' || event.key === 'vela_theme') applyStoredTheme(event.newValue);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  useEffect(() => { let active = true; void buildFeeds(symbol, config.provider || '').then(value => { if (!active) return; setFeeds(value); setReady(true); }).catch(error => { console.error('Backtest feed setup failed:', error); setReady(true); }); return () => { active = false; }; }, [symbol, config.provider]);
  const loadHistory = useMemo(() => async (selectedSymbol: string, selectedTimeframe: string, from: number, to: number, onProgress?: (loadedBars: number) => void): Promise<CandleBar[]> => {
    const providerKey = feedName(selectedSymbol) || config.provider?.toLowerCase();
    if (!providerKey) throw new Error('Choose a symbol from a connected data feed before loading history.');
    const provider = feeds.providers.get(providerKey);
    if (!provider) throw new Error(`${providerKey.toUpperCase()} history is unavailable. Connect that feed in Omega or choose another asset.`);
    const ticker = bareSymbol(selectedSymbol);
    const byTime = new Map<number, OHLCV>();
    let cursor = to;
    while (cursor >= from && byTime.size < 50_000) {
      const limit = Math.min(10_000, 50_000 - byTime.size);
      const page = await provider.getBars(ticker, selectedTimeframe, { from, to: cursor, limit });
      if (!page.length) break;
      const seconds = (time: number) => time > 1e12 ? time / 1000 : time;
      for (const bar of page) {
        const time = seconds(bar.time);
        if (time * 1000 >= from && time * 1000 <= cursor) byTime.set(time, { ...bar, time });
      }
      onProgress?.(byTime.size);
      const oldest = seconds(page[0]?.time ?? NaN);
      if (!Number.isFinite(oldest) || oldest * 1000 <= from || oldest * 1000 >= cursor) break;
      cursor = oldest * 1000 - 1;
    }
    return [...byTime.values()].sort((left, right) => left.time - right.time);
  }, [feeds.providers, config.provider]);
  const close = () => { const desktop = (window as Window & AppBridge).velaDesktop; if (desktop?.closeCurrentWindow) void desktop.closeCurrentWindow(); else window.close(); };
  if (!ready) return <div className="omega-backtest-loading">Connecting to Omega data feeds…</div>;
  return <BacktestWindow open source={source} candles={[]} symbol={feeds.selectedSymbol} timeframe={timeframe as Timeframe} assets={feeds.assets} loadHistory={loadHistory} onClose={close} />;
}

const root = createRoot(document.getElementById('visual-backtest-app')!);
let appRoot: React.ReactNode = <App config={{}} />;
root.render(appRoot);
const windowBridge = (window as Window & AppBridge).velaVisualBacktestWindow;
windowBridge?.onOpenConfig?.(config => { appRoot = <App config={config} />; root.render(appRoot); });
