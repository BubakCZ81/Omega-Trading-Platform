/**
 * Click-to-identify, multi-select.
 *
 * Asking an operator to name a panel by class or y-coordinate is unreasonable: they are looking
 * at a screen, not at the document tree. This gives them the only interface that makes sense -
 * press a shortcut, click the panels, done.
 *
 * Ctrl+Shift+P  start picking          click  add the element under the pointer
 * Esc           save the selection     Alt+click  drop the last one
 *
 * Everything selected is written at once, so ten buttons can be described in one gesture.
 */

import { reportCaughtError } from './diagnostics';

declare global {
  interface Window {
    velaLayout?: { save(payload: unknown): Promise<string> };
    pickPanel?: () => void;
  }
}

interface PickedItem {
  element: HTMLElement;
  outline: HTMLDivElement;
  payload: Record<string, unknown>;
}

/**
 * Resolve what the operator almost certainly meant.
 *
 * Clicking the label inside a button used to record the inner span instead of the button, so
 * two clicks on the same control produced two different selectors. A click now climbs to the
 * nearest real control; Shift+click keeps the exact element when that is genuinely wanted.
 */
function meaningfulTarget(target: HTMLElement, exact: boolean): HTMLElement {
  if (exact) return target;
  const control = target.closest('button, summary, [role="button"], a[href], input, select, textarea, details');
  if (control instanceof HTMLElement) return control;
  let node: HTMLElement | null = target;
  for (let depth = 0; depth < 4 && node; depth += 1) {
    if (node.id || (typeof node.className === 'string' && node.className.trim())) return node;
    node = node.parentElement;
  }
  return target;
}

