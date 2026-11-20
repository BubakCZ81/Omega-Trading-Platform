import { timeframeToMs } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';
import { historyPreloadTarget } from './chartHistoryDepth.ts';

type LoadedBarCount = { loaded: number; target: number };

export class LoadedBarsController {
  private readonly workspace: VelaWorkspace;
  private readonly listeners = new Map<string, Array<() => void>>();
  private readonly counts = new Map<string, LoadedBarCount>();
  private readonly label = document.getElementById('bottom-loaded-bars');
  private readonly connectionStatus = document.getElementById('terminal-connection-status');
  private readonly connectionLabel = document.getElementById('terminal-connection-label');
  private readonly formatter = new Intl.NumberFormat();

  constructor(workspace: VelaWorkspace) {
    this.workspace = workspace;
    document.addEventListener('omega:trading-broker-connected', () => this.render());
    document.addEventListener('omega:trading-broker-disconnected', () => this.render());
    document.addEventListener('omega:trading-broker-connecting', () => this.render());
  }

  public render(): void {
    const cellId = this.workspace.active?.id;
    const entry = cellId ? this.counts.get(cellId) : undefined;
    const chart = this.workspace.active?.chart;
    const hasProvider = Boolean(chart?.data.providers().length);
    const loadedBars = entry?.loaded ?? 0;
    const waitingForData = Boolean(chart && !chart.market.offline && loadedBars === 0);
    if (this.connectionStatus) {
      this.connectionStatus.dataset.state = !hasProvider ? 'disconnected' : waitingForData ? 'waiting' : 'connected';
    }
    if (this.connectionLabel) {
      this.connectionLabel.textContent = !hasProvider
        ? 'No feed connected'
        : waitingForData
          ? 'Feed connected · waiting for data'
          : 'Feed connected';
    }
    if (!this.label) return;
    if (!entry) {
      this.label.textContent = 'Loaded Bars: loading…';
      this.label.title = 'Chart history is loading.';
      return;
    }
    const loaded = this.formatter.format(entry.loaded);
    const target = Math.max(0, entry.target);
    this.label.textContent = target > entry.loaded
      ? `Loaded Bars: ${loaded} / ${this.formatter.format(target)}`
      : `Loaded Bars: ${loaded}`;
    this.label.title = `${loaded} chart bars loaded${target > entry.loaded ? ` of ${this.formatter.format(target)} requested` : ''}.`;
  }

  public set(cellId: string, loaded: number, target?: number): void {
    const safeLoaded = Math.max(0, Math.floor(loaded));
    const existing = this.counts.get(cellId);
    const chart = this.workspace.cell(cellId)?.chart;
    this.counts.set(cellId, {
      loaded: safeLoaded,
      target: Math.max(safeLoaded, Math.floor(target ?? existing?.target ?? chart?.market.bars ?? safeLoaded)),
    });
    if (this.workspace.active?.id === cellId) this.render();
  }

  public watch(cellId: string): void {
    if (this.listeners.has(cellId)) return;
    const cell = this.workspace.cell(cellId);
    if (!cell) return;
    const target = Math.max(0, Number(cell.chart.market.bars) || 0);
    let extendingHistory = false;
    let exhaustedBoundary = '';
    let previousViewport = cell.chart.getVisibleRange();
    let historyLoading = false;
    let pendingPan = false;
    const boundaryKey = (oldest: number): string => {
      const { symbol, timeframe, session } = cell.chart.market;
      return JSON.stringify([symbol, timeframe, session, oldest]);
    };
    const maybeExtendHistory = (range: { from: number; to: number }): void => {
      const market = cell.chart.market;
      const oldest = cell.chart.replay.bounds?.first;
      if (market.offline || !market.symbol || !market.timeframe || oldest === undefined
        || cell.chart.replay.state.active) return;
      if (extendingHistory || historyLoading) {
        pendingPan = true;
        return;
      }
      const boundary = boundaryKey(oldest);
      if (boundary === exhaustedBoundary) return;
      const loaded = this.counts.get(cellId)?.loaded ?? 0;
      const requested = Math.max(1, Number(market.bars) || 500);
      const nextTarget = historyPreloadTarget(range, oldest, timeframeToMs(market.timeframe), loaded, requested);
      if (nextTarget === undefined) return;
      extendingHistory = true;
      this.set(cellId, loaded, nextTarget);
      void cell.chart.setMarket({ bars: nextTarget })
        .then(() => cell.chart.historyComplete())
        .catch(error => {
          console.error(`Could not load older chart history for ${market.symbol}:`, error);
        })
        .finally(() => {
          extendingHistory = false;
          if (!this.listeners.has(cellId) || !pendingPan || !previousViewport) return;
          pendingPan = false;
          maybeExtendHistory(previousViewport);
        });
    };
    this.set(cellId, 0, target);
    this.listeners.set(cellId, [
      cell.chart.on('load:start', () => {
        historyLoading = true;
        exhaustedBoundary = '';
        previousViewport = null;
        pendingPan = false;
      }),
      cell.chart.on('load:end', event => {
        this.set(cellId, event.bars, Number(cell.chart.market.bars) || event.bars);
      }),
      cell.chart.on('history:progress', event => {
        historyLoading = true;
        this.set(cellId, event.loaded, event.target);
      }),
      cell.chart.on('history:complete', event => {
        historyLoading = false;
        if (extendingHistory && event.reason === 'genesis') exhaustedBoundary = boundaryKey(event.oldestTime);
        this.set(cellId, event.barsLoaded, Number(cell.chart.market.bars) || event.barsLoaded);
        if (!extendingHistory && pendingPan && previousViewport) {
          pendingPan = false;
          queueMicrotask(() => {
            if (this.listeners.has(cellId) && previousViewport) maybeExtendHistory(previousViewport);
          });
        }
      }),
      cell.chart.on('load:error', () => {
        historyLoading = false;
        const loaded = this.counts.get(cellId)?.loaded ?? 0;
        this.set(cellId, loaded, Number(cell.chart.market.bars) || loaded);
      }),
      cell.chart.on('viewport:changed', range => {
        const previous = previousViewport;
        previousViewport = range;
        if (previous && range.from < previous.from) maybeExtendHistory(range);
        else if (previous && range.from > previous.from) pendingPan = false;
      }),
    ]);
  }

  public unwatch(cellId: string): void {
    this.listeners.get(cellId)?.forEach(dispose => dispose());
    this.listeners.delete(cellId);
    this.counts.delete(cellId);
    this.render();
  }
}
