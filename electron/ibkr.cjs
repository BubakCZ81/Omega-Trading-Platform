'use strict';

const { IBApi, EventName, SecType, OrderAction, OrderType } = require('@stoqey/ib');

const DEFAULT_HOST = '127.0.0.1';
const PAPER_PORT = 7497;
const LIVE_PORT = 7496;
const QUOTE_MAX_AGE_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

function parseIbkrContract(rawSymbol) {
  if (typeof rawSymbol !== 'string' || !rawSymbol.trim() || rawSymbol.length > 100) {
    throw new Error('Enter a valid IBKR chart symbol.');
  }
  const symbol = rawSymbol.trim().replace(/^(?:ibkr|mt5|quantower):/i, '').toUpperCase();
  const forex = symbol.match(/^([A-Z]{3})\/?([A-Z]{3})$/);
  if (forex && forex[1] !== forex[2]) {
    return { symbol: forex[1], secType: SecType.CASH, currency: forex[2], exchange: 'IDEALPRO', omegaKind: 'forex' };
  }
  const future = symbol.match(/^([A-Z0-9.]+)\s+(\d{6})@([A-Z0-9.]+)$/);
  if (future) {
    return {
      symbol: future[1], secType: SecType.FUT, currency: 'USD', exchange: future[3],
      lastTradeDateOrContractMonth: future[2], omegaKind: 'future',
    };
  }
  if (/^[A-Z0-9.]+[FGHJKMNQUVXZ]\d$/.test(symbol)) {
    throw new Error('Specify futures as SYMBOL YYYYMM@EXCHANGE (for example ES 202609@CME); the compact month code is ambiguous.');
  }
  if (/^[A-Z][A-Z0-9.]{0,11}$/.test(symbol)) {
    return { symbol, secType: SecType.STK, currency: 'USD', exchange: 'SMART', omegaKind: 'stock' };
  }
  throw new Error('Use a stock ticker (AAPL), forex pair (EURUSD), or future as SYMBOL YYYYMM@EXCHANGE (for example ES 202609@CME).');
}

