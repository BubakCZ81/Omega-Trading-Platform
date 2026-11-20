export interface ChartScriptSource {
  source?: unknown;
  title?: unknown;
  id?: unknown;
}

export interface InternalStrategySource {
  title: string;
  source: string;
}

/** A Pine strategy is evaluated only by the isolated local replay engine. */
export function currentInternalStrategy(scripts: readonly ChartScriptSource[]): InternalStrategySource | null {
  const script = scripts.find(candidate =>
    typeof candidate.source === 'string' && /^\s*strategy\s*\(/m.test(candidate.source),
  );
  if (!script || typeof script.source !== 'string') return null;
  const title = typeof script.title === 'string' && script.title.trim()
    ? script.title.trim()
    : typeof script.id === 'string' && script.id.trim() ? script.id.trim() : 'Current strategy';
  return { title: title.slice(0, 160), source: script.source };
}
