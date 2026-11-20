#!/usr/bin/env node
/**
 * Platform boundary check.
 *
 * Omega is meant to be able to replace its charting library without a rewrite. That only
 * stays true if new code does not reach for the library directly. This script counts the
 * modules that import `@luxalgo/*` and fails when the number grows past the recorded
 * baseline, so the boundary cannot quietly erode.
 *
 * It is a ratchet, not a wall: the baseline only ever goes down. Each file that migrates
 * to `src/platform` lowers it, and it can be lowered here in the same commit.
 *
 * Usage: node scripts/check-platform-boundary.mjs [--update]
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Direct importers of the charting library outside src/platform, frozen at this count. */
const BASELINE = 40;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const PLATFORM_DIR = join(SRC, 'platform') + sep;
const LIBRARY_PATTERN = /from\s+['"]@luxalgo\//;

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collect(full));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts') || entry.name.endsWith('.d.ts')) continue;
    files.push(full);
  }
  return files;
}

const offenders = [];
for (const file of await collect(SRC)) {
  // The boundary module itself is the one place allowed to name the library.
  if (file.startsWith(PLATFORM_DIR)) continue;
  const source = await readFile(file, 'utf8');
  if (LIBRARY_PATTERN.test(source)) offenders.push(relative(ROOT, file));
}

const total = offenders.length;
const update = process.argv.includes('--update');

if (update) {
  console.log(`Platform boundary: ${total} direct importer(s).`);
  console.log(`Set BASELINE = ${total} in scripts/check-platform-boundary.mjs to ratchet it in.`);
  process.exit(0);
}

if (total > BASELINE) {
  console.error(`Platform boundary violated: ${total} modules import the charting library directly, baseline is ${BASELINE} (${total - BASELINE} over).`);
  console.error('Import from "./platform" instead. For reference, every direct importer today:\n');
  for (const file of offenders) console.error(`  - ${file}`);
  process.exit(1);
}

const improved = BASELINE - total;
console.log(
  improved > 0
    ? `Platform boundary OK: ${total} direct importer(s), ${improved} below the baseline of ${BASELINE}. Lower the baseline to lock the improvement in.`
    : `Platform boundary OK: ${total} direct importer(s) (baseline ${BASELINE}).`,
);
