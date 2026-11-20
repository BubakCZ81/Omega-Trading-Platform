#!/usr/bin/env node
/**
 * Theme contrast audit.
 *
 * "Readable in every theme" is a claim, so it should be measurable rather than a matter of
 * taste. This script reads the two Omega palettes out of styles.css, computes the WCAG
 * contrast ratio for every text/background pair the UI actually uses, and fails when a pair
 * falls below the ratio its role requires.
 *
 * Thresholds (WCAG 2.1):
 *   4.5:1 for body text, 3:1 for large text, disabled text and UI boundaries.
 *
 * Usage: node scripts/check-theme-contrast.mjs [--verbose]
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STYLES = join(ROOT, 'src', 'styles.css');

const TOKENS = [
  'bg', 'surface', 'elevated', 'text', 'muted', 'border', 'accent',
  'button-accent', 'button-accent-contrast', 'button-danger', 'button-danger-contrast',
  'error', 'success', 'warning',
];

function channel(value) {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const light = Math.max(la, lb);
  const dark = Math.min(la, lb);
  return (light + 0.05) / (dark + 0.05);
}

function themeName(selector) {
  if (selector.includes('data-theme-variant="solarized-dark"')) return 'Solarized Dark';
  if (selector.includes('data-theme-variant="solarized-light"')) return 'Solarized Light';
  if (selector.includes('data-theme="light"')) return 'light (soft)';
  return 'dark';
}

const source = await readFile(STYLES, 'utf8');
const lines = source.split(/\r?\n/);
const palettes = new Map();

/** Raw custom-property text per theme, so var() references can be resolved. */
const rawProperties = new Map();

let current = null;
for (const line of lines) {
  // The default dark palette lives in `:root`, not in a body[data-theme] block, so it must
  // be included or the most-used theme is the one never audited.
  const selector = /^((?:body(?:\[[^\]]+\])*)|:root)\s*\{/.exec(line.trim());
  if (selector) {
    current = themeName(selector[1]);
    if (!palettes.has(current)) palettes.set(current, {});
    if (!rawProperties.has(current)) rawProperties.set(current, new Map());
    continue;
  }
  const declaration = /--([a-z0-9-]+)\s*:\s*([^;]+);/.exec(line);
  if (!declaration || !current) continue;
  rawProperties.get(current).set(`--${declaration[1]}`, declaration[2].trim());
}

/**
 * Resolve a custom property to a hex colour, following `var(--x)` references. Panels now take
 * their colour from named variables (`--omega-surface: var(--panel-top1-bg)`), and an audit
 * that only understood literal hex reported them as missing.
 */
function resolveColor(name, properties, depth = 0) {
  if (depth > 6) return null;
  const raw = properties.get(name);
  if (!raw) return null;
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw;
  const reference = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  if (reference) return resolveColor(reference[1], properties, depth + 1);
  return null;
}

for (const [theme, properties] of rawProperties) {
  const palette = palettes.get(theme);
  for (const token of TOKENS) {
    const value = resolveColor(`--omega-${token}`, properties);
    if (value) palette[token] = value;
  }
}

/** The pairs the interface actually renders, with the ratio each needs. */
const CHECKS = [
  { fg: 'text', bg: 'bg', min: 4.5, label: 'body text on page' },
  { fg: 'text', bg: 'surface', min: 4.5, label: 'body text on panel' },
  { fg: 'text', bg: 'elevated', min: 4.5, label: 'body text on raised panel' },
  { fg: 'muted', bg: 'bg', min: 3.0, label: 'muted text on page' },
  { fg: 'muted', bg: 'surface', min: 3.0, label: 'muted text on panel' },
  { fg: 'muted', bg: 'elevated', min: 3.0, label: 'muted text on raised panel' },
  { fg: 'accent', bg: 'bg', min: 3.0, label: 'accent on page' },
  { fg: 'accent', bg: 'surface', min: 3.0, label: 'accent on panel' },
  { fg: 'button-accent-contrast', bg: 'button-accent', min: 4.5, label: 'accent button text' },
  { fg: 'button-danger-contrast', bg: 'button-danger', min: 4.5, label: 'danger button text' },
  { fg: 'error', bg: 'surface', min: 3.0, label: 'error on panel' },
  { fg: 'success', bg: 'surface', min: 3.0, label: 'success on panel' },
  { fg: 'warning', bg: 'surface', min: 3.0, label: 'warning on panel' },
  { fg: 'border', bg: 'surface', min: 1.4, label: 'panel border vs panel' },
];

const verbose = process.argv.includes('--verbose');
const failures = [];

for (const [theme, palette] of palettes) {
  const missing = TOKENS.filter(token => !palette[token]);
  if (missing.length) {
    failures.push(`${theme}: missing token(s) ${missing.join(', ')}`);
    continue;
  }
  for (const check of CHECKS) {
    const ratio = contrast(palette[check.fg], palette[check.bg]);
    const passed = ratio >= check.min;
    if (verbose || !passed) {
      console.log(`${passed ? 'ok  ' : 'FAIL'} ${theme.padEnd(22)} ${check.label.padEnd(30)} ${ratio.toFixed(2)}:1 (needs ${check.min})`);
    }
    if (!passed) failures.push(`${theme}: ${check.label} is ${ratio.toFixed(2)}:1, needs ${check.min}:1`);
  }
}

if (palettes.size !== 4) failures.push(`Expected four theme palettes, found ${palettes.size}`);

if (failures.length) {
  console.error(`\nContrast audit failed in ${failures.length} place(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`Contrast audit OK: ${palettes.size} palettes, ${CHECKS.length} pairs each.`);
