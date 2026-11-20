import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the chart-topbar Pine Editor launcher opens the standalone editor', async () => {
  const [main, actions, controls, html, standaloneHtml, indicatorBrowserHtml, standalone, drawer, styles, indicatorBrowser, preload, electronMain] = await Promise.all([
    readFile(new URL('./main.ts', import.meta.url), 'utf8'),
    readFile(new URL('./favoriteDrawingTools.ts', import.meta.url), 'utf8'),
    readFile(new URL('./pineScriptControls.ts', import.meta.url), 'utf8'),
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../pine-editor.html', import.meta.url), 'utf8'),
    readFile(new URL('../indicator-browser.html', import.meta.url), 'utf8'),
    readFile(new URL('./pineEditorStandalone.ts', import.meta.url), 'utf8'),
    readFile(new URL('./editorDrawer.ts', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
    readFile(new URL('./indicatorBrowser.ts', import.meta.url), 'utf8'),
    readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8'),
    readFile(new URL('../electron/main.cjs', import.meta.url), 'utf8'),
  ]);

  assert.match(main, /topbar:\s*\{\s*left:\s*\[[^\]]*'omega-favorite-drawing-tools'[^\]]*'omega-pine-editor'/);
  assert.match(actions, /id:\s*'omega-pine-editor'[\s\S]*?label:\s*'Pine Editor'[\s\S]*?iconOnly:\s*false[\s\S]*?run:\s*\(\)\s*=>\s*window\.dispatchEvent\(new CustomEvent\('omega:pine-editor:open-standalone'\)\)/);
  assert.match(controls, /addEventListener\('omega:pine-editor:open-standalone'[\s\S]*?openStandaloneEditorForCurrentScript/);
  assert.match(controls, /if \(!standalone\) \{[\s\S]*?openTauriStandaloneEditor\(name, sourceToOpen\)/);
  assert.match(html, /id="indicator-browser-create-script"[^>]*>New Indicator</);
  assert.match(html, /id="indicator-browser-create-category"/);
  assert.match(indicatorBrowser, /createSavedScriptCategory\(name\)/);
  assert.match(indicatorBrowser, /indicator-browser-create-category'[\s\S]*?createCategory\(\)/);
  assert.match(indicatorBrowser, /createNewScript\(\)/);
  assert.match(indicatorBrowser, /newScript', '1'[\s\S]*?window\.open/);
  assert.match(indicatorBrowserHtml, /id="create-script"[^>]*>New Indicator</);
  assert.match(indicatorBrowser, /label: 'Delete script'[\s\S]*?label: 'Move to Category'[\s\S]*?label: 'Rename category'[\s\S]*?label: 'Delete category'/);
  assert.match(indicatorBrowser, /const menuHost = document\.getElementById\('indicator-browser-modal'\) \?\? document\.body;[\s\S]*?menuHost\.appendChild\(menu\)/);
  assert.match(styles, /\.indicator-context-menu \{[^}]*min-width: 13rem[^}]*background: var\(--panel\)[^}]*box-shadow:/);
  assert.match(drawer, /createNewScript\(\): Promise<boolean>/);
  assert.match(standalone, /onNewScript\(\(\) => document\.getElementById\('new-script'\)\?\.click\(\)\)/);
  assert.match(standalone, /get\('newScript'\) === '1'[\s\S]*?getElementById\('new-script'\)\?\.click\(\)/);
  assert.doesNotMatch(main, /pineEditorTestButton|fitTopToolbarToFit|hideFeatureElements\(false, 'editor-toggle-btn', 'editor-drawer', 'resize-handle'\)/);
  assert.doesNotMatch(html, /id="editor-toggle-btn"/);
  assert.match(styles, /body:not\(\[data-pine-editor-surface="standalone"\]\) #editor-drawer,[\s\S]*?display:\s*none\s*!important/);
  assert.match(drawer, /if \(!standalonePineEditor\) \{[\s\S]*?drawer\.style\.display = 'none'/);
  assert.doesNotMatch(standaloneHtml, /id="open-docked"/);
  assert.match(standaloneHtml, /id="pine-editor-loading"[\s\S]*?Preparing Pine Editor/);
  assert.match(standaloneHtml, /omega:pine-editor:ready[\s\S]*?finishPineEditorLoading/);
  assert.match(standaloneHtml, /pine-editor-load-error[\s\S]*?pine-editor-retry/);
  assert.doesNotMatch(standalone, /openDocked|onOpenDocked|open-docked/);
  assert.match(standalone, /requestAnimationFrame\(\(\)\s*=>\s*\{[\s\S]*?editor\.layout\(\);[\s\S]*?editor\.focus\(\);[\s\S]*?window\.dispatchEvent\(new Event\('omega:pine-editor:ready'\)\)/);
  assert.match(indicatorBrowser, /indicator-browser-create-script[\s\S]*?createNewScript\(\)/);
  assert.match(preload, /pine-editor:new-script[\s\S]*?onNewScript/);
  assert.match(electronMain, /function assertTrustedPineEditorRequest\(event\)[\s\S]*?\[mainWindow, indicatorBrowserWindow\]/);
  assert.match(electronMain, /ipcMain\.handle\('pine-editor:new-script'[\s\S]*?assertTrustedPineEditorRequest\(event\)[\s\S]*?webContents\.send\('pine-editor:new-script'\)/);
  assert.doesNotMatch(controls, /onOpenDocked|openDocked/);
});

test('toolbar auto-fit is a persisted Appearance setting and never hides Pine controls', async () => {
  const [main, settings] = await Promise.all([
    readFile(new URL('./main.ts', import.meta.url), 'utf8'),
    readFile(new URL('./chartRendererSettings.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(settings, /label:\s*'Auto-fit toolbar to window'/);
  assert.match(main, /TOOLBAR_AUTO_FIT_STORAGE_KEY/);
  assert.match(main, /fitTopToolbarToWindow/);
  assert.doesNotMatch(main, /hideFeatureElements\(false, 'editor-toggle-btn', 'editor-drawer', 'resize-handle'\)/);
});
