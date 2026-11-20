const crypto = require('node:crypto');
const http = require('node:http');

const REDIRECT_PATH = '/omega/saxo-callback';
const AUTH_HOSTS = Object.freeze({
  sim: 'https://sim.logonvalidation.net',
  live: 'https://live.logonvalidation.net',
});
const API_HOSTS = Object.freeze({
  sim: 'https://gateway.saxobank.com/sim/openapi',
  live: 'https://gateway.saxobank.com/openapi',
});
const MAX_RESPONSE_BYTES = 1_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CALLBACK_TIMEOUT_MS = 180_000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeText(value, maxLength = 200) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

class SaxoBridge {
  constructor({ fetchImpl = globalThis.fetch, openExternal = async () => { throw new Error('External browser authorization is unavailable.'); } } = {}) {
    this.fetchImpl = fetchImpl;
    this.openExternal = openExternal;
    this.environment = null;
    this.appKey = '';
    this.accessToken = '';
    this.refreshToken = '';
    this.accessTokenExpiresAt = 0;
    this.accounts = [];
    this.armedStrategyAccountKey = '';
    this.orderIntents = new Map();
    this.instrumentCache = new Map();
    this.callbackServer = null;
    this.pendingAuthorization = null;
    this.revision = 0;
  }

  async connect(request) {
    this.disconnect();
    const revision = this.revision;
    if (!isRecord(request)) throw new TypeError('Enter valid Saxo OpenAPI connection settings.');
    const appKey = safeText(request.appKey, 200);
    const environment = request.environment === 'live' ? 'live' : request.environment === 'sim' ? 'sim' : '';
    if (!appKey || !/^[A-Za-z0-9._-]{4,200}$/.test(appKey)) throw new TypeError('Enter a valid Saxo OpenAPI App Key.');
    if (!environment) throw new TypeError('Choose the Saxo simulation or live environment.');
    this.environment = environment;
    this.appKey = appKey;
    try {
      const token = await this.authorize(appKey, environment);
      if (revision !== this.revision) throw new Error('Saxo authorization was superseded by a newer connection.');
      this.setTokens(token);
      const response = await this.apiRequest('GET', '/port/v1/accounts');
      if (revision !== this.revision) throw new Error('Saxo connection was superseded by a newer provider request.');
      if (!isRecord(response) || !Array.isArray(response.Data)) throw new Error('Saxo returned an invalid account list.');
      this.accounts = response.Data.filter(account => isRecord(account)
        && typeof account.AccountKey === 'string' && account.AccountKey.length > 0)
        .map(account => ({
          accountKey: account.AccountKey,
          accountId: safeText(account.AccountId, 80),
          currency: safeText(account.Currency, 12),
          accountType: safeText(account.AccountType, 40),
          active: account.Active !== false,
          fractionalOrderEnabled: account.FractionalOrderEnabled === true,
        }))
        .filter(account => account.active);
      if (!this.accounts.length) throw new Error('Saxo returned no active trading accounts for this application.');
      return this.status();
    } catch (error) {
      this.clearSession();
      throw error;
    }
  }

