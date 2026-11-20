import { registerIcon, registerWidgetAction } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { refreshChart, resetChartView } from './chartReset';
import { initializeChartContextMenuPresentation } from './chartContextMenuPresentation';

type PaperTradingModule = typeof import('./chartPaperTrading');

interface ChartContextActionsOptions {
  workspace: VelaWorkspace;
  ensurePaperTrading(): Promise<PaperTradingModule>;
  hasPendingPaperOrderAtPrice(chart: VelaWorkspace['chart'], price: number | null | undefined): boolean;
  getShowBidAskLines(): boolean;
  setShowBidAskLines(enabled: boolean): void;
  getTheme(): string;
  setTheme(theme: 'dark' | 'light'): void;
  getResetChartCandles(): number;
  openChartSettings(chart: VelaWorkspace['chart']): void;
  openReplayControls(): void;
  startReplayAt(time: number, cellId: string): Promise<unknown>;
}

const contextActionIcons: Record<string, string> = {
  'omega-context-cancel-order': '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="m17 3 4 4m0-4-4 4"/>',
  'omega-context-add-order': '<path d="M12 3a9 9 0 1 0 9 9"/><path d="M12 7v5l3 2"/><path d="M19 14v7m-3.5-3.5h7"/>',
  'omega-context-copy-price': '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  'omega-context-reset-view': '<path d="M4 11a8 8 0 1 1 2 6"/><path d="M4 4v7h7"/><path d="M12 7v5l3 2"/>',
  'omega-context-refresh': '<path d="M20 11a8 8 0 1 0-1.6 5M20 4v7h-7"/>',
  'omega-context-replay': '<path d="M4 5v6h6"/><path d="M5.5 15a7 7 0 1 0 1-7"/><path d="m10 8 6 4-6 4z"/>',
  'omega-context-replay-panel': '<path d="M3 4h18v16H3z"/><path d="M3 9h18m-6-5v5"/><path d="m8 12 5 3-5 3z"/>',
  // These four were referenced by the menu entries but never registered, so the items
  // would have rendered without an icon.
  'omega-context-pine': '<path d="M6 3h9l3 3v15H6z"/><path d="M15 3v4h4"/><path d="m9 12 2 2-2 2"/><path d="M14 16h3"/>',
  'omega-context-background': '<path d="M12 3s6 6.4 6 10a6 6 0 0 1-12 0c0-3.6 6-10 6-10z"/>',
  'omega-context-theme-light': '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5M17.5 17.5 19 19M19 5l-1.5 1.5M6.5 17.5 5 19"/>',
  'omega-context-theme-dark': '<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a7 7 0 1 0 10.5 10.5z"/>',
};

