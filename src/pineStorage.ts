import { reportCaughtError } from './diagnostics.ts';
export const DEFAULT_SCRIPTS: Record<string, string> = {
  'Dual EMA Cross': `//@version=6
indicator("Dual EMA Cross", overlay = true)

fastLen = input.int(9, "Fast EMA")
slowLen = input.int(21, "Slow EMA")

fastEma = ta.ema(close, fastLen)
slowEma = ta.ema(close, slowLen)

bullish = ta.crossover(fastEma, slowEma)
bearish = ta.crossunder(fastEma, slowEma)

plot(fastEma, title = "Fast EMA", color = color.green, linewidth = 2)
plot(slowEma, title = "Slow EMA", color = color.red, linewidth = 2)

plotshape(bullish, title = "Bullish", style = shape.triangleup, location = location.belowbar, color = color.green, size = size.small)
plotshape(bearish, title = "Bearish", style = shape.triangledown, location = location.abovebar, color = color.red, size = size.small)
`,
};

const scriptsStorageKey = 'vela_user_scripts';

export function getSavedScripts(): Record<string, string> {
  try {
	const data = localStorage.getItem(scriptsStorageKey);
	if (!data) return { ...DEFAULT_SCRIPTS };
	const parsed = JSON.parse(data) as unknown;
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULT_SCRIPTS };
	const scripts = Object.fromEntries(Object.entries(parsed).filter(([, value]) => typeof value === 'string'));
	return Object.keys(scripts).length ? scripts : { ...DEFAULT_SCRIPTS };
  } catch (error) {
    reportCaughtError('pine-storage:read', error, 'Saved Pine scripts could not be read; default scripts are shown instead.');
	return { ...DEFAULT_SCRIPTS };
  }
}

export function notifyPineScriptCatalogChanged(): void {
  if (typeof document !== 'undefined') {
	document.dispatchEvent(new CustomEvent('omega:pine-script-catalog-changed'));
  }
}

export function saveScriptsToStorage(data: Record<string, string>, onError?: (message: string) => void): boolean {
  try {
	localStorage.setItem(scriptsStorageKey, JSON.stringify(data));
	notifyPineScriptCatalogChanged();
	return true;
  } catch (error) {
	const message = `Could not save scripts: ${error instanceof Error ? error.message : String(error)}`;
	onError?.(message);
	console.error(message);
	return false;
  }
}

export const userScriptCategories = ['Trend', 'Oscillators', 'Volume', 'Volatility', 'Other'] as const;
export type UserScriptCategory = string;

const scriptCategoriesStorageKey = 'vela_user_script_categories';
const savedScriptCategoryNamesStorageKey = 'vela_user_script_category_names';

export function getSavedScriptCategories(): Record<string, UserScriptCategory> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(scriptCategoriesStorageKey) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const validEntries = Object.entries(parsed).filter(([, value]) =>
      typeof value === 'string' && isValidScriptCategory(value),
    ) as Array<[string, UserScriptCategory]>;
    return Object.fromEntries(validEntries);
  } catch (error) {
    reportCaughtError('pine-storage:categories-read', error, 'Saved Pine script categories could not be read.');
    return {};
  }
}

function isValidScriptCategory(value: string): boolean {
  return value.trim().length > 0 && value.trim().length <= 60;
}

function getSavedCustomScriptCategoryNames(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(savedScriptCategoryNamesStorageKey) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const reserved = new Set<string>(userScriptCategories);
    return [...new Set(parsed
      .filter((value): value is string => typeof value === 'string')
      .map(value => value.trim())
      .filter(value => isValidScriptCategory(value) && !reserved.has(value)))];
  } catch (error) {
    reportCaughtError('pine-storage:category-names-read', error, 'Saved Pine category names could not be read.');
    return [];
  }
}

/** Includes the defaults and categories saved with scripts or created explicitly. */
export function getSavedScriptCategoryNames(): UserScriptCategory[] {
  return [...new Set([
    ...userScriptCategories,
    ...getSavedCustomScriptCategoryNames(),
    ...Object.values(getSavedScriptCategories()),
  ])].sort((left, right) => left.localeCompare(right));
}

