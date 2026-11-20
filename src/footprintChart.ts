/** DOM pip-movement footprint renderer. */
import { registerChartType, registerRendererLayer, type OHLCV, type RendererLayerArgs } from './platform';
import { inferPipSize } from './pipSize';

export interface FootprintLevel { price: number; downPips: number; upPips: number; }
export interface FootprintProfile { time: number; high: number; low: number; levels: FootprintLevel[]; }
interface FootprintPayload { profiles: FootprintProfile[]; loading: boolean; }
export interface FootprintSettings {
  rowCount?: number; mode?: 'bidask' | 'delta' | 'profile'; fontSize?: number;
  textMaxVisibleCandles?: number;
  bullTextColor?: string; bearTextColor?: string; bullColor?: string; bearColor?: string;
  showPoc?: boolean; pocColor?: string; pocLineWidth?: number;
}

let settings: FootprintSettings = {
  rowCount: 10, mode: 'bidask', fontSize: 14, textMaxVisibleCandles: 10, showPoc: true,
  bullColor: '#22c55e', bearColor: '#ef4444', pocColor: '#eab308', pocLineWidth: 2,
};
export const getFootprintSettings = (): FootprintSettings => ({ ...settings });
export const setFootprintSettings = (next: Partial<FootprintSettings>): void => { settings = { ...settings, ...next }; };

