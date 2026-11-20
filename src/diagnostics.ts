/**
 * Visible failure reporting.
 *
 * A swallowed exception is the worst kind of bug: the platform keeps running with wrong
 * state and nobody ever learns why. This module exists so that every `catch` can say "this
 * went wrong, here" in one line, without deciding on its own how loud to be.
 *
 * Two rules make it safe to call from anywhere:
 *  - it never throws (a failure in the failure reporter would be absurd);
 *  - identical failures are throttled, so a per-frame catch cannot flood the console or
 *    the diagnostics buffer and hide everything else.
 */

export interface CaughtFailure {
  /** Where it happened, e.g. `paper-trading:save`. Keep it stable — it is the dedupe key. */
  source: string;
  message: string;
  at: number;
  count: number;
}

const THROTTLE_MS = 5_000;
const MAX_REMEMBERED = 200;

const seen = new Map<string, CaughtFailure>();
const order: string[] = [];

function toMessage(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

/**
 * Record a caught exception.
 *
 * @param source stable identifier such as `paper-trading:load`
 * @param error  whatever the catch received
 * @param detail optional extra context for the operator
 * @returns true when this call was actually reported (false when throttled)
 */
export function reportCaughtError(source: string, error: unknown, detail?: string): boolean {
  const key = `${source}|${toMessage(error)}`;
  const now = Date.now();
  const previous = seen.get(key);
  if (previous && now - previous.at < THROTTLE_MS) {
    previous.count += 1;
    return false;
  }

  const entry: CaughtFailure = { source, message: toMessage(error), at: now, count: 1 };
  seen.set(key, entry);
  order.push(key);
  while (order.length > MAX_REMEMBERED) {
    const oldest = order.shift();
    if (oldest) seen.delete(oldest);
  }

  // Never let reporting itself break the caller.
  try {
    console.warn(`[Omega] ${source}: ${detail ? `${detail} — ` : ''}${entry.message}`, error);
  } catch { /* console unavailable */ }

  try {
    window.velaDiagnostics?.record({
      source: 'caught-error',
      type: 'error',
      name: source,
      status: 'error',
      message: detail ? `${detail}: ${entry.message}` : entry.message,
    });
  } catch { /* diagnostics unavailable */ }

  return true;
}

/** Recent caught failures, newest last — handy in the diagnostics view. */
export function recentCaughtFailures(): readonly CaughtFailure[] {
  return order.map(key => seen.get(key)).filter((entry): entry is CaughtFailure => Boolean(entry));
}

/** Clear the throttle memory. Exposed for tests. */
export function resetCaughtFailures(): void {
  seen.clear();
  order.length = 0;
}
