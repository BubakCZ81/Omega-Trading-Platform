export interface BacktestAssetReference {
  symbol: string;
}

function bareSymbol(value: string): string {
  return value.includes(':') ? value.slice(value.indexOf(':') + 1) : value;
}

function symbolProvider(value: string): string {
  return value.includes(':') ? value.slice(0, value.indexOf(':')).toLowerCase() : '';
}

export function resolveBacktestAssetSymbol(
  current: string,
  assets: readonly BacktestAssetReference[],
  preferredProvider = '',
): string | undefined {
  const exact = assets.find(asset => asset.symbol.toLowerCase() === current.toLowerCase());
  if (exact) return exact.symbol;

  const currentTicker = bareSymbol(current).toLowerCase();
  const preferred = preferredProvider.trim().toLowerCase();
  const preferredMatch = preferred
    ? assets.find(asset => symbolProvider(asset.symbol) === preferred && bareSymbol(asset.symbol).toLowerCase() === currentTicker)
    : undefined;
  return preferredMatch?.symbol
    ?? assets.find(asset => bareSymbol(asset.symbol).toLowerCase() === currentTicker)?.symbol;
}
