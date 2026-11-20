export const standardIndicatorCategories = [
  'Discover',
  'Favorites',
  'Strategies',
  'Trend',
  'Oscillators',
  'Volume',
  'Volatility',
  'Market Structure',
  'Built-in',
  'My Scripts',
] as const;
export const popularIndicatorCategories = [
  'Trend',
  'Oscillators',
  'Volume',
  'Volatility',
] as const;

export const categoryAliases: Record<string, string> = {
  'Moving Averages': 'Trend',
  'Trailing Stops': 'Trend',
  'Highlighters': 'Trend',
  'Bands & Channels': 'Volatility',
  'Statistics': 'Volume',
  'Research': 'Built-in',
  'Utils': 'Built-in',
  'Utilities': 'Built-in',
  'Compatible': 'Built-in',
  'All scripts': 'Discover',
};

export function normalizeIndicatorCategory(category?: string): string {
  if (!category) return 'Other';
  return categoryAliases[category] ?? category;
}

export function buildIndicatorCategoryList(
  additionalCategories: Iterable<string>,
  customCategories: Iterable<string> = [],
): string[] {
  const allowed = new Set<string>(standardIndicatorCategories);
  const normalizedAdditional = [...additionalCategories]
    .map(category => categoryAliases[category] ?? category)
    .filter(category => allowed.has(category as typeof standardIndicatorCategories[number]));

  const standard = [...standardIndicatorCategories].filter(cat =>
    cat === 'Discover' || cat === 'Favorites' || cat === 'Strategies' || cat === 'Built-in' || cat === 'My Scripts' || normalizedAdditional.includes(cat)
  );
  const custom = [...new Set([...customCategories]
    .map(category => categoryAliases[category] ?? category)
    .filter(category => category.trim().length > 0 && !allowed.has(category as typeof standardIndicatorCategories[number])))]
    .sort((left, right) => left.localeCompare(right));
  return [...standard, ...custom];
}
