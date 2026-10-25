import type { DataProvider, OHLCV, SymbolDescriptor, SymbolInfo } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

interface AlpacaSdkBridge {
  fetchHistoricalBars(request: {
    symbol: string;
    timeframe: '1m' | '5m' | '15m' | '1h' | '1d';
    from: number;
    to: number;
    limit: number;
  }): Promise<OHLCV[] | null>;
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

const sdkTimeframes: Record<string, '1m' | '5m' | '15m' | '1h' | '1d'> = {
  '1': '1m',
  '1M': '1m',
  '1MIN': '1m',
  '5': '5m',
  '5M': '5m',
  '5MIN': '5m',
  '15': '15m',
  '15M': '15m',
  '15MIN': '15m',
  '60': '1h',
  '1H': '1h',
  'D': '1d',
  '1D': '1d',
};

const timeframeMilliseconds: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '1d': 24 * 60 * 60_000,
};

function normalizeTicker(ticker: string): string {
  return ticker.replace(/^alpaca:/i, '').trim().toUpperCase();
}

export class AlpacaDataProvider implements DataProvider {
  private readonly bridge: AlpacaSdkBridge;
  private connected = false;
  private descriptors: SymbolDescriptor[] = commonSymbols;

  constructor(bridge: AlpacaSdkBridge) {
    this.bridge = bridge;
  }

  info() {
    return {
      name: 'alpaca',
      displayName: 'Alpaca (Broker SDK)',
      capabilities: { enumerate: true, stream: false, symbolInfo: true },
    };
  }

  setConnected(connected: boolean) {
    this.connected = connected;
  }

  async listSymbols(): Promise<SymbolDescriptor[]> {
    return this.descriptors;
  }

  async getBars(ticker: string, timeframe: string, range: { from?: number; to?: number; limit?: number }): Promise<OHLCV[]> {
    if (!this.connected) throw new Error('Connect Alpaca through the Broker panel to load chart data.');
    const normalized = timeframe.trim().toUpperCase();
    const sdkTimeframe = sdkTimeframes[normalized];
    if (!sdkTimeframe) throw new Error(`Alpaca Broker SDK does not support chart timeframe "${timeframe}". Use 1, 5, 15, 60 minutes, or daily.`);
    const limit = Math.max(1, Math.min(10_000, Math.floor(range.limit ?? 1000)));
    const interval = timeframeMilliseconds[sdkTimeframe];
    const to = range.to ?? Date.now();
    const from = range.from ?? to - limit * interval;
    const bars = await this.bridge.fetchHistoricalBars({
      symbol: normalizeTicker(ticker),
      timeframe: sdkTimeframe,
      from,
      to,
      limit,
    });
    if (!bars) throw new Error('Alpaca Broker SDK history is unavailable. Connect Alpaca in the Broker panel.');
    return bars.length > limit ? bars.slice(-limit) : bars;
  }

  async getSymbolInfo(ticker: string): Promise<SymbolInfo> {
    const normalized = normalizeTicker(ticker);
    return {
      ticker: normalized,
      name: normalized,
      description: 'US equities via Alpaca Broker SDK market data',
      currency: 'USD',
      exchange: 'IEX',
      timezone: 'America/New_York',
    };
  }

}

export function initializeAlpacaSdkFeed(getWorkspace: () => VelaWorkspace): void {
  const bridge = window.velaBroker as (Window['velaBroker'] & AlpacaSdkBridge) | undefined;
  if (!bridge?.fetchHistoricalBars) return;

  const provider = new AlpacaDataProvider(bridge);
  let connected = false;
  let revision = 0;
  const registerChart = async (chart: VelaWorkspace['chart'], expectedRevision: number) => {
    chart.data.registerProvider('alpaca', provider);
    await chart.data.ready();
    if (!connected || expectedRevision !== revision) chart.data.unregisterProvider('alpaca');
  };
  const registerWorkspace = async () => {
    const currentRevision = revision;
    await Promise.all(getWorkspace().cells().map(cell => registerChart(cell.chart, currentRevision)));
  };
  const disable = () => {
    connected = false;
    revision += 1;
    provider.setConnected(false);
    for (const cell of getWorkspace().cells()) cell.chart.data.unregisterProvider('alpaca');
  };
  const connect = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== 'alpaca') {
      disable();
      return;
    }
    connected = true;
    revision += 1;
    provider.setConnected(true);
    void registerWorkspace().catch(error => {
      console.error('Could not register Alpaca Broker SDK chart data:', error);
    });
  };
  const disconnect = (event: Event) => {
    if ((event as CustomEvent<string>).detail !== 'alpaca') return;
    disable();
  };

  document.addEventListener('omega:trading-broker-connected', connect);
  document.addEventListener('omega:trading-broker-disconnected', disconnect);
  getWorkspace().on('cell:created', event => {
    if (!connected) return;
    const cell = getWorkspace().cell(event.id);
    if (cell) void registerChart(cell.chart, revision).catch(error => {
      console.error('Could not register Alpaca Broker SDK data on a new chart:', error);
    });
  });
}
