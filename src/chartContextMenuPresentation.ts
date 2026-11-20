const BODY_MENU_SEPARATOR_GROUPS = [
  [
    'action:omega-context-cancel-pending-paper-order',
    'action:omega-context-add-pending-paper-order',
    'action:omega-quicktrade-toggle',
  ],
  ['action:omega-context-reset-view'],
  ['action:omega-context-background'],
  ['action:omega-context-start-replay', 'action:omega-context-open-replay'],
] as const;

export function getContextMenuSeparatorTargets(itemIds: readonly string[]): string[] {
  return BODY_MENU_SEPARATOR_GROUPS.flatMap(group => {
    const target = group.find(id => itemIds.includes(id));
    if (!target) return [];
    const index = itemIds.indexOf(target);
    return index > 0 && itemIds[index - 1] !== 'separator' ? [target] : [];
  });
}

function addBodyMenuSeparators(menu: HTMLElement): void {
  if (menu.getAttribute('data-state') !== 'open') return;
  const children = Array.from(menu.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
  if (!children.some(child => child.dataset.veiId?.startsWith('action:omega-context')
    || child.dataset.veiId === 'action:omega-quicktrade-toggle')) return;
  const itemIds = children.map(child => child.getAttribute('role') === 'separator'
    ? 'separator'
    : child.dataset.veiId ?? '');
  for (const id of getContextMenuSeparatorTargets(itemIds)) {
    const row = children.find(child => child.dataset.veiId === id);
    if (!row) continue;
    const separator = document.createElement('li');
    separator.className = 'vela-menu-sep';
    separator.dataset.slot = 'dropdown-menu-separator';
    separator.setAttribute('role', 'separator');
    menu.insertBefore(separator, row);
  }

  let hasVisibleItem = false;
  let pendingSeparators: HTMLElement[] = [];
  for (const child of Array.from(menu.children).filter((item): item is HTMLElement => item instanceof HTMLElement)) {
    if (child.getAttribute('role') === 'separator') {
      child.hidden = false;
      pendingSeparators.push(child);
      continue;
    }
    if (getComputedStyle(child).display === 'none' || child.getAttribute('aria-hidden') === 'true') continue;
    pendingSeparators.forEach((separator, index) => {
      separator.hidden = !hasVisibleItem || index > 0;
    });
    pendingSeparators = [];
    hasVisibleItem = true;
  }
  pendingSeparators.forEach(separator => { separator.hidden = true; });
}

export function initializeChartContextMenuPresentation(): void {
  const menus = new Set<HTMLElement>();
  const collectMenu = (element: Element): void => {
    const menu = element.matches('.vela-menu[role="menu"]')
      ? element
      : element.closest('.vela-menu[role="menu"]');
    if (menu instanceof HTMLElement) menus.add(menu);
    for (const nested of element.querySelectorAll<HTMLElement>('.vela-menu[role="menu"]')) menus.add(nested);
  };
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.target instanceof Element) collectMenu(record.target);
      for (const node of record.addedNodes) {
        if (node instanceof Element) collectMenu(node);
      }
    }
    for (const menu of menus) addBodyMenuSeparators(menu);
    menus.clear();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['data-state'],
  });
}
