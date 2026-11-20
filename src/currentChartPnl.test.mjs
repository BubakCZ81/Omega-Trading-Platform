import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeCurrentChartPnl } from './currentChartPnl.ts';

const format = (amount, currency) => `${currency} ${amount.toFixed(2)}`;

test('paper P/L includes only open trades on the specified chart', () => {
  const trades = [
    { cellId: 'chart-a', currency: 'USD', pnl: 12.5 },
    { cellId: 'chart-a', currency: 'USD', pnl: -2.25 },
    { cellId: 'chart-b', currency: 'USD', pnl: 999 },
  ];
  assert.deepEqual(
    summarizeCurrentChartPnl(trades, 'chart-a', trade => trade.pnl, format),
    { text: 'P/L: USD 10.25', state: 'positive' },
  );
});

test('paper P/L resets to zero when the current chart has no open trades', () => {
  const trades = [{ cellId: 'other-chart', currency: 'USD', pnl: 15 }];
  assert.deepEqual(
    summarizeCurrentChartPnl(trades, 'empty-chart', trade => trade.pnl, format),
    { text: 'P/L: $0.00', state: 'zero' },
  );
});
