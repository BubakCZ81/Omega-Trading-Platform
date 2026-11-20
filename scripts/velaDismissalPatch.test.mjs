import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { basename } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { patchVelaDismissal, velaManualDismissalPlugin } from './velaDismissalPatch.mjs';

test('non-chunk assets are left untouched', () => {
  assert.equal(patchVelaDismissal('index.js', 'closeOnInteractOutside: opts.closeOnInteractOutside ?? true,'), null);
  assert.equal(patchVelaDismissal('chunk-a.js', 'const unrelated = 1;'), null);
});

test('the drawer default keeps dialogs open on outside interaction', () => {
  const source = 'const opts = { closeOnInteractOutside: opts.closeOnInteractOutside ?? true, };';
  const patched = patchVelaDismissal('chunk-abc123.js', source);
  assert.equal(patched, 'const opts = { closeOnInteractOutside: opts.closeOnInteractOutside ?? false, };');
  // The upstream source is never mutated in place.
  assert.match(source, /\?\? true/);
});

test('unexpected occurrence counts are reported instead of silently patched', () => {
  assert.throws(
    () => patchVelaDismissal('chunk-abc123.js', 'closeOnInteractOutside: true,'),
    /expected 4 occurrence\(s\) of dialog outside-dismissal policy, found 1/,
  );
  assert.throws(
    () => patchVelaDismissal('chunk-abc123.js', 'closeOnInteractOutside: opts.closeOnInteractOutside ?? true,\ncloseOnInteractOutside: opts.closeOnInteractOutside ?? true,'),
    /expected 1 occurrence\(s\) of default drawer outside-dismissal policy, found 2/,
  );
});

test('the vite plugin only transforms @luxalgo/vela dist chunks', () => {
  const plugin = velaManualDismissalPlugin();
  assert.equal(plugin.name, 'vela-manual-dismissal');
  assert.equal(plugin.enforce, 'pre');

  assert.equal(plugin.transform('closeOnInteractOutside: true,', '/app/src/main.ts'), null);
  assert.equal(plugin.transform('closeOnInteractOutside: true,', 'C:\\app\\node_modules\\other\\dist\\chunk-x.js'), null);

  const patched = plugin.transform(
    'closeOnInteractOutside: opts.closeOnInteractOutside ?? true,',
    'C:\\app\\node_modules\\@luxalgo\\vela\\dist\\chunk-abc123.js',
  );
  assert.match(patched.code, /\?\? false/);
  assert.equal(patched.map, null);
});

test('patched Vela resets by actual candles and refreshes the same market and its indicators', async () => {
  const hooks = registerHooks({
    load(url, context, next) {
      const result = next(url, context);
      if (!url.startsWith('file:') || !url.includes('/node_modules/@luxalgo/vela/dist/chunk-')) return result;
      const filename = fileURLToPath(url);
      const source = patchVelaDismissal(basename(filename), readFileSync(filename, 'utf8'));
      return source === null ? result : { ...result, source };
    },
  });
  let chart;
  try {
    const { Vela } = await import('@luxalgo/vela');
    const calls = [];
    const renderer = new Proxy({
      setVisibleRange: (...args) => calls.push(args),
      getVisibleRange: () => null,
      readFeature: () => 'candles',
    }, { get: (target, key) => target[key] ?? (() => undefined) });
    const bars = [10, 20, 400, 900, 903].map(time => ({ time, open: 1, high: 2, low: 1, close: 2 }));
    const feed = {
      load: async () => bars,
      invalidateMarket: market => calls.push(market.symbol),
    };
    chart = new Vela({}, { symbol: 'MT5:EURUSD', timeframe: 'T75', volume: false }, { renderer, dataFeed: feed });
    await chart.ready();
    assert.equal(chart.setVisibleBarCount(2), 2);
    assert.deepEqual(calls.at(-1), [{ from: 900, to: 903 }, { rightMargin: true }]);
    assert.equal(chart.setVisibleBarCount(100), 5);
    assert.deepEqual(calls.at(-1)?.[0], { from: 10, to: 903 });
    // Spy on the orchestrator's indicator lifecycle after first paint.
    chart.orchestrator.restartNativeIndicators = () => calls.push('native');
    chart.orchestrator.reexecuteIndicators = () => calls.push('script');
    calls.length = 0;
    await chart.setMarket({ reload: true });
    assert.equal(chart.market.symbol, 'MT5:EURUSD');
    assert.equal(chart.market.timeframe, 'T75');
    assert.deepEqual(calls, ['MT5:EURUSD', 'native', 'script']);
  } finally {
    chart?.destroy();
    hooks.deregister();
  }
});
