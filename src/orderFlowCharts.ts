import {
  registerChartType,
  registerRendererLayer,
  type ChartTypeDefinition,
  type RendererLayerArgs,
  type SeriesDataEngine,
  type SeriesDataEngineHost,
} from '@luxalgo/vela';

export interface RenkoBrick {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface PositionedRenkoBrick {
  brick: RenkoBrick;
  logical: number;
  width: number;
}

const MAX_BRICKS_PER_BAR = 500;
const FX_CURRENCIES = new Set([
  'AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'NZD', 'USD',
]);
const RENKO_PIP_OPTIONS = [
  ...Array.from({ length: 50 }, (_, index) => index + 1),
  ...Array.from({ length: 10 }, (_, index) => 55 + index * 5),
  ...Array.from({ length: 8 }, (_, index) => 150 + index * 50),
  ...Array.from({ length: 25 }, (_, index) => 600 + index * 100),
].map(value => [String(value), `${value} pips`] as [string, string]);

function finiteSetting(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function averageTrueRange(bars: readonly { high: number; low: number; close: number }[], length: number): number {
  const start = Math.max(0, bars.length - Math.max(1, Math.floor(length)));
  let total = 0;
  let count = 0;
  for (let index = start; index < bars.length; index += 1) {
    const bar = bars[index];
    const previousClose = bars[index - 1]?.close ?? bar.close;
    total += Math.max(bar.high - bar.low, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
    count += 1;
  }
  return count > 0 ? total / count : 0;
}

export function inferPipSize(symbol: string): number | null {
  const normalized = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  for (let index = 0; index <= normalized.length - 6; index += 1) {
    const base = normalized.slice(index, index + 3);
    const quote = normalized.slice(index + 3, index + 6);
    if (FX_CURRENCIES.has(base) && FX_CURRENCIES.has(quote)) {
      return quote === 'JPY' ? 0.01 : 0.0001;
    }
  }
  return null;
}

export function buildRenkoBricks(
  bars: readonly { time: number; open: number; high: number; low: number; close: number }[],
  options: { mode?: unknown; boxSize?: unknown; atrLength?: unknown; brickPips?: unknown; customBrickPips?: unknown; pipSize?: unknown; symbol?: string } = {},
): RenkoBrick[] {
  if (bars.length < 2) return [];
  const atrLength = Math.max(1, Math.floor(finiteSetting(options.atrLength, 14)));
  const inferredPipSize = inferPipSize(options.symbol ?? '');
  const configuredPipSize = finiteSetting(options.pipSize, 0);
  const pipSize = configuredPipSize > 0 ? configuredPipSize : inferredPipSize ?? 0.01;
  const customBrickPips = finiteSetting(options.customBrickPips, 0);
  const brickPips = customBrickPips > 0 ? customBrickPips : finiteSetting(options.brickPips, 5);
  if (options.mode === 'pips' && (!Number.isSafeInteger(brickPips) || brickPips < 1 || brickPips > 3000)) return [];
  const boxSize = options.mode === 'fixed'
    ? finiteSetting(options.boxSize, 1)
    : options.mode === 'pips'
      ? brickPips * pipSize
      : averageTrueRange(bars, atrLength);
  if (!(boxSize > 0) || !Number.isFinite(boxSize)) return [];

  let anchor = bars[0].close;
  let direction = 0;
  const bricks: RenkoBrick[] = [];
  const processTarget = (target: number, source: typeof bars[number], emitted: number[]) => {
    let barBrickCount = 0;
    while (barBrickCount < MAX_BRICKS_PER_BAR && bricks.length < 100_000) {
      let nextDirection = direction;
      let open = anchor;
      let close = anchor;

      if (direction === 0) {
        if (target >= anchor + boxSize) nextDirection = 1;
        else if (target <= anchor - boxSize) nextDirection = -1;
        else break;
        close = anchor + nextDirection * boxSize;
      } else if ((target - anchor) * direction >= boxSize) {
        nextDirection = direction;
        close = anchor + direction * boxSize;
      } else if ((target - anchor) * direction <= -2 * boxSize) {
        nextDirection = -direction;
        open = anchor - direction * boxSize;
        close = anchor - direction * 2 * boxSize;
      } else {
        break;
      }

      const index = bricks.length;
      bricks.push({
        time: source.time,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
      });
      emitted.push(index);
      anchor = close;
      direction = nextDirection;
      barBrickCount += 1;
    }
  };

  for (let index = 1; index < bars.length && bricks.length < 100_000; index += 1) {
    const bar = bars[index];
    const path = bar.close >= bar.open
      ? [bar.open, bar.low, bar.high, bar.close]
      : [bar.open, bar.high, bar.low, bar.close];
    const emitted: number[] = [];
    for (const target of path) processTarget(target, bar, emitted);

    const lastIndex = emitted[emitted.length - 1];
    if (lastIndex !== undefined) {
      const brick = bricks[lastIndex];
      brick.high = Math.max(brick.high, Math.min(bar.high, brick.high + boxSize));
      brick.low = Math.min(brick.low, Math.max(bar.low, brick.low - boxSize));
    }
  }
  return bricks;
}

/** cTrader-style range bars: every completed bar spans exactly the selected pip range. */
export function buildRangeBars(
  bars: readonly { time: number; open: number; high: number; low: number; close: number }[],
  options: { brickPips?: unknown; customBrickPips?: unknown; pipSize?: unknown; symbol?: string } = {},
): RenkoBrick[] {
  if (bars.length < 2) return [];
  const pipSize = finiteSetting(options.pipSize, 0) || inferPipSize(options.symbol ?? '') || 0.01;
  const configured = finiteSetting(options.customBrickPips, 0) || finiteSetting(options.brickPips, 5);
  const size = configured * pipSize;
  if (!(size > 0) || !Number.isFinite(size)) return [];
  const out: RenkoBrick[] = [];
  let open = bars[0].open;
  let high = open;
  let low = open;
  for (const bar of bars.slice(1)) {
    const path = bar.close >= bar.open ? [bar.open, bar.low, bar.high, bar.close] : [bar.open, bar.high, bar.low, bar.close];
    for (const target of path) {
      high = Math.max(high, target); low = Math.min(low, target);
      while (high - low >= size && out.length < 100_000) {
        const direction = Math.abs(high - open) >= Math.abs(open - low) ? 1 : -1;
        const close = open + direction * size;
        out.push({ time: bar.time, open, high: Math.max(open, close), low: Math.min(open, close), close });
        open = close;
        high = Math.max(open, target); low = Math.min(open, target);
      }
    }
  }
  return out;
}

function clearLayer(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, dpr: number) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
}

function renderRenko(args: RendererLayerArgs, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) {
  const bricks = isRenkoPayload(args.data) ? args.data : [];
  if (bricks.length === 0) return;
  const logicalByTime = new Map(args.bars.map((bar, index) => [bar.time, index]));
  const pitch = Math.max(1, args.coords.pxPerBar());
  const range = args.coords.visibleLogicalRange();
  const positioned = layoutRenkoBricks(bricks.map(brick => ({
    brick,
    logical: logicalByTime.get(brick.time) ?? args.coords.timeToLogical(brick.time),
  })), range, pitch);
  for (const { brick, logical, width } of positioned) {
    const x = args.coords.logicalToX(logical);
    const openY = args.coords.priceToY(brick.open, args.scale, args.bounds);
    const closeY = args.coords.priceToY(brick.close, args.scale, args.bounds);
    const rising = brick.close >= brick.open;
    const color = rising ? args.theme.upColor : args.theme.downColor;

    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1;
    const top = Math.min(openY, closeY);
    const height = Math.max(1, Math.abs(closeY - openY));
    ctx.fillRect(x - width / 2, top, width, height);
    ctx.strokeRect(x - width / 2, top, width, height);
  }
}

export function layoutRenkoBricks(
  entries: readonly { brick: RenkoBrick; logical: number }[],
  visibleRange: { from: number; to: number },
  pitch: number,
): PositionedRenkoBrick[] {
  const span = visibleRange.to - visibleRange.from;
  if (!(span > 0) || !(pitch > 0) || !Number.isFinite(pitch)) return [];
  const visible = entries.filter(entry =>
    Number.isFinite(entry.logical)
    && entry.logical >= visibleRange.from
    && entry.logical <= visibleRange.to,
  );
  if (visible.length === 0) return [];

  const spacing = span / visible.length;
  const width = Math.max(1, Math.min(pitch * 0.82, pitch * spacing * 0.82));
  return visible.map((entry, index) => ({
    brick: entry.brick,
    logical: visibleRange.from + (index + 0.5) * spacing,
    width,
  }));
}

function isRenkoPayload(value: unknown): value is RenkoBrick[] {
  return Array.isArray(value) && value.every((brick: unknown) => {
    if (!brick || typeof brick !== 'object') return false;
    const item = brick as RenkoBrick;
    return [item.time, item.open, item.high, item.low, item.close].every(Number.isFinite);
  });
}

class PipBarDataEngine implements SeriesDataEngine {
  private host: SeriesDataEngineHost | null = null;
  private settings: Record<string, unknown> = {};
  private symbolPipSize: number | null = null;
  private infoRequest: Promise<void> | null = null;
  private readonly build: typeof buildRenkoBricks;
  constructor(build: typeof buildRenkoBricks) { this.build = build; }

  start(host: SeriesDataEngineHost) {
    this.host = host;
    const inferredPipSize = inferPipSize(host.symbol);
    if (inferredPipSize !== null) {
      this.symbolPipSize = inferredPipSize;
    } else {
      this.infoRequest = host.data.symbolInfo(host.symbol).then(info => {
        if (this.host !== host || !info) return;
        const candidate = Number(info.pipSize ?? info.pip_size ?? info.minTick ?? info.mintick);
        if (Number.isFinite(candidate) && candidate > 0) {
          this.symbolPipSize = candidate;
          this.recompute();
        }
      }).catch(error => {
        if (this.host !== host) return;
        console.warn(`Could not resolve Renko pip size for "${host.symbol}":`, error);
      });
    }
    this.recompute();
  }

  suspend() {}
  resume() { this.recompute(); }
  stop() {
    this.host = null;
    this.symbolPipSize = null;
    this.infoRequest = null;
  }
  onBars() { this.recompute(); }
  onSettings(settings: Record<string, unknown>) {
    this.settings = settings;
    this.recompute();
  }

  private recompute() {
    if (!this.host) return;
    const pipSize = finiteSetting(this.settings.pipSize, 0) > 0
      ? this.settings.pipSize
      : this.symbolPipSize ?? undefined;
    this.host.pushData(this.build(this.host.bars(), {
      ...this.settings,
      pipSize,
      symbol: this.host.symbol,
    }));
  }
}

function layer(id: string, render: (args: RendererLayerArgs, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D) => void) {
  registerRendererLayer({
    id,
    placement: 'above-data',
    create: () => {
      let canvas: HTMLCanvasElement | null = null;
      return {
        mount(target) {
          canvas = target;
        },
        render(args) {
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;
          clearLayer(ctx, canvas, args.coords.dpr);
          if (args.priceStyle === id) render(args, canvas, ctx);
        },
      };
    },
  });
}

const renko: ChartTypeDefinition = {
  id: 'renko',
  label: 'Renko',
  basePainting: 'none',
  dataEngine: () => new PipBarDataEngine(buildRenkoBricks),
  settings: {
    title: 'Renko',
    rows: [
      { kind: 'select', key: 'mode', label: 'Brick size mode', options: [['pips', 'Pips (cTrader style)'], ['atr', 'ATR'], ['fixed', 'Fixed price']], defval: 'pips' },
      { kind: 'select', key: 'brickPips', label: 'Brick size', options: RENKO_PIP_OPTIONS, defval: '5', when: { key: 'mode', equals: 'pips' } },
      { kind: 'number', key: 'customBrickPips', label: 'Custom brick size (1–3,000; 0 = preset)', defval: 0, min: 0, max: 3000, step: 1, when: { key: 'mode', equals: 'pips' } },
      { kind: 'number', key: 'pipSize', label: 'Pip size override (price units, 0 = auto)', defval: 0, min: 0, step: 0.00001, when: { key: 'mode', equals: 'pips' } },
      { kind: 'number', key: 'boxSize', label: 'Fixed brick size', defval: 1, min: 0.000001, step: 0.01, when: { key: 'mode', equals: 'fixed' } },
      { kind: 'number', key: 'atrLength', label: 'ATR length', defval: 14, min: 1, max: 500, step: 1, when: { key: 'mode', equals: 'atr' } },
    ],
  },
};

const range: ChartTypeDefinition = {
  id: 'range',
  label: 'Range',
  basePainting: 'none',
  dataEngine: () => new PipBarDataEngine(buildRangeBars),
  settings: {
    title: 'Range bars',
    rows: [
      { kind: 'select', key: 'brickPips', label: 'Range size', options: RENKO_PIP_OPTIONS, defval: '5' },
      { kind: 'number', key: 'customBrickPips', label: 'Custom range (pips, 0 = preset)', defval: 0, min: 0, max: 3000, step: 1 },
      { kind: 'number', key: 'pipSize', label: 'Pip size override (price units, 0 = auto)', defval: 0, min: 0, step: 0.00001 },
    ],
  },
};

export function registerOrderFlowChartTypes() {
  if (registered) return;
  registered = true;
  registerChartType(renko);
  registerChartType(range);
  layer('renko', renderRenko);
  layer('range', renderRenko);
}

let registered = false;