function validateIbkrConnectionConfig(config = {}) {
  if (config.environment !== undefined && !['paper', 'live'].includes(config.environment)) {
    throw new Error('Choose either a paper or live IBKR connection.');
  }
  const environment = config.environment === 'live' ? 'live' : 'paper';
  const host = typeof config.host === 'string' && config.host.trim() ? config.host.trim() : DEFAULT_HOST;
  if (!['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase())) {
    throw new Error('IBKR TWS connections must use localhost or a loopback address.');
  }
  const port = Number(config.port ?? (environment === 'live' ? LIVE_PORT : PAPER_PORT));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Enter a valid local TWS / IB Gateway port.');
  const clientId = Number(config.clientId ?? 31);
  if (!Number.isInteger(clientId) || clientId < 1 || clientId > 32767) throw new Error('IBKR API client ID must be an integer from 1 to 32767.');
  return { host, port, clientId, environment };
}

function requestErrorMessage(args, requestId, fallback) {
  if (args[0] !== requestId && args[2] !== requestId) return null;
  return args[0] instanceof Error ? args[0].message || fallback
    : typeof args[2] === 'string' ? args[2] || fallback
      : fallback;
}

class IbkrBridge {
  constructor({ apiFactory = options => new IBApi(options), events = EventName, secTypes = SecType, actions = OrderAction, orderTypes = OrderType, now = Date.now } = {}) {
    this.apiFactory = apiFactory;
    this.events = events;
    this.secTypes = secTypes;
    this.actions = actions;
    this.orderTypes = orderTypes;
    this.now = now;
    this.api = null;
    this.config = null;
    this.accounts = [];
    this.nextOrderId = null;
    this.requestId = 100;
    this.strategyAccountId = null;
    this.listeners = [];
    this.submittedIntents = new Set();
  }

  assertEnvironment(accountId) {
    const accountEnvironment = accountId.toUpperCase().startsWith('DU') ? 'paper' : 'live';
    if (this.config?.environment !== accountEnvironment) {
      throw new Error(`IBKR account ${accountId} appears to be ${accountEnvironment}; reconnect using the matching paper/live environment before trading.`);
    }
  }

  isConnected() {
    return Boolean(this.api?.isConnected && this.nextOrderId !== null && this.accounts.length);
  }

  addListener(event, listener) {
    this.api.on(event, listener);
    this.listeners.push([event, listener]);
  }

  clearListeners() {
    for (const [event, listener] of this.listeners) this.api?.removeListener(event, listener);
    this.listeners = [];
  }

  async connect(rawConfig) {
    await this.disconnect();
    this.config = validateIbkrConnectionConfig(rawConfig);
    this.api = this.apiFactory({ host: this.config.host, port: this.config.port });
    let connected = false;
    let accountListReceived = false;
    let readyResolve;
    let readyReject;
    const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const maybeReady = () => {
      if (!connected || !accountListReceived || this.nextOrderId === null) return;
      if (!this.accounts.length) {
        readyReject(new Error('TWS / IB Gateway connected but did not report a managed account. Sign in and enable API access for the intended account.'));
        return;
      }
      readyResolve(this.status());
    };
    this.addListener(this.events.connected, () => {
      connected = true;
      this.api.reqManagedAccts();
      this.api.reqIds();
      maybeReady();
    });
    this.addListener(this.events.managedAccounts, accounts => {
      this.accounts = String(accounts ?? '').split(',').map(value => value.trim()).filter(Boolean);
      accountListReceived = true;
      maybeReady();
    });
    this.addListener(this.events.nextValidId, orderId => {
      if (Number.isSafeInteger(orderId) && orderId >= 0) this.nextOrderId = Math.max(this.nextOrderId ?? 0, orderId);
      maybeReady();
    });
    this.addListener(this.events.disconnected, () => {
      this.accounts = [];
      this.nextOrderId = null;
      this.strategyAccountId = null;
    });
    this.addListener(this.events.error, (...args) => {
      const code = typeof args[1] === 'number' ? args[1] : undefined;
      const message = args[0] instanceof Error ? args[0].message : typeof args[2] === 'string' ? args[2] : '';
      if (!connected && (code === 502 || code === 504 || args[0] instanceof Error)) {
        readyReject(new Error(message || `Could not connect to TWS / IB Gateway at ${this.config.host}:${this.config.port}.`));
      }
    });
    const timeout = setTimeout(() => readyReject(new Error(`Timed out connecting to TWS / IB Gateway at ${this.config.host}:${this.config.port}. Enable socket clients in TWS and check the paper/live port.`)), CONNECT_TIMEOUT_MS);
    try {
      this.api.connect(this.config.clientId);
      return await ready;
    } catch (error) {
      await this.disconnect();
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async disconnect() {
    const api = this.api;
    this.strategyAccountId = null;
    this.accounts = [];
    this.nextOrderId = null;
    if (!api) return true;
    this.clearListeners();
    this.api = null;
    this.config = null;
    if (api.isConnected) api.disconnect();
    return true;
  }

  status() {
    return {
      connected: this.isConnected(),
      host: this.config?.host ?? DEFAULT_HOST,
      port: this.config?.port ?? PAPER_PORT,
      environment: this.config?.environment ?? 'paper',
      accounts: [...this.accounts],
    };
  }

  assertConnected() {
    if (!this.isConnected()) throw new Error('Connect and sign in to TWS or IB Gateway before using IBKR.');
  }

  assertAccount(accountId) {
    this.assertConnected();
    if (typeof accountId !== 'string' || !this.accounts.includes(accountId)) {
      throw new Error('The selected IBKR account is not part of the active TWS / IB Gateway session.');
    }
  }

  armStrategyTrading(accountId, armed) {
    this.assertAccount(accountId);
    this.assertEnvironment(accountId);
    if (typeof armed !== 'boolean') throw new Error('Choose whether IBKR Pine strategy trading should be armed.');
    this.strategyAccountId = armed ? accountId : null;
    return { armed: this.strategyAccountId === accountId, accountId: this.strategyAccountId };
  }

  async resolveContract(rawSymbol) {
    this.assertConnected();
    const { omegaKind: _omegaKind, ...requested } = parseIbkrContract(rawSymbol);
    const requestId = ++this.requestId;
    const matches = [];
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        this.api?.removeListener(this.events.contractDetails, onDetails);
        this.api?.removeListener(this.events.contractDetailsEnd, onEnd);
        this.api?.removeListener(this.events.error, onError);
      };
      const onDetails = (id, details) => { if (id === requestId && details?.contract) matches.push(details); };
      const onEnd = id => {
        if (id !== requestId) return;
        cleanup();
        if (matches.length !== 1) {
          reject(new Error(matches.length ? `IBKR returned ${matches.length} matching contracts for ${rawSymbol}; use a more specific symbol.` : `IBKR found no contract for ${rawSymbol}.`));
          return;
        }
        resolve(matches[0]);
      };
      const onError = (...args) => {
        const message = requestErrorMessage(args, requestId, `IBKR could not resolve ${rawSymbol}.`);
        if (!message) return;
        cleanup();
        reject(new Error(message));
      };
      const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out resolving IBKR contract ${rawSymbol}.`)); }, 5_000);
      this.api.on(this.events.contractDetails, onDetails);
      this.api.on(this.events.contractDetailsEnd, onEnd);
      this.api.on(this.events.error, onError);
      this.api.reqContractDetails(requestId, requested);
    });
  }

  async quote(rawSymbol) {
    const details = await this.resolveContract(rawSymbol);
    const contract = details.contract;
    const requestId = ++this.requestId;
    this.api.reqMarketDataType(1);
    return new Promise((resolve, reject) => {
      let bid = null;
      let ask = null;
      const cleanup = () => {
        clearTimeout(timeout);
        this.api?.removeListener(this.events.tickPrice, onPrice);
        this.api?.removeListener(this.events.error, onError);
        this.api?.cancelMktData(requestId);
      };
      const finish = () => {
        if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) return;
        const quote = { bid, ask, timeMsc: this.now(), minTick: Number(details.minTick) || 0, contract: { symbol: contract.symbol, secType: contract.secType, currency: contract.currency, exchange: contract.exchange, multiplier: contract.multiplier ?? '', lastTradeDateOrContractMonth: contract.lastTradeDateOrContractMonth ?? '' } };
        cleanup();
        resolve(quote);
      };
      const onPrice = (id, field, price) => {
        if (id !== requestId || !Number.isFinite(price) || price <= 0) return;
        if (field === 1) bid = price;
        if (field === 2) ask = price;
        finish();
      };
      const onError = (...args) => {
        const message = requestErrorMessage(args, requestId, `IBKR could not provide a real-time quote for ${rawSymbol}.`);
        if (!message) return;
        cleanup();
        reject(new Error(message));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`IBKR did not provide a fresh real-time bid and ask for ${rawSymbol}. Check market-data permissions and that the market is open.`));
      }, 4_000);
      this.api.on(this.events.tickPrice, onPrice);
      this.api.on(this.events.error, onError);
      this.api.reqMktData(requestId, contract, null, false, false);
    });
  }

  async placeOrder(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid IBKR order request.');
    this.assertAccount(request.accountId);
    this.assertEnvironment(request.accountId);
    if (request.source === 'pine') {
      if (this.strategyAccountId !== request.accountId) throw new Error('Automatic Pine strategy trading is not armed for the selected IBKR account.');
    } else if (request.source !== 'manual' || request.confirmed !== true) {
      throw new Error('Confirm the IBKR order preview before submitting the order.');
    }
    if (!['BUY', 'SELL'].includes(request.side)) throw new Error('IBKR order side must be BUY or SELL.');
    if (typeof request.intentId !== 'string' || !request.intentId.trim() || request.intentId.length > 200) {
      throw new Error('IBKR orders require a bounded unique intent ID.');
    }
    const intentId = request.intentId.trim();
    if (this.submittedIntents.has(intentId)) throw new Error('This IBKR order intent was already submitted; inspect TWS before retrying.');
    const enteredQuantity = Number(request.quantity);
    if (!Number.isFinite(enteredQuantity) || enteredQuantity <= 0 || enteredQuantity > 1_000_000_000) throw new Error('Enter a valid IBKR quantity.');
    const { contract, minTick } = await this.resolveContract(request.symbol);
    const quote = await this.quote(request.symbol);
    if (this.now() - quote.timeMsc > QUOTE_MAX_AGE_MS) throw new Error('IBKR returned a stale quote; no order was sent. Refresh prices and retry.');
    const parsed = parseIbkrContract(request.symbol);
    const quantity = parsed.omegaKind === 'forex' ? enteredQuantity * 100_000 : enteredQuantity;
    if (parsed.omegaKind === 'future' && !Number.isInteger(quantity)) throw new Error('IBKR futures quantity must be a whole number of contracts.');
    const stopLoss = request.stopLoss === undefined ? undefined : Number(request.stopLoss);
    const takeProfit = request.takeProfit === undefined ? undefined : Number(request.takeProfit);
    if (stopLoss !== undefined && (!Number.isFinite(stopLoss) || stopLoss <= 0)) throw new Error('Enter a valid IBKR stop price.');
    if (takeProfit !== undefined && (!Number.isFinite(takeProfit) || takeProfit <= 0)) throw new Error('Enter a valid IBKR take-profit price.');
    if ((stopLoss !== undefined || takeProfit !== undefined) && (!Number.isFinite(minTick) || minTick <= 0)) throw new Error('IBKR did not provide a valid minimum tick for attached protection orders.');
    if (request.side === 'BUY' && ((stopLoss !== undefined && stopLoss >= quote.bid) || (takeProfit !== undefined && takeProfit <= quote.ask))) throw new Error('For an IBKR buy, stop loss must be below bid and take profit above ask.');
    if (request.side === 'SELL' && ((stopLoss !== undefined && stopLoss <= quote.ask) || (takeProfit !== undefined && takeProfit >= quote.bid))) throw new Error('For an IBKR sell, stop loss must be above ask and take profit below bid.');

    const orderId = this.nextOrderId;
    const protectionOrders = Number(stopLoss !== undefined) + Number(takeProfit !== undefined);
    const hasProtection = protectionOrders > 0;
    this.nextOrderId += 1 + protectionOrders;
    const action = request.side === 'BUY' ? this.actions.BUY : this.actions.SELL;
    const account = request.accountId;
    const orderRef = `OMEGA:${intentId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40)}`;
    this.submittedIntents.add(intentId);
    if (this.submittedIntents.size > 10_000) this.submittedIntents.delete(this.submittedIntents.values().next().value);
    if (hasProtection) {
      const exitAction = request.side === 'BUY' ? this.actions.SELL : this.actions.BUY;
      const ocaGroup = `OMEGA-${orderId}`;
      this.api.placeOrder(orderId, contract, {
        action, orderType: this.orderTypes.MKT, totalQuantity: quantity, account, orderRef, transmit: false,
      });
      let childId = orderId + 1;
      if (takeProfit !== undefined) {
        this.api.placeOrder(childId++, contract, {
          action: exitAction, orderType: this.orderTypes.LMT, totalQuantity: quantity, lmtPrice: takeProfit,
          account, parentId: orderId, ...(stopLoss !== undefined ? { ocaGroup } : {}), transmit: stopLoss === undefined,
        });
      }
      if (stopLoss !== undefined) {
        this.api.placeOrder(childId, contract, {
          action: exitAction, orderType: this.orderTypes.STP, totalQuantity: quantity, auxPrice: stopLoss,
          account, parentId: orderId, ...(takeProfit !== undefined ? { ocaGroup } : {}), transmit: true,
        });
      }
    } else {
      this.api.placeOrder(orderId, contract, {
        action, orderType: this.orderTypes.MKT, totalQuantity: quantity, account, orderRef, transmit: true,
      });
    }
    return { status: 'submitted', orderId, quantity, quoteTimeMsc: quote.timeMsc, protected: hasProtection };
  }
}

module.exports = {
  DEFAULT_HOST,
  PAPER_PORT,
  LIVE_PORT,
  QUOTE_MAX_AGE_MS,
  parseIbkrContract,
  validateIbkrConnectionConfig,
  IbkrBridge,
};