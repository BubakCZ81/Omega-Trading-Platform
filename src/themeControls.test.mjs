import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLightOmegaTheme,
  isOmegaTheme,
  OMEGA_THEME_CHOICES,
  omegaThemeMode,
  velaTheme,
} from './themeControls.ts';

test('all four platform themes are selectable', () => {
  assert.deepEqual(OMEGA_THEME_CHOICES.map(([value]) => value), [
    'dark', 'light', 'solarized-dark', 'solarized-light',
  ]);
  for (const [value] of OMEGA_THEME_CHOICES) assert.equal(isOmegaTheme(value), true);
  assert.equal(isOmegaTheme('__proto__'), false);
});

test('Solarized themes map to the matching chart palette and UI tokens', () => {
  const dark = velaTheme('solarized-dark');
  const light = velaTheme('solarized-light');
  assert.equal(dark.chart.background, '#002b36');
  assert.equal(dark.chart.upColor, '#859900');
  assert.equal(dark.tokens['--vela-surface-elev'], '#0b414d');
  assert.equal(light.chart.background, '#fdf6e3');
  assert.equal(light.chart.textColor, '#073642');
  assert.equal(light.tokens['--vela-surface'], '#eee8d5');
  assert.equal(typeof dark.id, 'string');
  assert.equal(typeof light.id, 'string');
});

test('light and dark variants select the right system color mode', () => {
  assert.equal(omegaThemeMode('solarized-dark'), 'dark');
  assert.equal(omegaThemeMode('solarized-light'), 'light');
  assert.equal(isLightOmegaTheme('solarized-light'), true);
  assert.equal(isLightOmegaTheme('solarized-dark'), false);
});
