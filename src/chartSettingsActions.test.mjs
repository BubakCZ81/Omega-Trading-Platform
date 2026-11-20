import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Chart Settings stays in the upper application toolbar with the Settings label', async () => {
  const [html, topPanel, main] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('./topPanel.ts', import.meta.url), 'utf8'),
    readFile(new URL('./main.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="top-chart-settings"[^>]*aria-label="Settings">Settings<\/button>/);
  assert.match(topPanel, /settingsButton\?\.addEventListener\('click', \(\) => actions\.onSettings\(\)\)/);
  assert.match(main, /onSettings:\s*\(\) => \{ void openChartSettings\(\); \}/);
});

test('Safeguards is a chart-settings category, not a top-panel Options button', async () => {
  const [html, rendererSettings, settingsActions, safeguardsPanel] = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('./chartRendererSettings.ts', import.meta.url), 'utf8'),
    readFile(new URL('./chartSettingsActions.ts', import.meta.url), 'utf8'),
    readFile(new URL('./safeguardsPanel.ts', import.meta.url), 'utf8'),
  ]);
  assert.doesNotMatch(html, /id="platform-options"/);
  assert.match(rendererSettings, /title:\s*'Safeguards',\s*id:\s*'omega-safeguards'/);
  assert.match(settingsActions, /Open Safeguards controls/);
  assert.match(settingsActions, /omega:open-safeguards/);
  assert.match(safeguardsPanel, /document\.addEventListener\('omega:open-safeguards', open\)/);
  assert.doesNotMatch(safeguardsPanel, /platform-options/);
});