export function initializeChartContextActions(options: ChartContextActionsOptions): void {
  const {
    workspace,
    ensurePaperTrading,
    hasPendingPaperOrderAtPrice,
    getShowBidAskLines,
    setShowBidAskLines,
    getTheme,
    setTheme,
    getResetChartCandles,
    openChartSettings,
    openReplayControls,
    startReplayAt,
  } = options;

  for (const [id, pathData] of Object.entries(contextActionIcons)) {
    registerIcon(id, `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${pathData}</svg>`);
  }

  registerWidgetAction({
    id: 'omega-context-copy-price',
    target: 'context:body',
    label: 'Copy price',
    icon: 'omega-context-copy-price',
    order: -110,
    when: context => context.pointer?.paneKind === 'price'
      && Number.isFinite(context.pointer.price),
    run: async context => {
      const price = context.pointer?.price;
      if (price == null || !Number.isFinite(price)) return;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable.');
        await navigator.clipboard.writeText(String(price));
        context.toast(`Copied ${price} to clipboard.`, 'success');
      } catch (error) {
        console.error('Could not copy the chart price to the clipboard:', error);
        context.toast('Could not copy the chart price to the clipboard.', 'error');
      }
    },
  });
  registerWidgetAction({
    id: 'omega-context-cancel-pending-paper-order',
    target: 'context:body',
    label: 'Cancel pending paper order',
    icon: 'omega-context-cancel-order',
    order: -100,
    when: context => context.pointer?.paneKind === 'price'
      && Number.isFinite(context.pointer.price)
      && hasPendingPaperOrderAtPrice(context.chart, context.pointer?.price),
    run: async context => {
      const paperTrading = await ensurePaperTrading();
      if (!paperTrading.cancelPendingPaperOrderAtPrice(context.chart, context.pointer?.price)) {
        context.toast('No pending paper order was found at that price.', 'error');
      }
    },
  });
  registerWidgetAction({
    id: 'omega-context-add-pending-paper-order',
    target: 'context:body',
    label: 'Add pending paper order…',
    icon: 'omega-context-add-order',
    order: -99,
    when: context => context.pointer?.paneKind === 'price'
      && Number.isFinite(context.pointer.price)
      && Number(context.pointer.price) > 0
      && Boolean(context.symbol)
      && Boolean(context.chart.data.resolve(context.symbol)),
    run: async context => {
      const paperTrading = await ensurePaperTrading();
      paperTrading.openPendingOrderDialog(context.chart, context.pointer?.price);
    },
  });
  registerWidgetAction({
    id: 'omega-context-reset-view',
    target: 'context:body',
    label: 'Reset Chart',
    icon: 'omega-context-reset-view',
    order: -120,
    run: context => {
      const visibleBars = resetChartView(context.chart, getResetChartCandles());
      if (!visibleBars) {
        context.toast('There are no loaded candles to show yet.', 'info');
        return;
      }
      context.toast(`Showing the latest ${visibleBars} candles.`, 'success');
    },
  });
  const refreshingCharts = new WeakSet<VelaWorkspace['chart']>();
  registerWidgetAction({
    id: 'omega-context-refresh',
    target: 'context:body',
    label: 'Refresh Chart',
    icon: 'omega-context-refresh',
    order: -119,
    when: ({ chart }) => !refreshingCharts.has(chart) && !chart.replay.state.active,
    run: async context => {
      const { chart } = context;
      if (refreshingCharts.has(chart)) return;
      refreshingCharts.add(chart);
      try {
        await refreshChart(chart);
        const visibleBars = resetChartView(chart, getResetChartCandles());
        context.toast(visibleBars ? 'Chart refreshed.' : 'The refresh returned no candles.', visibleBars ? 'success' : 'info');
      } catch (error) {
        console.error('Could not refresh the chart:', error);
        context.toast('Could not refresh the chart.', 'error');
      } finally {
        refreshingCharts.delete(chart);
      }
    },
  });
  for (const enable of [true, false]) {
    registerWidgetAction({
      id: enable ? 'omega-context-enable-bid-ask' : 'omega-context-disable-bid-ask',
      target: 'context:body',
      label: enable ? 'Enable Bid/Ask lines' : 'Disable Bid/Ask lines',
      order: 119,
      when: () => getShowBidAskLines() !== enable,
      run: () => setShowBidAskLines(enable),
    });
  }
  const countdownBeforeHiding = new WeakMap<VelaWorkspace['chart'], boolean>();
  for (const enable of [true, false]) {
    registerWidgetAction({
      id: enable ? 'omega-context-enable-last-price' : 'omega-context-disable-last-price',
      target: 'context:body',
      label: enable ? 'Enable last-price line' : 'Disable last-price line',
      order: 119.5,
      when: ({ chart }) => (
        Boolean(chart.renderer.get('currentPriceLine'))
        || Boolean(chart.renderer.get('priceLabel'))
        || Boolean(chart.renderer.get('countdown'))
      ) !== enable,
      run: ({ chart }) => {
        const { renderer } = chart;
        if (!enable) countdownBeforeHiding.set(chart, Boolean(renderer.get('countdown')));
        renderer.set('currentPriceLine', enable);
        renderer.set('priceLabel', enable);
        renderer.set('countdown', enable && (countdownBeforeHiding.get(chart) ?? true));
      },
    });
  }
  registerWidgetAction({
    id: 'omega-context-background',
    target: 'context:body',
    label: 'Chart settings…',
    icon: 'omega-context-background',
    order: 120,
    when: () => true,
    run: context => {
      openChartSettings(context.chart);
    },
  });
  registerWidgetAction({
    id: 'omega-context-theme-light',
    target: 'context:body',
    label: 'Switch to Light theme',
    icon: 'omega-context-theme-light',
    order: 121,
    when: () => false,
    run: context => {
      setTheme('light');
      context.toast('Switched to Light theme.', 'success');
    },
  });
  registerWidgetAction({
    id: 'omega-context-theme-dark',
    target: 'context:body',
    label: 'Switch to Dark blue theme',
    icon: 'omega-context-theme-dark',
    order: 121,
    when: () => false,
    run: context => {
      setTheme('dark');
      context.toast('Switched to Dark blue theme.', 'success');
    },
  });
  registerWidgetAction({
    id: 'omega-context-pine-window',
    target: 'context:body',
    label: 'Open Pine Editor (standalone window)',
    icon: 'omega-context-pine',
    order: 122,
    // This used to be `() => false`, which registered the item but hid it everywhere. It is
    // shown whenever the standalone editor is actually reachable: the desktop window bridge,
    // or the docked editor's own "open in new window" button.
    when: () => {
      if (window.velaPineEditorWindow) return true;
      const button = document.getElementById('btn-open-standalone-editor') as HTMLButtonElement | null;
      return Boolean(button && !button.hidden);
    },
    run: context => {
      const button = document.getElementById('btn-open-standalone-editor') as HTMLButtonElement | null;
      if (button && !button.hidden) {
        button.click();
        return;
      }
      context.toast('The separate Pine Editor is available only in the Omega desktop app.', 'info');
    },
  });
  registerWidgetAction({
    id: 'omega-context-start-replay',
    target: 'context:body',
    label: 'Start replay from here',
    icon: 'omega-context-replay',
    order: 123,
    when: context => Number.isFinite(context.pointer?.time),
    run: context => {
      const from = context.pointer?.time;
      if (from == null || !Number.isFinite(from)) return;
      const cell = workspace.cells().find(candidate => candidate.chart === context.chart);
      if (!cell) {
        context.toast('Could not identify the chart for replay.', 'error');
        return;
      }
      openReplayControls();
      void startReplayAt(from, cell.id);
    },
  });
  registerWidgetAction({
    id: 'omega-context-open-replay',
    target: 'context:body',
    label: 'Open Replay',
    icon: 'omega-context-replay-panel',
    order: 124,
    run: openReplayControls,
  });
  initializeChartContextMenuPresentation();
}
