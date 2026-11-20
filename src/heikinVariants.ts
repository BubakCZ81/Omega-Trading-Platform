/**
 * Registers the Heikin Ashi calculation variants with the charting layer.
 *
 * The mathematics lives in `heikinMath.ts` so it can be tested without loading the charting
 * library; this module only performs the registration side effect.
 */

import { registerChartType } from './platform';
import { createHeikinTransform, HEIKIN_VARIANTS, type HeikinBar } from './heikinMath';

/**
 * Register every variant. The built-in `heikinashi` style is left untouched so saved
 * workspaces keep working — these are additional choices, not replacements.
 */
export function registerHeikinVariants(): void {
  for (const variant of HEIKIN_VARIANTS) {
    // 'heikin-standard' is the textbook formula the built-in style already applies.
    if (variant.id === 'heikin-standard') continue;
    const transform = createHeikinTransform(variant.smoothing, variant.length);
    registerChartType({
      id: variant.id,
      label: variant.label,
      barTransform: {
        full: raw => transform.full(raw as readonly HeikinBar[]) as never,
        next: (raw, previousView) => transform.next(raw as HeikinBar, previousView as HeikinBar | undefined) as never,
      },
    });
  }
}
