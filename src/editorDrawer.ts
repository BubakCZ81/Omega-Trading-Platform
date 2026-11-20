export {};

declare global {
  interface Window {
    isEditorOpen: boolean;
    toggleEditor(forceState?: boolean): void;
    showConsole(): void;
    addConsoleOutput?: (message: string, type?: string, diagnosticKey?: string) => void;
    addConsoleActivity?: (message: string, type?: string) => void;
    clearConsoleDiagnostics?: (diagnosticKey: string) => void;
    velaPineEditorWindow?: {
      open(): Promise<boolean>;
      openScript(name: string, source: string): Promise<boolean>;
      createNewScript(): Promise<boolean>;
      publishScriptUpdate(script: { name: string; source: string; action: 'add' | 'update' }): void;
      onScriptUpdated(callback: (script: { name: string; source: string; action: 'add' | 'update' }) => void): () => void;
      publishScriptResult(result: { name: string; action: 'add' | 'update'; ok: boolean; message: string }): void;
      onScriptResult(callback: (result: { name: string; action: 'add' | 'update'; ok: boolean; message: string }) => void): () => void;
      onOpenScript(callback: (script: { name: string; source: string }) => void): () => void;
      onNewScript(callback: () => void): () => void;
    };
  }
}

const standalonePineEditor = new URLSearchParams(window.location.search).get('window') === 'pine-editor';

window.isEditorOpen = standalonePineEditor;

