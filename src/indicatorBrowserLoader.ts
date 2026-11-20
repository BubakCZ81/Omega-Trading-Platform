import { registerWidgetAction, type WidgetContext } from '@luxalgo/vela/widget';

let indicatorBrowserRegistered = false;
let indicatorBrowserModule: Promise<typeof import('./indicatorBrowser')> | null = null;

function loadIndicatorBrowser(): Promise<typeof import('./indicatorBrowser')> {
  if (!indicatorBrowserModule) {
    indicatorBrowserModule = import('./indicatorBrowser').catch(error => {
      indicatorBrowserModule = null;
      throw error;
    });
  }
  return indicatorBrowserModule;
}

function openIndicatorBrowser(context: WidgetContext): void {
  void loadIndicatorBrowser().then(module => module.openIndicatorBrowser(context)).catch(error => {
    context.toast(
      error instanceof Error ? `Could not load Indicators: ${error.message}` : `Could not load Indicators: ${String(error)}`,
      'error',
    );
  });
}

export function ensureIndicatorBrowserRegistration(): void {
  if (indicatorBrowserRegistered) return;
  registerWidgetAction({
    id: 'indicators',
    target: 'topbar',
    label: 'Indicators',
    icon: 'indicators',
    align: 'left',
    order: 10,
    run: openIndicatorBrowser,
  });
  indicatorBrowserRegistered = true;
}

export function isIndicatorBrowserRegistered(): boolean {
  return indicatorBrowserRegistered;
}

document.addEventListener('pine-indicator-picker-open', event => {
  const context = (event as CustomEvent<WidgetContext>).detail;
  if (context) openIndicatorBrowser(context);
});

ensureIndicatorBrowserRegistration();
