import type { ScriptingEngine } from './platform';
import { normalizePineRuntimeCompatibilitySource } from './pineRuntimeCompatibility.ts';

let validationEngine: ScriptingEngine | null = null;
let validationEngineLoading: Promise<ScriptingEngine> | null = null;
let validationSequence = 0;

async function getValidationEngine(): Promise<ScriptingEngine> {
  if (validationEngine) return validationEngine;
  if (!validationEngineLoading) {
    validationEngineLoading = import('@luxalgo/vela-pinets')
      .then(({ PineEngine }) => {
        validationEngine = new PineEngine();
        return validationEngine;
      })
      .catch(error => {
        validationEngineLoading = null;
        throw error;
      });
  }
  return validationEngineLoading;
}

export async function validatePineSourceOnWorker(
  source: string,
  engine?: ScriptingEngine,
): Promise<void> {
  const runtime = engine ?? await getValidationEngine();
  const normalized = normalizePineRuntimeCompatibilitySource(source);
  await runtime.prepare(normalized, `omega-validation-${++validationSequence}`);
}
