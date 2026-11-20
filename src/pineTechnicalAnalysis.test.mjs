import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PineTS } from 'pinets';

const [{ pineEditorReference }, declarations] = await Promise.all([
  import('./pineEditorReference.ts'),
  readFile(new URL('../node_modules/pinets/dist/types/namespaces/ta/ta.index.d.ts', import.meta.url), 'utf8'),
]);

const runtimeMethods = [...declarations.matchAll(/import\s+\{\s*(\w+)\s*\}\s+from '\.\/methods\//g)]
  .map(match => `ta.${match[1]}`);

const variableOnly = new Set(['accdist', 'iii', 'nvi', 'obv', 'pvi', 'pvt', 'wad', 'wvad']);
const dualForm = new Set(['tr', 'vwap']);

test('Monaco reference catalog covers every installed PineTS TA method', () => {
  const documented = new Map(
    pineEditorReference
      .filter(entry => entry.name.startsWith('ta.'))
      .map(entry => [entry.name, entry]),
  );
  const missing = runtimeMethods.filter(name => !documented.has(name));

  assert.equal(runtimeMethods.length, 68, 'review the documented method count when upgrading PineTS');
  assert.deepEqual(missing, [], 'each runtime TA method must be available to Monaco and the reference panel');
  for (const name of runtimeMethods) {
    const entry = documented.get(name);
    const member = name.slice(3);
    const prefix = variableOnly.has(member) ? `${name} ` : `${name}(`;
    assert.ok(entry.signature.startsWith(prefix), `${name} needs an accurate signature`);
    if (dualForm.has(member)) assert.equal(entry.valueSignature, `${name} → series float`);
    assert.ok(entry.description.trim(), `${name} needs hover/reference documentation`);
  }
});

test('PineTS executes representative TA calculations on OHLCV history', async () => {
  const candles = Array.from({ length: 60 }, (_, index) => {
    const close = 100 + index * 0.3 + Math.sin(index / 3) * 2;
    return {
      open: close - 0.4,
      high: close + 1.2,
      low: close - 1.1,
      close,
      volume: 100 + index,
      openTime: 1_700_000_000_000 + index * 60_000,
    };
  });
  const pine = new PineTS(candles);
  const result = await pine.run(`//@version=6
indicator("TA execution smoke test")
plot(ta.sma(close, 14), title="SMA")
plot(ta.ema(close, 14), title="EMA")
plot(ta.rsi(close, 14), title="RSI")
plot(ta.atr(14), title="ATR")
[macdLine, signalLine, histogram] = ta.macd(close, 12, 26, 9)
plot(macdLine, title="MACD")
[basis, upper, lower] = ta.bb(close, 20, 2)
plot(upper, title="Bollinger upper")
`);

  for (const title of ['SMA', 'EMA', 'RSI', 'ATR', 'MACD', 'Bollinger upper']) {
    const value = result.plots[title]?.data.at(-1)?.value;
    assert.equal(typeof value, 'number', `${title} should produce a numeric plotted value`);
    assert.ok(Number.isFinite(value), `${title} should produce a finite value after warm-up`);
  }
  assert.ok(result.plots.RSI.data.at(-1).value >= 0 && result.plots.RSI.data.at(-1).value <= 100);
  assert.ok(result.plots.ATR.data.at(-1).value > 0);
});


// Built-in names in the official TradingView Pine v6 reference. ta.param is
// an internal PineTS helper and is deliberately excluded.
const scalarArguments = {
  alma: 'close, 5, 0.85, 6', atr: '5', barssince: 'bar_index % 5 == 0',
  bbw: 'close, 5, 2', cci: 'close, 5', change: 'close', cmo: 'close, 5', cog: 'close, 5',
  correlation: 'close, open, 5', cum: 'close', dev: 'close, 5', ema: 'close, 5',
  highest: 'close, 5', highestbars: 'close, 5', hma: 'close, 5', kcw: 'close, 5, 2',
  linreg: 'close, 5, 0', lowest: 'close, 5', lowestbars: 'close, 5', max: 'close',
  median: 'close, 5', mfi: 'close, 5', min: 'close', mode: 'close, 5', mom: 'close, 5',
  percentile_linear_interpolation: 'close, 5, 50', percentile_nearest_rank: 'close, 5, 50',
  percentrank: 'close, 5', pivothigh: 'high, 2, 2', pivotlow: 'low, 2, 2', range: 'close, 5',
  rci: 'close, 5', rma: 'close, 5', roc: 'close, 5', rsi: 'close, 5',
  sar: '0.02, 0.02, 0.2', sma: 'close, 5', stdev: 'close, 5', stoch: 'close, high, low, 5',
  swma: 'close', tr: 'true', tsi: 'close, 5, 10', valuewhen: 'bar_index % 5 == 0, close, 1',
  variance: 'close, 5', vwap: 'close', vwma: 'close, 5', wma: 'close, 5', wpr: '5',
};
const booleanArguments = {
  cross: 'close, open', crossover: 'close, open', crossunder: 'close, open',
  falling: 'close, 3', rising: 'close, 3',
};
const tupleArguments = {
  bb: ['close, 5, 2', 3], dmi: ['5, 5', 3], kc: ['close, 5, 2', 3],
  macd: ['close, 5, 10, 4', 3], supertrend: ['2, 5', 2],
};

test('all 67 documented TradingView TA built-ins execute in PineTS', async () => {
  const names = new Set([
    ...variableOnly, ...dualForm, ...Object.keys(scalarArguments),
    ...Object.keys(booleanArguments), ...Object.keys(tupleArguments), 'pivot_point_levels',
  ]);
  assert.equal(names.size, 67);
  assert.deepEqual(
    [...names].map(name => `ta.${name}`).sort(),
    runtimeMethods.filter(name => name !== 'ta.param').sort(),
  );

  const statements = ['//@version=6', 'indicator("Full TA coverage")'];
  const plots = [];
  const addPlot = (expression, name) => {
    statements.push(`plot(${expression}, "${name}")`);
    plots.push(name);
  };
  for (const name of [...variableOnly, ...dualForm]) addPlot(`ta.${name}`, `${name}_series`);
  for (const [name, args] of Object.entries(scalarArguments)) addPlot(`ta.${name}(${args})`, name);
  for (const [name, args] of Object.entries(booleanArguments)) addPlot(`ta.${name}(${args}) ? 1 : 0`, name);
  for (const [name, [args, count]] of Object.entries(tupleArguments)) {
    const variables = Array.from({ length: count }, (_, index) => `${name}_${index}`);
    statements.push(`[${variables.join(', ')}] = ta.${name}(${args})`);
    for (const variable of variables) addPlot(variable, variable);
  }
  statements.push('pivots = ta.pivot_point_levels("Traditional", bar_index % 10 == 0, false)');
  addPlot('array.get(pivots, 0)', 'pivot_point_levels');

  const candles = Array.from({ length: 80 }, (_, index) => {
    const close = 100 + index / 10 + Math.sin(index / 2) * 3;
    const open = 100 + index / 10 + Math.cos(index / 2);
    return {
      open, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, close,
      volume: 100 + index % 11, openTime: 1_700_000_000_000 + index * 60_000,
    };
  });
  const result = await new PineTS(candles).run(statements.join('\n'));
  for (const title of plots) {
    assert.ok(result.plots[title]?.data.some(point => Number.isFinite(point.value)), `${title} should produce a finite value`);
  }
});
