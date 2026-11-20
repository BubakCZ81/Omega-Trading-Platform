export function visibleReplayPoints<T extends { time: number }>(points: readonly T[], from: number, to: number): T[] {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].time < from) low = middle + 1;
    else high = middle;
  }
  const visible: T[] = [];
  for (let index = low; index < points.length && points[index].time <= to; index++) {
    visible.push(points[index]);
  }
  return visible;
}
