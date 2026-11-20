const test = require('node:test');
const assert = require('node:assert/strict');
const { CTraderMcpClient, ENDPOINT, summarizeTool } = require('./ctrader-mcp.cjs');

function response(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: name => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

test('connects only to the loopback cTrader MCP endpoint and lists tools', async () => {
  const calls = [];
  const client = new CTraderMcpClient({ fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (init.method === 'DELETE') return response(204, null);
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') {
      return response(200, { jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2025-11-25', serverInfo: { name: 'ctrader-desktop', version: '2.0.0' }, capabilities: { tools: {} },
      } }, { 'mcp-session-id': 'session-1', 'content-type': 'application/json' });
    }
    if (request.method === 'notifications/initialized') return response(202, null);
    return response(200, { jsonrpc: '2.0', id: request.id, result: { tools: [
      { name: 'get_account', description: 'Read account state', inputSchema: { type: 'object', properties: {} } },
      { name: 'place_order', description: 'Place an order', inputSchema: { type: 'object', properties: { symbol: { type: 'string' } } } },
    ] } }, { 'content-type': 'application/json' });
  } });

  const status = await client.connect();
  assert.equal(ENDPOINT, 'http://127.0.0.1:9876/mcp/');
  assert.equal(status.connected, true);
  assert.equal(status.server.name, 'ctrader-desktop');
  assert.deepEqual(status.tools.map(tool => tool.name), ['get_account', 'place_order']);
  assert.ok(calls.every(call => call.url === ENDPOINT));
  assert.equal(calls[2].init.headers['Mcp-Session-Id'], 'session-1');

  await client.connect();
  assert.equal(calls[3].init.method, 'DELETE');
  assert.equal(calls[3].init.headers['Mcp-Session-Id'], 'session-1');
  assert.equal(calls[4].init.method, 'POST');
  assert.equal(calls[5].init.method, 'POST');
  assert.equal(calls[6].init.method, 'POST');
  assert.equal(client.status().connected, true);

  await client.disconnect();
  assert.equal(calls[7].init.method, 'DELETE');
  assert.equal(client.status().connected, false);
});

test('fails clearly when the gateway cannot return its MCP tools', async () => {
  const client = new CTraderMcpClient({ fetchImpl: async (_url, init) => {
    if (init.method === 'DELETE') return response(204, null);
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') {
      return response(200, { jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2025-11-25', serverInfo: { name: 'ctrader-desktop', version: '2.0.0' }, capabilities: { tools: {} },
      } }, { 'mcp-session-id': 'session-1', 'content-type': 'application/json' });
    }
    if (request.method === 'notifications/initialized') return response(202, null);
    return response(404, null);
  } });

  await assert.rejects(client.connect(), /HTTP 404 for tools\/list/);
  assert.equal(client.status().connected, false);
});

test('explains that an initialize 404 may indicate a bad path or stale session', async () => {
  const client = new CTraderMcpClient({ fetchImpl: async () => response(404, null) });
  await assert.rejects(client.connect(), /may not expose an MCP handler.*stale session/);
  assert.equal(client.status().connected, false);
});

test('rejects malformed or oversized tool metadata', () => {
  assert.equal(summarizeTool({ name: '../place-order', description: 'bad', inputSchema: { type: 'object', properties: {} } }), null);
  assert.equal(summarizeTool({ name: 'place_order', description: 'x'.repeat(2001), inputSchema: { type: 'object', properties: {} } }), null);
  assert.ok(summarizeTool({ name: 'place_order', description: 'Place an order', inputSchema: { type: 'object', properties: {} } }));
});

test('allows only selected read tools and validates explicitly lot-sized chart orders', async () => {
  const toolCalls = [];
  const tools = [
    ...['get_symbols', 'get_symbol_details', 'get_trendbars', 'close_all_positions']
      .map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} } })),
    {
      name: 'get_spot_prices',
      description: 'Get live prices',
      inputSchema: {
        type: 'object',
        properties: { symbol: { type: 'string' } },
        required: ['symbol'],
      },
    },
    {
      name: 'place_market_order',
      description: 'Place a market order',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          side: { type: 'string' },
          lots: { type: 'number' },
          volumeType: { type: 'string' },
          slPips: { type: 'number' },
          comment: { type: 'string' },
        },
        required: ['symbol', 'side', 'lots', 'volumeType'],
      },
    },
  ];
  const client = new CTraderMcpClient({ fetchImpl: async (url, init) => {
    const request = JSON.parse(init.body);
    if (request.method === 'initialize') {
      return response(200, { jsonrpc: '2.0', id: request.id, result: {
        protocolVersion: '2025-11-25', serverInfo: { name: 'ctrader-desktop', version: '2.0.0' }, capabilities: { tools: {} },
      } }, { 'mcp-session-id': 'session-1', 'content-type': 'application/json' });
    }
    if (request.method === 'notifications/initialized') return response(202, null);
    if (request.method === 'tools/list') return response(200, { jsonrpc: '2.0', id: request.id, result: { tools } }, { 'content-type': 'application/json' });
    if (request.method === 'tools/call') {
      toolCalls.push(request.params);
      return response(200, { jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] } }, { 'content-type': 'application/json' });
    }
    throw new Error(`Unexpected MCP method ${request.method} at ${url}`);
  } });

  await client.connect();
  assert.deepEqual(await client.callMarketData('get_spot_prices', { symbolName: 'EURUSD' }), { ok: true });
  await assert.rejects(client.callMarketData('close_all_positions', {}), /not enabled for chart market data/);
  await assert.rejects(client.placeMarketOrder({ symbolName: 'EURUSD', side: 'buy', volume: 0.01, volumeType: 'units' }), /explicitly expressed in lots/);
  assert.deepEqual(await client.placeMarketOrder({ symbolName: 'EURUSD', side: 'buy', volume: 0.01, volumeType: 'lots', stopLossPips: 10 }), { ok: true });
  assert.deepEqual(toolCalls.map(call => call.name), ['get_spot_prices', 'place_market_order']);
  assert.deepEqual(toolCalls[0].arguments, { symbol: 'EURUSD' });
  assert.deepEqual(toolCalls[1].arguments, {
    symbol: 'EURUSD', side: 'buy', lots: 0.01, volumeType: 'lots', comment: 'Omega confirmed chart order', slPips: 10,
  });
});
