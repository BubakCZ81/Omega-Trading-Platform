import {
  registerNativeIndicator,
  registerRendererLayer,
  type NativeIndicatorContext,
  type RendererLayerArgs,
} from '@luxalgo/vela';

export const QUICK_TRADE_LAYER_ID = 'omega-quick-trade-levels';

export type TradeLineRole = 'entry' | 'stopLoss' | 'takeProfit';
export type TradeOverlayAction = 'close' | 'reverse';
export type PendingOverlayAction = 'cancel';
export type OverlayAction = TradeOverlayAction | PendingOverlayAction;

export interface TradeOverlayLevel {
  tradeId: string;
  role: TradeLineRole;
  price: number;
  label: string;
  color: string;
  lineWidth: number;
  readonly?: boolean;
  pending?: boolean;
  hoveredAction?: OverlayAction;
}

export interface TradeOverlayHit {
  tradeId: string;
  role: TradeLineRole;
  x: number;
  y: number;
  width: number;
  height: number;
  top?: number;
  action?: OverlayAction;
}

export interface TradeOverlayCanvas extends HTMLCanvasElement {
  omegaTradePriceAtY?: (y: number) => number;
  omegaTradePlotWidth?: number;
  omegaTradeBarIndexAtX?: (x: number) => number | null;
  omegaTradeBarIndexAtTime?: (time: number) => number | null;
}

export function nearestBarIndexAtX(
  bars: readonly { time: number }[],
  x: number,
  timeToX: (time: number) => number,
): number | null {
  if (!Number.isFinite(x) || bars.length === 0) return null;

  let low = 0;
  let high = bars.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const barX = timeToX(bars[middle].time);
    if (!Number.isFinite(barX)) return null;
    if (barX < x) low = middle + 1;
    else high = middle;
  }

  const rightX = timeToX(bars[low].time);
  if (!Number.isFinite(rightX)) return null;
  if (low === 0) return 0;
  const leftX = timeToX(bars[low - 1].time);
  if (!Number.isFinite(leftX)) return low;
  return Math.abs(x - leftX) <= Math.abs(x - rightX) ? low - 1 : low;
}

export function isTradePlotX(x: number, plotWidth: number): boolean {
  return Number.isFinite(x) && Number.isFinite(plotWidth) && x >= 0 && x <= plotWidth;
}

export function resolveMeasurementPoint(
  x: number,
  y: number,
  plotWidth: number,
  priceAtY: (y: number) => number,
  barIndexAtX?: (x: number) => number | null,
): { price: number; barIndex: number | null } | null {
  if (!isTradePlotX(x, plotWidth)) return null;
  const price = priceAtY(y);
  if (!Number.isFinite(price) || price <= 0) return null;
  return { price, barIndex: barIndexAtX?.(x) ?? null };
}

export function isTradeOverlayLabelHit(
  hit: Pick<TradeOverlayHit, 'x' | 'y' | 'width' | 'height'>,
  x: number,
  y: number,
): boolean {
  return x >= hit.x && x <= hit.x + hit.width
    && y >= hit.y - hit.height / 2 && y <= hit.y + hit.height / 2;
}

function isTradeOverlayData(data: unknown): data is { levels: TradeOverlayLevel[] } {
  return !!data && typeof data === 'object'
    && Array.isArray((data as { levels?: unknown }).levels);
}

function drawRoundedLabelBackground(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const corner = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + corner, y);
  ctx.lineTo(x + width - corner, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + corner);
  ctx.lineTo(x + width, y + height - corner);
  ctx.quadraticCurveTo(x + width, y + height, x + width - corner, y + height);
  ctx.lineTo(x + corner, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - corner);
  ctx.lineTo(x, y + corner);
  ctx.quadraticCurveTo(x, y, x + corner, y);
  ctx.closePath();
}

