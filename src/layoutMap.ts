/**
 * Layout map.
 *
 * Every colour change so far failed at the same step: working out which element on screen was
 * meant. Names and screenshots kept pointing at different strips because the chart draws
 * several bars that look alike but are different elements.
 *
 * The map is delivered through the diagnostics channel, which the preload already exposes, so
 * it works after a plain reload. One diagnostic entry per box keeps each message short; read
 * them back from userData/diagnostics.jsonl with source "layout".
 */

import { reportCaughtError } from './diagnostics';

declare global {
  interface Window {
    // velaDiagnostics is already declared by the diagnostics module; only the newer file API
    // needs a declaration here.
    velaLayout?: { save(payload: unknown): Promise<string> };
  }
}

const MAX_BOXES = 160;

function describe(element: HTMLElement): string | null {
  const rect = element.getBoundingClientRect();
  // Narrow enough to catch the small controls too (the symbol chip, Indicators, the star and
  // their separators), which a 200px floor excluded.
  if (rect.width < 40 || rect.height < 10 || rect.height > 200) return null;
  if (rect.bottom < 0 || rect.top > window.innerHeight) return null;
  const style = window.getComputedStyle(element);
  if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) return null;
  const classes = typeof element.className === 'string'
    ? element.className.trim().split(/\s+/).slice(0, 4).join('.')
    : '';
  const id = element.id ? `#${element.id}` : '';
  if (!id && !classes) return null;
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  // y|height|width|tag#id.classes|background|text
  return [
    Math.round(rect.y),
    Math.round(rect.height),
    Math.round(rect.width),
    `${element.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ''}`,
    style.backgroundColor,
    text,
  ].join('|');
}

export function startLayoutCapture(): void {
  const capture = (reason: string) => {
    try {
      const root = document.getElementById('app-container') ?? document.body;
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const element of root.querySelectorAll<HTMLElement>('*')) {
        if (lines.length >= MAX_BOXES) break;
        const line = describe(element);
        if (!line || seen.has(line)) continue;
        seen.add(line);
        lines.push(line);
      }
      // One entry per box: diagnostic messages are length-limited, so a single payload would
      // be truncated.
      for (const line of lines) {
        window.velaDiagnostics?.record({
          source: 'layout',
          type: 'box',
          name: reason,
          status: 'ok',
          message: line,
        });
      }
      // The richer JSON file is written too when the newer preload is available.
      void window.velaLayout?.save({
        reason,
        capturedAt: new Date().toISOString(),
        viewport: { width: window.innerWidth, height: window.innerHeight },
        theme: document.body.dataset.theme ?? 'dark',
        boxes: lines,
      });
    } catch (error) {
      reportCaughtError('layout:capture', error);
    }
  };
  window.setTimeout(() => capture('startup'), 3000);
  (window as unknown as { captureLayoutMap?: (reason?: string) => void }).captureLayoutMap =
    (reason = 'manual') => capture(reason);
}
