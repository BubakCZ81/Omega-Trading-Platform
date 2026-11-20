import assert from 'node:assert/strict';
import test from 'node:test';
import { PineTS } from 'pinets';
import { normalizePineRuntimeCompatibilitySource } from './pineRuntimeCompatibility.ts';

const q = String.fromCharCode(34);

test('guards ticks-per-row rolling profile rows against a zero-size array', async () => {
  const source = [
    '//@version=6',
    `indicator(${q}RVP${q}, overlay=true)`,
    'rngP = 0.0',
    'step = 1.0',
    'int rows = 1',
    'rows := int(math.ceil(rngP / step))',
    'a = array.new<float>(rows, 0.0)',
    'poc = a.indexof(a.max())',
    'plot(a.get(poc))',
  ].join('\n');

  const normalized = normalizePineRuntimeCompatibilitySource(source);
  assert.match(normalized, /rows := math\.max\(1, int\(math\.ceil\(rngP \/ step\)\)\)/);

  const candles = [{ open: 100, high: 100, low: 100, close: 100, volume: 100, openTime: 1700000000000 }];
  const result = await new PineTS(candles).run(normalized);
  assert.ok(result.plots);
});
