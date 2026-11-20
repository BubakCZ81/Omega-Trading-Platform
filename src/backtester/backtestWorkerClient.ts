import type { CandleBar, Timeframe } from './types.ts';
import type { PineBacktestOverrides, PineBacktestResult } from './backtester.ts';

let nextRequestId = 1;

export function runPineBacktestInWorker(
  source: string,
  candles: CandleBar[],
  symbol: string,
  timeframe: Timeframe,
  overrides: PineBacktestOverrides = {},
): Promise<PineBacktestResult> {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('This browser does not support background Pine backtesting.'));
  const worker = new Worker(new URL('./backtest.worker.ts', import.meta.url), { type: 'module', name: 'pine-backtest' });
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ id: number; ok: boolean; result?: PineBacktestResult; error?: string }>) => {
      if (event.data.id !== id) return;
      worker.terminate();
      if (event.data.ok && event.data.result) resolve(event.data.result);
      else reject(new Error(event.data.error || 'Pine backtest failed in its worker.'));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The Pine backtest worker stopped unexpectedly.'));
    };
    worker.postMessage({ id, source, candles, symbol, timeframe, overrides });
  });
}
