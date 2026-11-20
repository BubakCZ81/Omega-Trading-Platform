import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PineTS } from 'pinets';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicRoot = path.join(projectRoot, 'public');
const indicatorRoot = path.join(publicRoot, 'indicators');
const upstreamRoot = path.join(indicatorRoot, 'everget');
const editorsPickRoot = path.join(indicatorRoot, "Editor's Pick");
const catalog = JSON.parse(await readFile(path.join(indicatorRoot, 'catalog.json'), 'utf8'));

async function listPineFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(entry => {
	const fullPath = path.join(directory, entry.name);
	return entry.isDirectory() ? listPineFiles(fullPath) : [fullPath];
  }));
  return files.flat().filter(file => file.endsWith('.pine'));
}

const originalSources = (await listPineFiles(upstreamRoot))
  .filter(file => !file.startsWith(path.join(upstreamRoot, 'compatible') + path.sep));
assert.equal(originalSources.length, 210, 'The upstream indicator source inventory changed.');
assert.ok(await readFile(path.join(upstreamRoot, 'LICENSE'), 'utf8').then(text => text.includes('GNU GENERAL PUBLIC LICENSE')),
  'The upstream GPL license notice is missing.');
assert.equal(catalog.length, 111, 'The verified indicator catalog changed; review the runtime-validated source set.');
assert.equal(catalog.filter(entry => entry.url?.includes('/indicators/everget/') && !entry.url.includes('/compatible/')).length, 32,
  'Prefer original, unmodified sources whenever they pass PineTS validation.');
assert.equal(new Set(catalog.map(entry => entry.name)).size, catalog.length, 'Catalog names must be unique.');
assert.equal(new Set(catalog.map(entry => entry.url ?? entry.sourceUrl)).size, catalog.length, 'Catalog source URLs must be unique.');
assert.deepEqual(catalog.map(entry => entry.name), [...catalog.map(entry => entry.name)].sort((a, b) => a.localeCompare(b)),
  'The indicator catalog must be sorted alphabetically by name.');
assert.deepEqual(
  catalog.filter(entry => entry.category === 'Strategies').map(entry => entry.name),
  ['Donchian Channel Turtle Breakout', 'Dual EMA Crossover Strategy', 'MACD Breakout Strategy', 'RSI + Bollinger Mean Reversion', 'Supertrend Trend-Following Strategy'],
  'The local strategy indicators must remain in the catalog.',
);
const marketStructure = catalog.filter(entry => entry.category === 'Market Structure');
assert.deepEqual(
  marketStructure.map(entry => entry.name),
  [
    'Liquidity + Order Blocks',
    'Market Structure — BOS / CHoCH / EQH / EQL',
    'Pinnacle Structure Cipher [JOAT]',
    'SM Radar — Market Structure / OB / FVG',
    'SMC Zones — BOS / CHoCH / Order Blocks / FVG',
  ],
  'The curated Market Structure collection must contain its public reference entries.',
);
for (const entry of marketStructure) {
  assert.equal(entry.referenceOnly, true, `${entry.name} must be reference-only.`);
  assert.equal(entry.url, undefined, `${entry.name} must not ship copied Pine source.`);
  assert.match(entry.sourceUrl ?? '', /^https:\/\/(www\.tradingview\.com\/script\/|github\.com\/)/, `${entry.name} must link to a public reference.`);
  assert.equal(entry.enabled, false, `${entry.name} must not auto-add to the chart.`);
}
assert.deepEqual(
  catalog.filter(entry => entry.collections?.includes('Built-in')).map(entry => entry.name),
  [
    'Awesome Oscillator',
    'Chandelier Exit',
    'Exponential Moving Average',
    'Hull Moving Average',
    'On Balance Volume',
    'Parabolic SAR',
    'Simple Moving Average',
    'Supertrend',
    'Weighted Moving Average',
    'Wilder Modified Moving Average',
  ],
  'The basic Pine indicators must remain in the Built-in collection.',
);

const editorPickCategories = (await readdir(editorsPickRoot, { withFileTypes: true }))
  .filter(entry => entry.isDirectory());
const editorPicks = (await Promise.all(editorPickCategories.map(async category => {
  const manifestPath = path.join(editorsPickRoot, category.name, 'catalog.json');
  return JSON.parse(await readFile(manifestPath, 'utf8'));
}))).flat();
assert.equal(editorPicks.length, 2, 'The licensed Editorâ€™s Pick collection changed; review each source and license.');

const bars = Array.from({ length: 500 }, (_, index) => {
  const close = 100 + Math.sin(index / 4) * 5 + index * 0.03;
  const open = close + Math.sin(index) * 0.3;
  return {
	open,
	high: Math.max(open, close) + 1,
	low: Math.min(open, close) - 1,
	close,
	volume: 100 + index % 17,
	openTime: 1_700_000_000_000 + index * 60_000,
  };
});

for (const entry of catalog) {
  assert.equal(entry.language, 'pine', `${entry.name} must use the Pine engine.`);
  const isStrategy = entry.category === 'Strategies';
  const isReference = entry.referenceOnly === true;
  assert.equal(entry.enabled, isStrategy, `${entry.name} has an unexpected auto-add setting.`);
  assert.ok(entry.category, `${entry.name} must have a picker category.`);
  if (isReference) {
    assert.equal(entry.url, undefined, `${entry.name} reference must not have a local source.`);
    assert.match(entry.sourceUrl ?? '', /^https:\/\/(www\.tradingview\.com\/script\/|github\.com\/)/, `${entry.name} reference URL is invalid.`);
    assert.ok(entry.description, `${entry.name} reference must have a description.`);
    continue;
  }
  assert.ok(
    entry.url.startsWith(isStrategy ? '/indicators/strategies/' : '/indicators/everget/'),
    `${entry.name} must point to an allowed local source.`,
  );

  const sourcePath = path.resolve(publicRoot, `.${decodeURIComponent(new URL(entry.url, 'http://localhost').pathname)}`);
  assert.ok(sourcePath.startsWith(publicRoot + path.sep), `${entry.name} source path must stay inside public assets.`);
  const source = await readFile(sourcePath, 'utf8');
  assert.match(source, /^\/\/@version=[56]\b/m, `${entry.name} must use a Pine version supported by PineTS.`);
  await new PineTS(bars).run(source);
}

for (const pick of editorPicks) {
  assert.equal(pick.license, 'GPL-3.0', `${pick.name} must have an explicit redistribution license.`);
  assert.ok(pick.sourceUrl.startsWith('https://www.tradingview.com/script/'), `${pick.name} must link to its Editorâ€™s Pick page.`);
  const catalogEntry = catalog.find(entry => entry.url === pick.source);
  assert.ok(catalogEntry, `${pick.name} must point to a verified local source.`);
  assert.ok(catalogEntry.collections?.includes(`Editor's Pick / ${pick.subcategory}`),
    `${pick.name} must appear in the ${pick.subcategory} Editorâ€™s Pick collection.`);
  assert.match(await readFile(path.resolve(indicatorRoot, pick.licenseFile), 'utf8'), /GNU GENERAL PUBLIC LICENSE/,
    `${pick.name} must include its GPL-3.0 license text.`);
  const source = await readFile(path.resolve(publicRoot, `.${decodeURIComponent(new URL(pick.source, 'http://localhost').pathname)}`), 'utf8');
  assert.match(source, /GPL-3\.0 license/i, `${pick.name} source must declare its redistribution license.`);
}

console.log(`Validated ${catalog.length} Pine indicators against ${originalSources.length} upstream source files.`);
