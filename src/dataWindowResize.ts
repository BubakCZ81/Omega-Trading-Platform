import { reportCaughtError } from './diagnostics';

/**
 * Resizable Data Window.
 *
 * Vela registers its built-in Data Window as a dock panel created without the
 * `resizable` option, which makes it the only docked panel the operator cannot drag
 * wider. The panel instance is reachable on the workspace's dock and its `setWidth()`
 * is public, so the missing handle can be added from here instead of patching the
 * framework or forking it.
 *
 * Every step is defensive: if a future Vela release changes the dock shape, this does
 * nothing at all and the panel keeps its ordinary fixed width.
 */

interface SidePanelLike {
  el: HTMLElement;
  setWidth?: (px: number) => void;
  refresh?: () => void;
}

interface DockEntryLike {
  id?: string;
  panel?: SidePanelLike;
}

interface DockLike {
  entries?: DockEntryLike[];
}

const WIDTH_STORAGE_KEY = 'omega.data-window.width';
const MIN_WIDTH = 220;
const MAX_WIDTH = 620;

function clampWidth(px: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(px)));
}

/**
 * Attach a drag handle to the Data Window, restore its saved width, and coalesce its
 * refreshes to one per animation frame (the panel rebuilds its whole body on every
 * crosshair move and every bar, which is what makes an open panel feel heavy).
 */
export function enableDataWindowResize(workspace: unknown): void {
  const dock = (workspace as { dock?: DockLike } | null | undefined)?.dock;
  const entry = dock?.entries?.find(candidate => candidate?.id === 'dataWindow');
  const panel = entry?.panel;
  if (!panel?.el || typeof panel.setWidth !== 'function') return;
  if (panel.el.dataset.omegaResizable === 'true') return;
  panel.el.dataset.omegaResizable = 'true';

  const stored = Number(localStorage.getItem(WIDTH_STORAGE_KEY));
  if (Number.isFinite(stored) && stored > 0) panel.setWidth(clampWidth(stored));

  const handle = document.createElement('div');
  handle.className = 'omega-data-window-resizer';
  handle.title = 'Drag to resize the Data Window';
  handle.setAttribute('role', 'separator');
  handle.setAttribute('aria-orientation', 'vertical');
  handle.setAttribute('aria-label', 'Resize the Data Window');
  panel.el.append(handle);

  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  handle.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragging = true;
    startX = event.clientX;
    startWidth = panel.el.getBoundingClientRect().width;
    handle.setPointerCapture(event.pointerId);
    panel.el.classList.add('omega-data-window-resizing');
    event.preventDefault();
  });

  handle.addEventListener('pointermove', event => {
    if (!dragging) return;
    // The dock owns the right edge, so dragging left makes the panel wider.
    panel.setWidth?.(clampWidth(startWidth - (event.clientX - startX)));
  });

  const endDrag = (event: PointerEvent): void => {
    if (!dragging) return;
    dragging = false;
    handle.releasePointerCapture?.(event.pointerId);
    panel.el.classList.remove('omega-data-window-resizing');
    const width = Math.round(panel.el.getBoundingClientRect().width);
    if (width > 0) {
      try {
        localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
      } catch (error) {
        reportCaughtError('data-window:save-width', error);
      }
    }
  };
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  const originalRefresh = panel.refresh?.bind(panel);
  if (originalRefresh) {
    let scheduled = false;
    panel.refresh = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        try {
          originalRefresh();
        } catch (error) {
          console.warn('Data Window refresh failed:', error);
        }
      });
    };
  }
}