function toggleEditor(forceState?: boolean): void {
  const drawer = document.getElementById('editor-drawer');
  const appContainer = document.getElementById('app-container');
  const handle = document.getElementById('resize-handle');
  const button = document.getElementById('editor-toggle-btn');
  // The bottom-bar tab was replaced by the topbar Pine Editor button, so the
  // drawer must toggle without requiring that (now absent) button element.
  if (!drawer || !handle) return;
  if (!standalonePineEditor) {
    window.isEditorOpen = false;
    drawer.style.display = 'none';
    handle.style.display = 'none';
    button?.classList.remove('active');
    appContainer?.classList.remove('pine-editor-fills-area');
    return;
  }

  const wasOpen = window.isEditorOpen;
  window.isEditorOpen = forceState ?? !window.isEditorOpen;
  // A reopened dock must never inherit an unreachable full-height state.
  if (!window.isEditorOpen) {
    drawer.classList.remove('editor-fullscreen');
    appContainer?.classList.remove('pine-editor-fills-area');
    drawer.style.removeProperty('height');
    drawer.dataset.editorSizeState = 'normal';
    const sizeControl = document.getElementById('btn-editor-fullscreen');
    sizeControl?.setAttribute('aria-pressed', 'false');
    sizeControl?.setAttribute('aria-label', 'Expand the editor to fill the platform');
    if (sizeControl) {
      sizeControl.title = 'Expand the editor to fill the platform';
      sizeControl.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>';
    }
  }
  drawer.style.display = window.isEditorOpen ? 'flex' : 'none';
  handle.style.display = window.isEditorOpen ? 'block' : 'none';
  if (window.isEditorOpen && !wasOpen && !standalonePineEditor) {
    drawer.dataset.previousHeight = String(drawer.offsetHeight);
    drawer.dataset.editorSizeState = 'fullscreen';
    drawer.classList.add('editor-fullscreen');
    appContainer?.classList.add('pine-editor-fills-area');
    const sizeControl = document.getElementById('btn-editor-fullscreen');
    sizeControl?.setAttribute('aria-pressed', 'true');
    sizeControl?.setAttribute('aria-label', 'Minimize the Pine editor');
    if (sizeControl) {
      sizeControl.title = 'Minimize the Pine editor';
      sizeControl.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 10 6 6 6-6" /></svg>';
    }
  }
  button?.classList.toggle('active', window.isEditorOpen);
  if (window.isEditorOpen) window.dispatchEvent(new CustomEvent('editor-opened'));
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

window.toggleEditor = toggleEditor;

document.addEventListener('omega:bottom-panel:editor-toggle', () => {
  toggleEditor();
});

if (standalonePineEditor) {
  document.body.dataset.pineEditorSurface = 'standalone';
  requestAnimationFrame(() => toggleEditor(true));
}

const resizeHandle = document.getElementById('resize-handle');
const editorDrawer = document.getElementById('editor-drawer');
if (resizeHandle && editorDrawer) {
  let dragging = false;
  let startY = 0;
  let startHeight = 320;

  resizeHandle.addEventListener('mousedown', event => {
    dragging = true;
    startY = event.clientY;
    startHeight = editorDrawer.offsetHeight;
    resizeHandle.classList.add('resizing');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', event => {
    if (!dragging) return;
    const height = Math.max(120, Math.min(window.innerHeight * 0.7, startHeight + startY - event.clientY));
    editorDrawer.style.height = `${height}px`;
  });
  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizeHandle.classList.remove('resizing');
    document.body.style.userSelect = '';
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
}

// One size control expands to fullscreen and collapses to the compact editor state.
const fullscreenButton = document.getElementById('btn-editor-fullscreen');
if (fullscreenButton && editorDrawer) {
  type EditorSizeState = 'normal' | 'fullscreen' | 'minimized';
  const getEditorSizeState = (): EditorSizeState => {
    if (editorDrawer.classList.contains('editor-fullscreen')) return 'fullscreen';
    return editorDrawer.dataset.editorSizeState === 'minimized' ? 'minimized' : 'normal';
  };
  const updateSizeButton = () => {
    const state = getEditorSizeState();
    const action = state === 'normal'
      ? 'Expand the editor to fill the platform'
      : state === 'fullscreen'
        ? 'Minimize the Pine editor'
        : 'Restore the Pine editor height';
    const direction = state === 'fullscreen' ? 'down' : 'up';
    const path = direction === 'up' ? 'm6 14 6-6 6 6' : 'm6 10 6 6 6-6';
    fullscreenButton.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}" /></svg>`;
    fullscreenButton.setAttribute('aria-pressed', String(state === 'fullscreen'));
    fullscreenButton.title = action;
    fullscreenButton.setAttribute('aria-label', action);
  };
  const restoreNormalHeight = () => {
    editorDrawer.classList.remove('editor-fullscreen');
    document.getElementById('app-container')?.classList.remove('pine-editor-fills-area');
    const previous = Number(editorDrawer.dataset.previousHeight);
    if (Number.isFinite(previous) && previous >= 120) editorDrawer.style.height = `${previous}px`;
    else editorDrawer.style.removeProperty('height');
    editorDrawer.dataset.editorSizeState = 'normal';
    updateSizeButton();
  };
  const syncEditorLayout = () => {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  updateSizeButton();
  fullscreenButton.addEventListener('click', () => {
    const state = getEditorSizeState();
    if (state === 'normal') {
      editorDrawer.dataset.previousHeight = String(editorDrawer.offsetHeight);
      editorDrawer.dataset.editorSizeState = 'fullscreen';
      editorDrawer.classList.add('editor-fullscreen');
      document.getElementById('app-container')?.classList.add('pine-editor-fills-area');
    } else if (state === 'fullscreen') {
      editorDrawer.classList.remove('editor-fullscreen');
      document.getElementById('app-container')?.classList.remove('pine-editor-fills-area');
      editorDrawer.style.height = '7.5rem';
      editorDrawer.dataset.editorSizeState = 'minimized';
    } else {
      // From the compact state, one click should expand directly to fullscreen.
      // Keep the height captured before the first expansion so Escape can restore it.
      editorDrawer.dataset.editorSizeState = 'fullscreen';
      editorDrawer.classList.add('editor-fullscreen');
      document.getElementById('app-container')?.classList.add('pine-editor-fills-area');
    }
    updateSizeButton();
    syncEditorLayout();
  });
  // Escape is a reliable recovery path even if a narrow layout makes the toolbar awkward.
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && editorDrawer.classList.contains('editor-fullscreen')) {
      event.preventDefault();
      restoreNormalHeight();
      syncEditorLayout();
    }
  });
}

const consoleDivider = document.getElementById('console-divider');
const consolePanel = document.getElementById('console-panel');
const consoleToggleHandle = document.getElementById('console-toggle-handle') as HTMLButtonElement | null;
const consoleOutput = document.getElementById('console-output');
const consoleActivityOutput = document.getElementById('console-activity-output');
const activityConsoleList = document.getElementById('activity-console-list');

// Match the Pine editor's Ctrl/Cmd+wheel behavior for every in-app log view.
// This changes only the log text size and never the platform layout scale.
const consoleFontSizeStorageKey = 'omega.console.font-size';
let consoleFontSize = Number(localStorage.getItem(consoleFontSizeStorageKey));
if (!Number.isFinite(consoleFontSize)) consoleFontSize = 12;
consoleFontSize = Math.max(10, Math.min(30, Math.round(consoleFontSize)));