function drawTradeLevels(
  ctx: CanvasRenderingContext2D,
  args: RendererLayerArgs,
  getTransparency: () => number,
): void {
  const { coords, bounds, scale } = args;
  const labelHeight = 30;
  const labelPadding = 12;
  const labelGap = 12;
  const controlSize = 18;
  const controlGap = 5;
  ctx.setTransform(coords.dpr, 0, 0, coords.dpr, 0, 0);
  ctx.clearRect(0, 0, coords.width, coords.height);

  const levels = isTradeOverlayData(args.data) ? args.data.levels : [];
  const hits: TradeOverlayHit[] = [];
  let previewEntryLabel: Omit<TradeOverlayHit, 'tradeId' | 'role'> | null = null;
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, bounds.top, coords.width, bounds.height);
  ctx.clip();
  for (const level of levels) {
    if (!Number.isFinite(level.price)) continue;
    const y = coords.priceToY(level.price, scale, bounds);
    if (!Number.isFinite(y) || y < bounds.top || y > bounds.top + bounds.height) continue;

    ctx.strokeStyle = level.color;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth = level.lineWidth;
    ctx.setLineDash([]);
    ctx.font = '700 13px sans-serif';
    const controlCount = level.role === 'entry' && !level.readonly ? (level.pending ? 1 : 2) : 0;
    const labelWidth = ctx.measureText(level.label).width + labelPadding * 2
      + (controlCount ? controlSize * controlCount + controlGap * (controlCount + 1) : 0);
    const labelX = coords.width - labelWidth - 6;
    if (level.tradeId.startsWith('preview:') && level.role === 'entry') {
      previewEntryLabel = { x: labelX, y, width: labelWidth, height: labelHeight };
    }
    const lineEndX = Math.max(0, labelX - labelGap);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(lineEndX, y);
    ctx.stroke();

    ctx.globalAlpha = 1;
    ctx.fillStyle = level.color;
    drawRoundedLabelBackground(ctx, labelX, y - labelHeight / 2, labelWidth, labelHeight, 7);
    ctx.globalAlpha = 1 - getTransparency() / 100;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(255,255,255,.7)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    if (level.role === 'entry' && !level.readonly) {
      const controls: Array<{ action: OverlayAction; x: number }> = level.pending
        ? [{ action: 'cancel', x: labelX + labelWidth - controlSize - controlGap }]
        : [
          { action: 'reverse', x: labelX + controlGap },
          { action: 'close', x: labelX + labelWidth - controlSize - controlGap },
        ];
      for (const control of controls) {
        const controlY = y - controlSize / 2;
        ctx.fillStyle = level.hoveredAction === control.action ? 'rgba(255,255,255,.34)' : 'rgba(255,255,255,.16)';
        drawRoundedLabelBackground(ctx, control.x, controlY, controlSize, controlSize, 5);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,.8)';
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1.8;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        if (control.action === 'close' || control.action === 'cancel') {
          ctx.moveTo(control.x + 6, controlY + 6);
          ctx.lineTo(control.x + controlSize - 6, controlY + controlSize - 6);
          ctx.moveTo(control.x + controlSize - 6, controlY + 6);
          ctx.lineTo(control.x + 6, controlY + controlSize - 6);
        } else {
          ctx.arc(control.x + controlSize / 2, controlY + controlSize / 2, 5, -Math.PI * 0.8, Math.PI * 0.7);
          ctx.lineTo(control.x + 3, controlY + 7);
          ctx.moveTo(control.x + 3, controlY + 7);
          ctx.lineTo(control.x + 8, controlY + 7);
          ctx.moveTo(control.x + 3, controlY + 7);
          ctx.lineTo(control.x + 4, controlY + 12);
        }
        ctx.stroke();
        hits.push({
          tradeId: level.tradeId,
          role: 'entry',
          action: control.action,
          x: control.x,
          y,
          width: controlSize,
          height: controlSize,
          top: controlY,
        });
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillText(level.label, labelX + labelPadding + (level.pending ? 0 : controlSize + controlGap), y);
    } else {
      ctx.fillText(level.label, labelX + labelPadding, y);
    }
    if (!level.readonly) {
      hits.push({ tradeId: level.tradeId, role: level.role, x: labelX, y, width: labelWidth, height: labelHeight });
    }
  }
  ctx.restore();
  const canvas = ctx.canvas as TradeOverlayCanvas;
  canvas.omegaTradePriceAtY = y => coords.yToPrice(y, scale, bounds);
  canvas.omegaTradePlotWidth = coords.width;
  canvas.omegaTradeBarIndexAtX = x => nearestBarIndexAtX(args.bars, x, time => coords.timeToX(time));
  canvas.omegaTradeBarIndexAtTime = time => nearestBarIndexAtX(args.bars, coords.timeToX(time), time => coords.timeToX(time));
  canvas.dataset.omegaTradeLevels = JSON.stringify(hits);
  if (previewEntryLabel) canvas.dataset.omegaPreviewEntryLabel = JSON.stringify(previewEntryLabel);
  else delete canvas.dataset.omegaPreviewEntryLabel;
}

let overlayRegistered = false;
let transparencyProvider: () => number = () => 18;

/** Update the transparency used by the already-registered overlay layer. */
export function setPaperTradeOverlayTransparency(getTransparency: () => number): void {
  transparencyProvider = getTransparency;
}

export function registerPaperTradeOverlay(getTransparency?: () => number): void {
  if (getTransparency) transparencyProvider = getTransparency;
  if (overlayRegistered) return;
  overlayRegistered = true;
  registerRendererLayer({
    id: QUICK_TRADE_LAYER_ID,
    placement: 'above-data',
    create: () => {
      let ctx: CanvasRenderingContext2D | null = null;
      return {
        mount: canvas => {
          canvas.dataset.omegaTradeOverlay = 'true';
          canvas.style.cursor = 'crosshair';
          ctx = canvas.getContext('2d');
        },
        render: args => {
          if (ctx) drawTradeLevels(ctx, args, transparencyProvider);
        },
      };
    },
  });

  registerNativeIndicator({
    type: QUICK_TRADE_LAYER_ID,
    title: 'Quick Trade Lines',
    shortTitle: 'Quick Trade',
    paneHint: 'price',
    overlay: true,
    legend: false,
    inputsSchema: () => [{ key: 'levels', title: 'Levels', type: 'text_area', defval: '[]' }],
    defaultInputs: () => ({ levels: '[]' }),
    create: () => {
      let context: NativeIndicatorContext | undefined;
      let levels: TradeOverlayLevel[] = [];
      const publish = () => {
        if (!context) return;
        context.emit({ priceLines: [] });
        context.pushData({ levels });
      };
      const readLevels = (inputs: Record<string, string | number | boolean>) => {
        const value = inputs.levels;
        levels = typeof value === 'string' ? JSON.parse(value) as TradeOverlayLevel[] : [];
      };
      return {
        start: (ctx, inputs) => {
          context = ctx;
          readLevels(inputs);
          publish();
        },
        onBars: () => undefined,
        onViewport: () => undefined,
        setInputs: inputs => {
          readLevels(inputs);
          publish();
        },
        suspend: () => undefined,
        resume: publish,
        stop: () => {
          publish();
          context = undefined;
        },
      };
    },
  });
}
