import { registerIcon, registerSidePanel, type SidePanelHandle, type Vela } from '@luxalgo/vela';

const panelStyles = `
  .omega-backtest-launcher { display:grid; gap:.875rem; padding:1rem; color:var(--omega-text,#e6edf7); background:var(--omega-bg,#101722); font: .875rem/1.5 "Segoe UI",system-ui,sans-serif; }
  .omega-backtest-launcher p { margin:0; color:var(--omega-muted,#9baac0); }
  .omega-backtest-launcher button { justify-self:start; border:1px solid var(--omega-accent,#2563eb); border-radius:.375rem; padding:.55rem .85rem; color:#fff; background:var(--omega-accent,#2563eb); font:inherit; cursor:pointer; }
  .omega-backtest-launcher button:disabled { opacity:.55; cursor:wait; }
  .omega-backtest-launcher [role=status] { min-height:1.4em; color:var(--omega-muted,#9baac0); }
  .omega-backtest-launcher [role=status][data-error=true] { color:var(--omega-error,#ef4444); }
`;

registerIcon(
  'omega-backtest',
  '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 5-7"/></svg>',
);

registerSidePanel({
  id: 'omega-backtest',
  title: 'Backtest',
  icon: 'omega-backtest',
  order: 74,
  width: 320,
  resizable: true,
  minWidth: 280,
  maxWidth: 480,
  mount(_context, body, header) {
    const style = document.createElement('style');
    style.textContent = panelStyles;
    document.head.append(style);

    const root = document.createElement('section');
    root.className = 'omega-backtest-launcher';
    const description = document.createElement('p');
    description.textContent = 'Run Pine strategies or indicators against historical data in the isolated backtest window. Adjust script inputs, review trades and statistics, and replay candles without sending broker orders.';
    const market = document.createElement('p');
    market.setAttribute('aria-live', 'polite');
    const run = document.createElement('button');
    run.type = 'button';
    run.textContent = 'Open Backtester';
    const status = document.createElement('div');
    status.setAttribute('role', 'status');
    root.append(description, market, run, status);
    body.replaceChildren(root);

    let chart: Vela | null = null;
    const setMarket = (next: Vela) => {
      chart = next;
      const symbol = next.market.symbol || '—';
      const timeframe = next.market.timeframe || '—';
      market.textContent = `${symbol} · ${timeframe}`;
      header.setTitle(`Backtest — ${symbol}`);
    };
    const launch = async () => {
      if (!chart) return;
      const symbol = chart.market.symbol || '';
      const timeframe = chart.market.timeframe || '';
      const resolved = chart.data.resolve(symbol);
      const strategy = chart.indicators().find(handle => typeof handle.source === 'string' && /^\s*strategy\s*\(/m.test(handle.source));
      run.disabled = true;
      status.dataset.error = 'false';
      status.textContent = 'Opening isolated backtester…';
      try {
        const opened = await window.velaVisualBacktestWindow?.open({
          symbol,
          timeframe,
          provider: resolved?.provider,
          strategy: strategy ? { title: strategy.title, source: strategy.source ?? '' } : undefined,
        });
        if (!opened) throw new Error('The Omega desktop backtester window is unavailable.');
        status.textContent = 'The backtest runner is ready. Orders remain simulated locally.';
      } catch (error) {
        status.dataset.error = 'true';
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally { run.disabled = false; }
    };
    run.addEventListener('click', () => void launch());
    return {
      onChart: setMarket,
      onOpen: () => { if (chart) setMarket(chart); },
      destroy() { style.remove(); root.remove(); },
    } satisfies SidePanelHandle;
  },
});