function selectorOf(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  for (let depth = 0; node && depth < 4; depth += 1, node = node.parentElement) {
    const id = node.id ? `#${node.id}` : '';
    const raw = (node as HTMLElement).className;
    const classes = typeof raw === 'string' && raw.trim()
      ? `.${raw.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
    parts.unshift(`${node.tagName.toLowerCase()}${id}${classes}`);
  }
  return parts.join(' > ');
}

function ancestorsOf(element: Element): string[] {
  const chain: string[] = [];
  let node: Element | null = element.parentElement;
  for (let depth = 0; node && depth < 7; depth += 1, node = node.parentElement) {
    const style = window.getComputedStyle(node);
    const raw = (node as HTMLElement).className;
    const classes = typeof raw === 'string' && raw.trim()
      ? `.${raw.trim().split(/\s+/).slice(0, 3).join('.')}`
      : '';
    chain.push(`${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes} [bg ${style.backgroundColor}]`);
  }
  return chain;
}

function describe(element: HTMLElement): Record<string, unknown> {
  const rect = element.getBoundingClientRect();
  const style = window.getComputedStyle(element);
  return {
    selector: selectorOf(element),
    // Which theme was active when this was picked. Without it a recorded colour cannot be
    // matched to the block in the stylesheet that produced it.
    theme: document.body.dataset.theme ?? 'dark',
    themeVariant: document.body.dataset.themeVariant || 'none',
    tag: element.tagName.toLowerCase(),
    id: element.id || undefined,
    classes: typeof element.className === 'string' ? element.className : undefined,
    rect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    background: style.backgroundColor,
    color: style.color,
    borderTop: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
    borderRight: `${style.borderRightWidth} ${style.borderRightStyle} ${style.borderRightColor}`,
    radius: style.borderRadius,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
    text: (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160),
    ancestors: ancestorsOf(element),
  };
}

export function startPanelPicker(): void {
  let active = false;
  let hoverOutline: HTMLDivElement | null = null;
  let badge: HTMLDivElement | null = null;
  let saveButton: HTMLButtonElement | null = null;
  let hovered: HTMLElement | null = null;
  const selected: PickedItem[] = [];

  const ensureUi = () => {
    if (!hoverOutline) {
      hoverOutline = document.createElement('div');
      hoverOutline.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483646;border:0.125rem dashed #4d9cff;background:rgba(77,156,255,0.10);border-radius:0.25rem';
      document.body.append(hoverOutline);
    }
    if (!badge) {
      badge = document.createElement('div');
      badge.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:0.5rem;z-index:2147483647;pointer-events:none;padding:0.375rem 0.75rem;border-radius:0.375rem;background:#0b1626;color:#eaf2ff;font:0.8125rem/1.4 Consolas,monospace;border:0.0625rem solid #4d9cff;white-space:nowrap';
      document.body.append(badge);
    }
    if (!saveButton) {
      // A real button: Esc is not reaching the document reliably (focus can sit in an editor or
      // a frame), and a keyboard-only save gave no way to finish the selection.
      saveButton = document.createElement('button');
      saveButton.type = 'button';
      saveButton.textContent = 'Save selection';
      saveButton.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);top:2.75rem;z-index:2147483647;padding:0.375rem 1rem;border-radius:0.375rem;background:#22d18b;color:#06231a;font:700 0.8125rem/1.3 Segoe UI,sans-serif;border:0;cursor:pointer;box-shadow:0 0.125rem 0.5rem rgba(0,0,0,.4)';
      saveButton.addEventListener('click', event => {
        event.preventDefault();
        event.stopPropagation();
        void save();
      });
      document.body.append(saveButton);
    }
  };

  const refreshBadge = () => {
    if (!badge) return;
    const count = selected.length;
    badge.textContent = count === 0
      ? 'Click a panel or button · Shift+click for the exact element · Esc or the button saves'
      : `${count} selected · press Save selection (or Esc) · Alt+click undoes · Shift+click = exact`;
    if (saveButton) {
      saveButton.textContent = count === 0 ? 'Close picker' : `Save selection (${count})`;
      saveButton.style.background = count === 0 ? '#27476f' : '#22d18b';
      saveButton.style.color = count === 0 ? '#eaf2ff' : '#06231a';
    }
  };

  const clearUi = () => {
    hoverOutline?.remove();
    badge?.remove();
    saveButton?.remove();
    hoverOutline = null;
    badge = null;
    saveButton = null;
    for (const item of selected) item.outline.remove();
  };

  const stop = () => {
    active = false;
    clearUi();
    hovered = null;
    document.removeEventListener('pointermove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    document.body.style.cursor = '';
  };

  const save = async () => {
    const items = selected.map(item => item.payload);
    window.velaDiagnostics?.record({
      source: 'panel-picker', type: 'ui', name: 'save-requested', status: 'info',
      message: `${items.length} element(s)`,
    });
    stop();
    if (items.length === 0) return;
    const bridge = window.velaLayout;
    if (!bridge) {
      window.velaDiagnostics?.record({
        source: 'panel-picker', type: 'ui', name: 'picked-no-bridge', status: 'error',
        message: `${items.length} elements could not be written - restart the application once`,
      });
      return;
    }
    try {
      const path = await bridge.save({
        picked: true,
        multi: items.length > 1,
        count: items.length,
        theme: { base: document.body.dataset.theme ?? 'dark', variant: document.body.dataset.themeVariant || 'none' },
        items,
      });
      window.velaDiagnostics?.record({
        source: 'panel-picker', type: 'ui', name: 'picked', status: 'ok',
        message: `${items.length} element(s) -> ${path} :: ${items.map(item => String(item.selector)).join(' ; ').slice(0, 160)}`,
      });
    } catch (error) {
      reportCaughtError('panel-picker:save', error);
    }
  };

  const onMove = (event: PointerEvent) => {
    if (!active) return;
    const target = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
    if (!target || target === hoverOutline || target === badge) return;
    hovered = target;
    ensureUi();
    const rect = target.getBoundingClientRect();
    if (hoverOutline) {
      hoverOutline.style.left = `${rect.x}px`;
      hoverOutline.style.top = `${rect.y}px`;
      hoverOutline.style.width = `${rect.width}px`;
      hoverOutline.style.height = `${rect.height}px`;
    }
  };

  const onClick = (event: MouseEvent) => {
    if (!active) return;
    // Never treat the picker's own controls as a pick: this listener runs in the capture phase,
    // before the Save button's own handler.
    const clicked = event.target as Node | null;
    if (clicked && (clicked === saveButton || clicked === badge || clicked === hoverOutline)) return;
    event.preventDefault();
    event.stopPropagation();
    const raw = (hovered ?? document.elementFromPoint(event.clientX, event.clientY)) as HTMLElement | null;
    if (!raw) return;
    ensureUi();

    if (event.altKey) {
      const last = selected.pop();
      last?.outline.remove();
      refreshBadge();
      return;
    }

    const target = meaningfulTarget(raw, event.shiftKey);
    const selector = selectorOf(target);
    if (selected.some(item => String(item.payload.selector) === selector)) {
      refreshBadge();
      return;
    }
    const outline = document.createElement('div');
    const rect = target.getBoundingClientRect();
    outline.style.cssText = `position:fixed;pointer-events:none;z-index:2147483645;border:0.125rem solid #22d18b;border-radius:0.25rem;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
    document.body.append(outline);
    selected.push({ element: target, outline, payload: describe(target) });
    refreshBadge();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && active) {
      event.preventDefault();
      void save();
    }
  };

  const begin = () => {
    if (active) return;
    active = true;
    // A previous session kept its selection, so a new pick silently saved the old elements as
    // well (or instead). Each session starts empty.
    for (const item of selected) item.outline.remove();
    selected.length = 0;
    ensureUi();
    refreshBadge();
    document.body.style.cursor = 'crosshair';
    document.addEventListener('pointermove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKey, true);
    // keyup as well: some app-level handlers swallow keydown before it reaches the document.
    document.addEventListener('keyup', onKey, true);
    window.velaDiagnostics?.record({
      source: 'panel-picker', type: 'ui', name: 'started', status: 'info',
      message: 'Click panels to select them. Esc saves, Alt+click removes the last.',
    });
  };

  document.addEventListener('keydown', event => {
    if (event.ctrlKey && event.shiftKey && (event.key === 'P' || event.key === 'p')) {
      event.preventDefault();
      begin();
    }
  }, true);
  window.pickPanel = begin;
}
