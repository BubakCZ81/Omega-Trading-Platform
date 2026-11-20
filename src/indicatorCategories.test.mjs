import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndicatorCategoryList, popularIndicatorCategories } from './indicatorCategories.ts';

test('keeps standard indicator categories in clean organized order', () => {
  const categories = buildIndicatorCategoryList(['Statistics', 'Trend', 'Research']);

  assert.ok(categories.includes('Discover'));
  assert.ok(categories.includes('Strategies'));
  assert.ok(categories.includes('Trend'));
  assert.ok(categories.includes('Built-in'));
});

test('retains catalog-specific categories and maps aliases without duplicates', () => {
  const categories = buildIndicatorCategoryList(['Statistics', 'Research', 'Moving Averages']);

  assert.ok(!categories.includes('Statistics'));
  assert.ok(!categories.includes('Research'));
  assert.ok(categories.includes('Volume'));
  assert.ok(categories.includes('Built-in'));
  assert.ok(categories.includes('Trend'));
});

test('keeps saved custom categories after standard categories', () => {
  const categories = buildIndicatorCategoryList(['Statistics', 'Trend'], ['Scalping Setups', 'Scalping Setups']);

  assert.ok(categories.indexOf('Scalping Setups') > categories.indexOf('My Scripts'));
  assert.equal(categories.filter(category => category === 'Scalping Setups').length, 1);
  assert.ok(!categories.includes('Statistics'));
  assert.ok(!categories.includes("Editor's Pick"));
});
