const { spawn } = require('node:child_process');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const REQUEST_TIMEOUT_MS = 15_000;
/**
 * Connecting is not a normal request: the bridge has to launch the terminal, wait for it to
 * report connected, and then serialise every symbol the broker offers — thousands of them on
 * a real account. Holding that to the 15 second request timeout is why a perfectly healthy
 * terminal appeared to "not connect" from the app while the same bridge worked when run by
 * hand.
 */
const CONNECT_TIMEOUT_MS = 180_000;
/** Listing symbols goes over the same slow path, just without the terminal start-up. */
const SYMBOL_LIST_TIMEOUT_MS = 90_000;
const MAX_SYMBOL_LENGTH = 100;
const MAX_TIMEFRAME_LENGTH = 16;

/** Accept an executable path or the Windows launcher form `py -3.13`. */
function resolvePythonCommand(value) {
  const raw = String(value || '').trim() || 'python';
  const quotedPath = raw.match(/^"(.+)"$/);
  if (quotedPath) return { command: quotedPath[1], args: [] };
  const launcher = raw.match(/^(py(?:\.exe)?)\s+(-3(?:\.\d+)?)$/i);
  if (launcher) return { command: launcher[1], args: [launcher[2]] };
  if (/\s/.test(raw)) throw new Error('Enter a Python path in quotes, or use the Windows launcher form: py -3.13.');
  return { command: raw, args: [] };
}

function validateBarsRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid MetaTrader bars request.');
  const ticker = typeof request.ticker === 'string' ? request.ticker.trim() : '';
  const timeframe = typeof request.timeframe === 'string' ? request.timeframe.trim() : '';
  if (!ticker || ticker.length > MAX_SYMBOL_LENGTH) throw new Error('Enter a valid MetaTrader symbol.');
  if (!timeframe || timeframe.length > MAX_TIMEFRAME_LENGTH) throw new Error('Enter a valid chart timeframe.');
  const range = request.range && typeof request.range === 'object' && !Array.isArray(request.range) ? request.range : {};
  const limit = range.limit === undefined ? 1000 : Number(range.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50_000) throw new Error('MetaTrader history request must be between 1 and 50,000 bars.');
  const from = range.from === undefined ? undefined : Number(range.from);
  const to = range.to === undefined ? undefined : Number(range.to);
  if ((from !== undefined && !Number.isFinite(from)) || (to !== undefined && !Number.isFinite(to))) {
    throw new Error('MetaTrader history range contains an invalid date.');
  }
  if (from !== undefined && to !== undefined && from > to) throw new Error('MetaTrader history range is reversed.');
  return { ticker, timeframe, range: { from, to, limit } };
}

function validateQuoteRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid MetaTrader quote request.');
  const ticker = typeof request.ticker === 'string' ? request.ticker.trim() : '';
  if (!ticker || ticker.length > MAX_SYMBOL_LENGTH) throw new Error('Enter a valid MetaTrader symbol.');
  return { ticker };
}

