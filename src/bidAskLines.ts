import {
  registerNativeIndicator,
  registerRendererLayer,
  type IndicatorHandle,
  type NativeIndicatorContext,
  type RendererLayerArgs,
  type Vela,
} from '@luxalgo/vela';
import { inferPipSize } from './pipSize.ts';
import { decimalPlaces } from './spreadFormatting.ts';

const LAYER_ID = 'bid-ask-lines';
const REFRESH_INTERVAL_MS = 2_000;
const STALE_QUOTE_INTERVAL_MS = 60_000;
/** Backoff used once a provider has failed repeatedly, so a dead feed cannot spam. */
const FAILED_REFRESH_INTERVAL_MS = 60_000;

interface BidAskQuote {
  bid: number;
  ask: number;
  digits: number;
  stale: boolean;
  bidColor: string;
  askColor: string;
  lineWidth: number;
  lineStyle: BidAskLineStyle['lineStyle'];
}

interface QuoteResponse {
  bid: number;
  ask: number;
  timeMsc?: number;
}

export function resolveBidAskDigits(ticker: string, info?: Record<string, unknown>): number {
  const digits = Number(info?.digits ?? NaN);
  if (Number.isInteger(digits) && digits >= 0 && digits <= 20) return digits;
  for (const field of ['minTick', 'mintick', 'tradeTickSize', 'tickSize']) {
    const tick = Number(info?.[field]);
    if (Number.isFinite(tick) && tick > 0) return decimalPlaces(tick);
  }
  const pip = inferPipSize(ticker);
  return pip === null ? 2 : decimalPlaces(pip) + 1;
}

export interface BidAskLineStyle {
  bidColor: string;
  askColor: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
}

export const BID_ASK_COLOR_OPTIONS = [
  ['#26a69a', 'Green'],
  ['#ef5350', 'Red'],
  ['#2962ff', 'Blue'],
  ['#ff9800', 'Orange'],
  ['#ab47bc', 'Purple'],
  ['#ffffff', 'White'],
] as const;

export const BID_ASK_WIDTH_OPTIONS = [1, 2, 3, 4, 5] as const;
export const BID_ASK_STYLE_OPTIONS = [
  ['solid', 'Solid'],
  ['dashed', 'Dashed'],
  ['dotted', 'Dotted'],
] as const;

const BID_COLOR_KEY = 'vela_bid_ask_bid_color';
const ASK_COLOR_KEY = 'vela_bid_ask_ask_color';
const WIDTH_KEY = 'vela_bid_ask_line_width';
const STYLE_KEY = 'vela_bid_ask_line_style';

export function loadBidAskLineStyle(): BidAskLineStyle {
  const colors = BID_ASK_COLOR_OPTIONS.map(([color]) => color);
  const storedBid = localStorage.getItem(BID_COLOR_KEY);
  const storedAsk = localStorage.getItem(ASK_COLOR_KEY);
  const storedWidth = Number(localStorage.getItem(WIDTH_KEY) ?? '1');
  const storedStyle = localStorage.getItem(STYLE_KEY);
  return {
    bidColor: storedBid && colors.includes(storedBid as typeof colors[number]) ? storedBid : BID_ASK_COLOR_OPTIONS[0][0],
    askColor: storedAsk && colors.includes(storedAsk as typeof colors[number]) ? storedAsk : BID_ASK_COLOR_OPTIONS[1][0],
    lineWidth: BID_ASK_WIDTH_OPTIONS.includes(storedWidth as typeof BID_ASK_WIDTH_OPTIONS[number]) ? storedWidth : 1,
    lineStyle: BID_ASK_STYLE_OPTIONS.some(([style]) => style === storedStyle)
      ? storedStyle as BidAskLineStyle['lineStyle']
      : 'dashed',
  };
}

