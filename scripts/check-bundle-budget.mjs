#!/usr/bin/env node
/**
 * Startup bundle budget.
 *
 * Vite warns that some chunk is over 500 kB, but that number says almost nothing: most of
 * this build is lazy (Monaco alone is 2.7 MB and only loads when the Pine editor opens), so
 * a large chunk there costs the operator nothing at startup.
 *
 * What actually decides how fast the platform opens is the set of files the browser must
 * fetch before the first paint: the entry module plus everything the HTML preloads. This
 * script sums exactly that, prints the breakdown, and fails if the startup weight grows.
 *
 * Run AFTER a build: node scripts/check-bundle-budget.mjs
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Startup bytes allowed, in KB. Raise deliberately, never by accident. */
const BUDGET_KB = 1750;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DIST = join(ROOT, 'dist');
const ASSETS = join(DIST, 'assets');

let html;
try {
  html = await readFile(join(DIST, 'index.html'), 'utf8');
} catch {
  console.error('No dist/index.html — run "npm run build" first.');
  process.exit(1);
}

const preloaded = [...html.matchAll(/rel="modulepreload"[^>]*href="\.\/assets\/([^"]+)"/g)].map(match => match[1]);
const entry = /<script[^>]*type="module"[^>]*src="\.\/assets\/([^"]+)"/.exec(html)?.[1];
const eager = [...new Set([entry, ...preloaded].filter(Boolean))];

let totalKb = 0;
const rows = [];
for (const name of eager) {
  try {
    const info = await stat(join(ASSETS, name));
    const kb = info.size / 1024;
    totalKb += kb;
    rows.push({ name, kb });
  } catch {
    console.error(`Listed in index.html but missing from dist/assets: ${name}`);
    process.exit(1);
  }
}

rows.sort((left, right) => right.kb - left.kb);
for (const row of rows) console.log(`${row.kb.toFixed(0).padStart(7)} KB  ${row.name}`);

let lazyKb = 0;
let lazyCount = 0;
for (const file of await readdir(ASSETS)) {
  if (!file.endsWith('.js') || eager.includes(file)) continue;
  lazyKb += (await stat(join(ASSETS, file))).size / 1024;
  lazyCount += 1;
}

const fmt = value => `${(value / 1024).toFixed(2)} MB`;
console.log(`\nStartup (eager): ${fmt(totalKb)} in ${rows.length} files — budget ${(BUDGET_KB / 1024).toFixed(2)} MB`);
console.log(`Deferred (lazy): ${fmt(lazyKb)} in ${lazyCount} files — costs nothing until used`);

if (totalKb > BUDGET_KB) {
  console.error(
    `\nStartup budget exceeded by ${fmt(totalKb - BUDGET_KB)}. `
    + 'Move a module behind a dynamic import, or raise BUDGET_KB in this script deliberately.',
  );
  process.exit(1);
}

console.log(`\nStartup budget OK (${Math.round((totalKb / BUDGET_KB) * 100)}% of budget used).`);
