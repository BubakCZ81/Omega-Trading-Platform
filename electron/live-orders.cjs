'use strict';

const ORDER_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_MAX_ORDER_VOLUME = 1000;
const MAX_CONFIGURED_ORDER_VOLUME = 10000;

function getMt5LiveOrderLimits(env = process.env) {
  const configured = env.OMEGA_MT5_MAX_ORDER_VOLUME;
  if (configured === undefined || configured === '') {
    return { maxVolume: DEFAULT_MAX_ORDER_VOLUME, source: 'default' };
  }
  const maxVolume = Number(configured);
  if (!Number.isFinite(maxVolume) || maxVolume <= 0 || maxVolume > MAX_CONFIGURED_ORDER_VOLUME) {
    throw new Error(`OMEGA_MT5_MAX_ORDER_VOLUME must be positive and no greater than ${MAX_CONFIGURED_ORDER_VOLUME} lots.`);
  }
  return { maxVolume, source: 'environment' };
}

function validateMt5OrderRequest(request, maxVolume = getMt5LiveOrderLimits().maxVolume) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('Invalid MetaTrader order request.');
  }
  if (!Number.isFinite(maxVolume) || maxVolume <= 0 || maxVolume > MAX_CONFIGURED_ORDER_VOLUME) {
    throw new Error(`The configured MT5 order-volume cap must be positive and no greater than ${MAX_CONFIGURED_ORDER_VOLUME} lots.`);
  }
  const intentId = typeof request.intentId === 'string' ? request.intentId.trim() : '';
  if (!ORDER_ID_PATTERN.test(intentId)) throw new Error('A valid unique order intent id is required.');
  const symbol = typeof request.symbol === 'string' ? request.symbol.trim() : '';
  if (!symbol || symbol.length > 100) throw new Error('Enter a valid MetaTrader symbol.');
  const side = typeof request.side === 'string' ? request.side.trim().toUpperCase() : '';
  if (side !== 'BUY' && side !== 'SELL') throw new Error('Order side must be BUY or SELL.');
  const volume = Number(request.volume);
  if (!Number.isFinite(volume) || volume <= 0) throw new Error('Order volume must be positive.');
  if (volume > maxVolume) throw new Error(`Order volume exceeds the configured ${maxVolume}-lot live-order limit.`);
  const stopLoss = request.stopLoss === undefined || request.stopLoss === null || request.stopLoss === '' ? undefined : Number(request.stopLoss);
  if (stopLoss === undefined || !Number.isFinite(stopLoss) || stopLoss <= 0) throw new Error('A positive stop-loss is required for every MT5 live order.');
  let takeProfit;
  if (request.takeProfit !== undefined && request.takeProfit !== null && request.takeProfit !== '') {
    takeProfit = Number(request.takeProfit);
    if (!Number.isFinite(takeProfit) || takeProfit <= 0) throw new Error('Take-profit must be a positive price when provided.');
  }
  return {
    intentId,
    symbol,
    side,
    volume,
    ...(stopLoss === undefined ? {} : { stopLoss }),
    ...(takeProfit === undefined ? {} : { takeProfit }),
  };
}

async function submitMt5Order({ request, armed, expectedAccount, maxVolume, mt5, journal }) {
  if (armed !== true) throw new Error('Live trading is not armed. Connect to MT5 first to enable trading.');
  const activeMaxVolume = maxVolume ?? getMt5LiveOrderLimits().maxVolume;
  const order = validateMt5OrderRequest(request, activeMaxVolume);
  if (!journal || typeof journal.verify !== 'function' || typeof journal.openEntries !== 'function'
    || typeof journal.begin !== 'function' || typeof journal.transition !== 'function') {
    const error = new Error('The durable order journal is unavailable; live orders are blocked.');
    error.phase = 'journal';
    throw error;
  }
  const integrity = journal.verify();
  if (!integrity?.ok) {
    const error = new Error('The order journal failed its integrity check; live orders are blocked.');
    error.phase = 'journal';
    throw error;
  }
  const unresolved = journal.openEntries();
  if (!Array.isArray(unresolved) || unresolved.length) {
    const error = new Error('An unresolved journaled order must be reconciled before another live order can be sent.');
    error.phase = 'journal';
    throw error;
  }

  let intent;
  try {
    intent = journal?.begin({
      id: order.intentId,
      broker: 'mt5',
      symbol: order.symbol,
      side: order.side,
      volume: order.volume,
      stopLoss: order.stopLoss ?? null,
      takeProfit: order.takeProfit ?? null,
      accountLogin: expectedAccount?.login ?? null,
      server: expectedAccount?.server ?? null,
    });
    journal.transition(intent.id, 'sent', { broker: 'mt5' });
  } catch (error) {
    const journalError = new Error(`The order journal could not record the live order; no order was sent: ${error instanceof Error ? error.message : String(error)}`);
    journalError.phase = 'journal';
    throw journalError;
  }

  let result;
  try {
    result = await mt5.placeOrder({ ...order, expectedAccount, maxOrderVolume: activeMaxVolume });
  } catch (error) {
    const phase = error && error.phase === 'pre-send' ? 'rejected' : 'unknown';
    try {
      journal.transition(intent.id, phase, {
        message: error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
      });
    } catch (journalError) {
      throw new Error(`MT5 may have received order ${intent.id}, and its journal status could not be recorded. Check MT5 and repair the order journal before retrying: ${journalError instanceof Error ? journalError.message : String(journalError)}`);
    }
    if (phase === 'unknown') {
      throw new Error(`MT5 may have received order ${intent.id}. Check the terminal and reconcile this journal entry before retrying.`);
    }
    throw error;
  }

  const status = result?.status;
  const journalStatus = status === 'filled' ? 'protected'
    : status === 'partial' ? 'partial'
      : status === 'rejected' ? 'rejected'
        : 'unknown';
  try {
    journal.transition(intent.id, journalStatus, result);
  } catch (error) {
    throw new Error(`MT5 may have received order ${intent.id}, but its final journal status could not be recorded. Check MT5 and reconcile before retrying: ${error instanceof Error ? error.message : String(error)}`);
  }
  // `protected` is the durable journal's settled state, not an MT5 execution
  // status. Callers must receive the broker result (`filled`, `partial`, …)
  // so a successfully filled order is never shown as an application error.
  return { id: intent.id, status, journalStatus, result };
}

module.exports = { getMt5LiveOrderLimits, submitMt5Order, validateMt5OrderRequest };
