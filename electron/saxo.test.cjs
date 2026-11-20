const test = require('node:test');
const assert = require('node:assert/strict');
const { SaxoBridge, AUTH_HOSTS, API_HOSTS, REDIRECT_PATH } = require('./saxo.cjs');

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

test('Saxo connects with OAuth PKCE and returns active accounts without exposing tokens', async () => {
  const requests = [];
  const bridge = new SaxoBridge({
    openExternal: async url => {
      const authorize = new URL(url);
      assert.equal(authorize.origin, AUTH_HOSTS.sim);
      assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(authorize.searchParams.get('code_challenge'));
      const redirect = new URL(authorize.searchParams.get('redirect_uri'));
      assert.equal(redirect.pathname, REDIRECT_PATH);
      const callback = new URL(redirect);
      callback.searchParams.set('code', 'auth-code');
      callback.searchParams.set('state', authorize.searchParams.get('state'));
      const response = await fetch(callback);
      assert.equal(response.status, 200);
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url) === `${AUTH_HOSTS.sim}/token`) {
        assert.equal(new URLSearchParams(init.body).get('code_verifier')?.length, 43);
        return jsonResponse(200, { access_token: 'private-access-token', refresh_token: 'private-refresh-token', expires_in: 1200 });
      }
      if (String(url) === `${API_HOSTS.sim}/port/v1/accounts`) {
        assert.equal(init.headers.Authorization, 'Bearer private-access-token');
        return jsonResponse(200, { Data: [
          { AccountKey: 'sim-account-key', AccountId: 'SIM-1', Currency: 'USD', Active: true },
          { AccountKey: 'inactive-key', AccountId: 'OLD', Active: false },
        ] });
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });

  const status = await bridge.connect({ appKey: 'test-app-key-1234', environment: 'sim' });
  assert.equal(status.connected, true);
  assert.equal(status.environment, 'sim');
  assert.deepEqual(status.accounts, [{
    accountKey: 'sim-account-key', accountId: 'SIM-1', currency: 'USD', accountType: '', active: true, fractionalOrderEnabled: false,
  }]);
  assert.equal(JSON.stringify(status).includes('private-access-token'), false);
  assert.equal(requests.length, 2);
  bridge.disconnect();
  assert.equal(bridge.status().connected, false);
});

test('Saxo rejects an OAuth callback with mismatched state', async () => {
  const bridge = new SaxoBridge({
    openExternal: async url => {
      const authorize = new URL(url);
      const callback = new URL(authorize.searchParams.get('redirect_uri'));
      callback.searchParams.set('code', 'auth-code');
      callback.searchParams.set('state', 'wrong-state');
      await fetch(callback);
    },
    fetchImpl: async () => { throw new Error('Token exchange must not happen.'); },
  });

  await assert.rejects(bridge.connect({ appKey: 'test-app-key-1234', environment: 'sim' }), /state did not match/i);
  assert.equal(bridge.status().connected, false);
});

test('Saxo validates credentials and restricts environments', async () => {
  const bridge = new SaxoBridge();
  await assert.rejects(bridge.connect({ appKey: 'x', environment: 'sim' }), /App Key/);
  await assert.rejects(bridge.connect({ appKey: 'valid-app-key', environment: 'unknown' }), /environment/);
});

function connectedSaxo({ quoteAgeMs = 0, delayedByMinutes = 0, instruments } = {}) {
  const submittedOrders = [];
  const bridge = new SaxoBridge({
    fetchImpl: async (url, init = {}) => {
      const requestUrl = new URL(String(url));
      if (requestUrl.pathname.endsWith('/ref/v1/instruments')) {
        return jsonResponse(200, { Data: instruments ?? [{ Identifier: 21, Symbol: 'EURUSD', AssetType: 'FxSpot', CurrencyCode: 'USD', Decimals: 5 }] });
      }
      if (requestUrl.pathname.includes('/ref/v1/instruments/details/')) {
        const uic = Number(requestUrl.pathname.split('/').at(-2));
        const foundInstrument = (instruments ?? [{ Identifier: 21, Symbol: 'EURUSD', AssetType: 'FxSpot' }])
          .find(item => (item.Identifier ?? item.Uic) === uic);
        return jsonResponse(200, {
          Uic: uic,
          AssetType: foundInstrument.AssetType,
          Symbol: foundInstrument.Symbol,
          Description: 'Euro / US Dollar',
          CurrencyCode: 'USD',
          IsTradable: true,
          MinimumTradeSize: 1000,
          AmountDecimals: 0,
          IncrementSize: 0.00005,
          TickSize: 0.00001,
        });
      }
      if (requestUrl.pathname.endsWith('/trade/v1/infoprices')) {
        return jsonResponse(200, {
          Uic: 21,
          AssetType: 'FxSpot',
          LastUpdated: new Date(Date.now() - quoteAgeMs).toISOString(),
          Quote: { Bid: 1.1, Ask: 1.1002, DelayedByMinutes: delayedByMinutes, MarketState: 'RegularTrading' },
        });
      }
      if (requestUrl.pathname.endsWith('/trade/v2/orders')) {
        const order = JSON.parse(init.body);
        submittedOrders.push(order);
        return jsonResponse(200, { OrderId: `order-${submittedOrders.length}` });
      }
      throw new Error(`Unexpected Saxo request: ${url}`);
    },
  });
  bridge.environment = 'sim';
  bridge.accessToken = 'test-token';
  bridge.accessTokenExpiresAt = Date.now() + 60_000;
  bridge.accounts = [{ accountKey: 'account-1', accountId: 'SIM-1', active: true, fractionalOrderEnabled: true }];
  return { bridge, submittedOrders };
}

