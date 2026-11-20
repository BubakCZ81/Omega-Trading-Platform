import type { VelaWorkspace } from './platform';

interface AutoFitRenderer {
  get(feature: string): unknown;
  set(feature: string, value: unknown): void;
}

interface AutoFitChart {
  renderer: AutoFitRenderer;
  market: { bars?: number };
}

interface AutoFitState {
  enabled: boolean;
  lastBarCount: number | null;
}

const states = new WeakMap<AutoFitRenderer, AutoFitState>();

/** Keep the price-axis auto-fit menu as a user preference, independent of manual drags. */
export function preservePriceAxisAutoFit(chartInput: VelaWorkspace['chart'], cellId: string): void {
  const chart = chartInput as unknown as AutoFitChart;
  const renderer = chart.renderer;
  if (states.has(renderer)) return;

  const originalGet = renderer.get;
  const originalSet = renderer.set;
  const key = `omega.price-axis-auto-fit:${cellId}`;
  const savedPreference = localStorage.getItem(key);
  const state: AutoFitState = {
    enabled: savedPreference !== 'false',
    lastBarCount: Number.isFinite(chart.market?.bars) ? chart.market.bars! : null,
  };
  states.set(renderer, state);

  renderer.get = function (feature: string): unknown {
    if (feature === 'autoScale') return state.enabled;
    return originalGet.call(this, feature);
  };
  renderer.set = function (feature: string, value: unknown): void {
    if (feature === 'autoScale') {
      state.enabled = Boolean(value);
      localStorage.setItem(key, String(state.enabled));
      originalSet.call(this, feature, state.enabled);
      return;
    }
    originalSet.call(this, feature, value);
  };

  // Prior versions treated an axis drag as the user's auto-fit choice. Restore the
  // stored preference on startup; thereafter only the context-menu toggle changes it.
  originalSet.call(renderer, 'autoScale', state.enabled);

  const timer = window.setInterval(() => {
    const barCount = chart.market?.bars;
    if (!Number.isFinite(barCount)) return;
    if (state.enabled && state.lastBarCount !== null && barCount !== state.lastBarCount) {
      // A new candle or history update resumes fitting to the current chart data.
      renderer.set('autoScale', true);
    }
    state.lastBarCount = barCount!;
  }, 500);
  window.addEventListener('beforeunload', () => window.clearInterval(timer), { once: true });
}
