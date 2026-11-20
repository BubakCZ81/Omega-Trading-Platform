const ENDPOINT = 'http://127.0.0.1:9876/mcp/';
const PROTOCOL_VERSION = '2025-11-25';
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_TOOLS = 200;
const REQUEST_TIMEOUT_MS = 8_000;
const MARKET_DATA_TOOLS = new Set(['get_symbols', 'get_symbol_details', 'get_spot_prices', 'get_trendbars']);
const ORDER_TOOL = 'place_market_order';
const ARGUMENT_ALIASES = {
  symbolName: ['symbolName', 'symbol_name', 'symbol', 'ticker', 'name'],
  timeframe: ['timeframe', 'timeFrame', 'period'],
  from: ['from', 'start', 'startDate', 'fromDate'],
  to: ['to', 'end', 'endDate', 'toDate'],
  limit: ['limit', 'count', 'bars'],
  side: ['side', 'tradeSide', 'orderSide', 'direction'],
  volume: ['volume', 'quantity', 'lots', 'lotSize'],
  volumeType: ['volumeType', 'volume_type', 'volumeUnit', 'unit'],
  stopLossPips: ['stopLossPips', 'stop_loss_pips', 'slPips'],
  takeProfitPips: ['takeProfitPips', 'take_profit_pips', 'tpPips'],
  comment: ['comment', 'label'],
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseResponse(text, contentType, expectedId) {
  let payloads;
  if (contentType?.includes('text/event-stream')) {
    payloads = text.split(/\r?\n\r?\n/).flatMap(event => {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') return [];
      try { return [JSON.parse(data)]; }
      catch { throw new Error('cTrader MCP returned an invalid event-stream response.'); }
    });
  } else {
    try { payloads = [JSON.parse(text)]; }
    catch { throw new Error('cTrader MCP returned an invalid JSON response.'); }
  }
  const response = payloads.find(item => item && item.id === expectedId);
  if (!response) throw new Error('cTrader MCP did not return the expected response.');
  if (response.error) {
    const message = typeof response.error.message === 'string' ? response.error.message.slice(0, 400) : 'MCP request failed.';
    throw new Error(`cTrader MCP: ${message}`);
  }
  return response.result;
}

function summarizeTool(tool) {
  if (!isRecord(tool) || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.-]{1,120}$/.test(tool.name)) return null;
  if (typeof tool.description !== 'string' || tool.description.length > 2000) return null;
  const inputSchema = isRecord(tool.inputSchema) ? tool.inputSchema : null;
  if (!inputSchema || inputSchema.type !== 'object' || !isRecord(inputSchema.properties ?? {})) return null;
  return { name: tool.name, description: tool.description, inputSchema };
}

class CTraderMcpClient {
  constructor({ fetchImpl = globalThis.fetch } = {}) {
    this.fetchImpl = fetchImpl;
    this.sessionId = '';
    this.nextId = 1;
    this.serverInfo = null;
    this.tools = [];
    this.initializing = null;
  }

