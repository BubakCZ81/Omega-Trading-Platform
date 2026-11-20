#!/usr/bin/env node
/**
 * Silent-catch ratchet.
 *
 * A `catch` that neither logs nor reports is a bug that already happened and was hidden.
 * Counting them makes the problem visible and stops it growing: the baseline only goes
 * down as blocks are given a voice.
 *
 * Usage: node scripts/check-silent-catches.mjs [--list] [--update]
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Silent catch blocks currently in the tree. Lower this as they are fixed.
 *
 * The floor at 22 is deliberate, not laziness. Every remaining one is either:
 *  - a self-guard inside diagnostics.ts (a failure reporter must never recurse into itself);
 *  - a documented no-op such as "the pointer may already be gone", where the comment IS the
 *    explanation and there is nothing an operator could act on;
 *  - a fallback that returns the failure to its caller, which surfaces it to the operator.
 */
const BASELINE = 19;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
/**
 * What counts as "having a voice". A catch is only silent when it neither writes to a log,
 * nor reports to diagnostics, nor tells the operator anything on screen, nor re-throws the
 * error so a caller handles it. Everything here is a real reporting channel in this app.
 */
const LOGGING = new RegExp([
  'console\\.(error|warn|info|log)',
  'velaDiagnostics',
  'appendDiagnostic',
  'reportCaughtError',
  'reportError',
  'writeActivity',
  'diagnostic\\(',
  'setStatus',
  'showGate',
  'setEditorStatus',
  'setError\\(',
  'toast\\(',
  'textContent\\s*=',
  'dataset\\.state',
  'this\\.log',
  'throw\\s',
].join('|'));

async function collect(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collect(full));
      continue;
    }
    if (!entry.name.endsWith('.ts')) continue;
    if (entry.name.includes('.test.') || entry.name.endsWith('.d.ts')) continue;
    files.push(full);
  }
  return files;
}

/**
 * The text of a catch block, from the brace that OPENS it to the matching close.
 *
 * Two shapes must both work, and the first version of this function handled neither:
 *  - `} catch {` — the same line also closes the try block, so counting from the start of
 *    the line nets to zero and the detector would read the following function;
 *  - `} catch (e) { /* note *\/ }` — a one-line body opens and closes on that line, so a
 *    "depth became positive" test never fires either.
 *
 * The fix is to start at the `catch` keyword AND at its opening brace, and to treat the
 * first line as already started.
 */
function catchBody(lines, startIndex) {
  const firstLine = lines[startIndex];
  const keywordAt = firstLine.search(/\bcatch\b/);
  if (keywordAt < 0) return '';
  const opening = firstLine.slice(keywordAt);
  const braceAt = opening.indexOf('{');
  if (braceAt < 0) return opening;
  const body = [];
  let depth = 0;
  for (let index = startIndex; index < Math.min(startIndex + 30, lines.length); index += 1) {
    const source = index === startIndex ? opening.slice(braceAt) : lines[index];
    body.push(source);
    depth += (source.match(/\{/g) ?? []).length - (source.match(/\}/g) ?? []).length;
    if (depth <= 0) break;
  }
  return body.join('\n');
}

const offenders = [];
for (const file of await collect(SRC)) {
  const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    // A real catch is followed by a parameter list or a block; the word also appears in
    // prose and in this file's own comments, which must not be counted.
    if (!/\bcatch\s*[({]/.test(lines[index])) continue;
    const body = catchBody(lines, index);
    if (LOGGING.test(body)) continue;
    offenders.push({ file: relative(ROOT, file), line: index + 1, body: body.replace(/\s+/g, ' ').trim() });
  }
}

if (process.argv.includes('--update')) {
  console.log(`Silent catches: ${offenders.length}. Set BASELINE = ${offenders.length} to ratchet.`);
  process.exit(0);
}

if (process.argv.includes('--list')) {
  for (const offender of offenders) console.log(`${offender.file}:${offender.line}  ${offender.body.slice(0, 110)}`);
}

if (offenders.length > BASELINE) {
  console.error(`Silent catch regression: ${offenders.length} blocks swallow errors, baseline is ${BASELINE}.`);
  const byFile = new Map();
  for (const offender of offenders) byFile.set(offender.file, (byFile.get(offender.file) ?? 0) + 1);
  for (const [file, count] of [...byFile].sort((a, b) => b[1] - a[1])) console.error(`  ${count}  ${file}`);
  console.error('\nCall reportCaughtError(...) inside the catch; run with --list for the lines.');
  process.exit(1);
}

const improved = BASELINE - offenders.length;
console.log(
  improved > 0
    ? `Silent catches OK: ${offenders.length}, ${improved} below the baseline of ${BASELINE}. Lower the baseline to lock it in.`
    : `Silent catches OK: ${offenders.length} (baseline ${BASELINE}).`,
);