function restoreCategoryStorage(previousValues: Map<string, string | null>, diagnosticKey: string, message: string): void {
  for (const [key, value] of previousValues) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (rollbackError) {
      reportCaughtError(`${diagnosticKey}:rollback`, rollbackError, message);
    }
  }
}

export function createSavedScriptCategory(category: UserScriptCategory): boolean {
  const name = category.trim();
  if (!isValidScriptCategory(name) || getSavedScriptCategoryNames().includes(name)) return false;
  try {
    const names = [...getSavedCustomScriptCategoryNames(), name].sort((left, right) => left.localeCompare(right));
    localStorage.setItem(savedScriptCategoryNamesStorageKey, JSON.stringify(names));
    notifyPineScriptCatalogChanged();
    return true;
  } catch (error) {
    reportCaughtError('pine-storage:category-create', error, 'The Pine script category could not be created.');
    return false;
  }
}

export function saveScriptCategory(name: string, category: UserScriptCategory): boolean {
  if (!name.trim() || !isValidScriptCategory(category)) return false;
  try {
    const categories = getSavedScriptCategories();
    categories[name] = category.trim();
    localStorage.setItem(scriptCategoriesStorageKey, JSON.stringify(categories));
    notifyPineScriptCatalogChanged();
    return true;
  } catch (error) {
    reportCaughtError('pine-storage:category-write', error, 'Pine script category could not be saved.');
    return false;
  }
}

export function renameSavedScriptCategory(category: UserScriptCategory, nextCategory: UserScriptCategory): boolean {
  const oldName = category.trim();
  const newName = nextCategory.trim();
  if (!isValidScriptCategory(oldName) || !isValidScriptCategory(newName)) return false;
  if (oldName === newName) return true;
  if (getSavedScriptCategoryNames().includes(newName)) return false;

  const customNames = getSavedCustomScriptCategoryNames();
  const previousValues = new Map<string, string | null>();
  try {
    previousValues.set(scriptCategoriesStorageKey, localStorage.getItem(scriptCategoriesStorageKey));
    if (customNames.includes(oldName)) {
      previousValues.set(savedScriptCategoryNamesStorageKey, localStorage.getItem(savedScriptCategoryNamesStorageKey));
    }
    const categories = getSavedScriptCategories();
    for (const [scriptName, savedCategory] of Object.entries(categories)) {
      if (savedCategory === oldName) categories[scriptName] = newName;
    }
    localStorage.setItem(scriptCategoriesStorageKey, JSON.stringify(categories));
    if (customNames.includes(oldName)) {
      const nextNames = [...customNames.filter(name => name !== oldName), newName].sort((left, right) => left.localeCompare(right));
      localStorage.setItem(savedScriptCategoryNamesStorageKey, JSON.stringify(nextNames));
    }
    notifyPineScriptCatalogChanged();
    return true;
  } catch (error) {
    restoreCategoryStorage(previousValues, 'pine-storage:category-rename', 'Previously saved category data could not be restored after a failed rename.');
    reportCaughtError('pine-storage:category-rename', error, 'The Pine script category could not be renamed.');
    return false;
  }
}