  async authorize(appKey, environment) {
    const authBase = AUTH_HOSTS[environment];
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    const state = crypto.randomBytes(24).toString('base64url');
    const server = http.createServer();
    this.callbackServer = server;
    const callback = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Saxo authorization timed out.')), CALLBACK_TIMEOUT_MS);
      timeout.unref?.();
      const finish = (error, value) => {
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(value);
      };
      this.pendingAuthorization = { reject: error => finish(error) };
      server.on('request', (request, response) => {
        const address = new URL(request.url || '/', 'http://localhost');
        if (request.method !== 'GET' || address.pathname !== REDIRECT_PATH) {
          response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
          return;
        }
        if (address.searchParams.get('state') !== state) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Authorization state did not match. Return to Omega and retry.');
          finish(new Error('Saxo authorization state did not match.'));
          return;
        }
        const code = address.searchParams.get('code');
        const oauthError = address.searchParams.get('error');
        if (oauthError || !code || code.length > 4096) {
          response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Saxo authorization was not completed. You may close this page.');
          finish(new Error(oauthError ? `Saxo authorization failed: ${safeText(oauthError, 100)}.` : 'Saxo did not return an authorization code.'));
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          .end('<!doctype html><title>Saxo connected</title><p>Authorization received. You may return to Omega.</p>');
        finish(null, code);
      });
      server.on('error', error => finish(error));
      server.listen(0, 'localhost', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          finish(new Error('Could not start the local Saxo OAuth callback listener.'));
          return;
        }
        const redirectUri = `http://localhost:${address.port}${REDIRECT_PATH}`;
        const authorizationUrl = new URL('/authorize', authBase);
        authorizationUrl.search = new URLSearchParams({
          response_type: 'code',
          client_id: appKey,
          redirect_uri: redirectUri,
          state,
          code_challenge: challenge,
          code_challenge_method: 'S256',
        }).toString();
        void Promise.resolve(this.openExternal(authorizationUrl.toString())).catch(error => finish(new Error(`Could not open Saxo authorization: ${safeText(error?.message ?? String(error), 200)}`)));
        this.pendingAuthorization.redirectUri = redirectUri;
      });
    });
    try {
      const code = await callback;
      const redirectUri = this.pendingAuthorization?.redirectUri;
      if (!redirectUri) throw new Error('Saxo OAuth callback setup was lost.');
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: appKey,
        code,
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      const response = await this.request(`${authBase}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: body.toString(),
      }, 'Saxo token exchange');
      if (!isRecord(response) || typeof response.access_token !== 'string' || !response.access_token) {
        throw new Error('Saxo returned an invalid OAuth token response.');
      }
      return response;
    } finally {
      this.pendingAuthorization = null;
      if (this.callbackServer === server) this.callbackServer = null;
      await new Promise(resolve => server.close(() => resolve()));
    }
  }

  setTokens(token) {
    this.accessToken = token.access_token;
    this.refreshToken = safeText(token.refresh_token, 4096);
    this.accessTokenExpiresAt = Date.now() + Math.max(0, Number(token.expires_in) || 0) * 1000;
  }

  async request(url, init, label) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { ...init, redirect: 'error', signal: controller.signal });
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${label} response exceeded the size limit.`);
      let body = null;
      if (text) {
        try { body = JSON.parse(text); }
        catch { throw new Error(`${label} returned invalid JSON.`); }
      }
      if (!response.ok) {
        const detail = isRecord(body) ? (body.Message ?? body.ErrorInfo?.Message ?? body.error_description) : null;
        throw new Error(`${label} failed (HTTP ${response.status})${detail ? `: ${safeText(String(detail), 250)}` : '.'}`);
      }
      return body;
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${label} timed out.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async apiRequest(method, path, body) {
    if (!this.accessToken || !this.environment) throw new Error('Connect to Saxo before making OpenAPI requests.');
    if (!path.startsWith('/') || path.startsWith('//')) throw new TypeError('Invalid Saxo OpenAPI path.');
    if (this.accessTokenExpiresAt && Date.now() >= this.accessTokenExpiresAt) {
      throw new Error('Saxo access token expired. Disconnect and authorize again.');
    }
    const base = API_HOSTS[this.environment];
    return this.request(`${base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, `Saxo ${method} ${path}`);
  }

  getAccount(accountKey) {
    if (typeof accountKey !== 'string' || !accountKey) throw new TypeError('Select a connected Saxo account.');
    const account = this.accounts.find(item => item.accountKey === accountKey);
    if (!account || !this.accessToken) throw new Error('The selected Saxo account is no longer connected.');
    return account;
  }

  async resolveInstrument(accountKey, requestedSymbol) {
    const account = this.getAccount(accountKey);
    if (typeof requestedSymbol !== 'string' || !requestedSymbol.trim() || requestedSymbol.length > 100) {
      throw new TypeError('Enter a valid Saxo instrument symbol.');
    }
    const symbol = requestedSymbol.trim().replace(/^saxo:/i, '');
    const cacheKey = `${account.accountKey}:${symbol.toUpperCase()}`;
    const cached = this.instrumentCache.get(cacheKey);
    if (cached) return { ...cached };
    const parameters = new URLSearchParams({
      Keywords: symbol,
      AssetTypes: 'FxSpot,Stock,StockIndex,ContractFutures',
      AccountKey: account.accountKey,
      '$top': '50',
    });
    const result = await this.apiRequest('GET', `/ref/v1/instruments?${parameters}`);
    if (!isRecord(result) || !Array.isArray(result.Data)) throw new Error('Saxo returned an invalid instrument search result.');
    const normalize = value => String(value ?? '').replace(/^saxo:/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
    const target = normalize(symbol);
    const targetBase = normalize(symbol.split(':', 1)[0]);
    const hasQualifier = symbol.includes(':');
    const matches = result.Data.filter(item => isRecord(item)
      && Number.isSafeInteger(item.Identifier ?? item.Uic)
      && typeof item.AssetType === 'string'
      && (normalize(item.Symbol) === target || (!hasQualifier && normalize(String(item.Symbol).split(':', 1)[0]) === targetBase)));
    if (!matches.length) throw new Error(`Saxo did not find an exact tradable instrument for ${symbol}.`);
    if (matches.length > 1) {
      const choices = matches.slice(0, 5).map(item => String(item.Symbol)).join(', ');
      throw new Error(`Saxo found multiple exact matches for ${symbol}: ${choices}. Select an exchange-qualified symbol.`);
    }
    const match = matches[0];
    const uic = match.Identifier ?? match.Uic;
    const detailParameters = new URLSearchParams({ AccountKey: account.accountKey, FieldGroups: 'MarketData' });
    const details = await this.apiRequest('GET', `/ref/v1/instruments/details/${uic}/${encodeURIComponent(match.AssetType)}?${detailParameters}`);
    if (!isRecord(details) || details.Uic !== uic || details.AssetType !== match.AssetType || details.IsTradable !== true) {
      throw new Error(`Saxo did not confirm that ${safeText(match.Symbol, 100)} is tradable for the selected account.`);
    }
    const decimals = Number(details.Format?.Decimals ?? details.AmountDecimals);
    const minTick = Number(details.TickSize ?? details.TickSizeLimitOrder ?? match.TickSize);
    const contractSize = Number(details.ContractSize ?? match.ContractSize);
    const instrument = {
      uic,
      assetType: match.AssetType,
      symbol: String(details.Symbol ?? match.Symbol),
      description: safeText(details.Description ?? match.Description, 200),
      currency: safeText(details.CurrencyCode ?? match.CurrencyCode ?? match.Currency, 12),
      minTick: Number.isFinite(minTick) && minTick > 0
        ? minTick
        : Number.isInteger(decimals) && decimals >= 0 && decimals <= 10 ? 10 ** -decimals : undefined,
      contractSize: Number.isFinite(contractSize) && contractSize > 0 ? contractSize : undefined,
      minimumTradeSize: Number(details.MinimumTradeSize) > 0 ? Number(details.MinimumTradeSize) : undefined,
      amountDecimals: Number.isInteger(Number(details.AmountDecimals)) ? Number(details.AmountDecimals) : undefined,
      fractionalOrderEnabled: account.fractionalOrderEnabled,
    };
    this.instrumentCache.set(cacheKey, instrument);
    return { ...instrument };
  }

  async quote(accountKey, requestedSymbol) {
    const account = this.getAccount(accountKey);
    const instrument = await this.resolveInstrument(accountKey, requestedSymbol);
    const parameters = new URLSearchParams({
      AccountKey: account.accountKey,
      Uic: String(instrument.uic),
      AssetType: instrument.assetType,
      FieldGroups: 'Quote,DisplayAndFormat',
    });
    const result = await this.apiRequest('GET', `/trade/v1/infoprices?${parameters}`);
    if (!isRecord(result)) throw new Error(`Saxo returned no current quote for ${instrument.symbol}.`);
    const prices = Array.isArray(result.Data) ? result.Data : [result];
    const matches = prices.filter(item => isRecord(item)
      && item.Uic === instrument.uic
      && item.AssetType === instrument.assetType
      && isRecord(item.Quote));
    if (matches.length !== 1) throw new Error(`Saxo returned no unique current quote for ${instrument.symbol}.`);
    const price = matches[0];
    const quote = price.Quote;
    const timeMsc = Date.parse(String(price.LastUpdated ?? result.LastUpdated ?? quote.LastUpdated ?? ''));
    const bid = Number(quote.Bid);
    const ask = Number(quote.Ask);
    const delayedByMinutes = quote.DelayedByMinutes == null ? 0 : Number(quote.DelayedByMinutes);
    const priceDecimals = Number(price.DisplayAndFormat?.Decimals ?? price.DisplayAndFormat?.OrderDecimals);
    const reportedMinTick = Number(price.TickSize ?? price.DisplayAndFormat?.TickSize);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) {
      throw new Error(`Saxo returned an invalid ${instrument.symbol} bid/ask quote.`);
    }
    if (!Number.isFinite(delayedByMinutes) || delayedByMinutes < 0) {
      throw new Error(`Saxo returned invalid delayed-quote metadata for ${instrument.symbol}.`);
    }
    return {
      symbol: instrument.symbol,
      bid,
      ask,
      timeMsc: Number.isFinite(timeMsc) ? timeMsc : null,
      delayedByMinutes,
      marketState: safeText(quote.MarketState, 40),
      instrument: {
        ...instrument,
        minTick: instrument.minTick ?? (Number.isFinite(reportedMinTick) && reportedMinTick > 0
          ? reportedMinTick
          : Number.isInteger(priceDecimals) && priceDecimals >= 0 && priceDecimals <= 10 ? 10 ** -priceDecimals : undefined),
        contractSize: instrument.contractSize ?? (Number.isFinite(Number(price.ContractSize)) && Number(price.ContractSize) > 0
          ? Number(price.ContractSize)
          : undefined),
      },
    };
  }

  armStrategyTrading(accountKey, armed) {
    if (typeof armed !== 'boolean') throw new TypeError('Choose whether Saxo Pine strategy trading should be armed.');
    this.getAccount(accountKey);
    this.armedStrategyAccountKey = armed ? accountKey : '';
    return { armed: this.armedStrategyAccountKey === accountKey, accountKey };
  }

  async placeOrder(request) {
    if (!isRecord(request)) throw new TypeError('Enter a valid Saxo order request.');
    const account = this.getAccount(request.accountKey);
    const source = request.source === 'pine' ? 'pine' : request.source === 'manual' ? 'manual' : '';
    if (!source) throw new TypeError('Saxo order source must be manual or Pine strategy.');
    if (source === 'manual' && request.confirmed !== true) throw new Error('Confirm the Saxo order preview before submitting.');
    if (source === 'pine' && this.armedStrategyAccountKey !== account.accountKey) {
      throw new Error('Automatic Saxo Pine trading is not armed for this account.');
    }
    const side = request.side === 'BUY' ? 'Buy' : request.side === 'SELL' ? 'Sell' : '';
    const quantity = Number(request.quantity);
    if (!side || !Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000_000) {
      throw new TypeError('Saxo order side and quantity must be valid.');
    }
    const rawIntentId = safeText(request.intentId, 500);
    if (!rawIntentId) throw new TypeError('A unique Saxo order intent ID is required.');
    const intentId = crypto.createHash('sha256').update(rawIntentId).digest('hex').slice(0, 40);
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify({
      accountKey: account.accountKey, symbol: request.symbol, side, quantity,
      stopLoss: request.stopLoss ?? null, takeProfit: request.takeProfit ?? null, source,
    })).digest('hex');
    const priorIntent = this.orderIntents.get(intentId);
    if (priorIntent) {
      if (priorIntent.payloadHash !== payloadHash) throw new Error('This Saxo order intent ID was already used with different order details.');
      const priorResult = priorIntent.promise ? await priorIntent.promise : priorIntent.result;
      return { ...priorResult, duplicate: true };
    }

    const promise = this.submitOrder({ account, request, side, quantity, source, intentId });
    const intent = { payloadHash, promise };
    this.orderIntents.set(intentId, intent);
    try {
      const result = await promise;
      this.orderIntents.set(intentId, { payloadHash, result });
      return result;
    } catch (error) {
      if (this.orderIntents.get(intentId) === intent) this.orderIntents.delete(intentId);
      throw error;
    }
  }

  async submitOrder({ account, request, side, quantity, source, intentId }) {
    const quote = await this.quote(account.accountKey, request.symbol);
    const quoteAge = Date.now() - Number(quote.timeMsc);
    if (!Number.isFinite(quote.timeMsc) || quoteAge < -1000 || quoteAge > 5000 || quote.delayedByMinutes > 0) {
      throw new Error('Saxo did not provide a fresh, real-time quote; no order was sent.');
    }
    const entryPrice = side === 'Buy' ? quote.ask : quote.bid;
    const stopLoss = request.stopLoss == null ? null : Number(request.stopLoss);
    const takeProfit = request.takeProfit == null ? null : Number(request.takeProfit);
    if (stopLoss !== null && (!Number.isFinite(stopLoss) || stopLoss <= 0
      || (side === 'Buy' ? stopLoss >= entryPrice : stopLoss <= entryPrice))) {
      throw new TypeError('Saxo stop-loss price is invalid for the selected order side.');
    }
    if (takeProfit !== null && (!Number.isFinite(takeProfit) || takeProfit <= 0
      || (side === 'Buy' ? takeProfit <= entryPrice : takeProfit >= entryPrice))) {
      throw new TypeError('Saxo take-profit price is invalid for the selected order side.');
    }

    let amount = quantity;
    if (quote.instrument.assetType === 'FxSpot') amount *= 100_000;
    else if (!account.fractionalOrderEnabled && !Number.isSafeInteger(amount)) {
      throw new TypeError('This Saxo account requires a whole-number share or contract quantity.');
    }
    if (quote.instrument.amountDecimals !== undefined) {
      const scale = 10 ** quote.instrument.amountDecimals;
      if (Math.abs(Math.round(amount * scale) - amount * scale) > 1e-8) {
        throw new TypeError(`Saxo supports at most ${quote.instrument.amountDecimals} decimal places for ${quote.instrument.symbol} quantity.`);
      }
    }
    if (quote.instrument.minimumTradeSize !== undefined && amount < quote.instrument.minimumTradeSize) {
      throw new TypeError(`Saxo's minimum order size for ${quote.instrument.symbol} is ${quote.instrument.minimumTradeSize}.`);
    }
    const oppositeSide = side === 'Buy' ? 'Sell' : 'Buy';
    const duration = { DurationType: 'DayOrder' };
    const childOrders = [];
    if (stopLoss !== null) childOrders.push({
      AccountKey: account.accountKey, Amount: amount, AssetType: quote.instrument.assetType,
      BuySell: oppositeSide, OrderDuration: duration, OrderPrice: stopLoss, OrderType: 'Stop', Uic: quote.instrument.uic,
    });
    if (takeProfit !== null) childOrders.push({
      AccountKey: account.accountKey, Amount: amount, AssetType: quote.instrument.assetType,
      BuySell: oppositeSide, OrderDuration: duration, OrderPrice: takeProfit, OrderType: 'Limit', Uic: quote.instrument.uic,
    });
    const body = {
      AccountKey: account.accountKey,
      Amount: amount,
      AssetType: quote.instrument.assetType,
      BuySell: side,
      ManualOrder: source === 'manual',
      OrderDuration: duration,
      OrderType: 'Market',
      Uic: quote.instrument.uic,
      ExternalReference: intentId,
      ...(childOrders.length ? { Orders: childOrders } : {}),
    };
    const result = await this.apiRequest('POST', '/trade/v2/orders', body);
    if (!isRecord(result) || typeof result.OrderId !== 'string' || !result.OrderId) {
      throw new Error('Saxo did not confirm an order ID. Check the Saxo platform before retrying.');
    }
    const orderResult = { status: 'submitted', orderId: result.OrderId, symbol: quote.instrument.symbol, quantity: amount, protected: childOrders.length > 0 };
    return orderResult;
  }

  status() {
    return {
      connected: Boolean(this.accessToken && this.environment),
      environment: this.environment,
      accounts: this.accounts.map(account => ({ ...account })),
      expiresAt: this.accessTokenExpiresAt || null,
      armedStrategyAccountKey: this.armedStrategyAccountKey || null,
    };
  }

  clearSession() {
    this.environment = null;
    this.appKey = '';
    this.accessToken = '';
    this.refreshToken = '';
    this.accessTokenExpiresAt = 0;
    this.accounts = [];
    this.armedStrategyAccountKey = '';
    this.orderIntents.clear();
    this.instrumentCache.clear();
  }

  disconnect() {
    this.revision += 1;
    const pending = this.pendingAuthorization;
    this.pendingAuthorization = null;
    if (pending) pending.reject(new Error('Saxo authorization was cancelled.'));
    const server = this.callbackServer;
    this.callbackServer = null;
    if (server?.listening) server.close();
    this.clearSession();
  }
}

module.exports = { SaxoBridge, AUTH_HOSTS, API_HOSTS, REDIRECT_PATH };
