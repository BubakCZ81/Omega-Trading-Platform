export type ModuleHealthState = 'ready' | 'missing' | 'recovered' | 'failed' | 'disabled' | 'deferred';

export interface StartupModuleDefinition {
  id: string;
  label: string;
  /** Optional modules that the operator disabled are reported as disabled, not broken. */
  optional?: boolean;
  isReady(): boolean | Promise<boolean>;
  recover?(): void | Promise<void>;
}

/**
 * A module that is deliberately NOT loaded during startup and is fetched on first use.
 *
 * It is still indexed, so the platform knows it exists, can report it as deferred rather
 * than broken, and can load it — sequentially, with one retry — when a feature needs it.
 */
export interface DeferredModuleDefinition {
  id: string;
  label: string;
  load(): Promise<unknown>;
}

export interface ModuleAudit {
  ready: string[];
  recovered: string[];
  deferred: string[];
  disabled: string[];
  problematic: string[];
}

type RecordDiagnostic = (entry: {
  source: string;
  type: string;
  name: string;
  status: 'ok' | 'error' | 'start';
  message: string;
}) => void;

const DEFAULT_RECOVERY_ATTEMPTS = 2;

/**
 * Verifies the modules that have a visible effect on the trading workspace.
 *
 * The platform must never open with half of its settings silently missing, so every
 * user-visible module is indexed here by id and label. A module that reports itself
 * unready is given a bounded number of recovery attempts; recovery is deliberately
 * finite so a genuinely broken optional module cannot create an endless retry loop or
 * keep consuming CPU after the platform has opened.
 */
export class StartupModuleIndex {
  private readonly modules: StartupModuleDefinition[] = [];
  private readonly deferredModules = new Map<string, DeferredModuleDefinition>();
  private readonly deferredLoads = new Map<string, Promise<unknown>>();
  private readonly deferredLoaded = new Set<string>();
  private lastResults: Record<string, ModuleHealthState> = {};
  private readonly record: RecordDiagnostic | undefined;
  private readonly recoveryAttempts: number;

  // Fields are assigned explicitly rather than declared as constructor parameter
  // properties: Node's type stripping cannot load parameter properties, which made this
  // module impossible to import from a test.
  constructor(record: RecordDiagnostic | undefined, recoveryAttempts = DEFAULT_RECOVERY_ATTEMPTS) {
    this.record = record;
    this.recoveryAttempts = recoveryAttempts;
  }

  register(definition: StartupModuleDefinition): void {
    if (this.modules.some(module => module.id === definition.id)) return;
    this.modules.push(definition);
  }

  /** Index a module that is loaded on first use instead of during startup. */
  registerDeferred(definition: DeferredModuleDefinition): void {
    if (this.deferredModules.has(definition.id)) return;
    this.deferredModules.set(definition.id, definition);
  }

  isDeferredLoaded(id: string): boolean {
    return this.deferredLoaded.has(id);
  }

  /**
   * Load a deferred module, one at a time, retrying a failed load once.
   *
   * Concurrent callers share one in-flight load, so a feature cannot fetch the same
   * chunk twice. Resolves to `null` when every attempt failed — the caller keeps its
   * existing fallback instead of throwing into the UI.
   */
  loadDeferred<T = unknown>(id: string, attempts = 2): Promise<T | null> {
    const inFlight = this.deferredLoads.get(id);
    if (inFlight) return inFlight as Promise<T | null>;
    const definition = this.deferredModules.get(id);
    if (!definition) return Promise.resolve(null);
    const total = Math.max(1, attempts);
    const run = (async (): Promise<T | null> => {
      for (let attempt = 1; attempt <= total; attempt += 1) {
        try {
          this.logDeferred(definition, 'start', `loading on demand (attempt ${attempt} of ${total}).`);
          const value = await definition.load();
          this.deferredLoaded.add(id);
          this.logDeferred(definition, 'ok', 'loaded on demand.');
          return value as T;
        } catch (error) {
          this.logDeferred(definition, 'error', error instanceof Error ? error.message : String(error));
        }
      }
      return null;
    })();
    this.deferredLoads.set(id, run);
    return run;
  }

