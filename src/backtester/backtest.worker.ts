import { runPineBacktest, type PineBacktestOverrides } from './backtester.ts';
import type { CandleBar, Timeframe } from './types.ts';

self.onmessage = async (event: MessageEvent<{
  id: number;
  source: string;
  candles: CandleBar[];
  symbol: string;
  timeframe: Timeframe;
  overrides: PineBacktestOverrides;
}>) => {
  const { id, source, candles, symbol, timeframe, overrides } = event.data;
  try {
    const result = await runPineBacktest(source, candles, symbol, timeframe, overrides);
    self.postMessage({ id, ok: true, result });
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
