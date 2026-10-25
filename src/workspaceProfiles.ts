import type { VelaWorkspace } from '@luxalgo/vela/workspace';

export function ensureWorkspaceScriptLedger(value: unknown): unknown {
  if (!value || typeof value !== 'object' || !Array.isArray((value as { charts?: unknown }).charts)) return value;
  const document = value as { charts: unknown[] };
  return {
    ...document,
    charts: document.charts.map(chart => {
      if (!chart || typeof chart !== 'object' || Array.isArray(chart)) return chart;
      const entry = chart as { ext?: unknown };
      const ext = entry.ext && typeof entry.ext === 'object' && !Array.isArray(entry.ext)
        ? entry.ext as Record<string, unknown>
        : {};
      return {
        ...entry,
        ext: {
          ...ext,
          'omega.scriptIndicators': Array.isArray(ext['omega.scriptIndicators']) ? ext['omega.scriptIndicators'] : [],
        },
      };
    }),
  };
}

export function initializeWorkspaceProfiles(
  workspace: VelaWorkspace,
  onApplyState: (state: unknown) => void,
): void {
  const profileNameInput = document.getElementById('workspace-profile-name') as HTMLInputElement | null;
  const saveBtn = document.getElementById('workspace-save-profile');
  const loadBtn = document.getElementById('workspace-load-profile');

  saveBtn?.addEventListener('click', async () => {
    const name = profileNameInput?.value.trim() ?? '';
    const state = JSON.stringify(workspace.getState());
    try {
      if (window.velaWorkspaceFiles) {
        const result = await window.velaWorkspaceFiles.saveProfile(name, state);
        if (!result.canceled) workspace.toast(`Workspace saved${result.path ? `: ${result.path}` : '.'}`, 'success');
        return;
      }
      if (!name) {
        workspace.toast('Enter a workspace name first.', 'error');
        return;
      }
      localStorage.setItem(`vela-profile:${name}`, state);
      workspace.toast(`Workspace "${name}" saved.`, 'success');
    } catch (error) {
      workspace.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  });

  loadBtn?.addEventListener('click', async () => {
    try {
      if (window.velaWorkspaceFiles) {
        const result = await window.velaWorkspaceFiles.loadProfile();
        if (!result.canceled && result.state) onApplyState(ensureWorkspaceScriptLedger(JSON.parse(result.state)));
        return;
      }
      const name = profileNameInput?.value.trim() ?? '';
      const state = name ? localStorage.getItem(`vela-profile:${name}`) : null;
      if (!state) {
        workspace.toast('Workspace profile not found.', 'error');
        return;
      }
      onApplyState(ensureWorkspaceScriptLedger(JSON.parse(state)));
    } catch (error) {
      workspace.toast(error instanceof Error ? error.message : String(error), 'error');
    }
  });
}
