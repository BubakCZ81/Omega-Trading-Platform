interface PriceWindow {
  min: number;
  max: number;
  log?: boolean;
}

interface PricePane {
  kind: string;
  scale: PriceWindow;
  manualScale: PriceWindow | null;
}

interface PriceBarRatioRenderer {
  name: string;
  scene: { panes: Map<string, PricePane> };
  coords: { barCount: number; getViewport: () => { barSpacing: number } };
  input?: NativeWheelInput;
  scaleDragHolder: PricePane | null;
  scaleDragStart: PriceWindow | null;
  beginPriceScale: (x: number, y: number) => void;
  priceScaleBy: (dy: number) => void;
  onViewportChange: (callback: (range: { from: number; to: number }) => void) => () => void;
  getVisibleRange: () => { from: number; to: number } | null;
  setVisibleRange: (range: { from: number; to: number }) => void;
  readFeature: (feature: string) => unknown;
  applyFeature: (feature: string, value: unknown) => void;
}

interface NativeWheelInput {
  el: HTMLElement | null;
  onWheel: (event: WheelEvent) => void;
}

interface RendererControl {
  renderer?: unknown;
}

export type WheelZoomMode = 'time' | 'price' | 'both';

export interface PriceBarRatioController {
  setEnabled(enabled: boolean): void;
  setWheelMode(mode: WheelZoomMode): void;
}

const pricePaneId = 'price';
const controllers = new WeakMap<PriceBarRatioRenderer, PriceBarRatioController>();

function scaleSpan(scale: PriceWindow): number {
  if (scale.log && scale.min > 0 && scale.max > 0) return Math.log(scale.max) - Math.log(scale.min);
  return scale.max - scale.min;
}

function resizeScale(scale: PriceWindow, factor: number): PriceWindow | null {
  if (!Number.isFinite(factor) || factor <= 0) return null;
  if (scale.log && scale.min > 0 && scale.max > 0) {
    const center = (Math.log(scale.min) + Math.log(scale.max)) / 2;
    const halfSpan = scaleSpan(scale) * factor / 2;
    return { ...scale, min: Math.exp(center - halfSpan), max: Math.exp(center + halfSpan) };
  }
  const center = (scale.min + scale.max) / 2;
  const halfSpan = scaleSpan(scale) * factor / 2;
  return { ...scale, min: center - halfSpan, max: center + halfSpan };
}

