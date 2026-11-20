const assert = require('node:assert/strict');
const test = require('node:test');
const { resolvePythonCommand, validateBarsRequest, validateQuoteRequest, validateTicksRequest } = require('./mt5.cjs');

test('accepts a Python path or a safe Windows Python launcher command', () => {
  assert.deepEqual(resolvePythonCommand('py -3.13'), { command: 'py', args: ['-3.13'] });
  assert.deepEqual(resolvePythonCommand('"C:\\Program Files\\Python313\\python.exe"'), { command: 'C:\\Program Files\\Python313\\python.exe', args: [] });
  assert.throws(() => resolvePythonCommand('python -m pip'), /Python path in quotes/);
});

test('validates and normalizes MT5 historical bar requests', () => {
  assert.deepEqual(validateBarsRequest({
    ticker: ' EURUSD ',
    timeframe: ' 5 ',
    range: { from: 100, to: 200, limit: 20 },
  }), {
    ticker: 'EURUSD',
    timeframe: '5',
    range: { from: 100, to: 200, limit: 20 },
  });
  assert.throws(() => validateBarsRequest({
    ticker: 'EURUSD',
    timeframe: '1',
    range: { from: 200, to: 100 },
  }), /range is reversed/);
});

test('rejects malformed MT5 symbols and tick ranges', () => {
  assert.throws(() => validateQuoteRequest({ ticker: ' ' }), /valid MetaTrader symbol/);
  assert.throws(() => validateTicksRequest({ ticker: 'EURUSD', fromMsc: -1 }), /valid MetaTrader tick start time/);
  assert.throws(() => validateTicksRequest({ ticker: 'EURUSD', fromMsc: 0, limit: 10_001 }), /between 1 and 10,000/);
});
