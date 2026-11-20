import { pineReference, type PineReferenceEntry } from './pineReference.ts';
import { PINE_DOCS } from './pineHoverDocs.ts';

export type { PineReferenceEntry } from './pineReference';

/** Merge curated Vela hover docs into Omega's reference without replacing its own entries. */
export const pineEditorReference: PineReferenceEntry[] = (() => {
  const merged = new Map(pineReference.map((entry) => [entry.name, { ...entry }]));
  for (const doc of Object.values(PINE_DOCS)) {
    const current = merged.get(doc.name);
    const manual = [
      doc.summary,
      doc.returns ? `Returns: ${doc.returns}` : '',
      doc.parameters?.length ? `Parameters:\n${doc.parameters.map((parameter) => `- ${parameter.name} (${parameter.type}${parameter.optional ? ', optional' : ''}${parameter.default ? `, default ${parameter.default}` : ''}): ${parameter.description}`).join('\n')}` : '',
      doc.example ? `Example:\n\`\`\`pine\n${doc.example}\n\`\`\`` : '',
      doc.manual ?? '',
    ].filter(Boolean).join('\n\n');
    if (current) {
      const hasCuratedVelaDetails = Boolean(doc.parameters?.length || doc.example || doc.manual);
      if (hasCuratedVelaDetails) {
        current.description = doc.summary;
        if (manual && !current.manual?.includes(doc.summary)) {
          current.manual = [manual, current.manual ? `## Omega reference\n\n${current.manual}` : ''].filter(Boolean).join('\n\n');
        }
      }
      continue;
    }
    merged.set(doc.name, {
      name: doc.name,
      signature: doc.syntax,
      description: doc.summary,
      category: doc.kind === 'function' ? 'Vela Pine Reference' : 'Pine Language',
      manual,
    });
  }
  return [...merged.values()];
})();
