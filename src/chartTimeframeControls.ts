import { applyTimeframe, timeframeInputState } from './timeframeSelection';
import { formatTimeframeLabel } from './chartViewLabel';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { timeframeToMs } from './platform';
import { DEFAULT_RESET_CHART_CANDLES, resetChartView } from './chartReset';

type PeriodChoice = { label: string; timeframe?: string; style: string; disabled?: boolean };

function formatTimeframeError(error: unknown, timeframe: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unsupported\s+timeframe/i.test(message)) {
    return `Unsupported Quantower timeframe: ${formatTimeframeLabel(timeframe)}`;
  }
  return `Could not load timeframe: ${message}`;
}

export function initializeChartTimeframeControls(
  workspace: VelaWorkspace,
  options: { getResetChartCandles?: () => number } = {},
): { sync(): void } {
  const customTimeframeMenu = document.getElementById('custom-timeframe-menu') as HTMLDetailsElement;
  const customTimeframeValue = document.getElementById('custom-timeframe-value') as HTMLInputElement;
  const customTimeframeUnit = document.getElementById('custom-timeframe-unit') as HTMLSelectElement;
  const timeframeHelp = document.getElementById('timeframe-help') as HTMLElement;
  const applyTimeframeButton = document.getElementById('apply-custom-timeframe') as HTMLButtonElement;
  const ctraderTimeframeMenu = document.getElementById('ctrader-timeframe-menu') as HTMLDetailsElement;
  const ctraderTimeframeGrid = document.getElementById('ctrader-timeframe-grid') as HTMLElement;
  let initialFootprintViewApplied = false;
  const FOOTPRINT_STARTUP_CANDLES = 5;

  const resetAfterTimeframe = (cell: ReturnType<typeof workspace.cell> | undefined): void => {
    if (!cell) return;
    resetChartView(cell.chart, options.getResetChartCandles?.() ?? DEFAULT_RESET_CHART_CANDLES);
  };

  const fitFootprintView = (cell: ReturnType<typeof workspace.cell> | undefined): boolean => {
    if (!cell) return false;
    const chart = cell.chart;
    // `market.bars` is the requested history depth, not proof that bars are loaded.
    // Waiting for replay bounds prevents an early no-op from marking startup fit done.
    const bounds = chart.replay.bounds;
    if (!bounds || !Number.isFinite(bounds.first) || !Number.isFinite(bounds.last) || bounds.last <= bounds.first) return false;
    chart.renderer.set('autoScale', true);
    const timeframe = chart.market.timeframe ?? '5';
    const isEventBased = /^(?:R\d+|RG\d+|RANGE\d+|RATR|T\d+)$/i.test(timeframe);
    const configuredBars = Math.max(0, Math.floor(Number(chart.market.bars) || 0));
    const rangeSpan = bounds.last - bounds.first;
    // Renko, range and tick bars are irregular events; interpreting R5 as five
    // minutes can put hundreds of event bars into a five-candle startup view.
    // Estimate their interval from the actual loaded history instead.
    const eventBarInterval = configuredBars > 1 ? rangeSpan / (configuredBars - 1) : Number.NaN;
    const duration = isEventBased && Number.isFinite(eventBarInterval) && eventBarInterval > 0
      ? eventBarInterval
      : timeframeToMs(timeframe);
    const latest = bounds.last;
    if (!Number.isFinite(duration) || duration <= 0) return false;
    const loadedBars = Math.max(1, Math.floor((bounds.last - bounds.first) / duration) + 1);
    const visibleBars = Math.min(loadedBars, FOOTPRINT_STARTUP_CANDLES);
    const range = {
      from: latest - duration * (visibleBars - 0.5),
      to: latest + duration * 0.5,
    };
    chart.setVisibleRange(range);
    const applied = chart.getVisibleRange();
    return Boolean(applied && applied.to - applied.from <= duration * (FOOTPRINT_STARTUP_CANDLES + 1));
  };

  const sync = (): void => {
    const timeframe = workspace.chart.market.timeframe ?? '60';
    customTimeframeMenu.querySelector('summary')!.textContent = formatTimeframeLabel(timeframe);
    const input = timeframeInputState(timeframe);
    if (input) {
      customTimeframeValue.value = String(input.value);
      customTimeframeUnit.value = input.unit;
    }
    const style = workspace.chart.renderer.get('priceStyle');
    const styleLabel = typeof style === 'string' && style !== 'candles'
      ? (style === 'heikinashi' ? `Heikin ${formatTimeframeLabel(timeframe)}` : style[0].toUpperCase() + style.slice(1))
      : formatTimeframeLabel(timeframe);
    const summary = ctraderTimeframeMenu.querySelector('summary')!;
    summary.textContent = 'Timeframe';
    summary.title = `Chart timeframe: ${styleLabel}`;
    summary.setAttribute('aria-label', `Chart timeframe: ${styleLabel}. Choose a period or chart view.`);
    for (const button of ctraderTimeframeGrid.querySelectorAll<HTMLButtonElement>('button[data-style]')) {
      const selected = button.dataset.style === style && button.dataset.timeframe === timeframe;
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    }
  };

  const setChartStyle = async (cell: ReturnType<typeof workspace.cell> | undefined, style: string): Promise<void> => {
    if (!cell) return;
    const enteringFootprint = style === 'footprint';
    if (enteringFootprint) initialFootprintViewApplied = false;
    cell.chart.renderer.set('priceStyle', style);
    if (enteringFootprint) {
      const apply = () => {
        initialFootprintViewApplied = fitFootprintView(cell);
      };
      apply();
      requestAnimationFrame(apply);
      window.setTimeout(apply, 120);
    }
  };

  const updateChartStyleHelp = (_cell: ReturnType<typeof workspace.cell> | undefined, _style: string): void => {
    delete timeframeHelp.dataset.state;
    timeframeHelp.textContent = '';
  };

  const standardPeriods: PeriodChoice[] = [
    ['1 minute', '1'], ['2 minutes', '2'], ['3 minutes', '3'], ['4 minutes', '4'], ['5 minutes', '5'], ['6 minutes', '6'], ['7 minutes', '7'], ['8 minutes', '8'], ['10 minutes', '10'], ['15 minutes', '15'], ['20 minutes', '20'], ['30 minutes', '30'], ['45 minutes', '45'], ['1 hour', '60'], ['2 hours', '120'], ['3 hours', '180'], ['4 hours', '240'], ['6 hours', '360'], ['8 hours', '480'], ['12 hours', '720'], ['1 day', 'D'], ['1 week', 'W'],
  ].map(([label, timeframe]) => ({ label, timeframe, style: 'candles' }));
  const tickSizes = [
    1, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 30, 50, 75, 100, 150, 200, 250, 300,
    400, 500, 750, 1000, 1500, 2000, 3000, 5000, 10000,
  ];

  const addPeriodColumn = (title: string, prefix: string, choices: PeriodChoice[]): void => {
    const column = document.createElement('section');
    column.className = 'ctrader-timeframe-column';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const list = document.createElement('div');
    list.className = 'ctrader-timeframe-list';
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = Boolean(choice.disabled);
      button.dataset.style = choice.style;
      if (choice.timeframe) button.dataset.timeframe = choice.timeframe;
      const key = document.createElement('kbd');
      key.textContent = prefix;
      button.append(key, document.createTextNode(choice.label));
      button.addEventListener('click', async () => {
        const cell = workspace.cell(workspace.active.id);
        if (!cell) return;
        window.velaDiagnostics?.record({
          source: 'timeframe', type: 'selection', name: 'timeframe.selected', status: 'start',
          message: `${choice.style} ${choice.timeframe ?? 'unknown'}`,
        });
        if (choice.timeframe?.startsWith('T') && cell.chart.data.resolve(cell.chart.market.symbol ?? '')?.provider !== 'mt5') {
          timeframeHelp.textContent = 'Tick bars are currently supported for connected MetaTrader 5 symbols only.';
          timeframeHelp.dataset.state = 'error';
          return;
        }
        if (choice.timeframe) {
          try {
            const actualTimeframe = await applyTimeframe(cell.chart, choice.timeframe);
            if (actualTimeframe !== choice.timeframe) {
            timeframeHelp.textContent = `Could not load ${formatTimeframeLabel(choice.timeframe)} bars; the chart is still showing ${formatTimeframeLabel(actualTimeframe)}.`;
            timeframeHelp.dataset.state = 'error';
            window.velaDiagnostics?.record({ source: 'timeframe', type: 'selection', name: 'timeframe.rejected', status: 'error', message: timeframeHelp.textContent });
            return;
            }
            timeframeHelp.textContent = `Showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
            delete timeframeHelp.dataset.state;
          } catch (error) {
            timeframeHelp.textContent = formatTimeframeError(error, choice.timeframe);
            timeframeHelp.dataset.state = 'error';
            window.velaDiagnostics?.record({ source: 'timeframe', type: 'selection', name: 'timeframe.failed', status: 'error', message: timeframeHelp.textContent });
            return;
          }
        }
        try {
          await setChartStyle(cell, choice.style);
        } catch (error) {
          timeframeHelp.textContent = error instanceof Error ? error.message : String(error);
          timeframeHelp.dataset.state = 'error';
          return;
        }
        resetAfterTimeframe(cell);
        updateChartStyleHelp(cell, choice.style);
        ctraderTimeframeMenu.open = false;
        sync();
        window.velaDiagnostics?.record({ source: 'timeframe', type: 'selection', name: 'timeframe.applied', status: 'ok', message: `${choice.style} ${cell.chart.market.timeframe ?? 'unknown'}` });
      });
      list.append(button);
    }
    column.append(heading, list);
    ctraderTimeframeGrid.append(column);
  };

  addPeriodColumn('Standard', 'M', standardPeriods);
  addPeriodColumn('Tick', 'T', tickSizes.map(value => ({
    label: `${value} ticks`, timeframe: `T${value}`, style: 'candles',
  })));
  const renkoPipSizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 75, 100];
  const rangePipSizes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 40, 50, 75, 100];
  addPeriodColumn('Renko', 'R', [
    { label: 'Automatic ATR', timeframe: 'RATR', style: 'candles' },
    ...renkoPipSizes.map(value => ({ label: `${value} pips`, timeframe: `R${value}`, style: 'candles' })),
  ]);
  addPeriodColumn('Range', 'RG', rangePipSizes.map(value => ({
    label: `${value} pips`, timeframe: `RG${value}`, style: 'candles',
  })));
  addPeriodColumn('Heikin Ashi', 'H', standardPeriods.map(item => ({ ...item, style: 'heikinashi' })));
  addPeriodColumn('Time At Price', 'TAP', standardPeriods.map(item => ({ ...item, style: 'tpo' })));
  addPeriodColumn('Footprint', 'FP', standardPeriods.map(item => ({ ...item, style: 'footprint' })));

  applyTimeframeButton.addEventListener('click', async () => {
    const amount = Number(customTimeframeValue.value);
    const unit = customTimeframeUnit.value;
    if (!Number.isSafeInteger(amount) || amount < 1) {
      timeframeHelp.textContent = 'Enter a positive whole number.';
      return;
    }
    const targetCell = workspace.cell(workspace.active.id);
    if (!targetCell) {
      timeframeHelp.textContent = 'Could not find the active chart.';
      return;
    }
    let timeframe: string;
    if (unit === 'ticks') {
      if (targetCell.chart.data.resolve(targetCell.chart.market.symbol ?? '')?.provider !== 'mt5') {
        timeframeHelp.textContent = 'Tick bars are currently supported for connected MetaTrader 5 symbols only.';
        timeframeHelp.dataset.state = 'error';
        return;
      }
      if (amount > 10_000) {
        timeframeHelp.textContent = 'Choose no more than 10,000 ticks per bar.';
        timeframeHelp.dataset.state = 'error';
        return;
      }
      timeframe = `T${amount}`;
    } else if (unit === 'atr-renko') {
      timeframe = 'RATR';
    } else if (unit === 'renko') {
      if (amount > 3000) {
        timeframeHelp.textContent = 'Choose no more than 3,000 pips per Renko brick.';
        timeframeHelp.dataset.state = 'error';
        return;
      }
      timeframe = `R${amount}`;
    } else if (unit === 'range') {
      if (amount > 3000) {
        timeframeHelp.textContent = 'Choose no more than 3,000 pips per Range bar.';
        timeframeHelp.dataset.state = 'error';
        return;
      }
      timeframe = `RG${amount}`;
    } else {
      const multiplier = unit === 'hours' ? 60 : unit === 'days' ? 1440 : 1;
      const maxMinutes = unit === 'days' ? 30 * 1440 : unit === 'hours' ? 24 * 60 : 1440;
      const minutes = amount * multiplier;
      if (!Number.isSafeInteger(minutes) || minutes > maxMinutes) {
        timeframeHelp.textContent = `Choose an interval no larger than ${unit === 'days' ? '30 days' : unit === 'hours' ? '24 hours' : '1,440 minutes'}.`;
        return;
      }
      timeframe = unit === 'days' && amount === 1 ? 'D' : String(minutes);
    }
    applyTimeframeButton.disabled = true;
    timeframeHelp.textContent = 'Loading timeframe…';
    try {
      const actualTimeframe = await applyTimeframe(targetCell.chart, timeframe);
      resetAfterTimeframe(targetCell);
      sync();
      if (actualTimeframe !== timeframe) {
        timeframeHelp.textContent = `Timeframe change did not complete. The chart is still showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
        timeframeHelp.dataset.state = 'error';
      } else {
        timeframeHelp.textContent = `Showing ${formatTimeframeLabel(actualTimeframe)} bars.`;
        delete timeframeHelp.dataset.state;
        customTimeframeMenu.open = false;
      }
    } catch (error) {
      sync();
      timeframeHelp.textContent = formatTimeframeError(error, timeframe);
      timeframeHelp.dataset.state = 'error';
    } finally {
      applyTimeframeButton.disabled = false;
    }
  });

  workspace.chart.on('priceStyle:change', event => {
    if (event.to === 'footprint') {
      initialFootprintViewApplied = false;
      const cell = workspace.cell(workspace.active.id);
      const apply = () => {
        if (!initialFootprintViewApplied) initialFootprintViewApplied = fitFootprintView(cell);
      };
      apply();
      requestAnimationFrame(apply);
      window.setTimeout(apply, 120);
    }
  });

  const applyInitialFootprintView = () => {
    if (initialFootprintViewApplied || workspace.chart.renderer.get('priceStyle') !== 'footprint') return;
    const cell = workspace.cell(workspace.active.id);
    const apply = () => {
      if (fitFootprintView(cell)) initialFootprintViewApplied = true;
    };
    apply();
    requestAnimationFrame(apply);
    window.setTimeout(apply, 160);
  };
  workspace.chart.on('load:end', applyInitialFootprintView);
  workspace.chart.on('history:complete', applyInitialFootprintView);
  workspace.chart.on('market:changed', () => {
    initialFootprintViewApplied = false;
    applyInitialFootprintView();
  });

  sync();
  applyInitialFootprintView();
  return { sync };
}
