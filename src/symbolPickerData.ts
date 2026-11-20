import type { SymbolPickerAsset } from './symbolPickerCategories';

export interface SymbolPickerDataSource {
  symbols(provider?: string): SymbolPickerAsset[];
  providerInstance(provider: string): {
    listSymbols?: () => Promise<SymbolPickerAsset[]>;
  } | undefined;
}

export interface ProviderSymbolLoad {
  symbols: Map<string, SymbolPickerAsset[]>;
  errors: Map<string, string>;
}

export async function loadPickerSymbols(
  data: SymbolPickerDataSource,
  providers: readonly string[],
): Promise<ProviderSymbolLoad> {
  const results = await Promise.all(providers.map(async provider => {
    try {
      const instance = data.providerInstance(provider);
      const descriptors = instance?.listSymbols
        ? await instance.listSymbols()
        : data.symbols(provider);
      return {
        ok: true as const,
        provider,
        descriptors: descriptors.map(descriptor => ({ ...descriptor, provider })),
      };
    } catch (error) {
      return {
        ok: false as const,
        provider,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }));
  const symbols = new Map<string, SymbolPickerAsset[]>();
  const errors = new Map<string, string>();
  for (const result of results) {
    if (result.ok) symbols.set(result.provider, result.descriptors);
    else errors.set(result.provider, result.error);
  }
  return { symbols, errors };
}
