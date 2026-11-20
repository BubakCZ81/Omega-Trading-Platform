import { registerIcon, registerWidgetAction } from '@luxalgo/vela';

const ACTION_ID = 'omega-quicktrade-toggle';
const quickTradeControls = document.getElementById('chart-paper-trade-controls');

// Chart Quick Trade is MT5-only, visible when Omega opens, and controlled from the chart context menu.
let enabled = true;
let quickTradePositionUpdate: (() => void) | null = null;

function registerToggleAction(): void {
  const iconId = enabled ? 'omega-quicktrade-enabled' : 'omega-quicktrade-disabled';
  registerWidgetAction({
    id: ACTION_ID,
    target: 'context:body',
    label: `${enabled ? 'Disable' : 'Enable'} Chart Quick Trade (MT5)`,
    icon: iconId,
    // Keep the account-scoped trading action near the chart controls.
    order: -98,
    run: () => setQuickTradeEnabled(!enabled),
  });
}

registerIcon(
  'omega-quicktrade-enabled',
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/><path d="m4.2 8.2 2.3 2.3 5-5"/></svg>',
);
registerIcon(
  'omega-quicktrade-disabled',
  '<svg viewBox="0 0 16 16" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.4"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/></svg>',
);
function renderQuickTradeControls(): void {
  if (!quickTradeControls) return;
  quickTradeControls.hidden = !enabled;
  quickTradeControls.setAttribute('aria-hidden', String(!enabled));
}

export function setQuickTradeEnabled(nextEnabled: boolean): void {
  enabled = nextEnabled;
  renderQuickTradeControls();
  document.dispatchEvent(new CustomEvent('omega:quick-trade-state-changed', {
    detail: { enabled },
  }));
  registerToggleAction();
  quickTradePositionUpdate?.();
}

export function initializeQuickTradeToggle(): void {
  setQuickTradeEnabled(true);
  pinQuickTradeInTopbar();
}

function pinQuickTradeInTopbar(): void {
  if (!quickTradeControls) return;
  const wrapper = document.getElementById('chart-wrapper');
  if (!wrapper) return;

  const observedElements = new Set<HTMLElement>();
  let observer: ResizeObserver;
  const observe = (element: HTMLElement | null | undefined): void => {
    if (!element || observedElements.has(element)) return;
    observedElements.add(element);
    observer.observe(element);
  };
  const updatePosition = (): void => {
    const velaTopbar = wrapper.querySelector<HTMLElement>(
      '.vela-cell[data-omega-tab-active="true"] .vela-widget-topbar',
    ) ?? wrapper.querySelector<HTMLElement>('.vela-widget-topbar');
    const leftControls = velaTopbar?.querySelector<HTMLElement>('.vela-cell-controls');
    const rightControls = Array.from(velaTopbar?.querySelectorAll<HTMLElement>(
      '.vela-widget-panels, .vela-widget-actions, button[id="vela-tool-vela-widget-alerts"]',
    ) ?? []);
    const wrapperRect = wrapper.getBoundingClientRect();
    const topbarRect = velaTopbar?.getBoundingClientRect();
    const globalToolbarRect = document.getElementById('top-toolbar')?.getBoundingClientRect();
    const chartStatusline = wrapper.querySelector<HTMLElement>('.vela-cell .vela-statusline');
    const activePnl = wrapper.querySelector<HTMLElement>(
      '.vela-cell[data-omega-tab-active="true"] .omega-chart-pnl',
    ) ?? wrapper.querySelector<HTMLElement>('.omega-chart-pnl');
    const chartStatuslineRect = chartStatusline?.getBoundingClientRect();
    observe(velaTopbar);
    observe(leftControls);
    for (const control of rightControls) observe(control);
    observe(document.getElementById('top-toolbar'));
    observe(chartStatusline);
    observe(activePnl);

    const panelHeight = quickTradeControls!.offsetHeight || 44;
    const panelWidth = quickTradeControls!.offsetWidth || Math.min(390, wrapperRect.width - 24);
    const leftEdge = leftControls?.getBoundingClientRect().right ?? topbarRect?.left ?? wrapperRect.left;
    const rightEdge = rightControls
      .map(control => control.getBoundingClientRect())
      .filter(rect => rect.width > 0 && rect.height > 0)
      .reduce((edge, rect) => Math.min(edge, rect.left), topbarRect?.right ?? wrapperRect.right);
    const availableGap = Math.max(0, rightEdge - leftEdge);
    const fitsInTopbar = !!topbarRect
      && topbarRect.height > 0
      && availableGap >= panelWidth + 16;
    const fallbackHeaderBottom = Math.max(
      globalToolbarRect?.bottom ?? wrapperRect.top,
      chartStatuslineRect?.bottom ?? wrapperRect.top,
    );
    let centerX = fitsInTopbar
      ? (leftEdge + rightEdge) / 2
      : wrapperRect.left + wrapperRect.width / 2;
    let centerY = fitsInTopbar
      ? topbarRect.top + topbarRect.height / 2
      : topbarRect?.height
        ? topbarRect.top + topbarRect.height / 2
        : fallbackHeaderBottom + panelHeight / 2 + 8;
    if (activePnl) {
      const pnlRect = activePnl.getBoundingClientRect();
      if (pnlRect.width > 0) {
        centerX = pnlRect.left + pnlRect.width / 2;
      }
    }
    centerX = Math.max(panelWidth / 2 + 8, Math.min(window.innerWidth - panelWidth / 2 - 8, centerX));
    quickTradeControls!.style.setProperty(
      '--omega-quick-trade-center-x',
      `${centerX}px`,
    );
    quickTradeControls!.style.setProperty(
      '--omega-quick-trade-center-y',
      `${centerY}px`,
    );
  };
  quickTradePositionUpdate = updatePosition;
  observer = new ResizeObserver(updatePosition);
  observe(wrapper);
  observe(quickTradeControls);
  const mutationObserver = new MutationObserver(updatePosition);
  mutationObserver.observe(wrapper, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-omega-tab-active'],
  });
  window.addEventListener('resize', updatePosition);
  window.addEventListener('scroll', updatePosition, true);
  updatePosition();
}

export function isQuickTradeEnabled(): boolean {
  return enabled;
}