export function createPriceBarRatioController(rendererControl: unknown): PriceBarRatioController {
  const renderer = (rendererControl as RendererControl | null)?.renderer as PriceBarRatioRenderer | undefined;
  if (!renderer
    || renderer.name !== 'native'
    || !renderer.scene?.panes
    || !renderer.coords?.getViewport
    || !renderer.getVisibleRange
    || !renderer.setVisibleRange
    || !renderer.beginPriceScale
    || !renderer.priceScaleBy
    || !renderer.onViewportChange
    || !renderer.readFeature
    || !renderer.applyFeature) {
    throw new Error('Lock price to bar ratio requires the native Vela chart renderer.');
  }

  const existing = controllers.get(renderer);
  if (existing) return existing;

  const originalBeginPriceScale = renderer.beginPriceScale;
  const originalPriceScaleBy = renderer.priceScaleBy;
  let enabled = false;
  let syncing = false;
  let wheelMode: WheelZoomMode = 'both';
  let wheelRatioLockUntil = 0;
  let lastBarSpacing = renderer.coords.getViewport().barSpacing;
  let gestureStartRange: { from: number; to: number } | null = null;
  const pricePane = renderer.scene.panes.get(pricePaneId);

  if (!pricePane) throw new Error('The native Vela renderer has no price scale.');

  const freezeCurrentScale = (): boolean => {
    if (renderer.coords.barCount === 0 || pricePane.manualScale !== null) return false;
    const span = scaleSpan(pricePane.scale);
    if (!Number.isFinite(span) || span <= 0) return false;
    pricePane.manualScale = { ...pricePane.scale };
    renderer.applyFeature('logScale', renderer.readFeature('logScale'));
    return true;
  };

  const wheelInput = renderer.input;
  if (!wheelInput?.el || !wheelInput.onWheel) {
    throw new Error('Wheel zoom configuration requires the native Vela input controller.');
  }
  const originalWheelHandler = wheelInput.onWheel;
  const configurableWheelHandler = (event: WheelEvent): void => {
    if (event.deltaY === 0 || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      originalWheelHandler.call(wheelInput, event);
      return;
    }

    if (wheelMode === 'time') {
      freezeCurrentScale();
      originalWheelHandler.call(wheelInput, event);
      return;
    }

    const zoomPriceAtCursor = () => {
      const bounds = wheelInput.el!.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      // Use Vela's public price-scale gesture directly. Replaying the same
      // wheel event after changing regionAt loses the original cursor anchor
      // in newer Vela builds, so the chart appears to scale from the edge.
      renderer.beginPriceScale(x, y);
      renderer.priceScaleBy(event.deltaY * 0.25);
    };

    if (wheelMode === 'both') {
      // Use Vela's native time zoom and couple price scaling to its actual
      // bar-spacing change in onViewportChange. A fixed multiplier makes the
      // axes drift apart and progressively flattens or stretches candles.
      wheelRatioLockUntil = performance.now() + 250;
      originalWheelHandler.call(wheelInput, event);
      return;
    }

    event.preventDefault();
    zoomPriceAtCursor();
  };
  wheelInput.el.removeEventListener('wheel', originalWheelHandler);
  wheelInput.el.addEventListener('wheel', configurableWheelHandler, { passive: false });

  renderer.beginPriceScale = function (x, y): void {
    originalBeginPriceScale.call(this, x, y);
    gestureStartRange = this.getVisibleRange();
  };

  renderer.priceScaleBy = function (dy): void {
    originalPriceScaleBy.call(this, dy);
    if (!enabled || syncing || this.scaleDragHolder !== pricePane || !this.scaleDragStart) return;

    const currentScale = pricePane.manualScale ?? pricePane.scale;
    const initialSpan = scaleSpan(this.scaleDragStart);
    const currentSpan = scaleSpan(currentScale);
    if (initialSpan <= 0 || currentSpan <= 0) return;

    const range = gestureStartRange;
    if (!range) return;
    const factor = currentSpan / initialSpan;
    const center = (range.from + range.to) / 2;
    const halfSpan = (range.to - range.from) * factor / 2;
    syncing = true;
    try {
      this.setVisibleRange({ from: center - halfSpan, to: center + halfSpan });
      lastBarSpacing = this.coords.getViewport().barSpacing;
    } finally {
      syncing = false;
    }
  };

  renderer.onViewportChange(() => {
    if (syncing) return;
    const barSpacing = renderer.coords.getViewport().barSpacing;
    if (!Number.isFinite(barSpacing) || barSpacing <= 0) return;

    const ratioLocked = enabled || (wheelMode === 'both' && performance.now() < wheelRatioLockUntil);
    if (!ratioLocked) {
      // Keep the baseline current while ordinary time-axis panning or zooming
      // is in effect, so the next proportional wheel gesture starts cleanly.
      lastBarSpacing = barSpacing;
      return;
    }
    if (barSpacing === lastBarSpacing) return;

    const currentScale = pricePane.manualScale ?? pricePane.scale;
    const resized = resizeScale(currentScale, lastBarSpacing / barSpacing);
    lastBarSpacing = barSpacing;
    if (!resized || !Number.isFinite(resized.min) || !Number.isFinite(resized.max)) return;

    pricePane.manualScale = resized;
    renderer.applyFeature('logScale', renderer.readFeature('logScale'));
  });

  const controller: PriceBarRatioController = {
    setEnabled(value): void {
      if (enabled === value) return;
      enabled = value;
      lastBarSpacing = renderer.coords.getViewport().barSpacing;
      if (enabled && pricePane.manualScale === null) {
        freezeCurrentScale();
      }
    },
    setWheelMode(mode): void {
      wheelMode = mode;
    },
  };

  controllers.set(renderer, controller);
  return controller;
}
