'use strict';

/**
 * Deterministic pre-trade risk checks.
 *
 * This module is intentionally pure: it receives a snapshot of the order, the
 * quote, the account and the configured limits, and returns every violation it
 * finds. The caller decides whether to surface, log, or refuse the order. All
 * checks run in the Electron main process; renderer-side validation is only a
 * convenience and must never be trusted for live orders.
 */

const DEFAULT_LIMITS = Object.freeze({
  requireQuote: true,
  maxQuoteAgeMs: 5_000,
  maxSpread: null,
  requireStopLoss: true,
  minStopDistance: null,
  minVolume: null,
  maxVolume: null,
  maxRiskAmount: null,
  maxNotional: null,
  maxOpenPositions: null,
  maxDailyLoss: null,
  duplicateWindowMs: 0,
  contractSize: 1,
  allowLive: false,
});

function finitePositive(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function roundPrice(value) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(8) : '';
}

function orderKey(order) {
  return [
    order.accountId ?? '',
    order.symbolId ?? '',
    order.side ?? '',
    roundPrice(order.volume),
    roundPrice(order.stopLoss),
    roundPrice(order.takeProfit),
  ].join('|');
}

function evaluatePreTradeOrder(order, context = {}) {
  const limits = { ...DEFAULT_LIMITS, ...(context.limits || {}) };
  const violations = [];
  const add = (code, message) => violations.push({ code, message });
  const now = Number.isFinite(Number(context.now)) ? Number(context.now) : Date.now();
  const account = context.account || {};
  const symbol = context.symbol || {};
  const quote = context.quote || null;

  if (!order || typeof order !== 'object' || Array.isArray(order)) {
    return { ok: false, violations: [{ code: 'order-invalid', message: 'The order request is invalid.' }] };
  }
  if (context.killSwitch === true) add('kill-switch', 'Trading is disabled by the kill switch.');
  if (account.tradingEnabled === false) add('account-disabled', 'This account is not enabled for trading.');
  if ((order.environment || account.environment) === 'live' && limits.allowLive !== true) {
    add('live-locked', 'Live order placement is locked for this build.');
  }

  const symbolId = order.symbolId === undefined || order.symbolId === null ? '' : String(order.symbolId).trim();
  if (!symbolId) add('symbol-required', 'Choose a tradable symbol.');
  const side = String(order.side || '').toUpperCase();
  if (side !== 'BUY' && side !== 'SELL') add('side-invalid', 'Choose BUY or SELL.');

  const volume = finitePositive(order.volume);
  if (volume === null) {
    add('volume-invalid', 'Order volume must be a positive number.');
  } else {
    const scaled = Math.round(volume * 100);
    const precise = Math.abs(scaled / 100 - volume) <= 1e-9;
    if (!precise) add('volume-precision', 'Volume can have at most two decimal places.');
    const step = finitePositive(symbol.stepVolume);
    if (precise && step !== null) {
      const scaledStep = Math.round(step * 100);
      if (scaledStep > 0 && scaled % scaledStep !== 0) {
        add('volume-step', `Volume must be a multiple of ${step}.`);
      }
    }
    const minVolume = finitePositive(symbol.minVolume) ?? finitePositive(limits.minVolume);
    const maxVolume = finitePositive(symbol.maxVolume) ?? finitePositive(limits.maxVolume);
    if (minVolume !== null && volume < minVolume) add('volume-too-small', `Volume must be at least ${minVolume}.`);
    if (maxVolume !== null && volume > maxVolume) add('volume-too-large', `Volume must be at most ${maxVolume}.`);
  }

  let price = null;
  if (limits.requireQuote && !quote) {
    add('quote-missing', 'A fresh quote is required before placing an order.');
  } else if (quote) {
    const bid = finitePositive(quote.bid);
    const ask = finitePositive(quote.ask);
    const receivedAt = typeof quote.receivedAt === 'number' ? quote.receivedAt : Date.parse(quote.receivedAt);
    if (bid === null || ask === null || ask < bid) {
      add('quote-invalid', 'The current bid/ask quote is invalid.');
    } else {
      const maxAge = finitePositive(limits.maxQuoteAgeMs);
      if (maxAge !== null && (!Number.isFinite(receivedAt) || now - receivedAt > maxAge)) {
        add('quote-stale', 'A fresh quote is required before placing an order.');
      }
      const spread = ask - bid;
      const maxSpread = finitePositive(limits.maxSpread);
      if (maxSpread !== null && spread > maxSpread) {
        add('spread-too-wide', `The market spread (${spread.toFixed(5)}) is wider than the configured limit.`);
      }
      price = side === 'SELL' ? bid : ask;
    }
  }

  const stopLoss = finiteNumber(order.stopLoss);
  if (limits.requireStopLoss && (stopLoss === null || stopLoss <= 0)) {
    add('stop-loss-required', 'A stop loss is required for every order.');
  }
  const takeProfit = order.takeProfit === undefined || order.takeProfit === null ? null : finiteNumber(order.takeProfit);

  if (price !== null && quote && side === 'BUY' && stopLoss !== null && stopLoss > 0) {
    if (!(stopLoss < Number(quote.bid))) add('stop-loss-wrong-side', 'For a BUY order, the stop loss must be below the current bid.');
  }
  if (price !== null && quote && side === 'SELL' && stopLoss !== null && stopLoss > 0) {
    if (!(stopLoss > Number(quote.ask))) add('stop-loss-wrong-side', 'For a SELL order, the stop loss must be above the current ask.');
  }
  if (price !== null && quote && takeProfit !== null) {
    if (takeProfit <= 0) add('take-profit-invalid', 'Take profit must be a positive price.');
    else if (side === 'BUY' && takeProfit <= Number(quote.ask)) add('take-profit-wrong-side', 'For a BUY order, take profit must be above the current ask.');
    else if (side === 'SELL' && takeProfit >= Number(quote.bid)) add('take-profit-wrong-side', 'For a SELL order, take profit must be below the current bid.');
  }

  const contractSize = finitePositive(symbol.contractSize) ?? finitePositive(limits.contractSize) ?? 1;
  const minStopDistance = finitePositive(limits.minStopDistance);
  let riskAmount = null;
  if (volume !== null && stopLoss !== null && stopLoss > 0 && quote) {
    const distance = side === 'SELL'
      ? (Number(quote.ask) > 0 ? stopLoss - Number(quote.ask) : null)
      : (Number(quote.bid) > 0 ? Number(quote.bid) - stopLoss : null);
    if (distance !== null && distance > 0) {
      if (minStopDistance !== null && distance < minStopDistance) {
        add('stop-loss-too-close', `The stop loss must be at least ${minStopDistance} away from the market.`);
      }
      riskAmount = distance * volume * contractSize;
      const maxRisk = finitePositive(limits.maxRiskAmount);
      if (maxRisk !== null && riskAmount > maxRisk) {
        add('risk-too-large', `The risk on this order (${riskAmount.toFixed(2)}) exceeds the configured per-order limit.`);
      }
    }
  }

  if (volume !== null && price !== null) {
    const notional = volume * contractSize * price;
    const maxNotional = finitePositive(limits.maxNotional);
    if (maxNotional !== null && notional > maxNotional) {
      add('notional-too-large', `The order notional (${notional.toFixed(2)}) exceeds the configured limit.`);
    }
  }

  const dayPnl = finiteNumber(account.dayPnl);
  const maxDailyLoss = finitePositive(limits.maxDailyLoss);
  if (dayPnl !== null && maxDailyLoss !== null && dayPnl <= -maxDailyLoss) {
    add('daily-loss-limit', 'The daily loss limit has been reached; new orders are blocked.');
  }

  const openPositions = finiteNumber(account.openPositions);
  const maxOpenPositions = finiteNumber(limits.maxOpenPositions);
  if (openPositions !== null && maxOpenPositions !== null && openPositions >= maxOpenPositions) {
    add('max-open-positions', `The maximum number of open positions (${maxOpenPositions}) has been reached.`);
  }

  const duplicateWindow = finitePositive(limits.duplicateWindowMs);
  if (duplicateWindow !== null && Array.isArray(context.recentOrders)) {
    const key = orderKey({ ...order, accountId: account.id });
    const duplicate = context.recentOrders.some((recent) => {
      if (!recent || recent.key !== key) return false;
      const at = typeof recent.at === 'number' ? recent.at : Date.parse(recent.at);
      return Number.isFinite(at) && now - at <= duplicateWindow;
    });
    if (duplicate) add('duplicate-order', 'An identical order was sent moments ago; wait before retrying.');
  }

  return {
    ok: violations.length === 0,
    violations,
    price,
    riskAmount,
    notional: volume !== null && price !== null ? volume * contractSize * price : null,
  };
}

module.exports = { DEFAULT_LIMITS, evaluatePreTradeOrder, orderKey };