export function removeSavedScript(
  name: string,
  onError?: (message: string) => void,
): boolean {
  const scripts = getSavedScripts();
  if (!Object.hasOwn(scripts, name)) return false;
  if (Object.keys(scripts).length <= 1) {
    onError?.('Keep at least one script.');
    return false;
  }

  const categories = getSavedScriptCategories();
  delete scripts[name];
  delete categories[name];
  let previousScripts: string | null = null;
  let previousCategories: string | null = null;
  try {
    previousScripts = localStorage.getItem(scriptsStorageKey);
    previousCategories = localStorage.getItem(scriptCategoriesStorageKey);
    localStorage.setItem(scriptsStorageKey, JSON.stringify(scripts));
    localStorage.setItem(scriptCategoriesStorageKey, JSON.stringify(categories));
    notifyPineScriptCatalogChanged();
    return true;
  } catch (error) {
    try {
      if (previousScripts === null) localStorage.removeItem(scriptsStorageKey);
      else localStorage.setItem(scriptsStorageKey, previousScripts);
      if (previousCategories === null) localStorage.removeItem(scriptCategoriesStorageKey);
      else localStorage.setItem(scriptCategoriesStorageKey, previousCategories);
    } catch (rollbackError) {
      reportCaughtError('pine-storage:script-delete-rollback', rollbackError, 'Previously saved Pine script data could not be restored after a failed delete.');
    }
    const message = `Could not delete the Pine script: ${error instanceof Error ? error.message : String(error)}`;
    onError?.(message);
    reportCaughtError('pine-storage:script-delete', error, 'The Pine script could not be deleted.');
    return false;
  }
}

/** Removes a user-created category assignment without deleting its Pine scripts. */
export function removeSavedScriptCategory(category: UserScriptCategory): boolean {
  if (!isValidScriptCategory(category)) return false;
  const customNames = getSavedCustomScriptCategoryNames();
  const previousValues = new Map<string, string | null>();
  try {
    previousValues.set(scriptCategoriesStorageKey, localStorage.getItem(scriptCategoriesStorageKey));
    if (customNames.includes(category)) {
      previousValues.set(savedScriptCategoryNamesStorageKey, localStorage.getItem(savedScriptCategoryNamesStorageKey));
    }
    const categories = getSavedScriptCategories();
    const remaining = Object.fromEntries(
      Object.entries(categories).filter(([, savedCategory]) => savedCategory !== category),
    );
    localStorage.setItem(scriptCategoriesStorageKey, JSON.stringify(remaining));
    if (customNames.includes(category)) {
      localStorage.setItem(savedScriptCategoryNamesStorageKey, JSON.stringify(customNames.filter(name => name !== category)));
    }
    notifyPineScriptCatalogChanged();
    return true;
  } catch (error) {
    restoreCategoryStorage(previousValues, 'pine-storage:category-delete', 'Previously saved category data could not be restored after a failed delete.');
    reportCaughtError('pine-storage:category-delete', error, 'The Pine script category could not be removed.');
    return false;
  }
}

export function saveNewScriptWithCategory(
  name: string,
  source: string,
  category: UserScriptCategory,
  scripts: Record<string, string>,
  onError?: (message: string) => void,
): boolean {
  const cleanCategory = category.trim();
  if (!name.trim() || name !== name.trim() || Object.hasOwn(scripts, name)) {
    onError?.(Object.hasOwn(scripts, name) ? `A script named "${name}" already exists.` : 'Enter a valid script name.');
    return false;
  }
  if (!isValidScriptCategory(cleanCategory)) {
    onError?.('Enter a category name containing 1 to 60 characters.');
    return false;
  }

  const previousValues = new Map<string, string | null>();
  try {
    previousValues.set(scriptsStorageKey, localStorage.getItem(scriptsStorageKey));
    previousValues.set(scriptCategoriesStorageKey, localStorage.getItem(scriptCategoriesStorageKey));
    const nextScripts = { ...scripts, [name]: source };
    const nextCategories = { ...getSavedScriptCategories(), [name]: cleanCategory };
    localStorage.setItem(scriptsStorageKey, JSON.stringify(nextScripts));
    localStorage.setItem(scriptCategoriesStorageKey, JSON.stringify(nextCategories));
    notifyPineScriptCatalogChanged();
    return true;
  } catch (error) {
    for (const [key, value] of previousValues) {
      try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      } catch (rollbackError) {
        reportCaughtError('pine-storage:script-create-rollback', rollbackError, 'Previously saved Pine script data could not be restored after a failed save.');
      }
    }
    const message = `Could not save the new Pine script and category: ${error instanceof Error ? error.message : String(error)}`;
    onError?.(message);
    reportCaughtError('pine-storage:script-create', error, 'The Pine script and its category could not be saved.');
    return false;
  }
}
