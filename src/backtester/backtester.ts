import { PineEngine } from '@luxalgo/vela-pinets';
import type { EngineContextSnapshot, InputSchema, InputValue, OHLCV, StrategyTrade } from '@luxalgo/vela';
import type { CandleBar, Timeframe } from './types.ts';

export interface BacktestPoint { time: number; equity: number }
export interface PineBacktestResult {
  context: EngineContextSnapshot;
  trades: StrategyTrade[];
  equity: BacktestPoint[];
  drawdown: BacktestPoint[];
  warnings: string[];
  inputs: InputSchema[];
  properties: InputSchema[];
}

export interface PineBacktestOverrides {
  inputs?: Record<string, InputValue>;
  props?: Record<string, InputValue>;
}

export async function getPineBacktestSchema(source: string) {
  const engine = new PineEngine({ props: 'all' });
  const prepared = await engine.prepare(source, `backtest-schema-${crypto.randomUUID()}`);
  return { inputs: prepared.inputs, properties: prepared.props ?? [], meta: prepared.meta };
}

/** Run a Pine strategy through Vela's bundled PineTS broker emulator, without mounting it on the chart. */
export async function runPineBacktest(source: string, candles: CandleBar[], symbol: string, timeframe: Timeframe, overrides: PineBacktestOverrides = {}): Promise<PineBacktestResult> {
  if (!/\b(?:strategy|indicator)\s*\(/.test(source)) throw new Error('The selected Pine Script must declare indicator() or strategy() before it can be run.');
  if (candles.length < 2) throw new Error('Load at least two candles before running a backtest.');

  const engine = new PineEngine({ props: 'all' });
  const prepared = await engine.prepare(source, `backtest-${crypto.randomUUID()}`);
  const bars: OHLCV[] = candles.map((bar) => ({
    time: Math.round(bar.time * 1000),
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume ?? 0,
  }));

  let rejectRun: ((error: Error) => void) | undefined;
  let resolveRun: (() => void) | undefined;
  const completed = new Promise<void>((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
  const session = engine.execute({
    prepared,
    market: { symbol, timeframe },
    bars,
    inputs: { ...Object.fromEntries(prepared.inputs.map((input) => [input.key, input.defval])), ...overrides.inputs },
    props: overrides.props,
    mode: 'static',
  }, {
    onModel: () => undefined,
    onError: (error) => rejectRun?.(error),
    onDone: () => resolveRun?.(),
  });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      completed,
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('PineTS backtest timed out after 30 seconds.')), 30000); }),
    ]);
    const context = await session.getContext?.(['meta', 'strategy', 'trades', 'plots', 'warnings']);
    if (!context || (!context.strategy && Object.keys(context.plots).length === 0)) throw new Error('PineTS did not return plots or strategy results. Check the script and its declaration.');
    const trades = context.trades ?? [];
    // PineTS exposes its broker-emulator round trips and final account stats but not
    // a public per-bar equity array. Rebuild the close-to-close curve from its actual
    // fill ledger, marking open positions at each historical candle close.
    const orderedTrades = [...trades].sort((a, b) => a.entry.time - b.entry.time);
    const closingTrades = [...trades].filter((trade) => trade.exit).sort((a, b) => (a.exit?.time ?? 0) - (b.exit?.time ?? 0));
    const openTrades = new Set<StrategyTrade>();
    const initialCapital = Number(context.strategy?.initialCapital) || 0;
    let realized = 0; let entryIndex = 0; let exitIndex = 0;
    const equity = bars.map((bar): BacktestPoint => {
      while (entryIndex < orderedTrades.length && orderedTrades[entryIndex].entry.time <= bar.time) openTrades.add(orderedTrades[entryIndex++]);
      while (exitIndex < closingTrades.length && (closingTrades[exitIndex].exit?.time ?? Infinity) <= bar.time) {
        const trade = closingTrades[exitIndex++];
        realized += trade.pnl ?? 0;
        openTrades.delete(trade);
      }
      const unrealized = [...openTrades].reduce((sum, trade) => {
        const direction = trade.side === 'long' ? 1 : -1;
        const pointValue = 1;
        const entryCommission = trade.open ? (trade.commission ?? 0) : 0;
        return sum + (bar.close - trade.entry.price) * trade.qty * direction * pointValue - entryCommission;
      }, 0);
      return { time: bar.time, equity: initialCapital + realized + unrealized };
    });
    let peak = Number(context.strategy?.initialCapital) || equity[0].equity;
    const drawdown = equity.map((point) => {
      peak = Math.max(peak, point.equity);
      return { time: point.time, equity: peak > 0 ? ((point.equity - peak) / peak) * 100 : 0 };
    });
    return { context, trades, equity, drawdown, warnings: context.warnings.map((warning) => warning.message), inputs: prepared.inputs, properties: prepared.props ?? [] };
  } finally {
    if (timeout) clearTimeout(timeout);
    session.stop();
  }
}