function saveBidAskLineStyle(style: BidAskLineStyle) {
  localStorage.setItem(BID_COLOR_KEY, style.bidColor);
  localStorage.setItem(ASK_COLOR_KEY, style.askColor);
  localStorage.setItem(WIDTH_KEY, String(style.lineWidth));
  localStorage.setItem(STYLE_KEY, style.lineStyle);
}

export function isQuoteResponse(value: unknown): value is QuoteResponse {
  if (!value || typeof value !== 'object') return false;
  const quote = value as Record<string, unknown>;
  return typeof quote.bid === 'number'
    && Number.isFinite(quote.bid)
    && typeof quote.ask === 'number'
    && Number.isFinite(quote.ask)
    && quote.bid !== 0
    && quote.ask !== 0
    && quote.ask >= quote.bid;
}

export function isCurrentBidAskQuote(quote: QuoteResponse): boolean {
  return quote.timeMsc === undefined || (Number.isFinite(quote.timeMsc)
    && quote.timeMsc > 0 && Date.now() - quote.timeMsc <= STALE_QUOTE_INTERVAL_MS);
}

export async function fetchBidAskQuote(
  provider: string,
  ticker: string,
  signal: AbortSignal,
  instance?: { getQuote?: (ticker: string) => Promise<QuoteResponse | null> },
  allowLastQuote = false,
): Promise<QuoteResponse | null> {
  signal.throwIfAborted();
  if (instance?.getQuote) {
    const quote = await instance.getQuote(ticker);
    signal.throwIfAborted();
    return isQuoteResponse(quote) && (allowLastQuote || isCurrentBidAskQuote(quote)) ? quote : null;
  }
  const symbol = ticker.toUpperCase();
  let response: Response;

  if (provider === 'mt5') {
    if (!window.velaMt5) throw new Error('MetaTrader quotes are available only in the Omega desktop app.');
    const quote = await window.velaMt5.quote(ticker);
    return isQuoteResponse(quote) && (allowLastQuote || isCurrentBidAskQuote(quote)) ? quote : null;
  }

  if (provider === 'coinbase') {
    response = await fetch(`https://api.exchange.coinbase.com/products/${encodeURIComponent(symbol)}/ticker`, { signal });
    if (!response.ok) throw new Error(`Coinbase quote request failed (${response.status}).`);
    const data = await response.json() as { bid?: string; ask?: string };
    const quote = { bid: Number(data.bid), ask: Number(data.ask) };
    return isQuoteResponse(quote) ? quote : null;
  }

  if (provider === 'hyperliquid') {
    response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'l2Book', coin: symbol }),
      signal,
    });
    if (!response.ok) throw new Error(`Hyperliquid quote request failed (${response.status}).`);
    const data = await response.json() as { levels?: Array<Array<{ px?: string }>> };
    const quote = {
      bid: Number(data.levels?.[0]?.[0]?.px),
      ask: Number(data.levels?.[1]?.[0]?.px),
    };
    return isQuoteResponse(quote) ? quote : null;
  }

  return null;
}

export function positionQuoteLabels(askY: number, bidY: number, top: number, height: number): [number, number] {
  const inset = Math.min(9, height / 2);
  const upper = top + inset;
  const lower = top + height - inset;
  const gap = Math.min(18, lower - upper);
  const clamp = (y: number) => Math.max(upper, Math.min(lower, y));
  const ask = clamp(askY);
  const bid = clamp(bidY);
  if (Math.abs(bid - ask) >= gap) return [ask, bid];
  const first = Math.min(clamp((ask + bid - gap) / 2), lower - gap);
  return askY <= bidY ? [first, first + gap] : [first + gap, first];
}

