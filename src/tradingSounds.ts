import { reportCaughtError } from './diagnostics.ts';
/**
 * Trading sound engine.
 *
 * A trader is not always looking at the window, so every meaningful event must be
 * audible: an order placed, a fill, a stop hit, an error, a dropped connection. Each
 * event gets its own short motif so they can be told apart without reading anything.
 *
 * Design notes
 * - Configuration lives in ONE place: the trade preferences owned by the paper-trading
 *   module. This module never persists its own copy, so the volume can never disagree
 *   with what the settings panel shows.
 * - The old engine capped gain at 0.16, which made 100 % volume barely audible. The
 *   ceiling is now 0.6 with a perceptual curve, so the middle of the slider is usable
 *   and the top end is genuinely loud.
 * - Sounds are synced tones, not files: nothing to load, nothing to break, no assets.
 */

export type TradingSoundEvent =
  | 'level'
  | 'protectionSaved'
  | 'orderPlaced'
  | 'orderFilled'
  | 'tradeClosed'
  | 'stopLossHit'
  | 'takeProfitHit'
  | 'error'
  | 'connectionLost'
  | 'connectionRestored';

interface SoundRecipe {
  notes: number[];
  type: OscillatorType;
  step: number;
  length: number;
}

const RECIPES: Record<TradingSoundEvent, SoundRecipe> = {
  // Neutral acknowledgement of a chart click.
  level: { notes: [1040], type: 'sine', step: 0.085, length: 0.11 },
  protectionSaved: { notes: [880, 1320], type: 'sine', step: 0.085, length: 0.11 },
  // New order accepted: a rising pair, clearly different from a close.
  orderPlaced: { notes: [720, 960], type: 'triangle', step: 0.09, length: 0.13 },
  orderFilled: { notes: [784, 988, 1319], type: 'sine', step: 0.07, length: 0.12 },
  // Position closed: falling pair.
  tradeClosed: { notes: [660, 440], type: 'triangle', step: 0.085, length: 0.11 },
  takeProfitHit: { notes: [1047, 1319, 1568], type: 'sine', step: 0.08, length: 0.16 },
  // A stop is bad news, so it is deliberately low and blunt.
  stopLossHit: { notes: [330, 220], type: 'sawtooth', step: 0.11, length: 0.2 },
  error: { notes: [220, 180], type: 'square', step: 0.13, length: 0.22 },
  connectionLost: { notes: [440, 330, 220], type: 'triangle', step: 0.12, length: 0.18 },
  connectionRestored: { notes: [523, 784, 1047], type: 'sine', step: 0.09, length: 0.14 },
};

/** Peak gain at 100 % volume. */
const MAX_GAIN = 0.6;

let enabled = true;
let volume = 50;
let context: AudioContext | null = null;

/**
 * Push the operator's sound preferences in. Called whenever trade preferences load or
 * are saved, so this module always mirrors the settings panel.
 */
export function configureTradingSounds(next: { enabled: boolean; volume: number }): void {
  enabled = next.enabled;
  volume = Number.isFinite(next.volume) ? Math.max(0, Math.min(100, next.volume)) : 50;
}

/** Current settings, for a caller that wants to render them. */
export function tradingSoundSettings(): { enabled: boolean; volume: number } {
  return { enabled, volume };
}

/** Perceptual curve: 50 % is comfortably audible instead of nearly silent. */
function gainForVolume(): number {
  const ratio = volume / 100;
  return MAX_GAIN * Math.pow(ratio, 0.7);
}

function audioContext(): AudioContext | null {
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null;
  if (!context) {
    try {
      context = new AudioContext();
    } catch (error) {
      reportCaughtError('trading-sounds:audio-context', error, 'AudioContext could not be created; trading sounds are unavailable.');
      return null;
    }
  }
  return context;
}

export function playTradingSound(event: TradingSoundEvent = 'level'): void {
  if (!enabled || volume <= 0) return;
  const ctx = audioContext();
  if (!ctx) return;
  const recipe = RECIPES[event] ?? RECIPES.level;
  const peak = gainForVolume();
  if (peak <= 0) return;

  const play = (): void => {
    const now = ctx.currentTime;
    recipe.notes.forEach((frequency, index) => {
      const start = now + index * recipe.step;
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      oscillator.type = recipe.type;
      oscillator.frequency.setValueAtTime(frequency, start);
      // Short attack avoids the click that a hard start produces, and the exponential
      // release keeps each motif from bleeding into the next.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(peak, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + recipe.length);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + recipe.length + 0.02);
    });
  };

  if (ctx.state === 'suspended') {
    void ctx.resume().then(play).catch(error => {
      console.warn('Trading sound unavailable:', error);
    });
  } else {
    play();
  }
}

declare global {
  interface Window {
    /** Lets any module (broker feeds, MT5, backtest) sound an event without importing this one. */
    omegaSounds?: {
      play(event: TradingSoundEvent): void;
      events: TradingSoundEvent[];
    };
  }
}

if (typeof window !== 'undefined') {
  window.omegaSounds = {
    play: playTradingSound,
    events: Object.keys(RECIPES) as TradingSoundEvent[],
  };
}
