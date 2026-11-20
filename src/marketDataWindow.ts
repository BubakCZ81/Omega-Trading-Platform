import { AlpacaDataProvider } from './alpacaFeed';
import { CTraderDataProvider } from './ctraderFeed';
import { Mt5DataProvider } from './mt5Feed';
import { QuantowerDataProvider } from './quantowerFeed';
import type { HistoryRequest, HistoryResult } from './marketDataProcess';
import { isAtrRenkoTimeframe } from './renkoRangeBars';

type AlpacaBridge = ConstructorParameters<typeof AlpacaDataProvider>[0];
type Mt5Bridge = ConstructorParameters<typeof Mt5DataProvider>[0];
type CTraderBridge = ConstructorParameters<typeof CTraderDataProvider>[0];
type QuantowerBridge = ConstructorParameters<typeof QuantowerDataProvider>[0];

interface HistoryRunner {
  alpacaBars: AlpacaBridge['fetchHistoricalBars'];
  mt5Bars: Mt5Bridge['bars'];
  mt5Info: Mt5Bridge['info'];
  tickBars: Mt5Bridge['tickBars'];
  cTraderData: CTraderBridge['marketData'];
  quantowerBars: QuantowerBridge['bars'];
  listen: (run: (source: number, request: HistoryRequest) => Promise<HistoryResult>) => void;
  release: (callback: (source: number) => void) => void;
  ready: () => void;
}

declare global {
  interface Window { omegaHistoryRunner: HistoryRunner }
}

const runner = window.omegaHistoryRunner;

const alpaca = new AlpacaDataProvider({ fetchHistoricalBars: runner.alpacaBars });
alpaca.setConnected(true);
const quantower = new QuantowerDataProvider({ bars: runner.quantowerBars } as QuantowerBridge);
quantower.setSymbols([{ ticker: '', description: '' }]);

function createMt5() {
  const provider = new Mt5DataProvider({
    bars: runner.mt5Bars,
    info: runner.mt5Info,
    tickBars: runner.tickBars,
  } as Mt5Bridge);
  provider.setSymbols([]);
  return provider;
}

function createCTrader() {
  const provider = new CTraderDataProvider({ marketData: runner.cTraderData } as CTraderBridge);
  provider.setSymbols([{ ticker: '' }]);
  return provider;
}

const mt5Connections = new Map<number, { generation: number; provider: Mt5DataProvider }>();
const cTraderConnections = new Map<number, { generation: number; provider: CTraderDataProvider }>();

function scopedProvider<T>(
  connections: Map<number, { generation: number; provider: T }>,
  source: number,
  generation: number,
  create: () => T,
): T {
  const existing = connections.get(source);
  if (existing?.generation === generation) return existing.provider;
  const provider = create();
  if (!existing || generation > existing.generation) connections.set(source, { generation, provider });
  return provider;
}

runner.listen(async (source, { provider, ticker, timeframe, range, connection = 0, symbol }) => {
  switch (provider) {
    case 'alpaca': return { bars: await alpaca.getBars(ticker, timeframe, range) };
    case 'quantower': return { bars: await quantower.getBars(ticker, timeframe, range) };
    case 'ctrader': {
      const feed = scopedProvider(cTraderConnections, source, connection, createCTrader);
      return { bars: await feed.getBars(ticker, timeframe, range, symbol) };
    }
    case 'mt5': {
      const feed = scopedProvider(mt5Connections, source, connection, createMt5);
      const bars = await feed.getBars(ticker, timeframe, range);
      return { bars, atrRenkoPips: isAtrRenkoTimeframe(timeframe) ? feed.getLockedAtrRenkoPips(ticker) : undefined };
    }
  }
});

runner.release(source => {
  mt5Connections.delete(source);
  cTraderConnections.delete(source);
});
runner.ready();
