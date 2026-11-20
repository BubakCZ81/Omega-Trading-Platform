/**
 * TAP (Time At Price) chart style for Vela.
 *
 * Every price row contains elapsed milliseconds, derived from timestamped
 * ticks in the background process. This is deliberately not a synthetic TPO.
 *
 * Registered as a native chart type and renderer layer via the Vela Plugin SDK.
 */

import {
  registerChartType,
  registerRendererLayer,
  type OHLCV,
  type RendererLayerArgs,
} from './platform/index.ts';

export interface TpoBracket {
  index: number;
  price: number;
  topPrice: number;
  bottomPrice: number;
  durationMs: number;
  isPoc: boolean;
  inValueArea: boolean;
  isSinglePrint: boolean;
  label: string;
}

export interface TpoProfile {
  time: number;
  high: number;
  low: number;
  open: number;
  close: number;
  brackets: TpoBracket[];
  pocPrice: number;
  vahPrice: number;
  valPrice: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface TapPriceLevel { price: number; durationMs: number; }
export interface TapProfile { time: number; high: number; low: number; levels: TapPriceLevel[]; }
interface TapPayload { profiles: TapProfile[]; loading: boolean; }

export interface TpoSettings {
  rowCount?: number;
  style?: 'blocks' | 'letters';
  valueAreaPct?: number;
  showPoc?: boolean;
  showValueArea?: boolean;
  showSinglePrints?: boolean;
}

let activeTpoSettings: TpoSettings = {
  rowCount: 18,
  style: 'blocks',
  valueAreaPct: 70,
  showPoc: true,
  showValueArea: true,
  showSinglePrints: true,
};

export function getTpoSettings(): TpoSettings {
  return { ...activeTpoSettings };
}

export function setTpoSettings(settings: Partial<TpoSettings>): void {
  activeTpoSettings = { ...activeTpoSettings, ...settings };
}

/** Converts tick-derived time-at-price levels into visible price rows. */
export function buildTapProfile(
  bar: OHLCV,
  levels: readonly TapPriceLevel[],
  settings: TpoSettings = {},
): TpoProfile {
  const rowCount = Math.max(6, Math.min(48, Math.floor(Number(settings.rowCount) || 18)));
  const valueAreaPct = Math.max(50, Math.min(95, Number(settings.valueAreaPct) || 70)) / 100;

  const range = bar.high - bar.low;
  const step = range > 0 ? range / rowCount : 0.0001;

  const brackets: TpoBracket[] = [];
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  let pocIndex = 0;

  const midPrice = (bar.high + bar.low) / 2;

  const durationByRow = new Array<number>(rowCount).fill(0);
  for (const level of levels) {
    if (!Number.isFinite(level.price) || !Number.isFinite(level.durationMs) || level.durationMs <= 0) continue;
    const index = range > 0
      ? Math.max(0, Math.min(rowCount - 1, Math.floor((level.price - bar.low) / range * rowCount)))
      : 0;
    durationByRow[index] += level.durationMs;
  }

  for (let index = 0; index < rowCount; index += 1) {
    const bottomPrice = bar.low + index * step;
    const topPrice = bottomPrice + step;
    const price = (bottomPrice + topPrice) / 2;

    const durationMs = durationByRow[index];
    if (durationMs > maxDurationMs) {
      maxDurationMs = durationMs;
      pocIndex = index;
    }
    totalDurationMs += durationMs;

    brackets.push({
      index,
      price,
      topPrice,
      bottomPrice,
      durationMs,
      isPoc: false,
      inValueArea: false,
      isSinglePrint: false,
      label: durationMs >= 1000 ? `${(durationMs / 1000).toFixed(1)}s` : `${Math.round(durationMs)}ms`,
    });
  }

  // Mark Point of Control (POC)
  if (brackets[pocIndex]) {
    brackets[pocIndex].isPoc = true;
  }
  const pocPrice = brackets[pocIndex]?.price ?? midPrice;

  // Value Area contains the configured share of actual time at price.
  const targetVaDuration = totalDurationMs * valueAreaPct;
  let vaDurationAccumulated = brackets[pocIndex]?.durationMs ?? 0;
  if (brackets[pocIndex]) brackets[pocIndex].inValueArea = true;

  let upPointer = pocIndex + 1;
  let downPointer = pocIndex - 1;

  while (vaDurationAccumulated < targetVaDuration && (upPointer < rowCount || downPointer >= 0)) {
    const upDuration = upPointer < rowCount ? (brackets[upPointer]?.durationMs ?? 0) : 0;
    const downDuration = downPointer >= 0 ? (brackets[downPointer]?.durationMs ?? 0) : 0;

    if (upDuration >= downDuration && upPointer < rowCount) {
      vaDurationAccumulated += upDuration;
      brackets[upPointer].inValueArea = true;
      upPointer += 1;
    } else if (downPointer >= 0) {
      vaDurationAccumulated += downDuration;
      brackets[downPointer].inValueArea = true;
      downPointer -= 1;
    } else if (upPointer < rowCount) {
      vaDurationAccumulated += upDuration;
      brackets[upPointer].inValueArea = true;
      upPointer += 1;
    } else {
      break;
    }
  }

  const vaBrackets = brackets.filter(bracket => bracket.inValueArea);
  const vahPrice = vaBrackets.at(-1)?.topPrice ?? bar.high;
  const valPrice = vaBrackets[0]?.bottomPrice ?? bar.low;

  return {
    time: bar.time,
    high: bar.high,
    low: bar.low,
    open: bar.open,
    close: bar.close,
    brackets,
    pocPrice,
    vahPrice,
    valPrice,
    totalDurationMs,
    maxDurationMs,
  };
}

function createTapDataEngine() {
  let host: any = null;
  let stopped = true;
  let revision = 0;
  let profiles: TapProfile[] = [];
  let activeTicker = '';
  let lastBarTime = 0;
  let stopTicks: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof window.setTimeout> | null = null;
  const push = (loading: boolean) => host?.pushData({ profiles, loading } satisfies TapPayload);
  const clearLive = () => {
    stopTicks?.(); stopTicks = null;
    if (refreshTimer !== null) window.clearTimeout(refreshTimer);
    refreshTimer = null;
  };
  const mapProfiles = (raw: unknown[]): TapProfile[] => raw.flatMap(profile => {
    if (!profile || typeof profile !== 'object') return [];
    const item = profile as { time?: unknown; high?: unknown; low?: unknown; levels?: unknown };
    if (![item.time, item.high, item.low].every(value => Number.isFinite(Number(value))) || !Array.isArray(item.levels)) return [];
    return [{ time: Number(item.time), high: Number(item.high), low: Number(item.low), levels: item.levels.flatMap(level => {
      const value = level as { price?: unknown; durationMs?: unknown };
      return Number.isFinite(Number(value?.price)) && Number.isFinite(Number(value?.durationMs))
        ? [{ price: Number(value.price), durationMs: Math.max(0, Number(value.durationMs)) }] : [];
    }) }];
  });
  const refreshCurrent = async () => {
    if (stopped || !host || !activeTicker) return;
    const bar = host.bars().at(-1) as OHLCV | undefined;
    if (!bar) return;
    const raw = await window.velaMt5?.footprintProfiles?.({ ticker: activeTicker, profileType: 'tap', bars: [bar], nextBarTime: Date.now() });
    if (stopped || !raw || host.bars().at(-1)?.time !== bar.time) return;
    const [profile] = mapProfiles(raw);
    if (!profile) return;
    profiles = [...profiles.filter(item => item.time !== profile.time), profile];
    push(false);
  };
  const subscribeLive = () => {
    clearLive();
    const bridge = window.velaMt5;
    if (!bridge?.subscribeTicks || !activeTicker) return;
    stopTicks = bridge.subscribeTicks(activeTicker, () => {
      if (refreshTimer !== null) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = null;
        void refreshCurrent().catch(() => {});
      }, 250);
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
    const ticker = symbols.find(symbol => symbol.ticker.replace(/^(?:CTRADER|MT5):/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase()
      === host.symbol.replace(/^(?:CTRADER|MT5):/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase())?.ticker;
    if (!ticker || request !== revision || stopped) return push(false);
    activeTicker = ticker;
    lastBarTime = bars.at(-1)?.time ?? 0;
    const old = new Map(profiles.map(profile => [profile.time, profile]));
    profiles = bars.map((bar: OHLCV) => old.get(bar.time) ?? { time: bar.time, high: bar.high, low: bar.low, levels: [] });
    push(true);
    const raw = await bridge.footprintProfiles?.({ ticker, profileType: 'tap', bars: bars.slice(-300), nextBarTime: Date.now() });
    if (request !== revision || stopped) return;
    const byTime = new Map(mapProfiles(raw ?? []).map(profile => [profile.time, profile]));
    profiles = bars.map((bar: OHLCV) => byTime.get(bar.time) ?? old.get(bar.time) ?? { time: bar.time, high: bar.high, low: bar.low, levels: [] });
    push(false);
    subscribeLive();
  };
  return {
    start(nextHost: any) {
      // Do not carry time-at-price rows into a replacement timeframe while
      // its tick profile is still loading.
      profiles = [];
      activeTicker = '';
      lastBarTime = 0;
      host = nextHost;
      stopped = false;
      push(true);
      void load().catch(() => push(false));
    },
    suspend() { stopped = true; revision += 1; clearLive(); },
    resume() { stopped = false; void load().catch(() => push(false)); },
    stop() { stopped = true; revision += 1; clearLive(); host = null; },
    onBars() { if (!stopped && host && (host.bars().at(-1)?.time ?? 0) !== lastBarTime) void load().catch(() => push(false)); },
    onViewport() {},
  };
}

let registered = false;

/**
 * Registers the TAP chart type and its canvas renderer layer with Vela.
 */
export function registerTpoChartType(): void {
  if (registered) return;
  registered = true;

  registerChartType({
    id: 'tpo',
    label: 'Time At Price',
    basePainting: 'none',
    dataEngine: createTapDataEngine,
    settings: {
      title: 'Time At Price Settings',
      rows: [
        { kind: 'number', key: 'rowCount', label: 'Price Brackets', defval: 18, min: 8, max: 36, step: 2 },
        { kind: 'select', key: 'style', label: 'Block Style', options: [['blocks', 'Shaded Rectangles'], ['letters', 'Elapsed-Time Labels']], defval: 'blocks' },
        { kind: 'number', key: 'valueAreaPct', label: 'Value Area (%)', defval: 70, min: 50, max: 90, step: 5 },
        { kind: 'toggle', key: 'showPoc', label: 'Highlight POC (Point of Control)', defval: true },
        { kind: 'toggle', key: 'showValueArea', label: 'Show VAH / VAL Lines', defval: true },
        { kind: 'toggle', key: 'showSinglePrints', label: 'Highlight Single Prints (Tails)', defval: true },
      ],
    },
  });

  registerRendererLayer({
    id: 'tpo',
    placement: 'above-data',
    create: () => {
      let canvas: HTMLCanvasElement | null = null;

      return {
        mount(target) {
          canvas = target;
        },

        modulateBase: (args: RendererLayerArgs) => {
          if (args.priceStyle !== 'tpo') return null;
          // Hide standard candle body so TPO profile replaces it
          return { candleBodyScale: 0, candleBodyAlpha: 0 };
        },

        render(args: RendererLayerArgs) {
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          const dpr = args.coords.dpr || 1;
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);

          if (args.priceStyle !== 'tpo') return;
          if (!args.bars || args.bars.length === 0) return;

          const visibleRange = args.coords.visibleLogicalRange?.() ?? { from: 0, to: args.bars.length };
          const fromIndex = Math.max(0, Math.floor(visibleRange.from) - 1);
          const toIndex = Math.min(args.bars.length - 1, Math.ceil(visibleRange.to) + 1);
          if (toIndex < fromIndex) return;

          const pitch = args.coords.pxPerBar();
          const width = Math.max(4, pitch * 0.9);
          const settings = { ...activeTpoSettings, ...(args.settings as TpoSettings) };
          const showPoc = settings.showPoc ?? true;
          const showValueArea = settings.showValueArea ?? true;
          const showSinglePrints = settings.showSinglePrints ?? true;
          const isLabels = settings.style === 'letters' && width >= 36;
          const payload = args.data as TapPayload | undefined;
          const profilesByTime = new Map((payload?.profiles ?? []).map(profile => [profile.time, profile]));

          for (let index = fromIndex; index <= toIndex; index += 1) {
            const bar = args.bars[index];
            if (!bar) continue;

            const x = args.coords.logicalToX(index);
            const left = x - width / 2;
            const tapProfile = profilesByTime.get(bar.time);
            if (!tapProfile) continue;
            const profile = buildTapProfile(bar, tapProfile.levels, settings);

            // 1. Draw central reference wick
            const yHigh = args.coords.priceToY(bar.high, args.scale, args.bounds);
            const yLow = args.coords.priceToY(bar.low, args.scale, args.bounds);
            ctx.strokeStyle = args.theme.textColor ? `${args.theme.textColor}33` : 'rgba(255,255,255,0.18)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x, yHigh);
            ctx.lineTo(x, yLow);
            ctx.stroke();

            // 2. Draw elapsed-time price rows.
            for (const bracket of profile.brackets) {
              const yTop = args.coords.priceToY(bracket.topPrice, args.scale, args.bounds);
              const yBottom = args.coords.priceToY(bracket.bottomPrice, args.scale, args.bounds);
              // Preserve the dense, readable profile blocks of the original
              // TPO renderer even when a chart is vertically compressed.
              const rowHeight = Math.max(4, Math.abs(yBottom - yTop) - 0.5);
              const rowTop = Math.min(yTop, yBottom);

              const hasMeasuredTime = bracket.durationMs > 0;
              const ratio = profile.maxDurationMs > 0 ? bracket.durationMs / profile.maxDurationMs : 0;
              // Raw milliseconds have an extreme long-tail (a quiet last
              // price can persist seconds while adjacent prices last only a
              // few ms). Square-root scaling keeps the same ordering while
              // restoring a legible TPO-like profile shape.
              const blockWidth = Math.max(width * 0.42, Math.sqrt(ratio) * width);
              // The Value Area is deliberately one pixel taller than the
              // normal TAP row so its accepted-price region reads clearly.
              const paintTop = bracket.inValueArea ? rowTop - 0.5 : rowTop;
              const paintHeight = rowHeight + (bracket.inValueArea ? 1 : 0);

              // Color determination
              if (bracket.isPoc && showPoc && hasMeasuredTime) {
                // Gold / Amber for Point of Control
                ctx.fillStyle = '#f59e0b';
                ctx.strokeStyle = '#fbbf24';
              } else if (bracket.isSinglePrint && showSinglePrints) {
                // Vivid Purple for single print rejection tails
                ctx.fillStyle = '#c084fc';
                ctx.strokeStyle = '#d8b4fe';
              } else if (bracket.inValueArea && hasMeasuredTime) {
                // Vibrant Cyan / Blue for Value Area
                ctx.fillStyle = '#38bdf8';
                ctx.strokeStyle = '#7dd3fc';
              } else {
                // Muted Slate for outside Value Area
                ctx.fillStyle = '#64748b';
                ctx.strokeStyle = '#94a3b8';
              }

              if (isLabels && hasMeasuredTime && rowHeight >= 12 && width >= 36) {
                // Draw actual elapsed time, never synthetic TPO letters.
                ctx.font = '600 10px Consolas, monospace';
                ctx.fillText(bracket.label, left, paintTop + paintHeight * 0.82);
              } else {
                // Clean shaded horizontal rectangle
                // Keep the complete price-range silhouette from the original
                // TPO blocks. Measured TAP duration controls the width and
                // highlights, while untouched brackets remain a quiet guide.
                ctx.globalAlpha = hasMeasuredTime
                  ? (bracket.isPoc ? 0.95 : bracket.inValueArea ? 0.75 : 0.52)
                  : 0.20;
                ctx.fillRect(left, paintTop, blockWidth, paintHeight);
                ctx.globalAlpha = 1.0;
              }

              // POC highlight box outline
              if (bracket.isPoc && showPoc && hasMeasuredTime) {
                ctx.lineWidth = 1.5;
                ctx.strokeRect(left, paintTop, blockWidth, paintHeight);
              }
            }

            // 3. Draw VAH / VAL level markers
            if (showValueArea) {
              const yVah = args.coords.priceToY(profile.vahPrice, args.scale, args.bounds);
              const yVal = args.coords.priceToY(profile.valPrice, args.scale, args.bounds);

              ctx.strokeStyle = '#38bdf8';
              ctx.lineWidth = 1;
              ctx.setLineDash([2, 2]);

              ctx.beginPath();
              ctx.moveTo(left, yVah);
              ctx.lineTo(left + width, yVah);
              ctx.moveTo(left, yVal);
              ctx.lineTo(left + width, yVal);
              ctx.stroke();
              ctx.setLineDash([]);
            }
          }
        },
      };
    },
  });
}

