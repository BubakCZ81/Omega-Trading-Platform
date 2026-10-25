import type { DataProvider, OHLCV, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

interface AlpacaBridge {
  connect(credentials?: { keyId?: string; secretKey?: string }): Promise<{ connected: boolean; feed: 'IEX' }>;
  status(): Promise<{ connected: boolean; configured: boolean; error?: string }>;
  bars(request: {
    ticker: string;
    timeframe: string;
    range: { from?: number; to?: number; limit: number };
  }): Promise<OHLCV[]>;
  assets(): Promise<Array<{ ticker: string; description: string; exchange: string }>>;
  subscribe(ticker: string, timeframe: string): Promise<string>;
  unsubscribe(subscriptionId: string): Promise<boolean>;
  disconnect(): Promise<boolean>;
  onBar(callback: (bar: AlpacaBarEvent) => void): () => void;
  onStatus(callback: (state: { connected: boolean; configured: boolean; error?: string }) => void): () => void;
}

interface AlpacaBarEvent extends OHLCV {
  subscriptionId: string;
  ticker: string;
  timeframe: string;
}

declare global {
  interface Window {
    velaAlpaca?: AlpacaBridge;
  }
}

const commonSymbols: SymbolDescriptor[] = [
  ['AAPL', 'Apple Inc.', 'NASDAQ'],
  ['MSFT', 'Microsoft Corporation', 'NASDAQ'],
  ['NVDA', 'NVIDIA Corporation', 'NASDAQ'],
  ['AMZN', 'Amazon.com Inc.', 'NASDAQ'],
  ['GOOGL', 'Alphabet Inc.', 'NASDAQ'],
  ['META', 'Meta Platforms Inc.', 'NASDAQ'],
  ['TSLA', 'Tesla Inc.', 'NASDAQ'],
  ['AVGO', 'Broadcom Inc.', 'NASDAQ'],
  ['COST', 'Costco Wholesale Corporation', 'NASDAQ'],
  ['NFLX', 'Netflix Inc.', 'NASDAQ'],
  ['JPM', 'JPMorgan Chase & Co.', 'NYSE'],
  ['V', 'Visa Inc.', 'NYSE'],
  ['WMT', 'Walmart Inc.', 'NYSE'],
  ['LLY', 'Eli Lilly and Company', 'NYSE'],
  ['ORCL', 'Oracle Corporation', 'NYSE'],
  ['XOM', 'Exxon Mobil Corporation', 'NYSE'],
  ['MA', 'Mastercard Incorporated', 'NYSE'],
  ['JNJ', 'Johnson & Johnson', 'NYSE'],
  ['HD', 'The Home Depot Inc.', 'NYSE'],
  ['BAC', 'Bank of America Corporation', 'NYSE'],
].map(([ticker, description, prefix]) => ({
  ticker: ticker as string,
  description: description as string,
  type: 'stock',
  prefix: prefix as string,
}));

const timeframeMinutes: Record<string, number> = {
  '1': 1,
  '5': 5,
  '15': 15,
  '30': 30,
  '60': 60,
  D: 1440,
  '1D': 1440,
};

function normalizeTicker(ticker: string): string {
  return ticker.replace(/^alpaca:/i, '').trim().toUpperCase();
}

export class AlpacaDataProvider implements DataProvider {
  private readonly bridge: AlpacaBridge;
  private connected = false;
  private descriptors: SymbolDescriptor[] = commonSymbols;

  constructor(bridge: AlpacaBridge) {
    this.bridge = bridge;
  }

  info() {
    return {
      name: 'alpaca',
      displayName: 'Alpaca Stocks (IEX)',
      capabilities: { enumerate: true, stream: true, symbolInfo: true },
    };
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  setAssets(assets: ReadonlyArray<{ ticker: string; description: string; exchange: string }>) {
    this.descriptors = assets.map(asset => ({
      ticker: asset.ticker,
      description: asset.description,
      type: 'stock',
      prefix: asset.exchange || 'US',
    }));
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    return this.descriptors;
  }

  async getBars(ticker: string, timeframe: string, range: { from?: number; to?: number; limit?: number }): Promise<OHLCV[]> {
    if (!this.connected) throw new Error('Alpaca feed is disconnected.');
    const normalized = timeframe.trim().toUpperCase();
    const minutes = timeframeMinutes[normalized];
    if (!minutes) throw new Error(`Alpaca supports 1, 5, 15, 30, 60 minute and daily timeframes; "${timeframe}" is not supported.`);
    const limit = Math.max(1, Math.min(50_000, range.limit ?? 1000));
    const bars = await this.bridge.bars({
      ticker: normalizeTicker(ticker),
      timeframe: normalized === '1D' ? 'D' : normalized,
      range: { ...range, limit },
    });
    return bars.length > limit ? bars.slice(-limit) : bars;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo> {
    const normalized = normalizeTicker(ticker);
    return {
      ticker: normalized,
      name: normalized,
      description: 'US equities via Alpaca IEX market data',
      currency: 'USD',
      exchange: 'IEX',
      timezone: 'America/New_York',
    };
  }

  subscribe(ticker: string, timeframe: string, onBar: (bar: OHLCV) => void): () => void {
    if (!this.connected) throw new Error('Alpaca feed is disconnected.');
    const normalized = timeframe.trim().toUpperCase();
    if (!timeframeMinutes[normalized]) throw new Error(`Alpaca does not support chart timeframe "${timeframe}".`);
    let active = true;
    let subscriptionId: string | undefined;
    void this.bridge.subscribe(normalizeTicker(ticker), normalized === '1D' ? 'D' : normalized).then(id => {
      subscriptionId = id;
      if (!active) void this.bridge.unsubscribe(id);
    }).catch(error => {
      if (active) console.error(`[Alpaca] Live subscription failed for ${ticker}:`, error);
    });
    const unsubscribeBar = this.bridge.onBar(bar => {
      if (active && bar.subscriptionId === subscriptionId) onBar(bar);
    });
    return () => {
      active = false;
      unsubscribeBar();
      if (subscriptionId) void this.bridge.unsubscribe(subscriptionId);
    };
  }
}

export function initializeAlpacaFeed(getWorkspace: () => VelaWorkspace): void {
  const modal = document.getElementById('alpaca-feed-modal');
  const openButton = document.getElementById('alpaca-feed-toggle');
  const closeButton = document.getElementById('alpaca-feed-close');
  const connectButton = document.getElementById('alpaca-feed-connect') as HTMLButtonElement | null;
  const disconnectButton = document.getElementById('alpaca-feed-disconnect') as HTMLButtonElement | null;
  const keyIdInput = document.getElementById('alpaca-key-id') as HTMLInputElement | null;
  const secretInput = document.getElementById('alpaca-secret-key') as HTMLInputElement | null;
  const status = document.getElementById('alpaca-feed-status');
  if (!modal || !openButton || !closeButton || !connectButton || !disconnectButton || !keyIdInput || !secretInput || !status) return;
  const bridge = window.velaAlpaca;
  if (!bridge) {
    status.textContent = 'Alpaca market data is available only in the Omega desktop app.';
    status.dataset.state = 'error';
    connectButton.disabled = true;
  }

  const provider = bridge ? new AlpacaDataProvider(bridge) : null;
  let connected = false;
  const setStatus = (message: string, isError = false) => {
    status.textContent = message;
    status.dataset.state = isError ? 'error' : 'info';
  };
  const registerProvider = async (chart: VelaWorkspace['chart']) => {
    if (!provider) return;
    chart.data.registerProvider('alpaca', provider);
    await chart.data.ready();
  };
  const registerWorkspace = async () => {
    await Promise.all(getWorkspace().cells().map(cell => registerProvider(cell.chart)));
  };

  getWorkspace().on('cell:created', event => {
    if (!connected) return;
    const cell = getWorkspace().cell(event.id);
    if (cell) void registerProvider(cell.chart).catch(error => {
      console.error('Could not register the Alpaca provider on a new chart:', error);
      setStatus(error instanceof Error ? error.message : String(error), true);
    });
  });

  bridge?.onStatus(state => {
    if (state.error) setStatus(state.error, true);
    if (!state.connected && connected) {
      connected = false;
      provider?.setConnected(false);
      for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('alpaca');
      connectButton.hidden = false;
      disconnectButton.hidden = true;
      if (!state.error) setStatus('Alpaca market data disconnected.');
    }
  });

  openButton.addEventListener('click', () => {
    modal.classList.add('open');
    modal.setAttribute('aria-hidden', 'false');
  });
  const closeModal = () => {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  };
  closeButton.addEventListener('click', closeModal);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && modal.classList.contains('open')) closeModal();
  });
  void bridge?.status().then(state => {
    if (state.error) setStatus(state.error, true);
    else if (state.configured) setStatus('Encrypted Alpaca credentials are saved. Enter both again to replace them, or connect with both fields blank.');
  }).catch(error => setStatus(error instanceof Error ? error.message : String(error), true));

  connectButton.addEventListener('click', async () => {
    if (!bridge || !provider) return;
    connectButton.disabled = true;
    setStatus('Connecting to Alpaca IEX market data…');
    try {
      await bridge.connect({ keyId: keyIdInput.value, secretKey: secretInput.value });
      keyIdInput.value = '';
      secretInput.value = '';
      provider.setConnected(true);
      connected = true;
      let assetCount = 0;
      try {
        const assets = await bridge.assets();
        provider.setAssets(assets);
        assetCount = assets.length;
      } catch (assetError) {
        console.warn('Could not load the Alpaca asset catalogue:', assetError);
        provider.setAssets(commonSymbols.map(symbol => ({
          ticker: symbol.ticker,
          description: symbol.description ?? symbol.ticker,
          exchange: symbol.prefix ?? 'US',
        })));
      }
      await registerWorkspace();
      connectButton.hidden = true;
      disconnectButton.hidden = false;
      setStatus(assetCount
        ? `Connected to Alpaca IEX. Loaded ${assetCount.toLocaleString()} active US equities into the asset browser. Use its source dropdown to show Alpaca only. Free-plan data is IEX-only and limited to 30 live symbols.`
        : 'Connected to Alpaca IEX, but its full asset catalogue could not be loaded. A fallback list is available; search for alpaca:AAPL or another US stock symbol.');
    } catch (error) {
      connected = false;
      provider.setConnected(false);
      for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('alpaca');
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      connectButton.disabled = false;
    }
  });

  disconnectButton.addEventListener('click', async () => {
    if (!bridge) return;
    disconnectButton.disabled = true;
    try {
      for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('alpaca');
      provider?.setConnected(false);
      await bridge.disconnect();
      connected = false;
      connectButton.hidden = false;
      disconnectButton.hidden = true;
      setStatus('Alpaca market data disconnected. Saved API credentials remain encrypted on this device.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      disconnectButton.disabled = false;
    }
  });
}
