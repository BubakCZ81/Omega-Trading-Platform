export type SymbolPickerCategory =
  | 'Forex'
  | 'Indices'
  | 'Stocks'
  | 'Crypto'
  | 'Futures & Commodities'
  | 'Other';

export const SYMBOL_PICKER_CATEGORIES: readonly SymbolPickerCategory[] = [
  'Forex',
  'Indices',
  'Stocks',
  'Crypto',
  'Futures & Commodities',
  'Other',
];

export interface SymbolPickerAsset {
  ticker: string;
  description?: string;
  type?: string;
  group?: string;
  provider?: string;
  prefix?: string;
}

export function symbolPickerCategory(item: SymbolPickerAsset): SymbolPickerCategory {
  const text = `${item.group ?? ''} ${item.type ?? ''} ${item.description ?? ''} ${item.ticker}`.toUpperCase();
  const ticker = item.ticker.toUpperCase();
  if (/\b(FOREX|FX|CURRENCY|CURRENCIES)\b/.test(text)) return 'Forex';
  if (/\b(INDEX|INDICES|US30|NAS100|USTEC|SPX|SP500|GER40|DE40|UK100|JP225|AUS200|FRA40)\b/.test(text)) return 'Indices';
  if (/\b(CRYPTO[A-Z]*|BTC|ETH|SOL|XRP|USDT|USDC)\b/.test(text)
    || /^(?:BTC|ETH|SOL|XRP|DOGE|ADA|BNB|LTC|DOT|AVAX|LINK|BCH|XLM|ATOM|USDT|USDC)[A-Z0-9._-]*$/.test(ticker)) return 'Crypto';
  if (/\b(FUTURE|FUTURES|COMMODIT|METAL|ENERGY|OIL|GOLD|SILVER|XAU|XAG|WTI|BRENT)\b/.test(text)
    || /^(?:XAU|XAG|WTI|BRENT)USD(?:[._-].*)?$/.test(ticker)) return 'Futures & Commodities';
  if (/\b(STOCK|EQUITY|ETF|NYSE|NASDAQ|AMEX)\b/.test(text)) return 'Stocks';
  if (/^[A-Z]{6}(?:[._-].*)?$/.test(ticker)) return 'Forex';
  return 'Other';
}

export function filterSymbolsByCategory<T extends SymbolPickerAsset>(
  items: readonly T[],
  query: string,
  category: 'All' | SymbolPickerCategory,
): T[] {
  const normalizedQuery = query.trim().toUpperCase();
  return items.filter(item => {
    const matchesQuery = !normalizedQuery
      || item.ticker.toUpperCase().includes(normalizedQuery)
      || item.description?.toUpperCase().includes(normalizedQuery)
      || item.type?.toUpperCase().includes(normalizedQuery)
      || item.group?.toUpperCase().includes(normalizedQuery);
    return matchesQuery && (category === 'All' || symbolPickerCategory(item) === category);
  });
}