function installConsoleFontZoom(host: HTMLElement | null): void {
  if (!host) return;
  host.style.setProperty('--omega-console-font-size', `${consoleFontSize}px`);
  host.addEventListener('wheel', event => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    event.stopPropagation();
    const direction = event.deltaY < 0 ? 1 : -1;
    const nextSize = Math.max(10, Math.min(30, consoleFontSize + direction));
    if (nextSize === consoleFontSize) return;
    consoleFontSize = nextSize;
    localStorage.setItem(consoleFontSizeStorageKey, String(consoleFontSize));
    document.querySelectorAll<HTMLElement>('#console-output, #console-activity-output, #activity-console-list')
      .forEach(element => element.style.setProperty('--omega-console-font-size', `${consoleFontSize}px`));
  }, { passive: false, capture: true });
}

installConsoleFontZoom(consoleOutput);
installConsoleFontZoom(consoleActivityOutput);
installConsoleFontZoom(activityConsoleList);

consoleToggleHandle?.addEventListener('click', () => {
  if (!consolePanel) return;
  const collapsed = consolePanel.classList.toggle('console-collapsed');
  consoleToggleHandle.textContent = collapsed ? '▲' : '▼';
  const label = collapsed ? 'Expand Pine Console' : 'Collapse Pine Console';
  consoleToggleHandle.setAttribute('aria-label', label);
  consoleToggleHandle.title = label;
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
});

if (consoleDivider && consolePanel && document.getElementById('editor-top')) {
  let resizing = false;
  let startY = 0;
  let startHeight = 200;
  const savedHeight = Number(localStorage.getItem('vela_console_height'));
  if (savedHeight > 0) consolePanel.style.height = `${savedHeight}px`;

  consoleDivider.addEventListener('mousedown', event => {
    resizing = true;
    startY = event.clientY;
    startHeight = consolePanel.offsetHeight;
    consoleDivider.classList.add('resizing');
    document.body.style.userSelect = 'none';
  });
  window.addEventListener('mousemove', event => {
    if (!resizing) return;
    const editorWorkspace = document.getElementById('editor-workspace');
    if (!editorWorkspace) return;
    const maxHeight = editorWorkspace.offsetHeight - 120;
    const height = Math.max(80, Math.min(maxHeight, startHeight + startY - event.clientY));
    consolePanel.style.height = `${height}px`;
    localStorage.setItem('vela_console_height', String(Math.round(height)));
  });
  window.addEventListener('mouseup', () => {
    if (!resizing) return;
    resizing = false;
    consoleDivider.classList.remove('resizing');
    document.body.style.userSelect = '';
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  });
}

document.getElementById('console-errors-clear')?.addEventListener('click', () => {
  if (consoleOutput) consoleOutput.textContent = '';
});
document.getElementById('console-activity-clear')?.addEventListener('click', () => {
  if (consoleActivityOutput) consoleActivityOutput.textContent = '';
});
window.showConsole = () => {
  if (consolePanel) consolePanel.style.display = 'flex';
  if (consoleDivider) consoleDivider.style.display = 'block';
  window.dispatchEvent(new Event('resize'));
};

function appendConsoleLine(host: HTMLElement | null, message: string, type = 'info', diagnosticKey?: string): void {
  if (!host) return;
  const line = document.createElement('div');
  line.className = `console-line ${type}`;
  if (diagnosticKey) line.dataset.diagnosticKey = diagnosticKey;
  const icon = document.createElement('span');
  icon.className = 'console-line-icon';
  icon.textContent = type === 'error' ? 'E' : type === 'warning' ? 'W' : type === 'success' ? 'OK' : 'i';
  const text = document.createElement('span');
  text.textContent = message;
  line.append(icon, text);
  host.append(line);
  while (host.childElementCount > 250) host.firstElementChild?.remove();
  host.scrollTop = host.scrollHeight;
}

window.addConsoleOutput = (message, type = 'info', diagnosticKey) => {
  appendConsoleLine(consoleOutput, message, type, diagnosticKey);
  window.showConsole();
};

window.addConsoleActivity = (message, type = 'info') => {
  appendConsoleLine(consoleActivityOutput, message, type);
  window.showConsole();
};

window.clearConsoleDiagnostics = diagnosticKey => {
  consoleOutput?.querySelectorAll<HTMLElement>('.console-line[data-diagnostic-key]').forEach(line => {
    if (line.dataset.diagnosticKey === diagnosticKey) line.remove();
  });
};
