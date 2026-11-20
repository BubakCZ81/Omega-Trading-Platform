let replayActive = false;

export function setReplayActive(active: boolean): void {
  replayActive = active;
}

export function isReplayActive(): boolean {
  return replayActive;
}

export function areLiveStrategyFillsAllowed(): boolean {
  return !replayActive;
}
