/**
 * Pure parsing and symbol-resolution helpers for the Time & Sales and DOM panels.
 *
 * These functions take raw MetaTrader tick and book payloads and return plain values,
 * with no DOM access and no panel state. Keeping
 * them separate from the panel module means the risky part of the feature — decoding an
 * untrusted external payload — can be read, reasoned about and tested on its own.
 */

import type { Vela } from '@luxalgo/vela';

export type TradeSide = 'BUY' | 'SELL';

export interface MarketTrade {
  time: number;
  price: number;
  quantity: number;
  side: TradeSide | 'FLAT';
  key?: string;
}

export interface DepthLevel {
  price: number;
  quantity: number;
}

export interface MarketDepth {
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export function marketFlowProviderForAccountId(accountId: string): string {
  const separator = accountId.indexOf(':');
  return separator > 0 ? accountId.slice(0, separator).toLowerCase() : '';
}

export function isMarketFlowFeedActive(provider: string, accountId: string, connectedProviders: ReadonlySet<string>): boolean {
  return (provider === 'mt5' || provider === 'quantower')
    && marketFlowProviderForAccountId(accountId) === provider
    && connectedProviders.has(provider);
}

/** The MetaTrader ticker behind the active chart, when that chart is on the MT5 feed. */
export function mt5SymbolForChart(chart: Vela): string | null {
  const activeSymbol = chart.market.symbol?.trim();
  if (!activeSymbol) return null;
  const resolved = chart.data.resolve(activeSymbol);
  if (resolved?.provider.toLowerCase() === 'mt5') return resolved.ticker.trim();
  if (chart.market.provider?.toLowerCase() === 'mt5' || /^mt5:/i.test(activeSymbol)) {
    const ticker = activeSymbol.replace(/^mt5:/i, '').trim();
    return ticker && ticker.length <= 100 ? ticker : null;
  }
  return null;
}

/** The Quantower symbol behind the active chart, when it is on the local bridge. */
export function quantowerSymbolForChart(chart: Vela): string | null {
  const activeSymbol = chart.market.symbol?.trim();
  if (!activeSymbol) return null;
  const resolved = chart.data.resolve(activeSymbol);
  if (resolved?.provider.toLowerCase() === 'quantower') return resolved.ticker.trim() || null;
  if (chart.market.provider?.toLowerCase() === 'quantower' || /^quantower:/i.test(activeSymbol)) {
    const ticker = activeSymbol.replace(/^quantower:/i, '').trim();
    return ticker || null;
  }
  // Quantower symbols are often displayed without the provider prefix (for
  // example `/NQ:XCME`). The account selector is authoritative in that case.
  if (typeof localStorage !== 'undefined' && localStorage.getItem('omega.selected-trading-account')?.toLowerCase().startsWith('quantower:')) {
    return activeSymbol.replace(/^quantower:/i, '').trim() || null;
  }
  return null;
}

export function parseMt5Ticks(value: unknown, previousPrice = 0): { ticks: MarketTrade[]; cursor: number } {
  if (!Array.isArray(value)) return { ticks: [], cursor: 0 };
  const seen = new Set<string>();
  let cursor = 0;
  let lastPrice = previousPrice;
  const ticks: MarketTrade[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const time = Number(raw.time);
    const bid = Number(raw.bid);
    const ask = Number(raw.ask);
    const last = Number(raw.last);
    const volume = Number(raw.volumeReal ?? raw.volume);
    const flags = Number(raw.flags);
    if (!Number.isFinite(time) || time <= 0 || !Number.isFinite(bid) || bid < 0
      || !Number.isFinite(ask) || ask < 0 || !Number.isFinite(last) || last < 0) continue;
    const price = last > 0 ? last : bid > 0 && ask >= bid ? (bid + ask) / 2 : bid || ask;
    if (!(price > 0)) continue;
    cursor = Math.max(cursor, time);
    const key = `${time}:${bid}:${ask}:${last}:${flags}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const direction = lastPrice > 0 ? Math.sign(price - lastPrice) : 0;
    ticks.push({
      time,
      price,
      quantity: Number.isFinite(volume) && volume > 0 ? volume : 0,
      side: direction > 0 ? 'BUY' : direction < 0 ? 'SELL' : 'FLAT',
      key,
    });
    lastPrice = price;
  }
  return { ticks, cursor };
}

export function isRecentMt5Tick(time: number, now = Date.now()): boolean {
  return Number.isFinite(time) && time >= now - 10_000 && time <= now + 2_000;
}

export function parseMt5Book(value: unknown): MarketDepth | null {
  if (!Array.isArray(value)) return null;
  const bids: DepthLevel[] = [];
  const asks: DepthLevel[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const price = Number(entry.price);
    const quantity = Number(entry.volume);
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(quantity) || quantity <= 0) continue;
    if (entry.side === 'bid') bids.push({ price, quantity });
    else if (entry.side === 'ask') asks.push({ price, quantity });
  }
  if (!bids.length || !asks.length) return null;
  return {
    bids: bids.sort((left, right) => right.price - left.price),
    asks: asks.sort((left, right) => left.price - right.price),
  };
}