registerRendererLayer({
  id: LAYER_ID,
  placement: 'above-data',
  create: () => {
    let canvas: HTMLCanvasElement;
    let context: CanvasRenderingContext2D | null = null;
    const badges: HTMLSpanElement[] = [];
    return {
      mount: mountedCanvas => {
        canvas = mountedCanvas;
        context = canvas.getContext('2d');
        for (const side of ['ask', 'bid']) {
          const badge = document.createElement('span');
          badge.className = 'omega-bid-ask-badge';
          badge.dataset.side = side;
          badge.hidden = true;
          canvas.parentElement?.append(badge);
          badges.push(badge);
        }
      },
      render: ({ data, coords, bounds, scale }: RendererLayerArgs) => {
        if (!context) return;
        context.setTransform(coords.dpr, 0, 0, coords.dpr, 0, 0);
        context.clearRect(0, 0, canvas.width / coords.dpr, canvas.height / coords.dpr);
        const quote = data as BidAskQuote | null | undefined;
        const askY = quote ? coords.priceToY(quote.ask, scale, bounds) : NaN;
        const bidY = quote ? coords.priceToY(quote.bid, scale, bounds) : NaN;
        if (!quote || !Number.isFinite(askY) || !Number.isFinite(bidY) || bounds.height <= 0) {
          for (const badge of badges) badge.hidden = true;
          return;
        }
        const positions = positionQuoteLabels(askY, bidY, bounds.top, bounds.height);
        const lines = [
          { name: 'ASK', price: quote.ask, y: askY, color: quote.askColor },
          { name: 'BID', price: quote.bid, y: bidY, color: quote.bidColor },
        ];
        context.save();
        context.lineWidth = quote.lineWidth;
        context.globalAlpha = quote.stale ? 0.6 : 1;
        context.setLineDash(quote.lineStyle === 'solid' ? [] : quote.lineStyle === 'dotted' ? [2, 3] : [5, 4]);
        lines.forEach((line, index) => {
          const bottom = bounds.top + bounds.height;
          const edge = line.y < bounds.top ? ' ↑' : line.y > bottom ? ' ↓' : '';
          if (!edge) {
            context!.strokeStyle = line.color;
            context!.beginPath();
            context!.moveTo(0, line.y);
            context!.lineTo(coords.width, line.y);
            context!.stroke();
          }
          const badge = badges[index];
          badge.hidden = false;
          const label = `${quote.stale ? 'LAST ' : ''}${line.name} ${line.price.toFixed(quote.digits)}${edge}`;
          if (badge.textContent !== label) badge.textContent = label;
          badge.style.backgroundColor = line.color;
          badge.style.top = `${positions[index]}px`;
          badge.style.right = `${Math.max(0, canvas.clientWidth - coords.width - 76)}px`;
        });
        context.restore();
      },
      destroy: () => { for (const badge of badges) badge.remove(); },
    };
  },
});

