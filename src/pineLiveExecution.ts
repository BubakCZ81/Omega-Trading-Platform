import { assertSelectedMt5Account } from './chartMt5Orders.ts';
import { isPineMt5AutoTradingArmed } from './pineStrategyAutoTrading.ts';
import { isPineIbkrAutoTradingArmed } from './pineIbkrAutoTrading.ts';
import { isPineSaxoAutoTradingArmed } from './pineSaxoAutoTrading.ts';
import { isPineQuantowerAutoTradingArmed } from './pineQuantowerAutoTrading.ts';

export type PineOrderSide = 'BUY' | 'SELL';
export interface PineOrderProtection {
  stopLoss?: number;
  takeProfit?: number;
  confirmed?: boolean;
}
const mt5PositionTickets = new Map<string, Array<{ ticket: string; volume: number }>>();
const quantowerPositionIds = new Map<string, Array<{ id: string; volume: number }>>();
const ibkrPositionQuantities = new Map<string, number>();
const saxoPositionQuantities = new Map<string, number>();

/** Route one Pine strategy fill; side is the strategy's entry direction, including for closes. */
export async function submitPineLiveFill(
  selectedAccount: string,
  symbol: string,
  side: PineOrderSide,
  quantity: number,
  intentKey: string,
  action: 'open' | 'close',
  protection: PineOrderProtection = {},
): Promise<'filled' | 'submitted'> {
  const provider = selectedAccount.slice(0, selectedAccount.indexOf(':')).toLowerCase();
  const ticker = symbol.trim().replace(/^(?:mt5|quantower|ibkr|saxo):/i, '');
  if (!ticker || !Number.isFinite(quantity) || quantity <= 0) throw new Error('Pine order symbol and quantity must be valid.');
  if (provider !== 'quantower' && action === 'open' && (!Number.isFinite(protection.stopLoss) || Number(protection.stopLoss) <= 0)) {
    throw new Error('Pine strategy entry was blocked: a positive strategy stop-loss is required before any broker order can be sent.');
  }
  if (action === 'open' && protection.takeProfit !== undefined
    && (!Number.isFinite(protection.takeProfit) || protection.takeProfit <= 0)) {
    throw new Error('Pine strategy entry was blocked: take-profit must be a positive finite price.');
  }
  if (provider === 'mt5') {
    if (!window.velaMt5?.placeOrder) throw new Error('MT5 order bridge is unavailable.');
    const bridge = window.velaMt5;
    const status = await bridge.tradingStatus();
    assertSelectedMt5Account(status, localStorage.getItem('omega.selected-trading-account'));
    if (!isPineMt5AutoTradingArmed(selectedAccount)) {
      throw new Error('Automatic Pine strategy trading is not armed for the selected MT5 account.');
    }
    const openSide = action === 'close' ? (side === 'BUY' ? 'SELL' : 'BUY') : side;
    if (action === 'close') {
      const positions = mt5PositionTickets.get(intentKey) ?? [];
      if (positions.length && bridge.closePosition) {
        let remaining = quantity;
        for (const position of [...positions].reverse()) {
          if (remaining <= 1e-9) break;
          const closeVolume = Math.min(position.volume, remaining);
          const result = await bridge.closePosition({ positionTicket: position.ticket, symbol: ticker, side, volume: closeVolume });
          if (result.status !== 'filled') {
            throw new Error(`MT5 strategy close returned ${String(result.status ?? 'unknown')}; inspect MT5 before retrying.`);
          }
          position.volume -= closeVolume;
          remaining -= closeVolume;
        }
        const remainingPositions = positions.filter(position => position.volume > 1e-9);
        if (remainingPositions.length) mt5PositionTickets.set(intentKey, remainingPositions);
        else mt5PositionTickets.delete(intentKey);
        if (remaining > 1e-9) throw new Error(`MT5 has no tracked position volume for the remaining ${remaining} units.`);
        return 'filled';
      }
      throw new Error('MT5 position ticket is unavailable for this Pine strategy close.');
    }
    const result = await bridge.placeOrder({
      intentId: crypto.randomUUID(), symbol: ticker, side: openSide, volume: quantity,
      stopLoss: protection.stopLoss, takeProfit: protection.takeProfit,
    });
    const ticket = String(result.result?.position ?? result.result?.order ?? '');
    const filledVolume = Number(result.result?.volume);
    if (ticket) {
      mt5PositionTickets.set(intentKey, [...(mt5PositionTickets.get(intentKey) ?? []), {
        ticket,
        volume: Number.isFinite(filledVolume) && filledVolume > 0 ? filledVolume : quantity,
      }]);
    }
    if (result.status !== 'filled') {
      throw new Error(`MT5 strategy order returned ${result.status}; inspect the MT5 order journal before retrying.`);
    }
    if (!ticket) throw new Error('MT5 reported a strategy order fill without a position ticket; inspect MT5 before the next strategy close.');
    return 'filled';
  }
  if (provider === 'quantower') {
    if (!window.velaQuantower?.placeOrder) throw new Error('Quantower order bridge is unavailable.');
    const accountId = selectedAccount.slice('quantower:'.length);
    if (!accountId || accountId === 'local') throw new Error('Select a connected Quantower trading account.');
    if (!isPineQuantowerAutoTradingArmed(selectedAccount)) {
      throw new Error('Automatic Pine strategy trading is not armed for the selected Quantower account.');
    }
    if (protection.confirmed !== true) throw new Error('Confirm the Quantower Pine order on the chart.');
    const bridge = window.velaQuantower;
    const accounts = await bridge.accounts();
    if (!accounts.some(account => account.id === accountId)
      || localStorage.getItem('omega.selected-trading-account') !== selectedAccount
      || !isPineQuantowerAutoTradingArmed(selectedAccount)) {
      throw new Error('The selected Quantower account changed or disconnected.');
    }
    if (action === 'close') {
      const positions = quantowerPositionIds.get(intentKey) ?? [];
      if (positions.length) {
        let remaining = quantity;
        for (const position of [...positions].reverse()) {
          if (remaining <= 1e-9) break;
          const closeQuantity = Math.min(position.volume, remaining);
          const result = await bridge.closePosition({ accountId, positionId: position.id, quantity: closeQuantity });
          if (result.status !== 'submitted' && result.status !== 'filled') {
            throw new Error(result.message || `Quantower close returned ${result.status}.`);
          }
          position.volume -= closeQuantity;
          remaining -= closeQuantity;
        }
        const remainingPositions = positions.filter(position => position.volume > 1e-9);
        if (remainingPositions.length) quantowerPositionIds.set(intentKey, remainingPositions);
        else quantowerPositionIds.delete(intentKey);
        if (remaining > 1e-9) throw new Error(`Quantower has no tracked position quantity for the remaining ${remaining} units.`);
        return 'submitted';
      }
      throw new Error('Quantower has no tracked position for this Pine strategy close.');
    }
    const result = await bridge.placeOrder({ accountId, symbol: ticker, side, quantity });
    if (result.status !== 'submitted' && result.status !== 'filled') {
      throw new Error(result.message || `Quantower returned order status ${result.status}.`);
    }
    if (result.status === 'filled' && result.positionId) {
      quantowerPositionIds.set(intentKey, [...(quantowerPositionIds.get(intentKey) ?? []), { id: result.positionId, volume: quantity }]);
    }
    if (result.status === 'filled' && !result.positionId) {
      throw new Error('Quantower filled the order without returning a position ID. Manage the position in Quantower.');
    }
    return result.status;
  }
  if (provider === 'ibkr') {
    const bridge = window.velaIbkr;
    const accountId = selectedAccount.slice('ibkr:'.length);
    if (!bridge?.placeOrder) throw new Error('IBKR order bridge is unavailable.');
    if (!accountId || !isPineIbkrAutoTradingArmed(selectedAccount)) {
      throw new Error('Automatic Pine strategy trading is not armed for the selected IBKR account.');
    }
    if (action === 'close') {
      let remaining = quantity;
      const tracked = ibkrPositionQuantities.get(intentKey) ?? 0;
      if (tracked <= 0) throw new Error('IBKR has no tracked position quantity for this Pine strategy close.');
      const closeQuantity = Math.min(tracked, remaining);
      const result = await bridge.placeOrder({
        accountId, symbol: ticker, side: side === 'BUY' ? 'SELL' : 'BUY', quantity: closeQuantity,
        source: 'pine', intentId: `${intentKey}:close:${closeQuantity}`,
      });
      if (result.status !== 'submitted') throw new Error(`IBKR strategy close returned ${String(result.status)}; inspect TWS before retrying.`);
      remaining -= closeQuantity;
      const nextTracked = tracked - closeQuantity;
      if (nextTracked > 1e-9) ibkrPositionQuantities.set(intentKey, nextTracked);
      else ibkrPositionQuantities.delete(intentKey);
      if (remaining > 1e-9) throw new Error(`IBKR has no tracked position quantity for the remaining ${remaining} units.`);
      return 'submitted';
    }
    const result = await bridge.placeOrder({
      accountId, symbol: ticker, side, quantity, source: 'pine', intentId: `${intentKey}:open:${quantity}`,
      stopLoss: protection.stopLoss, takeProfit: protection.takeProfit,
    });
    if (result.status !== 'submitted') throw new Error(`IBKR strategy order returned ${String(result.status)}; inspect TWS before retrying.`);
    ibkrPositionQuantities.set(intentKey, (ibkrPositionQuantities.get(intentKey) ?? 0) + quantity);
    return 'submitted';
  }
  if (provider === 'saxo') {
    const bridge = window.velaSaxo;
    const accountKey = selectedAccount.slice('saxo:'.length);
    if (!bridge?.placeOrder) throw new Error('Saxo order bridge is unavailable.');
    if (!accountKey || !isPineSaxoAutoTradingArmed(selectedAccount)) {
      throw new Error('Automatic Pine strategy trading is not armed for the selected Saxo account.');
    }
    if (action === 'close') {
      const tracked = saxoPositionQuantities.get(intentKey) ?? 0;
      if (tracked <= 0) throw new Error('Saxo has no tracked position quantity for this Pine strategy close.');
      const closeQuantity = Math.min(tracked, quantity);
      const result = await bridge.placeOrder({
        accountKey, symbol: ticker, side: side === 'BUY' ? 'SELL' : 'BUY', quantity: closeQuantity,
        source: 'pine', intentId: `${intentKey}:close:${closeQuantity}`,
      });
      if (result.status !== 'submitted') throw new Error(`Saxo strategy close returned ${String(result.status)}; inspect Saxo before retrying.`);
      const remainingTracked = tracked - closeQuantity;
      if (remainingTracked > 1e-9) saxoPositionQuantities.set(intentKey, remainingTracked);
      else saxoPositionQuantities.delete(intentKey);
      if (quantity - closeQuantity > 1e-9) throw new Error(`Saxo has no tracked position quantity for the remaining ${quantity - closeQuantity} units.`);
      return 'submitted';
    }
    const result = await bridge.placeOrder({
      accountKey, symbol: ticker, side, quantity, source: 'pine', intentId: `${intentKey}:open:${quantity}`,
      stopLoss: protection.stopLoss, takeProfit: protection.takeProfit,
    });
    if (result.status !== 'submitted') throw new Error(`Saxo strategy order returned ${String(result.status)}; inspect Saxo before retrying.`);
    saxoPositionQuantities.set(intentKey, (saxoPositionQuantities.get(intentKey) ?? 0) + quantity);
    return 'submitted';
  }
  throw new Error('Select MT5, Quantower, IBKR, or Saxo in the account selector to route Pine orders.');
}