  async post(payload, notification = false) {
    if (typeof this.fetchImpl !== 'function') throw new Error('HTTP requests are unavailable in this runtime.');
    const id = this.nextId++;
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    };
    const timer = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    let response;
    try {
      response = await this.fetchImpl(ENDPOINT, {
        method: 'POST', headers, redirect: 'error', signal: timer,
        body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), ...payload }),
      });
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error('cTrader MCP request timed out.');
      throw new Error(`Could not connect to cTrader MCP at ${ENDPOINT}: ${String(error?.message ?? error).slice(0, 250)}`);
    }
    if (!response.ok) {
      if (response.status === 404 && payload.method === 'initialize') {
        throw new Error(`The cTrader MCP endpoint ${ENDPOINT} returned HTTP 404 during initialization. The configured path may not expose an MCP handler, or the gateway may still hold a stale session; verify the endpoint and restart the cTrader MCP gateway to release any abandoned session.`);
      }
      throw new Error(`cTrader MCP returned HTTP ${response.status} for ${payload.method}.`);
    }
    const sessionId = response.headers?.get?.('Mcp-Session-Id');
    if (sessionId) this.sessionId = sessionId;
    if (notification || response.status === 202) return null;
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error('cTrader MCP response exceeded the size limit.');
    return parseResponse(text, response.headers?.get?.('content-type') ?? '', id);
  }

  async connect() {
    await this.disconnect();
    try {
      const result = await this.post({
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Omega', version: '4.0.0' },
        },
      });
      if (!isRecord(result) || typeof result.protocolVersion !== 'string' || !isRecord(result.serverInfo)) {
        throw new Error('cTrader MCP returned an invalid initialization response.');
      }
      this.serverInfo = { name: String(result.serverInfo.name ?? ''), version: String(result.serverInfo.version ?? '') };
      if (result.protocolVersion !== PROTOCOL_VERSION) {
        throw new Error(`cTrader MCP negotiated unsupported protocol ${result.protocolVersion}.`);
      }
      await this.post({ method: 'notifications/initialized', params: {} }, true);
      const toolsResult = await this.post({ method: 'tools/list', params: {} });
      if (!isRecord(toolsResult) || !Array.isArray(toolsResult.tools) || toolsResult.tools.length > MAX_TOOLS) {
        throw new Error('cTrader MCP returned an invalid or oversized tool list.');
      }
      this.tools = toolsResult.tools.map(summarizeTool).filter(Boolean);
      return this.status();
    } catch (error) {
      try {
        await this.disconnect();
      } catch (cleanupError) {
        const connectMessage = error instanceof Error ? error.message : String(error);
        const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
        throw new Error(`${connectMessage} MCP session cleanup also failed: ${cleanupMessage}`);
      }
      throw error;
    }
  }

  status() {
    return {
      connected: Boolean(this.sessionId && this.serverInfo),
      endpoint: ENDPOINT,
      server: this.serverInfo,
      tools: this.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    };
  }

  async callMarketData(toolName, argumentsObject) {
    if (!MARKET_DATA_TOOLS.has(toolName)) throw new Error(`cTrader MCP tool ${String(toolName)} is not enabled for chart market data.`);
    return this.callTool(toolName, argumentsObject);
  }

  async placeMarketOrder(request) {
    if (!isRecord(request) || typeof request.symbolName !== 'string' || !request.symbolName.trim()) {
      throw new Error('A cTrader symbol is required for a confirmed market order.');
    }
    if (request.side !== 'buy' && request.side !== 'sell') throw new Error('A cTrader market order side must be buy or sell.');
    if (typeof request.volume !== 'number' || !Number.isFinite(request.volume) || request.volume <= 0 || request.volumeType !== 'lots') {
      throw new Error('cTrader chart orders require a positive volume explicitly expressed in lots.');
    }
    for (const field of ['stopLossPips', 'takeProfitPips']) {
      if (request[field] !== undefined && (typeof request[field] !== 'number' || !Number.isFinite(request[field]) || request[field] <= 0)) {
        throw new Error(`cTrader ${field} must be a positive finite number when supplied.`);
      }
    }
    const args = {
      symbolName: request.symbolName.trim(),
      side: request.side,
      volume: request.volume,
      volumeType: 'lots',
      comment: 'Omega confirmed chart order',
      ...(request.stopLossPips === undefined ? {} : { stopLossPips: request.stopLossPips }),
      ...(request.takeProfitPips === undefined ? {} : { takeProfitPips: request.takeProfitPips }),
    };
    return this.callTool(ORDER_TOOL, args);
  }

  async callTool(toolName, argumentsObject) {
    if (!this.sessionId || !this.serverInfo) throw new Error('cTrader MCP is not connected.');
    const tool = this.tools.find(item => item.name === toolName);
    if (!tool) throw new Error(`The connected cTrader MCP does not advertise ${toolName}.`);
    if (!isRecord(argumentsObject)) throw new Error(`Arguments for cTrader MCP tool ${toolName} must be an object.`);
    const properties = tool.inputSchema.properties;
    const propertyNames = isRecord(properties) ? Object.keys(properties) : [];
    let resolvedArguments = argumentsObject;
    if (propertyNames.length) {
      resolvedArguments = {};
      for (const [key, value] of Object.entries(argumentsObject)) {
        const destination = (ARGUMENT_ALIASES[key] ?? [key]).find(alias => propertyNames.includes(alias));
        if (destination) resolvedArguments[destination] = value;
      }
      const required = Array.isArray(tool.inputSchema.required) ? tool.inputSchema.required : [];
      const missing = required.filter(key => typeof key === 'string' && resolvedArguments[key] === undefined);
      if (missing.length) {
        throw new Error(`cTrader MCP ${toolName} requires unsupported argument(s): ${missing.join(', ')}.`);
      }
    }
    const result = await this.post({ method: 'tools/call', params: { name: toolName, arguments: resolvedArguments } });
    if (!isRecord(result) || result.isError === true) {
      const message = Array.isArray(result?.content)
        ? result.content.filter(item => isRecord(item) && typeof item.text === 'string').map(item => item.text).join(' ').slice(0, 400)
        : '';
      throw new Error(`cTrader MCP ${toolName} failed${message ? `: ${message}` : '.'}`);
    }
    if (isRecord(result.structuredContent)) return result.structuredContent;
    if (!Array.isArray(result.content)) throw new Error(`cTrader MCP ${toolName} returned no content.`);
    const text = result.content.filter(item => isRecord(item) && typeof item.text === 'string').map(item => item.text).join('\n').trim();
    if (!text) throw new Error(`cTrader MCP ${toolName} returned no text content.`);
    try { return JSON.parse(text); }
    catch { return text; }
  }

  async disconnect() {
    const sessionId = this.sessionId;
    if (sessionId) {
      if (typeof this.fetchImpl !== 'function') throw new Error('HTTP requests are unavailable while closing the cTrader MCP session.');
      let response;
      try {
        response = await this.fetchImpl(ENDPOINT, {
          method: 'DELETE',
          headers: {
            Accept: 'application/json, text/event-stream',
            'MCP-Protocol-Version': PROTOCOL_VERSION,
            'Mcp-Session-Id': sessionId,
          },
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (error?.name === 'TimeoutError') throw new Error('Closing the cTrader MCP session timed out.');
        throw new Error(`Could not close the cTrader MCP session: ${String(error?.message ?? error).slice(0, 250)}`);
      }
      if (!response.ok && response.status !== 404) {
        throw new Error(`cTrader MCP session cleanup returned HTTP ${response.status}.`);
      }
    }
    this.sessionId = '';
    this.serverInfo = null;
    this.tools = [];
    this.initializing = null;
    return true;
  }
}

module.exports = { CTraderMcpClient, ENDPOINT, MARKET_DATA_TOOLS, ORDER_TOOL, parseResponse, summarizeTool };