registerNativeIndicator({
  type: LAYER_ID,
  title: 'Bid and Ask',
  shortTitle: 'Bid/Ask',
  paneHint: 'price',
  overlay: true,
  legend: false,
  inputsSchema: () => [],
  defaultInputs: () => ({}),
  create: () => {
    let context: NativeIndicatorContext | undefined;
    let timer: number | undefined;
    let request: AbortController | undefined;
    let stopTickStream: (() => void) | undefined;
    let warnedFor = '';
    let consecutiveFailures = 0;
    let running = false;
    let generation = 0;
    let subscribedTicker = '';
    let liveTickSequence = 0;
    let lastLiveTickAt = 0;
    let precision: { key: string; digits: number; lastQuote: QuoteResponse | null; retryAt: number } | undefined;

    const stopPolling = () => {
      running = false;
      generation++;
      window.clearTimeout(timer);
      request?.abort();
      stopTickStream?.();
      stopTickStream = undefined;
      subscribedTicker = '';
      lastLiveTickAt = 0;
      precision = undefined;
    };

    const publish = (ctx: NativeIndicatorContext, quote: QuoteResponse | null) => {
      if (precision) precision.lastQuote = quote;
      ctx.pushData(quote && precision
        ? { ...quote, ...loadBidAskLineStyle(), digits: precision.digits, stale: !isCurrentBidAskQuote(quote) }
        : null);
    };

    const poll = async (ctx: NativeIndicatorContext, currentGeneration: number) => {
      if (!running || currentGeneration !== generation) return;
      if (!ctx.live) { publish(ctx, null); return; }
      const resolved = ctx.data.resolve(ctx.symbol);
      if (!resolved) {
        stopTickStream?.();
        stopTickStream = undefined;
        subscribedTicker = '';
        lastLiveTickAt = 0;
        precision = undefined;
        publish(ctx, null);
      } else {
        const ticker = resolved.ticker;
        const key = `${resolved.provider}:${ticker}`;
        if (precision?.key !== key) {
          precision = { key, digits: resolveBidAskDigits(ticker), lastQuote: null, retryAt: 0 };
          publish(ctx, null);
        }
        const activePrecision = precision;
        if (Date.now() >= activePrecision.retryAt) {
          activePrecision.retryAt = Infinity;
          void ctx.data.symbolInfo(ctx.symbol).then(info => {
            if (activePrecision !== precision) return;
            activePrecision.retryAt = info ? Infinity : Date.now() + FAILED_REFRESH_INTERVAL_MS;
            const digits = resolveBidAskDigits(ticker, info);
            if (digits === activePrecision.digits) return;
            activePrecision.digits = digits;
            publish(ctx, activePrecision.lastQuote);
          }).catch(() => {
            activePrecision.retryAt = Date.now() + FAILED_REFRESH_INTERVAL_MS;
          });
        }
        const instance = ctx.data.providerInstance(resolved.provider) as Parameters<typeof fetchBidAskQuote>[3];
        const bridge = resolved.provider === 'mt5' ? window.velaMt5 : undefined;
        const tickBridge = bridge as typeof bridge & {
          subscribeTicks?: (symbol: string, callback: (ticks: Array<{ bid: number; ask: number; time: number }>) => void) => () => void;
        };
        let seededStream = false;
        if (tickBridge?.subscribeTicks) {
          try {
            if (subscribedTicker !== ticker) {
              stopTickStream?.();
              stopTickStream = undefined;
              subscribedTicker = ticker;
              stopTickStream = tickBridge.subscribeTicks(ticker, ticks => {
                if (!running || currentGeneration !== generation || !Array.isArray(ticks)) return;
                for (let index = ticks.length - 1; index >= 0; index--) {
                  const tick = ticks[index];
                  const quote = { bid: tick?.bid, ask: tick?.ask, timeMsc: tick?.time };
                  if (isQuoteResponse(quote) && isCurrentBidAskQuote(quote)) {
                    liveTickSequence++;
                    lastLiveTickAt = Date.now();
                    publish(ctx, quote);
                    break;
                  }
                }
              });
              // Seed the line immediately; subsequent MT5 updates arrive on the tick stream.
              request?.abort();
              request = new AbortController();
              seededStream = true;
              const sequenceBeforeSeed = liveTickSequence;
              try {
                const quote = await fetchBidAskQuote(resolved.provider, ticker, request.signal, instance, true);
                if (running && currentGeneration === generation && sequenceBeforeSeed === liveTickSequence) publish(ctx, quote);
              } catch (error) {
                if (!(error instanceof DOMException && error.name === 'AbortError')) {
                  console.warn(`Could not load the initial MT5 quote for ${ticker}:`, error);
                }
              }
            }
          } catch (error) {
            console.warn(`Could not subscribe to MT5 quotes for ${ticker}; falling back to polling:`, error);
          }
        }
        if (resolved.provider === 'mt5' && stopTickStream && (seededStream || Date.now() - lastLiveTickAt < REFRESH_INTERVAL_MS * 2)) {
          if (running && currentGeneration === generation) {
            timer = window.setTimeout(() => void poll(ctx, currentGeneration), REFRESH_INTERVAL_MS);
          }
          return;
        }
        if (resolved.provider !== 'mt5' && stopTickStream) {
          stopTickStream();
          stopTickStream = undefined;
          subscribedTicker = '';
        }
        request?.abort();
        request = new AbortController();
        const sequenceBeforeQuote = liveTickSequence;
        try {
          const quote = await fetchBidAskQuote(resolved.provider, ticker, request.signal, instance, true);
          if (sequenceBeforeQuote === liveTickSequence && running && currentGeneration === generation) {
            publish(ctx, quote);
            warnedFor = '';
            consecutiveFailures = 0;
          }
        } catch (error) {
          if (!(error instanceof DOMException && error.name === 'AbortError')) {
            consecutiveFailures += 1;
            const key = `${resolved.provider}:${resolved.ticker}`;
            if (warnedFor !== key) {
              console.warn(`Bid/ask quote unavailable for ${key}:`, error);
              warnedFor = key;
            }
          }
          if (sequenceBeforeQuote === liveTickSequence && running && currentGeneration === generation) publish(ctx, null);
        }
      }
      if (running && currentGeneration === generation) {
        // A provider that keeps failing (a disconnected terminal, an unreachable venue) must
        // not be retried every two seconds: that produced a failure per chart per poll and
        // flooded the diagnostics log. After three failures it backs off to once a minute
        // and keeps recovering as soon as a quote succeeds.
        const delay = consecutiveFailures >= 3 ? FAILED_REFRESH_INTERVAL_MS : REFRESH_INTERVAL_MS;
        timer = window.setTimeout(() => void poll(ctx, currentGeneration), delay);
      }
    };

    return {
      start: ctx => {
        context = ctx;
        running = true;
        generation++;
        void poll(ctx, generation);
      },
      onBars: () => undefined,
      onViewport: () => undefined,
      setInputs: () => undefined,
      suspend: () => { stopPolling(); context?.pushData(null); },
      resume: () => {
        if (!running) {
          running = true;
          generation++;
          if (context) void poll(context, generation);
        }
      },
      stop: () => {
        stopPolling();
        context?.pushData(null);
        context = undefined;
      },
    };
  },
});

