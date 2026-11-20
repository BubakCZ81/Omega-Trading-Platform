import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import type { ChartTabsController, ChartTabsState } from './chartTabs';
import type { ReplayControls } from './replayControls';
import { currentInternalStrategy } from './strategyBacktest';

export interface WorkspaceFeatureLoaderOptions {
  workspace: VelaWorkspace;
  tabsState: ChartTabsState;
  maxTabs: number;
  layoutId(count: number): string;
  isTabsLayout(layoutId: string): boolean;
  groupByCellId: Record<string, string>;
  groupColorHex: Record<string, string>;
  chartGridHost: HTMLElement;
  chartLayoutSelect: HTMLSelectElement;
  onReplayActiveChange(active: boolean): void;
}

export function createWorkspaceFeatureLoaders(options: WorkspaceFeatureLoaderOptions) {
  const chartTabsBar = document.getElementById('chart-tabs-bar') as HTMLElement;
  const chartTabsList = document.getElementById('chart-tabs-list') as HTMLElement;
  const chartTabsToggle = document.getElementById('chart-tabs-toggle') as HTMLButtonElement;
  const chartTabsAdd = document.getElementById('chart-tabs-add') as HTMLButtonElement;
  let chartTabsController: ChartTabsController | null = null;
  let chartTabsInitialization: Promise<ChartTabsController> | null = null;
  let replayControls: ReplayControls | null = null;
  let replayControlsInitialization: Promise<ReplayControls> | null = null;

  function ensureChartTabs(): Promise<ChartTabsController> {
    if (chartTabsController) return Promise.resolve(chartTabsController);
    if (!chartTabsInitialization) {
      chartTabsInitialization = import('./chartTabs')
        .then(({ initializeChartTabs }) => {
          chartTabsController = initializeChartTabs({
            workspace: options.workspace,
            state: options.tabsState,
            maxTabs: options.maxTabs,
            layoutId: options.layoutId,
            isTabsLayout: options.isTabsLayout,
            groupByCellId: options.groupByCellId,
            groupColorHex: options.groupColorHex,
            chartGridHost: options.chartGridHost,
            chartLayoutSelect: options.chartLayoutSelect,
            chartTabsBar,
            chartTabsList,
            chartTabsToggle,
            chartTabsAdd,
          });
          chartTabsController.render();
          return chartTabsController;
        })
        .catch(error => {
          chartTabsInitialization = null;
          throw error;
        });
    }
    return chartTabsInitialization;
  }

  function renderChartTabs(): void {
    chartTabsController?.render();
  }

  function setChartTabsEnabled(enabled: boolean): void {
    void ensureChartTabs().then(controller => controller.setEnabled(enabled)).catch(error => {
      console.error('Could not initialize chart tabs:', error);
      options.workspace.toast('Chart tabs could not be loaded.', 'error');
    });
  }

  function ensureReplayControls(): Promise<ReplayControls> {
    if (replayControls) return Promise.resolve(replayControls);
    if (!replayControlsInitialization) {
      replayControlsInitialization = import('./replayControls')
        .then(({ initializeReplayControls }) => {
          const controls = initializeReplayControls(options.workspace, options.onReplayActiveChange);
          if (!controls) throw new Error('Replay controls are missing from the page.');
          replayControls = controls;
          return controls;
        })
        .catch(error => {
          replayControlsInitialization = null;
          throw error;
        });
    }
    return replayControlsInitialization;
  }

  function openReplayControls(): void {
    void ensureReplayControls().then(controls => controls.open()).catch(error => {
      console.error('Could not initialize Replay:', error);
      options.workspace.toast('Replay could not be loaded.', 'error');
    });
  }

  async function startReplayAt(from: number, cellId?: string): Promise<void> {
    const controls = await ensureReplayControls();
    await controls.startAt(from, cellId);
  }

  async function openVisualBacktest(): Promise<void> {
    const sourceChart = options.workspace.active?.chart;
    const symbol = sourceChart?.market.symbol;
    const timeframe = sourceChart?.market.timeframe;
    if (window.velaVisualBacktestWindow && symbol && timeframe) {
      const resolved = sourceChart.data.resolve(symbol);
      const strategy = currentInternalStrategy((sourceChart.indicators?.() ?? []) as Array<{ source?: unknown; title?: unknown; id?: unknown }>);
      const opened = await window.velaVisualBacktestWindow.open({ symbol, timeframe, provider: resolved?.provider, strategy: strategy ?? undefined });
      if (!opened) throw new Error('Visual Backtest window could not be opened.');
      return;
    }
    throw new Error('Visual Backtest is available only in the Omega desktop window.');
  }

  return {
    ensureChartTabs,
    renderChartTabs,
    setChartTabsEnabled,
    ensureReplayControls,
    openReplayControls,
    startReplayAt,
    openVisualBacktest,
  };
}