function validateTicksRequest(request) {
  const { ticker } = validateQuoteRequest(request);
  const fromMsc = Number(request.fromMsc);
  const limit = request.limit === undefined ? 1000 : Number(request.limit);
  if (!Number.isFinite(fromMsc) || fromMsc < 0) throw new Error('Enter a valid MetaTrader tick start time.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new Error('MetaTrader tick request must be between 1 and 10,000 ticks.');
  return { ticker, fromMsc, limit };
}

class Mt5Bridge {
  constructor({ spawnImpl = spawn, scriptPath = path.join(__dirname, 'mt5_bridge.py') } = {}) {
    this.spawnImpl = spawnImpl;
    this.scriptPath = scriptPath;
    this.child = null;
    this.pythonExecutable = '';
    this.pending = new Map();
    this.tickStreams = new Map();
    this.pendingTickStreams = new Map();
    this.output = '';
    this.errorOutput = '';
    this.closing = false;
    this.disconnectPromise = null;
  }

  async connect(pythonExecutable) {
    if (pythonExecutable !== undefined && (typeof pythonExecutable !== 'string' || pythonExecutable.trim().length > 1024)) {
      throw new Error('Enter a valid Python executable path.');
    }
    const executable = pythonExecutable?.trim() || process.env.OMEGA_MT5_PYTHON || 'python';
    const command = resolvePythonCommand(executable);
    const commandKey = [command.command, ...command.args].join(' ');
    if (this.child && commandKey !== this.pythonExecutable) await this.disconnect();
    this.start(command);
    try {
      return await this.request('connect', {}, CONNECT_TIMEOUT_MS);
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async symbols() {
    return this.request('symbols', {}, SYMBOL_LIST_TIMEOUT_MS);
  }

  async bars(request) {
    return this.request('bars', validateBarsRequest(request));
  }

  async quote(request) {
    return this.request('quote', validateQuoteRequest(request));
  }

  async status() {
    return this.request('status');
  }

  async placeOrder(order) {
    return this.request('place_order', { order });
  }

  async openPosition(request) {
    return this.request('open_position', { ...request });
  }

  async verifyLiveProvenance(intent, account) {
    return this.request('verify_live_provenance', { intent, account });
  }

  async validateProtection(intent) {
    return this.request('validate_protection', { intent });
  }

  async getPosition({ positionTicket }) {
    return this.request('get_position', { positionTicket });
  }

  async closePosition(request) {
    return this.request('close_position', { ...request });
  }

  async reconcileIntent({ intentId, action, account }) {
    return this.request('reconcile_intent', { intentId, action, account });
  }

  async ticks(request) {
    return this.request('ticks', validateTicksRequest(request));
  }

  async marketBook(ticker) {
    return this.request('market_book', validateQuoteRequest({ ticker }));
  }

  start(commandSpec) {
    if (this.child) return;
    const executable = commandSpec.command;
    this.pythonExecutable = [executable, ...commandSpec.args].join(' ');
    this.closing = false;
    let child;
    try {
      child = this.spawnImpl(executable, [...commandSpec.args, '-u', this.scriptPath], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      throw this.executableError(error, executable);
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (this.child === child) this.handleStdout(chunk);
    });
    child.stderr.on('data', chunk => {
      if (this.child !== child) return;
      this.errorOutput = `${this.errorOutput}${chunk}`.slice(-2000);
    });
    child.on('error', error => {
      if (this.child === child) this.handleChildFailure(this.executableError(error, executable));
    });
    child.on('exit', code => {
      // disconnect() intentionally kills the previous process. Its exit event can arrive
      // after a replacement bridge has already started, so only let the active child fail
      // requests or clear bridge state.
      if (this.child !== child) return;
      const detail = this.errorOutput.trim();
      const suffix = detail ? ` ${detail.slice(-1000)}` : '';
      this.handleChildFailure(new Error(`MetaTrader bridge exited (${code ?? 'unknown'}).${suffix}`));
    });
  }

  executableError(error, executable) {
    if (error?.code === 'ENOENT') {
      return new Error(`Python executable "${executable}" was not found. Install Python 3.10–3.14, or enter its full path. The MetaTrader5 Python package must also be installed for that interpreter.`);
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  handleStdout(chunk) {
    this.output += chunk;
    let newline;
    while ((newline = this.output.indexOf('\n')) >= 0) {
      const line = this.output.slice(0, newline).trim();
      this.output = this.output.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        this.handleChildFailure(new Error(`MetaTrader bridge returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`));
        return;
      }
      if (response.event === 'ticks' && typeof response.subscriptionId === 'string') {
        const stream = this.tickStreams.get(response.subscriptionId);
        if (stream && Array.isArray(response.ticks)) {
          stream(response.ticks);
        } else if (Array.isArray(response.ticks) && typeof response.ticker === 'string') {
          const pending = this.pendingTickStreams.get(response.ticker);
          if (pending) {
            for (const callback of pending) callback(response.ticks);
            this.pendingTickStreams.delete(response.ticker);
          }
        }
        continue;
      }
      const pending = this.pending.get(response.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      if (response.ok) pending.resolve(response.result);
      else {
        const error = new Error(typeof response.error === 'string' ? response.error : 'MetaTrader bridge request failed.');
        error.phase = response.phase === 'pre-send' ? 'pre-send' : 'send-unknown';
        pending.reject(error);
      }
    }
  }

  handleChildFailure(error) {
    const child = this.child;
    this.child = null;
    this.output = '';
    if (child && !this.closing) {
      try {
        child.kill();
      } catch (killError) {
        console.error('Could not stop the failed MetaTrader bridge process:', killError);
      }
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.tickStreams.clear();
    this.pendingTickStreams.clear();
  }

  request(action, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    if (!this.child || this.child.killed || !this.child.stdin.writable) {
      const error = new Error('MetaTrader is not connected. Open the MT5 Feed panel and connect first.');
      error.phase = 'pre-send';
      return Promise.reject(error);
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MetaTrader did not respond to "${action}" within ${Math.round(timeoutMs / 1000)} seconds.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, action, ...payload })}\n`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  async subscribeTicks(ticker, onTicks) {
    const { ticker: normalizedTicker } = validateQuoteRequest({ ticker });
    if (typeof onTicks !== 'function') throw new Error('MetaTrader tick subscriber must be a function.');
    let pendingCallbacks = this.pendingTickStreams.get(normalizedTicker);
    if (!pendingCallbacks) {
      pendingCallbacks = new Set();
      this.pendingTickStreams.set(normalizedTicker, pendingCallbacks);
    }
    pendingCallbacks.add(onTicks);
    let result;
    try {
      result = await this.request('stream_ticks', { ticker: normalizedTicker });
    } catch (error) {
      pendingCallbacks.delete(onTicks);
      if (pendingCallbacks.size === 0) this.pendingTickStreams.delete(normalizedTicker);
      throw error;
    }
    const subscriptionId = result?.subscriptionId;
    if (typeof subscriptionId !== 'string' || !subscriptionId) {
      pendingCallbacks.delete(onTicks);
      if (pendingCallbacks.size === 0) this.pendingTickStreams.delete(normalizedTicker);
      throw new Error('MetaTrader did not create a tick stream.');
    }
    pendingCallbacks.delete(onTicks);
    if (pendingCallbacks.size === 0) this.pendingTickStreams.delete(normalizedTicker);
    this.tickStreams.set(subscriptionId, onTicks);
    return () => {
      this.tickStreams.delete(subscriptionId);
      void this.request('stop_tick_stream', { subscriptionId }).catch(() => {});
    };
  }

  async disconnect() {
    if (this.disconnectPromise) return this.disconnectPromise;
    const child = this.child;
    if (!child) return true;
    this.closing = true;
    this.disconnectPromise = (async () => {
      try {
        await this.request('disconnect');
      } catch (error) {
        console.error('MetaTrader bridge did not shut down cleanly:', error);
      } finally {
        if (this.child === child) {
          this.child = null;
          child.kill();
        }
        this.pending.clear();
        this.output = '';
        this.errorOutput = '';
        this.closing = false;
        this.disconnectPromise = null;
      }
      return true;
    })();
    return this.disconnectPromise;
  }
}

module.exports = { Mt5Bridge, resolvePythonCommand, validateBarsRequest, validateQuoteRequest, validateTicksRequest };
