#!/usr/bin/env node
/**
 * Turn the UI inventory into a readable map.
 *
 * The platform writes userData/ui-inventory.json on start-up: every element it renders, with
 * position, size, colours, borders and text. That file is the source of truth for "which panel
 * is where"; this script renders it as a table a human can read and search, so a change can be
 * requested by position instead of by description.
 *
 * Usage: node scripts/generate-ui-map.mjs [path-to-inventory.json]
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_PATH = join(homedir(), 'AppData', 'Roaming', 'Omega', 'ui-inventory.json');
const source = process.argv[2] ?? DEFAULT_PATH;

let inventory;
try {
  inventory = JSON.parse(await readFile(source, 'utf8'));
} catch (error) {
  console.error(`Could not read the inventory at ${source}: ${error.message}`);
  console.error('Start Omega once so it writes the file, then run this again.');
  process.exit(1);
}

const nodes = Array.isArray(inventory.nodes) ? inventory.nodes : [];
const label = node => node.id ? `#${node.id}` : (node.classes ?? '(no class)');

const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ');

function table(rows, headers) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines.join('\n');
}

const bands = nodes
  .filter(node => node.kind === 'bar' || node.kind === 'panel')
  .filter(node => node.w >= 200)
  .sort((left, right) => left.y - right.y || left.x - right.x);

const buttons = nodes.filter(node => node.kind === 'button').sort((left, right) => left.y - right.y || left.x - right.x);
const fields = nodes.filter(node => node.kind === 'field').sort((left, right) => left.y - right.y || left.x - right.x);
const windows = nodes.filter(node => node.kind === 'window');

const totals = Object.entries(inventory.totals ?? {}).map(([kind, count]) => `${kind}: ${count}`).join(', ');

const documentText = `# UI map

> This is a viewport snapshot, not the complete source index. For stable selectors, labels,
> component ownership, Vela bindings, and responsive layout anchors across all UI surfaces, see
> [UI-AGENT-INDEX.md](UI-AGENT-INDEX.md).

Generated from the platform's own inventory, taken ${inventory.capturedAt} in the ${inventory.theme} theme at
${(inventory.viewport ?? []).join('x')}.

Elements: ${nodes.length} (${totals}).

Positions are pixels: \`x,y\` measured from the top-left of the window, then \`width×height\`. The
DOM path column gives the structural anchor; use it when the viewport differs from this snapshot.

## Bars and panels, top to bottom

${table(bands.map(node => [node.y, node.h, `${node.x},${node.y}`, `${node.w}×${node.h}`, label(node), node.path, node.background, node.kind, node.text.slice(0, 48)]), ['y', 'h', 'position', 'size', 'element', 'DOM path', 'background', 'kind', 'text'])}

## Windows and dialogs

${windows.length ? table(windows.map(node => [label(node), `${node.w}×${node.h}`, node.background, node.text.slice(0, 48)]), ['element', 'size', 'background', 'text']) : 'None were open when the inventory was taken.'}

## Buttons (${buttons.length})

${table(buttons.map(node => [`${node.x},${node.y}`, `${node.w}×${node.h}`, label(node), node.path, node.background, node.borderColor, node.text.slice(0, 40)]), ['position', 'size', 'element', 'DOM path', 'background', 'border', 'text'])}

## Fields (${fields.length})

${table(fields.map(node => [`${node.x},${node.y}`, `${node.w}×${node.h}`, label(node), node.path, node.background, node.text.slice(0, 40)]), ['position', 'size', 'element', 'DOM path', 'background', 'text'])}

## How to use this

Name a row by its position and text - "the bar at y=52 holding Trading Panel" - and the element
column gives the exact selector. Anything not in this table did not exist when the inventory was
taken; open the panel first, then run \`captureUiInventory()\` in the developer console.
`;

const target = join(ROOT, 'docs', 'UI-MAP.md');
await writeFile(target, documentText, 'utf8');
console.log(`Wrote ${target} — ${nodes.length} elements, ${bands.length} bars/panels, ${buttons.length} buttons.`);
