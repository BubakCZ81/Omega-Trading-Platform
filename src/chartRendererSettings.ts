import type { VelaWorkspace } from './platform';
import {
  BID_ASK_COLOR_OPTIONS,
  BID_ASK_STYLE_OPTIONS,
  BID_ASK_WIDTH_OPTIONS,
  type BidAskLineStyle,
} from './bidAskLines';
import { getMarketFlowStyle, setMarketFlowStyle } from './marketFlowPane';
import { reportCaughtError } from './diagnostics';
import { isOmegaTheme, OMEGA_THEME_CHOICES, type OmegaTheme } from './themeControls';
import type { ChartTabsState } from './chartTabs';
import type { TopPanelMode } from './topPanelMode';
import { MAX_CHART_HISTORY_BARS } from './chartHistoryDepth';

export interface ChartRendererSettingsOptions {
  getWorkspace(): VelaWorkspace;
  chartTabsState: ChartTabsState;
  groupByCellId: Record<string, string>;
  isChartTabsLayout(layoutId: string): boolean;
  setChartTabsEnabled(enabled: boolean): void;
  setCellGroup(cellId: string, group: string): unknown;
  getTheme(): OmegaTheme;
  setTheme(theme: OmegaTheme): void;
  getTopPanelMode(): TopPanelMode;
  setTopPanelMode(mode: TopPanelMode): void;
  getToolbarAutoFitEnabled(): boolean;
  setToolbarAutoFitEnabled(enabled: boolean): void;
  getBarThickness(): number;
  setBarThickness(value: number): void;
  getLockPriceToBarRatio(): boolean;
  setLockPriceToBarRatio(enabled: boolean): void;
  getWheelZoomMode(): 'time' | 'price' | 'both';
  setWheelZoomMode(mode: 'time' | 'price' | 'both'): void;
  getShowBidAskLines(): boolean;
  setShowBidAskLines(enabled: boolean): void;
  getBidAskLineStyle(): BidAskLineStyle;
  setBidAskLineStyle(style: Partial<BidAskLineStyle>): void;
  setLoadedBars(cellId: string, bars: number): void;
}

const registeredCharts = new WeakSet<object>();
/** Per-chart handle that re-applies the settings sections on demand. */
const settingsSectionAppliers = new WeakMap<object, () => void>();

/**
 * Re-apply a chart's settings sections.
 *
 * Call this immediately before opening the settings dialog: the sections were registered
 * once when the chart was created, and a dialog opened later could otherwise show a partial
 * list — the recurring "half of the settings are missing" report.
 */
export function reapplyChartSettingsSections(chart: VelaWorkspace['chart']): void {
  settingsSectionAppliers.get(chart)?.();
}
const guardedDataWindowRenderers = new WeakSet<object>();

/**
 * Vela's built-in Data Window asks the renderer for a readout on every crosshair move and
 * on every bar update. When one indicator model cannot produce a row, that readout throws
 * inside Vela's own event handler, so the failure is re-raised for every mouse move and the
 * platform appears to freeze or crash as soon as the panel is open.
 *
 * Wrapping the documented readout seam keeps such a failure local and cheap: the panel
 * reports "no data" once, instead of taking the chart's event loop down with it.
 */
function guardDataWindowReadout(chart: VelaWorkspace['chart']): void {
  const renderer = chart.renderer as unknown as { dataWindowReadout?: () => unknown } | null;
  if (!renderer || typeof renderer.dataWindowReadout !== 'function') return;
  if (guardedDataWindowRenderers.has(renderer)) return;
  guardedDataWindowRenderers.add(renderer);
  const original = renderer.dataWindowReadout.bind(chart.renderer);
  let warned = false;
  renderer.dataWindowReadout = () => {
    try {
      return original();
    } catch (error) {
      if (!warned) {
        warned = true;
        const message = error instanceof Error ? error.message : String(error);
        console.error('Data Window readout failed; the panel will show no data instead of freezing the platform:', error);
        window.velaDiagnostics?.record({
          source: 'data-window', type: 'panel', name: 'readout', status: 'error', message,
        });
      }
      return null;
    }
  };
}

