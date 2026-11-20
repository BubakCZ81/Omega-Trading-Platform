import assert from 'node:assert/strict';
import test from 'node:test';
import { lintPineSource } from './pineLinter.ts';

const script = (body) => `//@version=6\nindicator("test")\n${body}`;

test('reports every unclosed bracket, not just the first', () => {
  const diagnostics = lintPineSource(script('a = ta.sma(close, 14\nb = ta.rsi(close\nplot(a\n'));
  const unclosed = diagnostics.filter(item => item.message.includes('never closed'));
  assert.equal(unclosed.length, 3);
  assert.deepEqual(unclosed.map(item => item.line), [3, 4, 5]);
});

test('reports a stray closing bracket on its own line', () => {
  const diagnostics = lintPineSource(script('a = close)\n'));
  assert.ok(diagnostics.some(item => item.line === 3 && item.message.includes('Unmatched')));
});

test('reports mismatched brackets with the opening line', () => {
  const diagnostics = lintPineSource(script('a = ta.sma(close, 14]\n'));
  const mismatch = diagnostics.find(item => item.message.includes('Mismatched'));
  assert.ok(mismatch);
  assert.equal(mismatch.line, 3);
});

test('finds several independent errors in one pass', () => {
  const diagnostics = lintPineSource([
    '//@version=6',
    'indicator("x")',
    'a = ta.sma(close, 14',
    'b = "unterminated',
    'plot(a)',
  ].join('\n'));
  assert.ok(diagnostics.some(item => item.line === 3 && item.message.includes('never closed')));
  assert.ok(diagnostics.some(item => item.line === 4 && item.message.includes('Unterminated string')));
});

test('does not flag balanced code', () => {
  assert.deepEqual(lintPineSource(script('a = ta.sma(close, 14)\nplot(a, color=color.red)\n')), []);
});

test('ignores brackets and quotes inside comments and strings', () => {
  assert.deepEqual(lintPineSource(script('// a stray ( bracket in a comment\nlabel_text = "close) here"\n')), []);
});

test('requires a script declaration', () => {
  const diagnostics = lintPineSource('//@version=6\na = close\nplot(a)\n');
  assert.ok(diagnostics.some(item => item.message.includes('Missing script declaration')));
});

test('flags strategy namespace used without a strategy declaration', () => {
  const diagnostics = lintPineSource(script('strategy.entry("L", strategy.long)\n'));
  assert.ok(diagnostics.some(item => item.message.includes('not declared with strategy')));
});

test('accepts strategy namespace when the script declares strategy', () => {
  const diagnostics = lintPineSource('//@version=6\nstrategy("s")\nstrategy.entry("L", strategy.long)\n');
  assert.deepEqual(diagnostics, []);
});

test('suggests the real namespace for a near miss', () => {
  const diagnostics = lintPineSource(script('a = strr.format("{0}", close)\n'));
  assert.ok(diagnostics.some(item => item.message.includes('Did you mean "str"')));
});

test('stays quiet about a user-defined variable that owns a dot call', () => {
  assert.deepEqual(lintPineSource(script('myLabel = label.new(bar_index, close)\nmyLabel.delete()\n')), []);
});

test('warns when indentation mixes tabs and spaces', () => {
  const diagnostics = lintPineSource(script('if close > open\n  a = 1\n\tb = 2\n'));
  assert.ok(diagnostics.some(item => item.message.includes('mixes tabs and spaces')));
});
