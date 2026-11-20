/**
 * Structural Pine Script linter.
 *
 * The npm validator in `pineStaticValidator.ts` stops at the FIRST error it finds, so an
 * operator with four mistakes in a file is shown one of them, fixes it, recompiles, and is
 * shown the next — one at a time, which is what made the editor feel broken.
 *
 * This module does not try to be a Pine parser. It checks the mistakes that can be found
 * in a single pass without one, so they can all be reported at once, on their own lines:
 *
 *   - unbalanced ( ) [ ] { }
 *   - unterminated string literals
 *   - a script that declares no indicator/strategy/library
 *   - `strategy.*` used in a script that never declared `strategy(...)`
 *   - a near-miss namespace (`strr.format`, `matth.abs`) with a "did you mean" hint
 *   - indentation that mixes tabs and spaces
 *
 * Deliberately conservative: nothing is reported unless the evidence is unambiguous, so a
 * false marker cannot teach the operator to ignore the gutter.
 */

export interface PineLintDiagnostic {
  message: string;
  line: number;
  column: number;
  length: number;
  severity: 'error' | 'warning' | 'info';
  source: string;
}

const SOURCE = 'Omega Pine linter';

/** Namespaces Pine actually exposes. Used only to suggest near-misses. */
const PINE_NAMESPACES = new Set([
  'ta', 'math', 'str', 'array', 'matrix', 'map', 'request', 'strategy', 'color',
  'label', 'line', 'box', 'table', 'input', 'alert', 'timeframe', 'syminfo',
  'barstate', 'session', 'currency', 'dayofweek', 'plot', 'hline', 'fill',
  'bgcolor', 'barcolor', 'indicator', 'library', 'display', 'format', 'order',
  'position', 'size', 'shape', 'scale', 'xloc', 'yloc', 'extend', 'chart',
  'runtime', 'log', 'time', 'timenow', 'na', 'bool', 'int', 'float', 'string',
]);

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

function distance(left: string, right: string): number {
  if (left === right) return 0;
  const rows = left.length + 1;
  const columns = right.length + 1;
  const table: number[][] = Array.from({ length: rows }, (_, row) => {
    const line = new Array<number>(columns).fill(0);
    line[0] = row;
    return line;
  });
  for (let column = 1; column < columns; column += 1) table[0][column] = column;
  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      table[row][column] = Math.min(
        table[row - 1][column] + 1,
        table[row][column - 1] + 1,
        table[row - 1][column - 1] + cost,
      );
    }
  }
  return table[rows - 1][columns - 1];
}

/** The closest real namespace, when `candidate` is a plausible typo of one. */
function suggestNamespace(candidate: string): string | null {
  if (candidate.length < 3) return null;
  let best: { name: string; score: number } | null = null;
  for (const name of PINE_NAMESPACES) {
    const score = distance(candidate, name);
    if (score <= (name.length <= 4 ? 1 : 2) && (!best || score < best.score)) best = { name, score };
  }
  return best?.name ?? null;
}

/** Strip a line's code from its string literals and trailing comment. */
function scanLine(raw: string): { code: string; hasOpenString: boolean } {
  let code = '';
  let quote: string | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index];
    if (quote) {
      if (character === '\\') { index += 1; continue; }
      if (character === quote) quote = null;
      code += ' ';
      continue;
    }
    if (character === '"' || character === "'") { quote = character; code += ' '; continue; }
    if (character === '/' && raw[index + 1] === '/') break;
    code += character;
  }
  return { code, hasOpenString: quote !== null };
}

/**
 * Lint a Pine source. Returns every problem it can prove, in source order.
 */