export function registerChartRendererSettings(
  chart: VelaWorkspace['chart'],
  options: ChartRendererSettingsOptions,
): void {
  if (registeredCharts.has(chart)) return;
  guardDataWindowReadout(chart);
  const {
    getWorkspace,
    chartTabsState,
    groupByCellId,
    isChartTabsLayout,
    setChartTabsEnabled,
    setCellGroup,
    getTheme,
    setTheme,
    getTopPanelMode,
    setTopPanelMode,
    getToolbarAutoFitEnabled,
    setToolbarAutoFitEnabled,
    getBarThickness,
    setBarThickness,
    getLockPriceToBarRatio,
    setLockPriceToBarRatio,
    getWheelZoomMode,
    setWheelZoomMode,
    getShowBidAskLines,
    setShowBidAskLines,
    getBidAskLineStyle,
    setBidAskLineStyle,
    setLoadedBars,
  } = options;
  const workspace = getWorkspace();
  const settingsCellId = () => workspace.cells().find(cell => cell.chart === chart)?.id ?? workspace.active.id;
  const bidAskColorOptions = BID_ASK_COLOR_OPTIONS.map(([color, label]) => [color, label] as const);
  const marketFlowFontOptions = [10, 11, 12, 13, 14, 16, 18].map(size => [String(size), `${size}px`] as const);
  const marketFlowSettings = (view: 'time-sales' | 'dom', title: string) => {
    const colorRows = [
      ['background', 'Panel background'],
      ['text', 'Text'],
      ['buy', 'Buy / bid'],
      ['sell', 'Sell / ask'],
      ['grid', 'Grid and separators'],
    ] as const;
    return {
      title,
      id: `omega-${view}-appearance`,
      rows: [
        {
          kind: 'select' as const,
          label: 'Font size',
          options: marketFlowFontOptions,
          get: () => String(getMarketFlowStyle(view).fontSize),
          set: (value: string) => setMarketFlowStyle(view, 'fontSize', value),
        },
        ...colorRows.map(([key, label]) => ({
          kind: 'color' as const,
          label,
          get: () => getMarketFlowStyle(view)[key],
          set: (value: string) => setMarketFlowStyle(view, key, value),
        })),
      ],
    };
  };
  const bidAskWidthOptions = BID_ASK_WIDTH_OPTIONS.map(width => [String(width), `${width}px`] as const);
  const settingsSections = [
    {
      title: 'Safeguards',
      id: 'omega-safeguards',
      rows: [{
        kind: 'heading',
        label: 'Provider capabilities, live-order protections, and offline scenarios',
      }],
    },
    {
      title: 'Workspace',
      id: 'omega-workspace',
      rows: [
        {
          kind: 'select',
          label: 'Layout',
          options: [['1', '1 chart'], ['2h', '2 charts — side by side'], ['2v', '2 charts — stacked'], ['4', '4 charts']],
          get: () => isChartTabsLayout(workspace.layout.id) ? '1' : workspace.layout.id,
          set: (layout: string) => {
            if (isChartTabsLayout(workspace.layout.id)) setChartTabsEnabled(false);
            workspace.setLayout(layout);
          },
        },
        {
          kind: 'toggle',
          label: 'Chart tabs',
          get: () => chartTabsState.enabled,
          set: (enabled: boolean) => setChartTabsEnabled(enabled),
        },
        {
          kind: 'select',
          label: 'Active chart group',
          options: [['', 'None'], ['red', 'Red'], ['blue', 'Blue'], ['green', 'Green'], ['yellow', 'Yellow'], ['purple', 'Purple']],
          get: () => groupByCellId[settingsCellId()] ?? '',
          set: (group: string) => { void setCellGroup(settingsCellId(), group); },
        },
        {
          kind: 'select',
          label: 'Workspace file',
          options: [['idle', 'Choose action…'], ['save', 'Save workspace…'], ['load', 'Load workspace…']],
          get: () => 'idle',
          set: (action: string) => {
            if (action === 'save') document.getElementById('workspace-save-profile')?.click();
            if (action === 'load') document.getElementById('workspace-load-profile')?.click();
          },
        },
      ],
    },
    {
      title: 'Appearance',
      id: 'omega-appearance',
      rows: [
        {
          kind: 'select',
          label: 'Platform theme',
          options: OMEGA_THEME_CHOICES,
          get: getTheme,
          set: (theme: string) => setTheme(isOmegaTheme(theme) ? theme : 'dark'),
        },
        {
          kind: 'select',
          label: 'Top panel size',
          options: [['classic', 'Classic — compact'], ['large', 'Large — readable controls']],
          get: getTopPanelMode,
          set: (mode: string) => setTopPanelMode(mode === 'large' ? 'large' : 'classic'),
        },
        {
          kind: 'toggle',
          label: 'Auto-fit toolbar to window',
          get: getToolbarAutoFitEnabled,
          set: (enabled: boolean) => setToolbarAutoFitEnabled(enabled),
        },
        {
          kind: 'color',
          label: 'Chart background',
          get: () => (chart.renderer.getConfig() as { layout?: { background?: string } }).layout?.background ?? localStorage.getItem('omega:chart-background') ?? '#101d30',
          set: (background: string) => {
            try {
              localStorage.setItem('omega:chart-background', background);
              document.documentElement.style.setProperty('--omega-chart-bg', background);
            } catch (error) {
              reportCaughtError('chart-renderer:save-background', error);
            }
            chart.renderer.applyConfig({ layout: { background } });
            document.dispatchEvent(new CustomEvent('omega:chart-background-changed', { detail: background }));
          },
        },
        {
          kind: 'color',
          label: 'Price axis text color',
          get: () => {
            const config = chart.renderer.getConfig() as { layout?: { textColor?: string } };
            return config.layout?.textColor ?? (getTheme() === 'dark' ? '#f1f6ff' : '#0f1c2c');
          },
          set: (textColor: string) => {
            localStorage.setItem('omega:price-axis-text-color', textColor);
            chart.renderer.applyConfig({ layout: { textColor } });
            document.dispatchEvent(new CustomEvent('omega:price-axis-text-color-changed', { detail: textColor }));
          },
        },
      ],
    },
    marketFlowSettings('time-sales', 'Time & Sales'),
    marketFlowSettings('dom', 'DOM'),
    {
      title: 'Market data',
      id: 'market-data',
      rows: [{
        kind: 'select',
        label: 'Candles to load',
        options: [
          ['500', '500'], ['1000', '1,000'], ['3000', '3,000'], ['5000', '5,000'],
          ['10000', '10,000'], ['15000', '15,000'], ['20000', '20,000'], ['25000', '25,000'],
          ['30000', '30,000'], ['40000', '40,000'], ['50000', '50,000'],
          ['100000', '100,000'], ['150000', '150,000'], [String(MAX_CHART_HISTORY_BARS), '200,000'],
        ],
        get: () => String(chart.market.bars ?? 3000),
        set: (value: string) => {
          const bars = Number(value);
          if (!Number.isSafeInteger(bars) || bars < 1 || bars > MAX_CHART_HISTORY_BARS) return;
          setLoadedBars(settingsCellId(), bars);
          void chart.setMarket({ bars });
        },
      }],
    },
    {
      title: 'Bar thickness',
      id: 'bar-thickness',
      rows: [{
        kind: 'select',
        label: 'Candle body width',
        options: ['15%', '25%', '35%', '45%', '55%', '65%', '75%', '85%', '95%', '100%'].map(value => [value, value] as const),
        get: () => `${Math.round(getBarThickness() * 100)}%`,
        set: (value: string) => setBarThickness(Number.parseInt(value, 10) / 100),
      }],
    },
    {
      title: 'Scale',
      id: 'price-bar-ratio',
      rows: [
        {
          kind: 'toggle',
          label: 'Lock price to bar ratio',
          get: getLockPriceToBarRatio,
          set: setLockPriceToBarRatio,
        },
        {
          kind: 'select',
          label: 'Mouse-wheel zoom',
          options: [
            ['time', 'Time axis — keep vertical scale'],
            ['price', 'Price axis — keep candle spacing'],
            ['both', 'Both axes - proportional zoom'],
          ],
          get: getWheelZoomMode,
          set: (mode: string) => setWheelZoomMode(mode === 'price' || mode === 'both' ? mode : 'time'),
        },
      ],
    },
    {
      title: 'Price lines',
      id: 'price-lines',
      rows: [
        {
          kind: 'toggle',
          label: 'Show bid and ask lines',
          get: getShowBidAskLines,
          set: setShowBidAskLines,
        },
        {
          kind: 'select',
          label: 'Bid line color',
          options: bidAskColorOptions,
          get: () => getBidAskLineStyle().bidColor,
          set: (bidColor: string) => setBidAskLineStyle({ bidColor }),
        },
        {
          kind: 'select',
          label: 'Ask line color',
          options: bidAskColorOptions,
          get: () => getBidAskLineStyle().askColor,
          set: (askColor: string) => setBidAskLineStyle({ askColor }),
        },
        {
          kind: 'select',
          label: 'Line width',
          options: bidAskWidthOptions,
          get: () => String(getBidAskLineStyle().lineWidth),
          set: (lineWidth: string) => setBidAskLineStyle({ lineWidth: Number(lineWidth) }),
        },
        {
          kind: 'select',
          label: 'Line style',
          options: BID_ASK_STYLE_OPTIONS,
          get: () => getBidAskLineStyle().lineStyle,
          set: (lineStyle: string) => setBidAskLineStyle({ lineStyle: lineStyle as BidAskLineStyle['lineStyle'] }),
        },
      ],
    },
  ];
  chart.renderer.setSettingsSections(settingsSections);
  // Keep a re-apply handle per chart. The dialog is opened later, often after other modules
  // have added sections of their own; re-applying before opening guarantees the operator
  // never sees a settings menu with sections missing.
  settingsSectionAppliers.set(chart, () => chart.renderer.setSettingsSections(settingsSections));
  registeredCharts.add(chart);
}
