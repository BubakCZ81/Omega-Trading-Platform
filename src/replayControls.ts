import { timeframeToMs } from '@luxalgo/vela';
import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export function initializeReplayControls(
  workspace: VelaWorkspace,
  onReplayActiveChanged: (active: boolean) => void,
): void {
  const replayMenu = document.getElementById('replay-menu') as HTMLDetailsElement | null;
  const replayFrom = document.getElementById('replay-from') as HTMLInputElement | null;
  const replaySpeed = document.getElementById('replay-speed') as HTMLSelectElement | null;
  const replayStatus = document.getElementById('replay-status') as HTMLElement | null;
  const replayStart = document.getElementById('replay-start') as HTMLButtonElement | null;
  const replayStep = document.getElementById('replay-step') as HTMLButtonElement | null;
  const replayPlayPause = document.getElementById('replay-play-pause') as HTMLButtonElement | null;
  const replayStop = document.getElementById('replay-stop') as HTMLButtonElement | null;

  if (!replayMenu || !replayFrom || !replaySpeed || !replayStatus || !replayStart || !replayStep || !replayPlayPause || !replayStop) return;

  function localDateTimeInputValue(timestamp: number): string {
    const date = new Date(timestamp);
    const localTime = new Date(timestamp - date.getTimezoneOffset() * 60_000);
    return localTime.toISOString().slice(0, 16);
  }

  function syncReplayControls() {
    const state = workspace.replay.state;
    replayStep!.disabled = !state.active || state.remaining === 0;
    replayPlayPause!.disabled = !state.active || state.remaining === 0;
    replayPlayPause!.textContent = state.playing ? 'Pause' : 'Play';
    replayStop!.disabled = !state.active;
    if (state.active && state.cursorTime != null) {
      replayStatus!.textContent = `${state.remaining} bars remaining · ${new Date(state.cursorTime).toLocaleString()}`;
    } else if (!replayStatus!.textContent?.startsWith('Could not')) {
      replayStatus!.textContent = 'Choose a starting time, then start replay.';
    }
  }

  replayMenu.addEventListener('toggle', () => {
    if (!replayMenu.open || replayFrom.value) return;
    const bounds = workspace.replay.bounds;
    if (!bounds) {
      replayStatus.textContent = 'No replayable chart history is loaded yet.';
      return;
    }
    const timeframe = workspace.chart.market.timeframe ?? '60';
    const suggestedStart = Math.max(bounds.first, bounds.last - timeframeToMs(timeframe) * 50);
    replayFrom.value = localDateTimeInputValue(suggestedStart);
  });

  replayStart.addEventListener('click', async () => {
    const from = new Date(replayFrom.value).getTime();
    if (!Number.isFinite(from)) {
      replayStatus.textContent = 'Choose a valid replay start date and time.';
      return;
    }
    replayStart.disabled = true;
    replayStatus.textContent = 'Preparing replay…';
    onReplayActiveChanged(true);
    try {
      await workspace.replay.start({ from });
      replayStatus.textContent = 'Replay paused. Step through bars or start playback.';
    } catch (error) {
      onReplayActiveChanged(workspace.replay.state.active);
      replayStatus.textContent = `Could not start replay: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      onReplayActiveChanged(workspace.replay.state.active);
      replayStart.disabled = false;
      syncReplayControls();
    }
  });

  replayStep.addEventListener('click', () => {
    if (!workspace.replay.step()) replayStatus.textContent = 'No more bars to replay.';
    syncReplayControls();
  });

  replayPlayPause.addEventListener('click', () => {
    const state = workspace.replay.state;
    if (state.playing) workspace.replay.pause();
    else workspace.replay.play(Number(replaySpeed.value));
    syncReplayControls();
  });

  replaySpeed.addEventListener('change', () => {
    if (workspace.replay.state.playing) {
      workspace.replay.play(Number(replaySpeed.value));
    }
  });

  replayStop.addEventListener('click', () => {
    onReplayActiveChanged(false);
    workspace.replay.stop();
    syncReplayControls();
  });

  for (const event of ['replay:start', 'replay:step', 'replay:play', 'replay:pause', 'replay:end'] as const) {
    workspace.replay.on(event, () => {
      onReplayActiveChanged(workspace.replay.state.active);
      syncReplayControls();
    });
  }

  syncReplayControls();
}
