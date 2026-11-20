export const chartSidebarLayout = {
  top: ['panels', 'objects', '|', 'actions'],
  bottom: ['dataWindow'],
};

const topbarPanelButtonIds = [
  'vela-tool-vela-widget-panel-omega-trading-panel',
  'vela-tool-vela-widget-panel-objects',
  'vela-tool-vela-widget-panel-omega-time-sales',
  'vela-tool-vela-widget-panel-omega-dom',
];

const topbarPanelButtonObservers = new WeakMap<ParentNode, MutationObserver>();

export function placeMarketFlowButtonsAfterTradingPanel(host: ParentNode): number {
  let placed = 0;
  for (const topbar of host.querySelectorAll<HTMLElement>('.vela-widget-topbar')) {
    const right = topbar.querySelector<HTMLElement>('.vela-topbar-right');
    const actions = right?.querySelector<HTMLElement>('.vela-widget-actions');
    const alerts = right?.querySelector<HTMLElement>('#vela-tool-vela-widget-alerts');
    if (!right || !actions || !alerts) continue;

    let anchor: HTMLElement = alerts;
    for (const id of [...topbarPanelButtonIds].reverse()) {
      const button = topbar.querySelector<HTMLElement>(`#${id}`);
      if (!button) continue;
      if (button.parentElement !== right || button.nextElementSibling !== anchor) {
        right.insertBefore(button, anchor);
        placed += 1;
      }
      anchor = button;
    }
  }
  return placed;
}

export function dockChartSidebarOnDrawingRail(host: ParentNode): boolean {
  const drawingRail = host.querySelector<HTMLElement>('.vela-ws-toolbar');
  const sidebar = host.querySelector<HTMLElement>('.vela-sidebar');
  if (!drawingRail || !sidebar) return false;
  if (sidebar.parentElement !== drawingRail) drawingRail.append(sidebar);
  drawingRail.dataset.omegaToolsRail = 'left';
  placeMarketFlowButtonsAfterTradingPanel(host);

  if (typeof MutationObserver !== 'undefined' && !topbarPanelButtonObservers.has(host)) {
    const observer = new MutationObserver(() => placeMarketFlowButtonsAfterTradingPanel(host));
    observer.observe(host as Node, { childList: true, subtree: true });
    topbarPanelButtonObservers.set(host, observer);
  }
  return true;
}
