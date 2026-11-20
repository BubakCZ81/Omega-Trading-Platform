/**
 * Order-intent idempotency.
 *
 * The single most expensive bug in a trading platform is sending the same order twice:
 * a double click, a retried IPC call, a reconnect that replays a request. The broker then
 * holds two positions and one stop-loss.
 *
 * This module gives every order a stable intent key and refuses a second send of the same
 * key inside a time window. It is deliberately independent of any broker: the paper engine
 * uses it today, and the live executor will use the same guard, so the protection does not
 * have to be invented twice.
 */

export interface IntentDecision {
  /** True when this intent may be sent; false when it is a duplicate. */
  allowed: boolean;
  key: string;
  /** Why it was refused, for the operator and the diagnostics log. */
  reason?: string;
}

const DEFAULT_WINDOW_MS = 30_000;
const MAX_TRACKED = 500;

/** key -> when it was accepted (epoch ms). */
const accepted = new Map<string, number>();

/**
 * Build a stable key for one intended order. Two clicks that produce the same instrument,
 * side, size and timestamp bucket collapse onto one key.
 *
 * The bucket is deliberately coarse (one second): a genuine second order a trader places
 * a second later must still go through, while an accidental duplicate lands in the same
 * bucket.
 */
export function orderIntentKey(input: {
  cellId?: string;
  symbol: string;
  side: string;
  lots: number;
  orderType?: string;
  at?: number;
}): string {
  const at = input.at ?? Date.now();
  const bucket = Math.floor(at / 1000);
  const symbol = String(input.symbol ?? '').trim().toUpperCase();
  const side = String(input.side ?? '').trim().toLowerCase();
  const lots = Number.isFinite(input.lots) ? input.lots.toFixed(4) : '0';
  const type = String(input.orderType ?? 'market').trim().toLowerCase();
  return `${input.cellId ?? 'chart'}|${symbol}|${side}|${lots}|${type}|${bucket}`;
}

function prune(now: number, windowMs: number): void {
  for (const [key, at] of accepted) {
    if (now - at > windowMs) accepted.delete(key);
  }
  while (accepted.size > MAX_TRACKED) {
    const oldest = accepted.keys().next();
    if (oldest.done) break;
    accepted.delete(oldest.value);
  }
}

/**
 * Ask whether an intent may proceed. `accept` records it, so call this exactly when the
 * order is actually submitted.
 */
export function requestOrderIntent(key: string, windowMs = DEFAULT_WINDOW_MS): IntentDecision {
  const now = Date.now();
  prune(now, windowMs);
  const previous = accepted.get(key);
  if (previous !== undefined && now - previous <= windowMs) {
    return {
      allowed: false,
      key,
      reason: `Duplicate order blocked: an identical order was accepted ${Math.round((now - previous) / 1000)}s ago.`,
    };
  }
  accepted.set(key, now);
  return { allowed: true, key };
}

/** Forget one key when submission fails or an order preview is cancelled. */
export function releaseOrderIntent(key: string): void {
  accepted.delete(key);
}

/** How many intents are currently remembered, for the diagnostics view. */
export function trackedIntentCount(): number {
  return accepted.size;
}
