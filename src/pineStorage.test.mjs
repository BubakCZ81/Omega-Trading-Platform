import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

const storageValues = new Map();
let failOnKey;

const localStorageMock = {
  getItem(key) {
    return storageValues.get(key) ?? null;
  },
  setItem(key, value) {
    if (key === failOnKey) {
      failOnKey = undefined;
      throw new Error('simulated storage failure');
    }
    storageValues.set(key, String(value));
  },
  removeItem(key) {
    storageValues.delete(key);
  },
};

beforeEach(() => {
  storageValues.clear();
  failOnKey = undefined;
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorageMock });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { velaDiagnostics: { record() {} } },
  });
});

afterEach(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
});

const storage = await import('./pineStorage.ts');

test('empty Pine categories can be created, renamed and deleted independently of scripts', () => {
  assert.equal(storage.createSavedScriptCategory('Scalping Setups'), true);
  assert.ok(storage.getSavedScriptCategoryNames().includes('Scalping Setups'));
  assert.equal(storage.createSavedScriptCategory('Scalping Setups'), false);
  assert.equal(storage.renameSavedScriptCategory('Scalping Setups', 'Momentum'), true);
  assert.ok(storage.getSavedScriptCategoryNames().includes('Momentum'));
  assert.ok(!storage.getSavedScriptCategoryNames().includes('Scalping Setups'));
  assert.equal(storage.removeSavedScriptCategory('Momentum'), true);
  assert.ok(!storage.getSavedScriptCategoryNames().includes('Momentum'));
});

test('new script and custom category persist together and are available after reload', () => {
  const scripts = storage.getSavedScripts();
  const source = '//@version=6\nindicator("Mean Reversion")\nplot(close)';

  assert.equal(storage.saveNewScriptWithCategory('Mean Reversion', source, '  Scalping Setups  ', scripts), true);

  assert.equal(storage.getSavedScripts()['Mean Reversion'], source);
  assert.equal(storage.getSavedScriptCategories()['Mean Reversion'], 'Scalping Setups');
  assert.ok(storage.getSavedScriptCategoryNames().includes('Scalping Setups'));
});

test('failed category persistence rolls back the script write and reports the failure', () => {
  const scripts = storage.getSavedScripts();
  const errors = [];
  failOnKey = 'vela_user_script_categories';

  assert.equal(
    storage.saveNewScriptWithCategory('Unpersisted', 'indicator("Unpersisted")', 'New Folder', scripts, message => errors.push(message)),
    false,
  );
  assert.equal(storage.getSavedScripts()['Unpersisted'], undefined);
  assert.equal(storage.getSavedScriptCategories()['Unpersisted'], undefined);
  assert.equal(storage.getSavedScriptCategoryNames().includes('New Folder'), false);
  assert.match(errors[0], /Could not save the new Pine script and category/);
});

test('duplicate script names are rejected without overwriting saved scripts', () => {
  const scripts = { Existing: 'original source' };
  storage.saveScriptsToStorage(scripts);
  const errors = [];

  assert.equal(storage.saveNewScriptWithCategory('Existing', 'replacement', 'Other', scripts, message => errors.push(message)), false);
  assert.equal(storage.getSavedScripts().Existing, 'original source');
  assert.match(errors[0], /already exists/);
});

test('blank or overlong custom category names are rejected', () => {
  const scripts = storage.getSavedScripts();
  const errors = [];

  assert.equal(storage.saveNewScriptWithCategory('Blank Category', 'source', '   ', scripts, message => errors.push(message)), false);
  assert.equal(storage.saveNewScriptWithCategory('Long Category', 'source', 'x'.repeat(61), scripts, message => errors.push(message)), false);
  assert.equal(storage.getSavedScripts()['Blank Category'], undefined);
  assert.equal(storage.getSavedScripts()['Long Category'], undefined);
  assert.equal(errors.length, 2);
});

test('removing a custom category keeps its scripts and returns them to My Scripts', () => {
  const scripts = storage.getSavedScripts();
  storage.saveNewScriptWithCategory('Keep Me', 'indicator("Keep Me")', 'Scalping Setups', scripts);
  storage.saveNewScriptWithCategory('Leave Alone', 'indicator("Leave Alone")', 'Other', storage.getSavedScripts());

  assert.equal(storage.removeSavedScriptCategory('Scalping Setups'), true);
  assert.equal(storage.getSavedScripts()['Keep Me'], 'indicator("Keep Me")');
  assert.equal(storage.getSavedScriptCategories()['Keep Me'], undefined);
  assert.equal(storage.getSavedScriptCategories()['Leave Alone'], 'Other');
  assert.ok(!storage.getSavedScriptCategoryNames().includes('Scalping Setups'));
});

test('renaming a category moves all assigned scripts and rejects an existing destination', () => {
  const scripts = storage.getSavedScripts();
  storage.saveNewScriptWithCategory('First', 'first source', 'Scalping Setups', scripts);
  storage.saveNewScriptWithCategory('Second', 'second source', 'Scalping Setups', storage.getSavedScripts());

  assert.equal(storage.renameSavedScriptCategory('Scalping Setups', 'Momentum'), true);
  assert.equal(storage.getSavedScriptCategories().First, 'Momentum');
  assert.equal(storage.getSavedScriptCategories().Second, 'Momentum');
  assert.equal(storage.renameSavedScriptCategory('Momentum', 'Other'), false);
});

test('deleting a script removes its category assignment and preserves the other scripts', () => {
  const scripts = storage.getSavedScripts();
  storage.saveNewScriptWithCategory('Remove Me', 'remove source', 'Custom', scripts);
  storage.saveNewScriptWithCategory('Keep Me', 'keep source', 'Other', storage.getSavedScripts());

  assert.equal(storage.removeSavedScript('Remove Me'), true);
  assert.equal(storage.getSavedScripts()['Remove Me'], undefined);
  assert.equal(storage.getSavedScriptCategories()['Remove Me'], undefined);
  assert.equal(storage.getSavedScripts()['Keep Me'], 'keep source');
});

test('deleting the final saved script is rejected', () => {
  storage.saveScriptsToStorage({ 'Only Script': 'source' });
  const errors = [];

  assert.equal(storage.removeSavedScript('Only Script', message => errors.push(message)), false);
  assert.equal(storage.getSavedScripts()['Only Script'], 'source');
  assert.match(errors[0], /Keep at least one script/);
});