test('Saxo resolves one exact instrument and rejects ambiguous matches', async () => {
  const single = connectedSaxo();
  assert.equal((await single.bridge.resolveInstrument('account-1', 'EURUSD')).symbol, 'EURUSD');

  const ambiguous = connectedSaxo({ instruments: [
    { Identifier: 21, Symbol: 'EURUSD:USD', AssetType: 'FxSpot' },
    { Identifier: 22, Symbol: 'EURUSD:EUR', AssetType: 'FxSpot' },
  ] });
  await assert.rejects(ambiguous.bridge.resolveInstrument('account-1', 'EURUSD'), /multiple exact matches/i);
  assert.equal((await ambiguous.bridge.resolveInstrument('account-1', 'EURUSD:USD')).uic, 21);
});

test('Saxo blocks stale and delayed quotes before submitting an order', async () => {
  const stale = connectedSaxo({ quoteAgeMs: 6000 });
  await assert.rejects(stale.bridge.placeOrder({
    accountKey: 'account-1', symbol: 'EURUSD', side: 'BUY', quantity: 0.1,
    source: 'manual', confirmed: true, intentId: 'stale-order',
  }), /fresh, real-time quote/i);
  assert.equal(stale.submittedOrders.length, 0);

  const delayed = connectedSaxo({ delayedByMinutes: 15 });
  await assert.rejects(delayed.bridge.placeOrder({
    accountKey: 'account-1', symbol: 'EURUSD', side: 'BUY', quantity: 0.1,
    source: 'manual', confirmed: true, intentId: 'delayed-order',
  }), /fresh, real-time quote/i);
  assert.equal(delayed.submittedOrders.length, 0);
});

test('Saxo confirms manual market orders with attached protection orders', async () => {
  const { bridge, submittedOrders } = connectedSaxo();
  await assert.rejects(bridge.placeOrder({
    accountKey: 'account-1', symbol: 'EURUSD', side: 'BUY', quantity: 0.005,
    source: 'manual', confirmed: true, intentId: 'below-increment',
  }), /minimum order size.*1000/i);
  assert.equal(submittedOrders.length, 0);

  const result = await bridge.placeOrder({
    accountKey: 'account-1', symbol: 'EURUSD', side: 'BUY', quantity: 0.1,
    stopLoss: 1.09, takeProfit: 1.12, source: 'manual', confirmed: true, intentId: 'manual-order',
  });
  assert.equal(result.status, 'submitted');
  assert.equal(result.protected, true);
  assert.equal(submittedOrders.length, 1);
  assert.equal(submittedOrders[0].Amount, 10_000);
  assert.equal(submittedOrders[0].OrderType, 'Market');
  assert.equal(submittedOrders[0].Orders.length, 2);
  assert.equal(submittedOrders[0].Orders[0].OrderType, 'Stop');
  assert.equal(submittedOrders[0].Orders[1].OrderType, 'Limit');
});

test('Saxo Pine orders are default-off, account-bound, and deduplicated', async () => {
  const { bridge, submittedOrders } = connectedSaxo();
  const request = {
    accountKey: 'account-1', symbol: 'EURUSD', side: 'BUY', quantity: 0.1,
    source: 'pine', intentId: 'strategy-position-open',
  };
  await assert.rejects(bridge.placeOrder(request), /not armed/i);
  assert.equal(submittedOrders.length, 0);

  assert.deepEqual(bridge.armStrategyTrading('account-1', true), { armed: true, accountKey: 'account-1' });
  const [first, duplicate] = await Promise.all([bridge.placeOrder(request), bridge.placeOrder(request)]);
  assert.equal(first.status, 'submitted');
  assert.equal(duplicate.duplicate, true);
  assert.equal(submittedOrders.length, 1);

  assert.deepEqual(bridge.armStrategyTrading('account-1', false), { armed: false, accountKey: 'account-1' });
  await assert.rejects(bridge.placeOrder({ ...request, intentId: 'strategy-position-next' }), /not armed/i);
});
