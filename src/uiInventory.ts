/**
 * Full UI inventory.
 *
 * A complete, machine-readable map of everything the platform renders: every element in the
 * document with its id, classes, position, size, computed colours, border, shadow and a text
 * sample, plus flags for what it is (button, panel, dialog) and the path that leads to it.
 *
 * It exists because identifying a panel by description kept failing - several strips look
 * alike and are different elements. With this file, "the bar with Trading Panel" is a lookup
 * instead of an argument.
 *
 * Written to userData/ui-inventory.json. Requires the preload that exposes window.velaLayout,
 * so it runs on a normal application start (not a window reload).
 */

import { reportCaughtError } from './diagnostics';

declare global {
  interface Window {
    velaLayout?: { save(payload: unknown): Promise<string> };
  }
}

interface InventoryNode {
  depth: number;
  tag: string;
  id?: string;
  classes?: string;
  path: string;
  x: number;
  y: number;
  w: number;
  h: number;
  background: string;
  color: string;
  borderTop: string;
  borderLeft: string;
  borderColor: string;
  shadow: string;
  fontSize: string;
  fontWeight: string;
  radius: string;
  visible: boolean;
  kind: string;
  text: string;
}

const MAX_NODES = 6000;

function pathOf(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
    const id = node.id ? `#${node.id}` : '';
    const cls = typeof (node as HTMLElement).className === 'string'
      ? (node as HTMLElement).className.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(name => `.${name}`).join('')
      : '';
    parts.unshift(`${node.tagName.toLowerCase()}${id}${cls}`);
    if (node.id) break;
  }
  return parts.join(' > ');
}

function classify(element: HTMLElement, style: CSSStyleDeclaration, rect: DOMRect): string {
  const role = element.getAttribute('role') ?? '';
  const tag = element.tagName.toLowerCase();
  if (role === 'dialog' || tag === 'dialog' || /modal|dialog|overlay/i.test(element.className as string)) return 'window';
  if (tag === 'button' || role === 'button' || (tag === 'input' && /button|submit/i.test((element as HTMLInputElement).type))) return 'button';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'field';
  if (style.backgroundColor !== 'rgba(0, 0, 0, 0)' && rect.width > 120 && rect.height > 18) return 'panel';
  if (rect.width > 600 && rect.height > 18 && rect.height < 90) return 'bar';
  if ((element.textContent ?? '').trim() && element.children.length === 0) return 'text';
  return 'container';
}

function collect(): { nodes: InventoryNode[]; viewport: [number, number]; theme: string } {
  const nodes: InventoryNode[] = [];
  const root = document.body;
  const walk = (element: Element, depth: number): void => {
    if (nodes.length >= MAX_NODES) return;
    if (element.tagName === 'SCRIPT' || element.tagName === 'STYLE' || element.tagName === 'LINK') return;
    const html = element as HTMLElement;
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
    const classes = typeof html.className === 'string'
      ? html.className.trim().split(/\s+/).filter(Boolean).slice(0, 6).join(' ')
      : '';
    if (visible && rect.width >= 8 && rect.height >= 6) {
      nodes.push({
        depth,
        tag: element.tagName.toLowerCase(),
        id: html.id || undefined,
        classes: classes || undefined,
        path: pathOf(element),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        w: Math.round(rect.width),
        h: Math.round(rect.height),
        background: style.backgroundColor,
        color: style.color,
        borderTop: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
        borderLeft: `${style.borderLeftWidth} ${style.borderLeftStyle} ${style.borderLeftColor}`,
        borderColor: style.borderColor,
        shadow: style.boxShadow === 'none' ? '' : style.boxShadow,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        radius: style.borderRadius,
        visible,
        kind: classify(html, style, rect),
        text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
      });
    }
    for (const child of Array.from(element.children)) walk(child, depth + 1);
  };
  walk(root, 0);
  return { nodes, viewport: [window.innerWidth, window.innerHeight], theme: document.body.dataset.theme ?? 'dark' };
}

async function save(): Promise<void> {
  const { nodes, viewport, theme } = collect();
  const counts: Record<string, number> = {};
  for (const node of nodes) counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  const payload = {
    capturedAt: new Date().toISOString(),
    theme,
    viewport,
    totals: counts,
    nodes,
  };
  if (!window.velaLayout) {
    // Without the file bridge the inventory would be lost, so say so instead of failing quietly.
    reportCaughtError('ui-inventory:no-bridge', new Error('window.velaLayout is missing - the app needs a full restart'), `${nodes.length} nodes were collected but could not be written`);
    return;
  }
  try {
    const target = await window.velaLayout.save(payload);
    window.velaDiagnostics?.record({
      source: 'ui-inventory',
      type: 'debug',
      name: 'saved',
      status: 'ok',
      message: `${nodes.length} elements written to ${target}`,
    });
  } catch (error) {
    reportCaughtError('ui-inventory:save', error);
  }
}

/** Capture once the window has settled; also exposed for a manual refresh from the console. */
export function startUiInventory(): void {
  window.setTimeout(() => void save(), 4000);
  (window as unknown as { captureUiInventory?: () => void }).captureUiInventory = () => void save();
}
