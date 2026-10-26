interface ToolbarPopupAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface ToolbarPopupSize {
  width: number;
  height: number;
}

export function getToolbarPopupPosition(
  anchor: ToolbarPopupAnchor,
  popup: ToolbarPopupSize,
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const gap = 12;
  const left = Math.max(gap, Math.min(anchor.left, viewport.width - popup.width - gap));
  const below = anchor.bottom + 6;
  const top = below + popup.height <= viewport.height - gap
    ? below
    : Math.max(gap, anchor.top - popup.height - 6);
  return { left, top };
}

export function initializeToolbarDropdowns(): void {
  const toolbar = document.getElementById('top-toolbar');
  if (!toolbar) return;

  const menus = Array.from(toolbar.querySelectorAll<HTMLDetailsElement>('details.timeframe-menu'))
    .flatMap(menu => {
      const popup = menu.querySelector<HTMLElement>('.ctrader-timeframe-content, .timeframe-menu-content');
      return popup ? [{ menu, popup }] : [];
    });
  if (menus.length === 0) return;

  const positionOpenMenus = (): void => {
    for (const { menu, popup } of menus) {
      if (!menu.open) continue;
      const anchor = menu.querySelector('summary')?.getBoundingClientRect();
      if (!anchor) continue;

      popup.style.position = 'fixed';
      popup.style.maxWidth = 'calc(100vw - 24px)';
      popup.style.maxHeight = 'calc(100vh - 24px)';
      popup.style.overflowY = 'auto';
      const bounds = popup.getBoundingClientRect();
      const position = getToolbarPopupPosition(
        anchor,
        { width: bounds.width, height: bounds.height },
        { width: window.innerWidth, height: window.innerHeight },
      );
      popup.style.left = `${position.left}px`;
      popup.style.top = `${position.top}px`;
    }
  };

  for (const { menu, popup } of menus) {
    menu.addEventListener('toggle', () => {
      if (menu.open) {
        for (const other of menus) {
          if (other.menu !== menu) other.menu.open = false;
        }
        positionOpenMenus();
      } else {
        popup.style.removeProperty('position');
        popup.style.removeProperty('left');
        popup.style.removeProperty('top');
        popup.style.removeProperty('max-width');
        popup.style.removeProperty('max-height');
        popup.style.removeProperty('overflow-y');
      }
    });
  }

  toolbar.addEventListener('scroll', positionOpenMenus, { passive: true });
  window.addEventListener('resize', positionOpenMenus);
  window.visualViewport?.addEventListener('resize', positionOpenMenus);
  window.visualViewport?.addEventListener('scroll', positionOpenMenus);
}
