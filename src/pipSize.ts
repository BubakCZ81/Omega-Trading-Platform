/**
 * Pip size inference for FX-style symbols.
 *
 * This is the only part of the retired order-flow chart module that is still needed:
 * paper trading and the spread readout use it to convert price units to pips. The Renko
 * and Range chart types that used to live beside it were removed because Vela does not
 * support styles that change the bar count or the time axis, which is why those bars
 * could never be sequenced reliably.
 */

const FX_CURRENCIES = new Set([
  'AUD', 'CAD', 'CHF', 'EUR', 'GBP', 'JPY', 'NZD', 'USD',
]);

/**
 * The pip size of an FX pair such as EURUSD (0.0001) or USDJPY (0.01), or `null` when the
 * symbol is not a six-letter FX pair.
 */
export function inferPipSize(symbol: string): number | null {
  const normalized = symbol.toUpperCase().replace(/[^A-Z]/g, '');
  for (let index = 0; index <= normalized.length - 6; index += 1) {
    const base = normalized.slice(index, index + 3);
    const quote = normalized.slice(index + 3, index + 6);
    if (FX_CURRENCIES.has(base) && FX_CURRENCIES.has(quote)) {
      return quote === 'JPY' ? 0.01 : 0.0001;
    }
  }
  return null;
}
