import { timeframeToMs } from './platform';
import type { VelaWorkspace } from './platform';
import { isAwayFromLatest, rangeEndingAtLatest } from './chartViewportRange';

function attachReturnToLatestButton(cell: ReturnType<VelaWorkspace['cells']>[number]): () => void {
  const { chart, host } = cell;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'omega-return-to-latest';
  button.setAttribute('aria-label', 'Return to latest bars');
  button.title = 'Return to latest bars';
  button.hidden = true;
  button.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M7 3.5 13.5 10 7 16.5z"/></svg>';
  host.append(button);

  const update = (): void => {
    const latest = chart.replay.bounds?.last ?? null;
    const timeframe = chart.market.timeframe;
    const away = !chart.replay.state.active
      && isAwayFromLatest(
        chart.getVisibleRange(),
        latest,
        timeframe ? timeframeToMs(timeframe) : 0,
      );
    button.hidden = !away;
    button.setAttribute('aria-hidden', String(!away));
  };
  const onClick = (): void => {
    if (chart.replay.state.active) return;
    const range = rangeEndingAtLatest(chart.getVisibleRange(), chart.replay.bounds?.last ?? Number.NaN);
    if (range) chart.setVisibleRange(range);
  };
  button.addEventListener('click', onClick);

  const unsubscribe = [
    chart.on('viewport:changed', update),
    chart.on('bar', update),
    chart.on('load:end', update),
    chart.on('history:progress', update),
    chart.on('history:complete', update),
    chart.on('market:changed', update),
    chart.on('replay:start', update),
    chart.on('replay:step', update),
    chart.on('replay:end', update),
  ];
  update();

  return () => {
    button.removeEventListener('click', onClick);
    for (const dispose of unsubscribe) dispose();
    button.remove();
  };
}

export function initializeChartReturnToLatest(workspace: VelaWorkspace): void {
  const mounted = new Map<string, () => void>();
  const mount = (cellId: string): void => {
    const cell = workspace.cell(cellId);
    if (!cell || mounted.has(cellId)) return;
    mounted.set(cellId, attachReturnToLatestButton(cell));
  };

  for (const cell of workspace.cells()) mount(cell.id);
  workspace.on('cell:created', event => mount(event.id));
  workspace.on('cell:destroyed', event => {
    mounted.get(event.id)?.();
    mounted.delete(event.id);
  });
}
