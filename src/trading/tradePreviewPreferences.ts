export interface TradePreviewPreferences {
  previewTrade: boolean;
  dontAskAgain: boolean;
}

export function resolveTradePreviewPreferences<T extends TradePreviewPreferences>(
  preferences: T,
): Omit<T, 'dontAskAgain'> & { dontAskAgain: boolean } {
  return {
    ...preferences,
    dontAskAgain: preferences.previewTrade ? false : preferences.dontAskAgain,
  };
}

export function shouldPreviewTrade(preferences: TradePreviewPreferences): boolean {
  return preferences.previewTrade;
}
