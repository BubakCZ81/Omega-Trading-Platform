import './pineEditorStandalone.css';
import { createPineEditor, createPineModel, getPineReferenceNameAtPosition, type PineEditor, type PineModel } from './pineEditorNext';
import { createPineReferencePanel } from './pineReferencePanel';
import { DEFAULT_SCRIPTS, getSavedScripts, saveScriptsToStorage } from './pineStorage';

type ChartAction = 'add' | 'update';

interface PineEditorBridge {
  open(): Promise<boolean>;
  openScript(name: string, source: string): Promise<boolean>;
  openDocked(): void;
  onOpenDocked(callback: () => void): () => void;
  publishScriptUpdate(script: { name: string; source: string; action: ChartAction }): void;
  onScriptUpdated(callback: (script: { name: string; source: string; action: ChartAction }) => void): () => void;
  onOpenScript(callback: (script: { name: string; source: string }) => void): () => void;
  onScriptResult(callback: (result: { name: string; action: ChartAction; ok: boolean; message: string }) => void): () => void;
  publishScriptResult(result: { name: string; action: ChartAction; ok: boolean; message: string }): void;
}

interface PineExportBridge {
  save(name: string, source: string): Promise<{ canceled: boolean; path?: string }>;
}

declare global {
  interface Window {
    velaPineEditorWindow?: PineEditorBridge;
    velaPineExport?: PineExportBridge;
  }
}

const scripts = getSavedScripts();
let currentScriptName = Object.keys(scripts)[0] ?? Object.keys(DEFAULT_SCRIPTS)[0];
let editor: PineEditor;
const models = new Map<string, PineModel>();
const scriptSelect = document.getElementById('script-select') as HTMLSelectElement;
const status = document.getElementById('editor-status') as HTMLSpanElement;
const editorHost = document.getElementById('code-editor') as HTMLDivElement;
const reference = document.getElementById('pine-reference') as HTMLElement;
let autosaveTimer: number | undefined;

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.dataset.state = isError ? 'error' : '';
}

function modelFor(name: string): PineModel {
  const existing = models.get(name);
  if (existing && !existing.isDisposed()) return existing;
  const model = createPineModel(`inmemory://pine/${encodeURIComponent(name)}.pine`, scripts[name] ?? '');
  models.set(name, model);
  return model;
}

function currentSource(): string {
  return editor.getValue();
}

function saveCurrent(showStatus = true): void {
  scripts[currentScriptName] = currentSource();
  saveScriptsToStorage(scripts, message => setStatus(message, true));
  if (showStatus) setStatus(`Saved “${currentScriptName}”.`);
}

function refreshScriptSelect(): void {
  scriptSelect.replaceChildren();
  for (const name of Object.keys(scripts)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    option.selected = name === currentScriptName;
    scriptSelect.append(option);
  }
}

function selectScript(name: string): void {
  currentScriptName = name;
  refreshScriptSelect();
  editor.setModel(modelFor(name));
  editor.focus();
  setStatus(`Editing “${name}”.`);
}

const referencePanel = createPineReferencePanel(() => editor);
editor = createPineEditor(editorHost, modelFor(currentScriptName), 'dark');
editor.onMouseDown(event => {
  if (event.event.browserEvent.detail !== 2 || !event.target.position) return;
  const model = editor.getModel();
  if (!model) return;
  const name = getPineReferenceNameAtPosition(model, event.target.position);
  if (name) referencePanel.open(name);
});
editor.onDidChangeModelContent(() => {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(() => saveCurrent(false), 650);
  setStatus('Unsaved changes');
});
refreshScriptSelect();

scriptSelect.addEventListener('change', () => selectScript(scriptSelect.value));
document.getElementById('save-script')?.addEventListener('click', () => saveCurrent());
document.getElementById('new-script')?.addEventListener('click', () => {
  const name = window.prompt('Name of the new Pine script:')?.trim();
  if (!name) return;
  if (Object.hasOwn(scripts, name)) {
    setStatus(`A script named “${name}” already exists.`, true);
    return;
  }
  scripts[name] = `//@version=6\nindicator(${JSON.stringify(name)}, overlay = true)\n\nplot(ta.ema(close, 20), "EMA 20", color = color.yellow)\n`;
  saveScriptsToStorage(scripts, message => setStatus(message, true));
  selectScript(name);
});
document.getElementById('delete-script')?.addEventListener('click', () => {
  if (Object.keys(scripts).length <= 1) {
    setStatus('Keep at least one script.', true);
    return;
  }
  if (!window.confirm(`Delete “${currentScriptName}”?`)) return;
  models.get(currentScriptName)?.dispose();
  models.delete(currentScriptName);
  delete scripts[currentScriptName];
  saveScriptsToStorage(scripts, message => setStatus(message, true));
  selectScript(Object.keys(scripts)[0]);
});
document.getElementById('export-script')?.addEventListener('click', async () => {
  saveCurrent(false);
  try {
    const result = await window.velaPineExport?.save(currentScriptName, currentSource());
    if (result && !result.canceled) setStatus(`Exported “${currentScriptName}”.`);
  } catch (error) {
    setStatus(`Could not export: ${error instanceof Error ? error.message : String(error)}`, true);
  }
});
document.getElementById('toggle-reference')?.addEventListener('click', () => {
  reference.hidden = !reference.hidden;
  const button = document.getElementById('toggle-reference') as HTMLButtonElement;
  button.setAttribute('aria-expanded', String(!reference.hidden));
  editor.layout();
});
document.getElementById('close-reference')?.addEventListener('click', () => {
  reference.hidden = true;
  (document.getElementById('toggle-reference') as HTMLButtonElement).setAttribute('aria-expanded', 'false');
  editor.layout();
});

function sendToChart(action: ChartAction): void {
  saveCurrent(false);
  if (!window.velaPineEditorWindow) {
    setStatus('The main Omega window is not available.', true);
    return;
  }
  window.velaPineEditorWindow.publishScriptUpdate({ name: currentScriptName, source: currentSource(), action });
  setStatus(`${action === 'add' ? 'Adding' : 'Updating'} “${currentScriptName}” on the chart…`);
}
document.getElementById('add-to-chart')?.addEventListener('click', () => sendToChart('add'));
document.getElementById('update-chart')?.addEventListener('click', () => sendToChart('update'));

window.velaPineEditorWindow?.onOpenScript(({ name, source }) => {
  if (!name || typeof source !== 'string') return;
  scripts[name] = source;
  saveScriptsToStorage(scripts, message => setStatus(message, true));
  const model = models.get(name);
  if (model && !model.isDisposed() && model.getValue() !== source) model.setValue(source);
  selectScript(name);
});
window.velaPineEditorWindow?.onScriptResult(({ name, ok, message }) => {
  if (name === currentScriptName) setStatus(message, !ok);
});

window.addEventListener('resize', () => editor.layout());
requestAnimationFrame(() => editor.focus());