export function lintPineSource(source: string): PineLintDiagnostic[] {
  if (!source.trim()) return [];
  const lines = source.split(/\r?\n/);
  const diagnostics: PineLintDiagnostic[] = [];
  const stack: { character: string; line: number; column: number }[] = [];
  const declaredNames = new Set<string>();
  let declaresScript = false;
  let usesStrategyNamespace = 0;
  let firstStrategyUse: { line: number; column: number } | null = null;
  let sawTabIndent = false;
  let sawSpaceIndent = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    const { code, hasOpenString } = scanLine(raw);

    if (hasOpenString) {
      diagnostics.push({
        message: 'Unterminated string: this quote is never closed before the end of the line.',
        line: lineNumber,
        column: raw.search(/["']/) + 1 || 1,
        length: 1,
        severity: 'error',
        source: SOURCE,
      });
    }

    if (/^\t+/.test(raw)) sawTabIndent = true;
    if (/^ +\S/.test(raw) && /^\s*/.exec(raw)?.[0].length) sawSpaceIndent = true;

    const declaration = /^\s*(indicator|strategy|library)\s*\(/.exec(code);
    if (declaration) declaresScript = true;

    const assignment = /^\s*(?:var\s+|varip\s+)?([a-z_]\w*)\s*=(?!=)/i.exec(code);
    if (assignment) declaredNames.add(assignment[1].toLowerCase());

    for (let column = 0; column < code.length; column += 1) {
      const character = code[column];
      if (OPENERS[character]) {
        stack.push({ character, line: lineNumber, column: column + 1 });
        continue;
      }
      if (!CLOSERS.has(character)) continue;
      const open = stack.pop();
      if (!open) {
        diagnostics.push({
          message: `Unmatched "${character}": there is no open bracket for it.`,
          line: lineNumber,
          column: column + 1,
          length: 1,
          severity: 'error',
          source: SOURCE,
        });
        continue;
      }
      if (OPENERS[open.character] !== character) {
        diagnostics.push({
          message: `Mismatched brackets: "${open.character}" opened on line ${open.line} is closed with "${character}".`,
          line: lineNumber,
          column: column + 1,
          length: 1,
          severity: 'error',
          source: SOURCE,
        });
      }
    }

    for (const match of code.matchAll(/\b([A-Za-z_]\w*)\.([A-Za-z_]\w*)/g)) {
      const namespace = match[1];
      const lower = namespace.toLowerCase();
      if (lower === 'strategy') {
        usesStrategyNamespace += 1;
        if (!firstStrategyUse) firstStrategyUse = { line: lineNumber, column: (match.index ?? 0) + 1 };
        continue;
      }
      if (PINE_NAMESPACES.has(lower) || declaredNames.has(lower)) continue;
      const suggestion = suggestNamespace(lower);
      if (!suggestion) continue;
      diagnostics.push({
        message: `Unknown namespace "${namespace}". Did you mean "${suggestion}"?`,
        line: lineNumber,
        column: (match.index ?? 0) + 1,
        length: namespace.length,
        severity: 'warning',
        source: SOURCE,
      });
    }
  }

  // Brackets left open at the end of the file: report each one where it was opened, which
  // is the line the operator actually has to fix.
  for (const open of stack) {
    diagnostics.push({
      message: `"${open.character}" is never closed.`,
      line: open.line,
      column: open.column,
      length: 1,
      severity: 'error',
      source: SOURCE,
    });
  }

  if (!declaresScript) {
    diagnostics.push({
      message: 'Missing script declaration: add indicator(...), strategy(...) or library(...) as the first statement.',
      line: 1,
      column: 1,
      length: 1,
      severity: 'error',
      source: SOURCE,
    });
  } else if (usesStrategyNamespace > 0 && firstStrategyUse && !/^\s*strategy\s*\(/m.test(source)) {
    diagnostics.push({
      message: 'strategy.* is used but this script is not declared with strategy(...).',
      line: firstStrategyUse.line,
      column: firstStrategyUse.column,
      length: 'strategy'.length,
      severity: 'error',
      source: SOURCE,
    });
  }

  if (sawTabIndent && sawSpaceIndent) {
    diagnostics.push({
      message: 'Indentation mixes tabs and spaces; Pine requires consistent indentation inside a block.',
      line: 1,
      column: 1,
      length: 1,
      severity: 'warning',
      source: SOURCE,
    });
  }

  return diagnostics.sort((left, right) => left.line - right.line || left.column - right.column);
}