type Tick = { time: number; bid: number; ask: number; last: number; volume: number; volumeReal: number; flags: number };
const cleanSymbol = (value: string) => value.replace(/^(?:CTRADER|MT5):/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
const tickPrice = (tick: Tick) => tick.last > 0 ? tick.last : tick.bid > 0 && tick.ask >= tick.bid ? (tick.bid + tick.ask) / 2 : tick.bid || tick.ask;

/** Converts the DOM tick path into directional distance travelled at every price. */
export function buildFootprintProfile(bar: OHLCV, ticks: readonly Tick[], pipSize: number): FootprintProfile {
  const levels = new Map<number, FootprintLevel>();
  let previous = bar.open;
  let previousDirection = 0;
  for (const tick of ticks) {
    const raw = tickPrice(tick);
    const price = Number(raw.toPrecision(12));
    if (!Number.isFinite(price) || price <= 0) continue;
    const direction = previous === 0 ? 0 : price > previous ? 1 : price < previous ? -1 : previousDirection;
    if (direction) {
      const row = levels.get(price) ?? { price, downPips: 0, upPips: 0 };
      const moved = Math.abs(price - previous) / pipSize;
      if (direction > 0) row.upPips += moved; else row.downPips += moved;
      levels.set(price, row);
    }
    if (price !== previous) previousDirection = direction;
    previous = price;
  }
  return { time: bar.time, high: bar.high, low: bar.low, levels: [...levels.values()] };
}

function createDataEngine() {
  let host: any = null;
  let stopped = true;
  let revision = 0;
  let profiles: FootprintProfile[] = [];
  let stopTicks: (() => void) | null = null;
  let activeTicker = '';
  let pipSize = 0;
  let lastBarTime = 0;
  let queuedTicks: Tick[] = [];
  let queuedBar: OHLCV | null = null;
  let liveTimer: ReturnType<typeof window.setTimeout> | null = null;
  let liveRequestActive = false;
  const push = (loading: boolean) => host?.pushData({ profiles, loading } satisfies FootprintPayload);
  const unsubscribe = () => {
    stopTicks?.(); stopTicks = null;
    if (liveTimer !== null) window.clearTimeout(liveTimer);
    liveTimer = null; queuedTicks = []; queuedBar = null; liveRequestActive = false;
  };
  const flushLiveProfile = () => {
    liveTimer = null;
    if (liveRequestActive || stopped || !host || !queuedBar || !queuedTicks.length) return;
    const bar = queuedBar;
    const ticks = queuedTicks;
    queuedBar = null;
    queuedTicks = [];
    liveRequestActive = true;
    // Coalesce fast tick bursts. At most one compact paint payload is sent per
    // 100 ms, independently of how many broker ticks arrived in that interval.
    void window.velaMt5?.footprintLiveProfile?.({ ticker: activeTicker, pipSize, bar, ticks }).then(profile => {
      if (stopped || !profile || host?.bars().at(-1)?.time !== bar.time) return;
      profiles = profiles.filter(existing => existing.time !== bar.time);
      profiles.push(profile);
      push(false);
    }).catch(() => {}).finally(() => {
      liveRequestActive = false;
      if (queuedTicks.length && liveTimer === null) liveTimer = window.setTimeout(flushLiveProfile, 100);
    });
  };
  const load = async () => {
    const request = ++revision;
    if (!host || stopped) return;
    const bars = host.bars().filter((bar: OHLCV) => [bar.time, bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
    if (!bars.length) return push(true);
    const bridge = window.velaMt5;
    if (!bridge) return push(false);
    const symbols = await bridge.symbols();
    const descriptor = symbols.find(symbol => cleanSymbol(symbol.ticker) === cleanSymbol(host.symbol));
    if (!descriptor || request !== revision || stopped) return push(false);
    const info = await bridge.info(descriptor.ticker);
    const point = Number(info?.point);
    const digits = Number(info?.digits);
    pipSize = inferPipSize(descriptor.ticker) ?? (point > 0 ? ((digits === 3 || digits === 5) ? point * 10 : point) : 0);
    if (!pipSize || request !== revision || stopped) return push(false);
    activeTicker = descriptor.ticker;
    lastBarTime = bars.at(-1)?.time ?? 0;
    const old = new Map(profiles.map(profile => [profile.time, profile]));
    profiles = bars.map((bar: OHLCV) => old.get(bar.time) ?? { time: bar.time, high: bar.high, low: bar.low, levels: [] });
    push(true);
    // MT5 retrieval, tick caching and profile aggregation run in Electron's
    // dedicated footprint worker. The renderer only receives ready-to-paint data.
    const selected = bars.slice(Math.max(0, bars.length - 300));
    const calculated = await bridge.footprintProfiles?.({
      ticker: activeTicker,
      pipSize,
      bars: selected,
      nextBarTime: Date.now() + 2_000,
    });
    if (request !== revision || stopped) return;
    if (Array.isArray(calculated)) {
      const calculatedByTime = new Map(calculated.map(profile => [profile.time, profile]));
      profiles = bars.map((bar: OHLCV) => calculatedByTime.get(bar.time) ?? old.get(bar.time) ?? {
        time: bar.time, high: bar.high, low: bar.low, levels: [],
      });
    }
    push(false);
    unsubscribe();
    if (bridge.subscribeTicks) {
      let lastTickTime = 0;
      stopTicks = bridge.subscribeTicks(activeTicker, incoming => {
        if (stopped || !host || !pipSize) return;
        const bar = host.bars().at(-1) as OHLCV | undefined;
        if (!bar) return;
        const fresh = (incoming as Tick[]).filter(tick => tick.time >= bar.time && tick.time > lastTickTime);
        if (!fresh.length) return;
        lastTickTime = Math.max(lastTickTime, ...fresh.map(tick => tick.time));
        if (bar.time !== lastBarTime) {
          lastBarTime = bar.time;
          queuedTicks = [];
        }
        queuedBar = bar;
        queuedTicks.push(...fresh);
        if (liveTimer === null && !liveRequestActive) liveTimer = window.setTimeout(flushLiveProfile, 100);
      });
    }
  };
  return {
    start(nextHost: any) {
      // A new market/timeframe must never inherit profile rows that share a
      // timestamp with the old series while the replacement bars are loading.
      profiles = [];
      activeTicker = '';
      lastBarTime = 0;
      host = nextHost;
      stopped = false;
      push(true);
      void load().catch(() => push(false));
    },
    suspend() { stopped = true; revision += 1; unsubscribe(); },
    resume() { stopped = false; void load().catch(() => push(false)); },
    stop() { stopped = true; revision += 1; unsubscribe(); host = null; },
    onBars() {
      if (stopped || !host) return;
      const newestBarTime = host.bars().at(-1)?.time ?? 0;
      // A forming-bar update is already handled by the tick stream. Reload only
      // when the chart adds/prepends bars or starts a genuinely new candle.
      if (newestBarTime !== lastBarTime) void load().catch(() => push(false));
    },
    onViewport() { /* Rendering already applies one shared scale to the current viewport. */ },
  };
}

interface PriceRow { top: number; bottom: number; down: number; up: number; }
function rowsFor(profile: FootprintProfile, count: number): PriceRow[] {
  const range = Math.max(Number.EPSILON, profile.high - profile.low);
  const step = range / count;
  const rows = Array.from({ length: count }, (_, index) => ({ bottom: profile.low + index * step, top: profile.low + (index + 1) * step, down: 0, up: 0 }));
  for (const level of profile.levels) {
    const index = Math.max(0, Math.min(count - 1, Math.floor((level.price - profile.low) / range * count)));
    rows[index].down += Math.max(0, level.downPips);
    rows[index].up += Math.max(0, level.upPips);
  }
  return rows;
}
const label = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value >= 100 ? value.toFixed(0) : value.toFixed(1);

function drawFootprintLoadingRing(context: CanvasRenderingContext2D, args: RendererLayerArgs, bar: OHLCV, index: number): void {
  const x = args.coords.logicalToX(index);
  const y = (args.coords.priceToY(bar.high, args.scale, args.bounds) + args.coords.priceToY(bar.low, args.scale, args.bounds)) / 2;
  const radius = Math.max(4, Math.min(10, args.coords.pxPerBar() * 0.18));
  const angle = (args.nowMs / 260) % (Math.PI * 2);
  context.save();
  context.strokeStyle = args.theme.textColor;
  context.globalAlpha = 0.72;
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(x, y, radius, angle, angle + Math.PI * 1.45);
  context.stroke();
  context.restore();
}

function defaultFootprintTextColor(background: string | undefined): '#000000' | '#ffffff' {
  const hex = /^#([0-9a-f]{6})$/i.exec(background ?? '');
  if (hex) {
    const value = Number.parseInt(hex[1], 16);
    const red = value >> 16;
    const green = (value >> 8) & 0xff;
    const blue = value & 0xff;
    return red * 0.299 + green * 0.587 + blue * 0.114 < 128 ? '#ffffff' : '#000000';
  }
  return '#ffffff';
}

let registered = false;
export function registerFootprintChartType(): void {
  if (registered) return;
  registered = true;
  registerChartType({
    id: 'footprint', label: 'DOM Pip Footprint', basePainting: 'none', dataEngine: createDataEngine,
    settings: { title: 'Footprint Settings', rows: [
      { kind: 'number', key: 'rowCount', label: 'Price Rows', defval: 10, min: 4, max: 32, step: 1 },
      { kind: 'select', key: 'mode', label: 'Display Mode', options: [['bidask', 'Down × Up pips'], ['delta', 'Delta'], ['profile', 'Total pips']], defval: 'bidask' },
      { kind: 'number', key: 'fontSize', label: 'Font Size (px)', defval: 14, min: 8, max: 18, step: 1 },
      { kind: 'number', key: 'textMaxVisibleCandles', label: 'Show Text Up To Candles on Screen', defval: 10, min: 1, max: 200, step: 1 },
      { kind: 'color', key: 'bullColor', label: 'Up Rectangle Color', defval: '#22c55e' },
      { kind: 'color', key: 'bearColor', label: 'Down Rectangle Color', defval: '#ef4444' },
      { kind: 'color', key: 'pocColor', label: 'POC Outline Color', defval: '#eab308' },
      { kind: 'number', key: 'pocLineWidth', label: 'POC Outline Thickness', defval: 2, min: 1, max: 5, step: 0.5 },
    ] },
  });
  registerRendererLayer({ id: 'footprint', placement: 'above-data', create: () => {
    let canvas: HTMLCanvasElement | null = null;
    let loading = false;
    return {
      mount(target) { canvas = target; },
      animating: () => loading,
      render(args: RendererLayerArgs) {
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        const dpr = args.coords.dpr || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
        if (args.priceStyle !== 'footprint' || !args.bars.length) return;
        const payload = args.data as FootprintPayload | undefined;
        // Keep rings visible until at least one real DOM-pip row exists. A
        // broker can return an empty historical tick batch before its archive
        // becomes available; that must not look like an empty chart.
        loading = Boolean(payload?.loading) || !(payload?.profiles.some(profile => profile.levels.length > 0));
        const visible = args.coords.visibleLogicalRange?.() ?? { from: 0, to: args.bars.length };
        const from = Math.max(0, Math.floor(visible.from) - 1);
        const to = Math.min(args.bars.length - 1, Math.ceil(visible.to) + 1);
        const current = { ...settings, ...(args.settings as FootprintSettings) };
        const rowCount = Math.max(4, Math.min(32, Number(current.rowCount) || 10));
        const byTime = new Map((payload?.profiles ?? []).map(profile => [profile.time, profile]));
        const chartRows = new Map<number, PriceRow[]>();
        let maximumPips = 0;
        // One maximum across the entire viewport: a large DOM move shrinks ALL rows together.
        for (let index = from; index <= to; index += 1) {
          const profile = byTime.get(args.bars[index]?.time);
          if (!profile) continue;
          const rows = rowsFor(profile, rowCount);
          chartRows.set(index, rows);
          for (const row of rows) maximumPips = Math.max(maximumPips, row.down, row.up);
        }
        if (!chartRows.size || maximumPips <= 0) {
          if (loading) for (let index = from; index <= to; index += 1) {
            const bar = args.bars[index];
            if (bar) drawFootprintLoadingRing(ctx, args, bar, index);
          }
          return;
        }
        const pitch = Math.max(1, args.coords.pxPerBar());
        const width = Math.max(6, pitch * 0.9);
        const half = Math.max(2, width / 2 - 1);
        const pixelsPerPip = half / maximumPips;
        const fontSize = Math.max(7, Math.min(18, Number(current.fontSize) || 14));
        // Use one chart-wide candle-count threshold. It deliberately never
        // depends on an individual row's rectangle width, so labels cannot
        // disappear selectively while the user is at the same zoom level.
        const visibleCandleCount = Math.max(0, to - from + 1);
        const textMaxVisibleCandles = Math.max(1, Math.min(200, Number(current.textMaxVisibleCandles) || 10));
        const showText = visibleCandleCount <= textMaxVisibleCandles;
        const themeText = defaultFootprintTextColor(args.theme.background);
        const bullText = current.bullTextColor || themeText;
        const bearText = current.bearTextColor || themeText;
        ctx.save(); ctx.beginPath(); ctx.rect(0, args.bounds.top, args.coords.width, args.bounds.height); ctx.clip();
        for (const [index, rows] of chartRows) {
          const x = Math.round(args.coords.logicalToX(index));
          let poc: PriceRow | undefined;
          for (const row of rows) {
            if (!poc || row.down + row.up > poc.down + poc.up) poc = row;
            const y1 = args.coords.priceToY(row.top, args.scale, args.bounds);
            const y2 = args.coords.priceToY(row.bottom, args.scale, args.bounds);
            const top = Math.min(y1, y2), height = Math.max(1, Math.abs(y2 - y1) - 1);
            const leftWidth = Math.min(half, row.down * pixelsPerPip);
            const rightWidth = Math.min(half, row.up * pixelsPerPip);
            if (current.mode === 'delta') {
              const delta = row.up - row.down, block = Math.min(width - 2, Math.abs(delta) * pixelsPerPip * 2);
              ctx.fillStyle = delta >= 0 ? current.bullColor! : current.bearColor!;
              if (block) ctx.fillRect(x - block / 2, top, block, height);
            } else if (current.mode === 'profile') {
              const block = Math.min(width - 2, (row.up + row.down) * pixelsPerPip);
              ctx.fillStyle = row.up >= row.down ? current.bullColor! : current.bearColor!;
              if (block) ctx.fillRect(x - block / 2, top, block, height);
            } else {
              if (leftWidth) { ctx.fillStyle = current.bearColor!; ctx.fillRect(x - leftWidth, top, leftWidth, height); }
              if (rightWidth) { ctx.fillStyle = current.bullColor!; ctx.fillRect(x, top, rightWidth, height); }
              if (showText) {
                ctx.font = `700 ${fontSize}px Consolas, monospace`; ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
                // Numbers sit just inside each rectangle's OUTER edge:
                // down-pip text on the left, up-pip text on the right.
                if (leftWidth > 0) {
                  ctx.fillStyle = bearText;
                  ctx.textAlign = 'left';
                  ctx.fillText(label(row.down), x - leftWidth + 2, top + height / 2);
                }
                if (rightWidth > 0) {
                  ctx.fillStyle = bullText;
                  ctx.textAlign = 'right';
                  ctx.fillText(label(row.up), x + rightWidth - 2, top + height / 2);
                }
              }
            }
          }
          if (poc && current.showPoc !== false) {
            const y1 = args.coords.priceToY(poc.top, args.scale, args.bounds), y2 = args.coords.priceToY(poc.bottom, args.scale, args.bounds);
            ctx.strokeStyle = current.pocColor || '#eab308';
            ctx.lineWidth = Math.max(1, Math.min(5, Number(current.pocLineWidth) || 2));
            ctx.strokeRect(x - half, Math.min(y1, y2), half * 2, Math.max(1, Math.abs(y2 - y1) - 1));
          }
          const delta = rows.reduce((total, row) => total + row.up - row.down, 0);
          const topY = args.coords.priceToY(rows.at(-1)!.top, args.scale, args.bounds);
          const bottomY = args.coords.priceToY(rows[0].bottom, args.scale, args.bounds);
          let deltaY = Math.max(topY, bottomY) + fontSize + 3;
          if (deltaY > args.bounds.top + args.bounds.height - 2) deltaY = Math.min(topY, bottomY) - 3;
          if (showText && deltaY >= args.bounds.top && deltaY <= args.bounds.top + args.bounds.height) {
            ctx.font = `700 ${fontSize + 2}px Consolas, monospace`;
            ctx.textBaseline = deltaY > Math.max(topY, bottomY) ? 'top' : 'bottom';
            ctx.textAlign = 'center';
            ctx.fillStyle = delta >= 0 ? '#166534' : '#7f1d1d';
            ctx.fillText(`${delta >= 0 ? '▲' : '▼'} ${label(Math.abs(delta))}`, x, deltaY, width + 20);
          }
        }
        if (loading) {
          for (let index = from; index <= to; index += 1) {
            if (chartRows.has(index)) continue;
            const bar = args.bars[index];
            if (bar) drawFootprintLoadingRing(ctx, args, bar, index);
          }
        }
        ctx.restore();
      },
    };
  } });
}
