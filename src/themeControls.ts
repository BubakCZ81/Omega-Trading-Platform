import { createTheme, registerTheme, type UiTheme } from './platform/index.ts';
import { reportCaughtError } from './diagnostics.ts';

export type OmegaTheme = 'dark' | 'light' | 'solarized-dark' | 'solarized-light';
export type OmegaThemeMode = 'dark' | 'light';

export const OMEGA_THEME_CHOICES: ReadonlyArray<readonly [OmegaTheme, string]> = [
  ['dark', 'Dark blue'],
  ['light', 'Soft light'],
  ['solarized-dark', 'Solarized Dark'],
  ['solarized-light', 'Solarized Light'],
];

interface ThemePalette {
  background: string;
  surface: string;
  elevated: string;
  text: string;
  muted: string;
  border: string;
  grid: string;
  accent: string;
  accentHover: string;
  up: string;
  down: string;
  buttonAccent: string;
  buttonText: string;
  buttonHover: string;
  error: string;
  success: string;
  warning: string;
}

const themePalettes: Record<OmegaTheme, ThemePalette> = {
  dark: {
    background: '#0d1420', surface: '#151f2c', elevated: '#202d3c',
    text: '#e6edf5', muted: '#a7b5c5', border: '#37475a', grid: '#26384a',
    accent: '#55a6ff', accentHover: '#82bdff', up: '#39c995', down: '#ff6577',
    buttonAccent: '#52d1bd', buttonText: '#0d1420', buttonHover: '#263a46',
    error: '#ff6577', success: '#39c995', warning: '#f0b95a',
  },
  light: {
    background: '#e8edf3', surface: '#f7f9fc', elevated: '#ffffff',
    text: '#1d2938', muted: '#526174', border: '#c5d0dc', grid: '#cbd5df',
    accent: '#176bc1', accentHover: '#10569f', up: '#14734e', down: '#b42336',
    buttonAccent: '#126b63', buttonText: '#ffffff', buttonHover: '#e2efee',
    error: '#b42336', success: '#14734e', warning: '#875000',
  },
  'solarized-dark': {
    background: '#002b36', surface: '#073642', elevated: '#0b414d',
    text: '#eee8d5', muted: '#93a1a1', border: '#586e75', grid: '#174853',
    accent: '#268bd2', accentHover: '#2aa198', up: '#859900', down: '#dc322f',
    buttonAccent: '#859900', buttonText: '#002b36', buttonHover: '#174853',
    error: '#ff6577', success: '#859900', warning: '#b58900',
  },
  'solarized-light': {
    background: '#fdf6e3', surface: '#eee8d5', elevated: '#ffffff',
    text: '#073642', muted: '#586e75', border: '#93a1a1', grid: '#e2d9c5',
    accent: '#268bd2', accentHover: '#006f9b', up: '#586e00', down: '#dc322f',
    buttonAccent: '#586e00', buttonText: '#fdf6e3', buttonHover: '#e2d9c5',
    error: '#b42336', success: '#586e00', warning: '#875000',
  },
};

function createOmegaTheme(palette: ThemePalette): UiTheme {
  const chart = {
    background: palette.background,
    textColor: palette.text,
    gridColor: palette.grid,
    borderColor: palette.border,
    upColor: palette.up,
    downColor: palette.down,
    fontFamily: 'Arial, sans-serif',
  };
  return createTheme({
    base: chart,
    accent: palette.accent,
    radius: 'sm',
    font: chart.fontFamily,
    tokens: {
      bg: palette.background,
      fg: palette.text,
      'fg-muted': palette.muted,
      'fg-faint': palette.muted,
      'fg-bright': palette.text,
      'fg-on-fill': palette.buttonText,
      surface: palette.surface,
      'surface-elev': palette.elevated,
      'surface-overlay': palette.elevated,
      'surface-sunken': palette.background,
      border: palette.border,
      'border-strong': palette.border,
      'border-soft': palette.border,
      'border-faint': palette.border,
      hover: palette.buttonHover,
      'hover-strong': palette.buttonHover,
      active: palette.buttonHover,
      focus: palette.accent,
      'focus-soft': palette.buttonHover,
      'selected-bg': palette.buttonHover,
      'selected-fg': palette.text,
      'accent-bright': palette.accentHover,
      'up': palette.up,
      'down': palette.down,
      profit: palette.success,
      loss: palette.error,
      danger: palette.error,
    },
  });
}

const velaThemes: Record<OmegaTheme, UiTheme> = {
  dark: createOmegaTheme(themePalettes.dark),
  light: createOmegaTheme(themePalettes.light),
  'solarized-dark': createOmegaTheme(themePalettes['solarized-dark']),
  'solarized-light': createOmegaTheme(themePalettes['solarized-light']),
};

registerTheme({ id: 'solarized-dark', label: 'Solarized Dark', theme: velaThemes['solarized-dark'] });
registerTheme({ id: 'solarized-light', label: 'Solarized Light', theme: velaThemes['solarized-light'] });

export function isOmegaTheme(theme: unknown): theme is OmegaTheme {
  return typeof theme === 'string' && Object.prototype.hasOwnProperty.call(velaThemes, theme);
}

export function omegaThemeMode(theme: OmegaTheme): OmegaThemeMode {
  return theme.endsWith('light') ? 'light' : 'dark';
}

export function isLightOmegaTheme(theme: OmegaTheme): boolean {
  return omegaThemeMode(theme) === 'light';
}

export function velaTheme(theme: OmegaTheme): UiTheme {
  return velaThemes[theme];
}

export function applyThemeUi(theme: OmegaTheme): void {
  const mode = omegaThemeMode(theme);
  const variant = theme === mode ? '' : theme;
  document.documentElement.dataset.theme = mode;
  document.body.dataset.theme = mode;
  document.documentElement.dataset.themeVariant = variant;
  document.body.dataset.themeVariant = variant;
  document.documentElement.style.colorScheme = mode;
  document.body.style.backgroundColor = 'var(--omega-bg)';

  try {
    const chartBg = localStorage.getItem('omega:chart-background');
    if (chartBg) {
      document.documentElement.style.setProperty('--omega-chart-bg', chartBg);
    }
  } catch (error) {
    reportCaughtError('theme:load-chart-background', error);
  }

  // The separate Pine editor window renders its own document, so it cannot inherit these
  // attributes — which is why it always painted the dark defaults, even in the light theme.
  // Persisting the choice gives that window something to read.
  try {
    localStorage.setItem('omega:theme', theme);
  } catch (error) {
    reportCaughtError('theme:persist', error);
  }

  for (const choice of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
    const selected = choice.dataset.themeChoice === theme;
    choice.setAttribute('aria-checked', String(selected));
    choice.classList.toggle('selected', selected);
  }
}

/** Applies the stored theme and wires the always-available toolbar picker. */
export function initializeThemeMenu(options: {
  getTheme(): OmegaTheme;
  setTheme(theme: OmegaTheme): void;
}): void {
  const menu = document.getElementById('theme-menu') as HTMLDetailsElement | null;
  applyThemeUi(options.getTheme());
  if (!menu) return;

  menu.addEventListener('click', event => {
    const choice = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-theme-choice]');
    if (!choice) return;
    const theme = choice.dataset.themeChoice;
    if (!isOmegaTheme(theme)) return;
    event.preventDefault();
    options.setTheme(theme);
    menu.open = false;
  });

  document.addEventListener('pointerdown', event => {
    if (menu.open && !menu.contains(event.target as Node)) menu.open = false;
  }, true);
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      menu.open = false;
      menu.querySelector('summary')?.focus();
    }
  });
}