  /**
   * What the platform expects to have, and what it actually has.
   *
   * Deferred modules are reported as deferred — not as failures — so a healthy platform
   * is never misreported just because a feature has not been opened yet.
   */
  audit(): ModuleAudit {
    const result: ModuleAudit = { ready: [], recovered: [], deferred: [], disabled: [], problematic: [] };
    for (const module of this.modules) {
      const state = this.lastResults[module.id];
      if (state === 'ready') result.ready.push(module.id);
      else if (state === 'recovered') result.recovered.push(module.id);
      else if (state === 'disabled') result.disabled.push(module.id);
      else result.problematic.push(module.id);
    }
    for (const id of this.deferredModules.keys()) {
      if (this.deferredLoaded.has(id)) result.ready.push(id);
      else result.deferred.push(id);
    }
    return result;
  }

  private logDeferred(definition: DeferredModuleDefinition, status: 'ok' | 'error' | 'start', message: string): void {
    this.record?.({
      source: 'startup-index', type: 'module', name: definition.id, status,
      message: `${definition.label}: ${message}`,
    });
  }

  /** The id/label inventory, so a caller can report what the platform expects to load. */
  inventory(): { id: string; label: string; optional: boolean }[] {
    const entries = this.modules.map(module => ({ id: module.id, label: module.label, optional: Boolean(module.optional) }));
    for (const module of this.deferredModules.values()) {
      entries.push({ id: module.id, label: module.label, optional: true });
    }
    return entries;
  }

  /** Health from the most recent verification pass. */
  results(): Record<string, ModuleHealthState> {
    return { ...this.lastResults };
  }

  async verifyAndRecover(): Promise<Record<string, ModuleHealthState>> {
    const result: Record<string, ModuleHealthState> = {};
    for (const module of this.modules) {
      const health = await this.safelyReady(module);
      if (health.ready) {
        result[module.id] = 'ready';
        this.log(module, 'ok', 'ready');
        continue;
      }
      if (!module.recover) {
        // A probe that THROWS means the module's own check is broken — that is a failure,
        // not "the feature is absent". A probe that merely answers false is "missing".
        result[module.id] = module.optional ? 'disabled' : health.errored ? 'failed' : 'missing';
        this.log(module, module.optional ? 'start' : 'error', module.optional
          ? 'not available in this session.'
          : health.errored ? 'its readiness check failed.' : 'missing and has no safe recovery action.');
        continue;
      }
      let recovered = false;
      for (let attempt = 1; attempt <= this.recoveryAttempts && !recovered; attempt += 1) {
        this.log(module, 'start', `missing; attempting recovery ${attempt} of ${this.recoveryAttempts}.`);
        try {
          await module.recover();
          recovered = (await this.safelyReady(module)).ready;
        } catch (error) {
          this.log(module, 'error', error instanceof Error ? error.message : String(error));
        }
      }
      result[module.id] = recovered ? 'recovered' : 'failed';
      this.log(module, recovered ? 'ok' : 'error', recovered ? 'recovered.' : 'recovery did not make the module ready.');
    }
    this.lastResults = result;
    return result;
  }

  private async safelyReady(module: StartupModuleDefinition): Promise<{ ready: boolean; errored: boolean }> {
    try {
      return { ready: Boolean(await module.isReady()), errored: false };
    } catch (error) {
      this.log(module, 'error', error instanceof Error ? error.message : String(error));
      return { ready: false, errored: true };
    }
  }

  private log(module: StartupModuleDefinition, status: 'ok' | 'error' | 'start', message: string): void {
    this.record?.({
      source: 'startup-index', type: 'module', name: module.id, status,
      message: `${module.label}: ${message}`,
    });
  }
}

/**
 * True when every one of the given element ids exists in the document.
 *
 * Presence — not visibility — is the right signal for module health: panels and
 * dialogs such as the broker or assistant panel are legitimately hidden until the
 * operator opens them, so requiring visibility would report them as broken forever.
 */
export function moduleElementsReady(ids: readonly string[]): boolean {
  if (typeof document === 'undefined') return false;
  return ids.every(id => document.getElementById(id) !== null);
}
