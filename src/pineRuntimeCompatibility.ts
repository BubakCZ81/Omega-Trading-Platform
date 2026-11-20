export function normalizePineRuntimeCompatibilitySource(source: string): string {
  if (typeof source !== 'string' || !source) return source;

  return source.replace(
    /(^|\n)(\s*)rows\s*:=\s*int\(math\.ceil\(rngP\s*\/\s*step\)\)/g,
    (_match, prefix: string, indentation: string) =>
      `${prefix}${indentation}rows := math.max(1, int(math.ceil(rngP / step)))`,
  );
}
