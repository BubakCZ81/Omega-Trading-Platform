interface ResizablePlatformWorkspace {
  resize(): void;
  cells(): Array<{ chart: { resize(): unknown } }>;
}

export interface PlatformChartResizeBinding {
  requestResize(): void;
  dispose(): void;
}

export function bindPlatformChartResize(
  workspace: ResizablePlatformWorkspace,
  target: EventTarget = document,
  requestFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): PlatformChartResizeBinding {
  let framePending = false;
  let disposed = false;

  const requestResize = (): void => {
    if (framePending || disposed) return;
    framePending = true;
    requestFrame(() => {
      framePending = false;
      if (disposed) return;
      workspace.resize();
      for (const cell of workspace.cells()) cell.chart.resize();
    });
  };

  const stage = typeof document === 'undefined' ? null : document.getElementById('chart-stage');
  const resizeObserver = stage && typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(requestResize)
    : null;
  target.addEventListener('omega:platform-layout-resize-request', requestResize);
  if (stage) resizeObserver?.observe(stage);
  return {
    requestResize,
    dispose() {
      if (disposed) return;
      disposed = true;
      target.removeEventListener('omega:platform-layout-resize-request', requestResize);
      resizeObserver?.disconnect();
    },
  };
}