export function createBidAskLinesController(chart: Pick<Vela, 'addNativeIndicator' | 'indicators'>) {
  let enabled = localStorage.getItem('vela_show_bid_ask_lines') !== 'false';
  let handle: IndicatorHandle | null = null;

  const setEnabled = (next: boolean) => {
    enabled = next;
    localStorage.setItem('vela_show_bid_ask_lines', String(next));
    if (enabled && !handle) handle = chart.addNativeIndicator(LAYER_ID);
    if (!enabled && handle) {
      handle.remove();
      handle = null;
    }
  };

  const setStyle = (style: BidAskLineStyle) => {
    const colors = BID_ASK_COLOR_OPTIONS.map(([color]) => color);
    if (!colors.includes(style.bidColor as typeof colors[number]) || !colors.includes(style.askColor as typeof colors[number])) {
      throw new Error('Choose a supported bid/ask line color.');
    }
    if (!BID_ASK_WIDTH_OPTIONS.includes(style.lineWidth as typeof BID_ASK_WIDTH_OPTIONS[number])) {
      throw new Error('Choose a bid/ask line width from 1 to 5.');
    }
    if (!BID_ASK_STYLE_OPTIONS.some(([lineStyle]) => lineStyle === style.lineStyle)) {
      throw new Error('Choose a supported bid/ask line style.');
    }
    saveBidAskLineStyle(style);
    if (handle) {
      handle.remove();
      handle = chart.addNativeIndicator(LAYER_ID);
    }
  };

  if (enabled) {
    handle = chart.addNativeIndicator(LAYER_ID);
  } else {
    for (const indicator of chart.indicators()) {
      if (indicator.nativeType === LAYER_ID) indicator.remove();
    }
  }

  return {
    setEnabled,
    setStyle,
    destroy: () => {
      handle?.remove();
      handle = null;
    },
  };
}
