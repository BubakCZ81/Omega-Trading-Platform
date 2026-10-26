import type { VelaTheme } from '@luxalgo/vela';

export type OmegaTheme = 'dark' | 'light' | 'high-contrast' | 'high-contrast-dark';

const highContrastTheme: VelaTheme = {
  background: '#f7fbff',
  textColor: '#061a33',
  gridColor: '#9bb1c8',
  borderColor: '#183b60',
  upColor: '#0063a8',
  downColor: '#b00020',
  fontFamily: 'Arial, sans-serif',
};

const highContrastDarkTheme: VelaTheme = {
  background: '#101d30',
  textColor: '#f5f9ff',
  gridColor: '#506d91',
  borderColor: '#9bbde5',
  upColor: '#00c98d',
  downColor: '#ff6473',
  fontFamily: 'Arial, sans-serif',
};

export function isOmegaTheme(theme: unknown): theme is OmegaTheme {
  return theme === 'dark' || theme === 'light' || theme === 'high-contrast' || theme === 'high-contrast-dark';
}

export function velaTheme(theme: OmegaTheme): VelaTheme | 'dark' | 'light' {
  if (theme === 'high-contrast') return highContrastTheme;
  if (theme === 'high-contrast-dark') return highContrastDarkTheme;
  return theme;
}

export function applyThemeUi(theme: OmegaTheme): void {
  const menu = document.getElementById('theme-menu') as HTMLDetailsElement | null;
  const baseTheme = theme === 'high-contrast' ? 'light' : theme === 'high-contrast-dark' ? 'dark' : theme;
  document.documentElement.dataset.theme = baseTheme;
  document.body.dataset.theme = baseTheme;
  document.documentElement.dataset.themeVariant = theme.startsWith('high-contrast') ? theme : '';
  document.body.dataset.themeVariant = theme.startsWith('high-contrast') ? theme : '';
  document.documentElement.style.colorScheme = baseTheme;
  if (menu) menu.dataset.active = 'true';
  for (const choice of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
    const selected = choice.dataset.themeChoice === theme;
    choice.setAttribute('aria-checked', String(selected));
    choice.classList.toggle('selected', selected);
  }
  document.body.style.backgroundColor = 'var(--omega-bg)';
}

export function initializeThemeMenu(options: {
  getTheme(): OmegaTheme;
  setTheme(theme: OmegaTheme): void;
}): void {
  const themeMenu = document.getElementById('theme-menu') as HTMLDetailsElement | null;
  if (!themeMenu) return;

  themeMenu.addEventListener('click', event => {
    const target = event.target;
    const choice = target instanceof Element
      ? target.closest<HTMLButtonElement>('[data-theme-choice]')
      : null;
    if (!choice || !themeMenu.contains(choice)) return;
    event.preventDefault();
    event.stopPropagation();
    const selected = choice.dataset.themeChoice;
    options.setTheme(isOmegaTheme(selected) ? selected : 'dark');
    themeMenu.open = false;
  });

  document.addEventListener('pointerdown', event => {
    if (themeMenu.open && event.target instanceof Node && !themeMenu.contains(event.target)) {
      themeMenu.open = false;
    }
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && themeMenu.open) {
      themeMenu.open = false;
      themeMenu.querySelector<HTMLElement>('summary')?.focus();
    }
  });

  applyThemeUi(options.getTheme());
}
