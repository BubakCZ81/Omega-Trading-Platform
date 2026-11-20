import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

function stackingIndex(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = [...styles.matchAll(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  const declaration = blocks.map(match => match[1]).filter(block => /z-index\s*:/i.test(block)).at(-1);
  const value = declaration?.match(/z-index\s*:\s*(\d+)/i)?.[1];
  return value === undefined ? null : Number(value);
}

test('Theme picker stacks above the Quick Trade panel', () => {
  const toolbarLayer = stackingIndex('#top-toolbar');
  const quickTradeLayer = stackingIndex('#chart-paper-trade-controls');
  assert.notEqual(toolbarLayer, null);
  assert.notEqual(quickTradeLayer, null);
  assert.ok(toolbarLayer > quickTradeLayer, `${toolbarLayer} must be above ${quickTradeLayer}`);
});

test('sidebar buttons share fixed rail geometry independent of theme', () => {
  const railRules = styles.match(/\.vela-ws-toolbar\[data-omega-tools-rail="left"\][\s\S]*?\.omega-statusline-group-square/)?.[0];
  assert.ok(railRules);
  assert.match(railRules, /flex-direction:\s*column/);
  assert.match(railRules, /> \.vela-dtb\s*\{[^}]*flex:\s*0 0 auto !important/);
  assert.match(railRules, /> \.vela-sidebar\s*\{[^}]*flex:\s*1 1 0% !important;[^}]*gap:\s*0\.375rem;[^}]*justify-content:\s*space-between !important/);
  assert.match(railRules, /\.vela-sidebar-section,[\s\S]*?\.vela-sidebar-group\s*\{[^}]*gap:\s*0\.25rem/);
  assert.match(railRules, /width:\s*2rem/);
  assert.match(railRules, /height:\s*1\.875rem/);
  assert.match(railRules, /min-height:\s*1\.875rem/);
  assert.doesNotMatch(railRules, /body\[data-theme=/);
});
