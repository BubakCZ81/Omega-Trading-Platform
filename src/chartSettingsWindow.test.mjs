import assert from 'node:assert/strict';
import test from 'node:test';
import { openChartSettingsWindow } from './chartSettingsWindow.ts';

test('chart settings opens the Canvas section by default', () => {
  const calls = [];
  openChartSettingsWindow({ renderer: { openSettings: section => calls.push(section) } });
  assert.deepEqual(calls, ['Canvas']);
});

test('chart settings can open the same window on a requested section', () => {
  const calls = [];
  openChartSettingsWindow({ renderer: { openSettings: section => calls.push(section) } }, 'Canvas');
  assert.deepEqual(calls, ['Canvas']);
});
