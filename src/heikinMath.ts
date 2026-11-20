/**
 * Heikin Ashi mathematics — pure, no framework imports, so it can be tested directly.
 *
 * The classic formula averages the previous two Heikin bars into the open, which is why it
 * flattens trends into long runs of one-colour candles. Traders disagree about how much
 * flattening helps: a very smooth variant makes a trend obvious but hides pullbacks, a
 * responsive one flips earlier but prints more noise. ProRealTime exposes that as a choice
 * of calculation types, and so does Omega.
 *
 * Every variant is a 1:1, time-preserving bar transform: the same number of bars at the same
 * times, only the OHLC values differ. That is the one kind of custom style the charting layer
 * supports safely. Renko and Range changed the bar count, which is why those were never
 * reliable and were removed.
 *
 * Smoothing blends the raw close with an EMA of the close before it is averaged into the
 * Heikin open. `smoothing` 0 is the textbook formula; higher values lean on the average and
 * produce calmer candles.
 */

export interface HeikinVariant {
  /** Price-style id registered with the charting layer. */
  id: string;
  label: string;
  /** How far the close leans toward its own average, 0 (textbook) to 1 (very smooth). */
  smoothing: number;
  /** EMA length used for the average. */
  length: number;
  description: string;
}

export const HEIKIN_VARIANTS: readonly HeikinVariant[] = [
  {
    id: 'heikin-standard',
    label: 'Heikin Ashi (standard)',
    smoothing: 0,
    length: 5,
    description: 'The textbook formula. Balanced: shows trends and still reveals pullbacks.',
  },
  {
    id: 'heikin-responsive',
    label: 'Heikin Ashi (responsive)',
    smoothing: 0.25,
    length: 3,
    description: 'Barely smoothed. Flips earlier than standard, but prints more false turns.',
  },
  {
    id: 'heikin-smooth',
    label: 'Heikin Ashi (smooth)',
    smoothing: 0.6,
    length: 5,
    description: 'Calmer candles. Trends read clearly, individual pullbacks are softened.',
  },
  {
    id: 'heikin-very-smooth',
    label: 'Heikin Ashi (very smooth)',
    smoothing: 0.85,
    length: 8,
    description: 'Strongly smoothed. Best for holding a long trend, worst for precise entries.',
  },
];

/** Ids that render as Heikin Ashi, including the charting layer's own built-in style. */
export function isHeikinStyle(style: string | null | undefined): boolean {
  if (!style) return false;
  return style === 'heikinashi' || style.startsWith('heikin-');
}

/** The variant behind a style id; the built-in `heikinashi` maps to the standard formula. */
export function heikinVariantFor(style: string | null | undefined): HeikinVariant | null {
  if (!isHeikinStyle(style)) return null;
  return HEIKIN_VARIANTS.find(variant => variant.id === style) ?? HEIKIN_VARIANTS[0];
}

export interface HeikinBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

/** A 1:1 bar transform, matching what the charting layer applies at its bar seam. */
export interface HeikinTransform {
  full(raw: readonly HeikinBar[]): HeikinBar[];
  next(raw: HeikinBar, previousView: HeikinBar | undefined): HeikinBar;
}

function ema(values: readonly number[], length: number): number[] {
  if (values.length === 0) return [];
  const factor = 2 / (Math.max(1, length) + 1);
  const out: number[] = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    out.push(values[index] * factor + out[index - 1] * (1 - factor));
  }
  return out;
}

/** Build the transform for one variant. Pure and deterministic. */
export function createHeikinTransform(smoothing: number, length: number): HeikinTransform {
  const blend = Math.max(0, Math.min(1, smoothing));

  /** The Heikin close is always the four-price average; smoothing moves it toward its EMA. */
  const fourPriceAverage = (bar: HeikinBar): number =>
    (bar.open + bar.high + bar.low + bar.close) / 4;

  const smoothedClose = (base: number, average: number): number =>
    blend === 0 ? base : base + (average - base) * blend;

  return {
    full(raw) {
      if (raw.length === 0) return [];
      const bases = raw.map(fourPriceAverage);
      const averages = ema(bases, length);
      const out: HeikinBar[] = [];
      for (let index = 0; index < raw.length; index += 1) {
        const bar = raw[index];
        const close = smoothedClose(bases[index], averages[index]);
        const previous = out[index - 1];
        // Textbook: the first open is the midpoint of the first bar; afterwards the open is
        // the midpoint of the previous Heikin bar's open and close.
        const open = previous ? (previous.open + previous.close) / 2 : (bar.open + close) / 2;
        out.push({
          time: bar.time,
          open,
          close,
          high: Math.max(bar.high, open, close),
          low: Math.min(bar.low, open, close),
          ...(bar.volume !== undefined ? { volume: bar.volume } : {}),
        });
      }
      return out;
    },

    next(raw, previousView) {
      const base = fourPriceAverage(raw);
      // Incremental smoothing for the forming candle: lean toward the previous view close.
      const close = blend === 0 ? base : base + ((previousView?.close ?? base) - base) * blend;
      const open = previousView ? (previousView.open + previousView.close) / 2 : (raw.open + close) / 2;
      return {
        time: raw.time,
        open,
        close,
        high: Math.max(raw.high, open, close),
        low: Math.min(raw.low, open, close),
        ...(raw.volume !== undefined ? { volume: raw.volume } : {}),
      };
    },
  };
}
