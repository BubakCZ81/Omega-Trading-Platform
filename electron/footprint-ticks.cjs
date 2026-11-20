'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BARS_PER_REQUEST = 300;
const TICKS_PER_PAGE = 10_000;
const MAX_PAGES_PER_RANGE = 20;
const MAX_TICK_BARS_PER_REQUEST = 1_000;
const MAX_TICKS_PER_TICK_BAR_REQUEST = 50_000;

function normalizeSymbol(symbol) {
  return symbol.replace(/^(?:CTRADER|MT5):/i, '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid footprint tick request.');
  const ticker = typeof request.ticker === 'string' ? request.ticker.trim() : '';
  const profileType = request.profileType === 'tap' ? 'tap' : 'footprint';
  const pipSize = Number(request.pipSize);
  const bars = request.bars;
  if (!ticker || ticker.length > 100) throw new Error('Enter a valid footprint symbol.');
  if (profileType === 'footprint' && (!Number.isFinite(pipSize) || pipSize <= 0)) throw new Error('Enter a valid footprint pip size.');
  if (!Array.isArray(bars) || bars.length > MAX_BARS_PER_REQUEST) throw new Error('Footprint request must contain at most 300 candles.');
  const cleanBars = bars.map(bar => {
    if (!bar || !Number.isFinite(Number(bar.time)) || !Number.isFinite(Number(bar.open))
      || !Number.isFinite(Number(bar.high)) || !Number.isFinite(Number(bar.low)) || !Number.isFinite(Number(bar.close))) {
      throw new Error('Footprint request contains an invalid candle.');
    }
    return {
      time: Number(bar.time), open: Number(bar.open), high: Number(bar.high),
      low: Number(bar.low), close: Number(bar.close),
    };
  });
  for (let index = 1; index < cleanBars.length; index += 1) {
    if (cleanBars[index].time <= cleanBars[index - 1].time) throw new Error('Footprint candles must be ordered by time.');
  }
  const nextBarTime = request.nextBarTime === undefined ? undefined : Number(request.nextBarTime);
  if (nextBarTime !== undefined && (!Number.isFinite(nextBarTime) || nextBarTime <= cleanBars.at(-1)?.time)) {
    throw new Error('Footprint request contains an invalid next candle time.');
  }
  return { ticker, pipSize, bars: cleanBars, nextBarTime, profileType };
}

function tradePrice(tick) {
  if (Number(tick.last) > 0) return Number(tick.last);
  if (Number(tick.bid) > 0 && Number(tick.ask) >= Number(tick.bid)) return (Number(tick.bid) + Number(tick.ask)) / 2;
  return Number(tick.bid || tick.ask);
}

// Tick bars are based on observations, not elapsed time. Keep the exact source
// order: repeated prices and equal-millisecond timestamps are still ticks.
function tickBarPrice(tick) {
  if (Number(tick.last) > 0) return Number(tick.last);
  if (Number(tick.bid) > 0) return Number(tick.bid);
  return Number(tick.ask);
}

function buildTickBars(ticks, ticksPerBar) {
  const bars = [];
  let current = null;
  for (const tick of ticks) {
    const time = Number(tick?.time);
    const price = tickBarPrice(tick ?? {});
    if (!Number.isFinite(time) || time < 0 || !Number.isFinite(price) || price <= 0) continue;
    if (!current) {
      const previousTime = Number(bars.at(-1)?.time) || -1;
      current = {
        // Vela requires strictly increasing x values. Preserve first-tick time
        // except where two consecutive bars begin in the same millisecond.
        time: Math.max(time, previousTime + 1),
        open: price, high: price, low: price, close: price,
        volume: Number(tick.volumeReal) > 0 ? Number(tick.volumeReal) : 0,
        tickCount: 0,
      };
    } else {
      current.high = Math.max(current.high, price);
      current.low = Math.min(current.low, price);
      current.close = price;
      if (Number(tick.volumeReal) > 0) current.volume += Number(tick.volumeReal);
    }
    current.tickCount += 1;
    if (current.tickCount === ticksPerBar) {
      const { tickCount, ...bar } = current;
      bars.push(bar);
      current = null;
    }
  }
  // The final bar is the sole live-forming bar; every earlier bar has exactly
  // ticksPerBar ticks.
  if (current) {
    const { tickCount, ...bar } = current;
    bars.push(bar);
  }
  return bars;
}

function validateTickBarsRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) throw new Error('Invalid tick-bar request.');
  const ticker = typeof request.ticker === 'string' ? request.ticker.trim() : '';
  const ticksPerBar = Number(request.ticksPerBar);
  const limit = Number(request.limit ?? 1_000);
  const from = request.from === undefined ? undefined : Number(request.from);
  const to = request.to === undefined ? Date.now() : Number(request.to);
  if (!ticker || ticker.length > 100) throw new Error('Enter a valid tick-bar symbol.');
  if (!Number.isSafeInteger(ticksPerBar) || ticksPerBar < 1 || ticksPerBar > 10_000) throw new Error('Tick bars must contain 1 to 10,000 ticks.');
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Enter a positive tick-bar limit.');
  if (from !== undefined && (!Number.isFinite(from) || from < 0)) throw new Error('Enter a valid tick-bar start time.');
  if (!Number.isFinite(to) || to < 0 || (from !== undefined && from > to)) throw new Error('Enter a valid tick-bar end time.');
  return { ticker, ticksPerBar, limit: Math.min(limit, MAX_TICK_BARS_PER_REQUEST), from, to };
}

async function fetchTickBarTicks(fetchTicks, ticker, from, to, target) {
  const ticks = [];
  let cursor = from;
  for (let page = 0; page < MAX_PAGES_PER_RANGE && ticks.length < target && cursor <= to; page += 1) {
    const requested = Math.min(TICKS_PER_PAGE, target - ticks.length);
    const batch = await fetchTicks({ ticker, fromMsc: cursor, limit: requested });
    ticks.push(...batch.filter(tick => Number(tick?.time) >= cursor && Number(tick?.time) <= to));
    const lastTime = Number(batch.at(-1)?.time);
    if (batch.length < requested || !Number.isFinite(lastTime) || lastTime < cursor || lastTime >= to) break;
    cursor = lastTime + 1;
  }
  return ticks;
}

async function fetchLatestTickBarTicks(fetchTicks, ticker, from, to, target) {
  const sample = await fetchTickBarTicks(fetchTicks, ticker, from, to, target);
  if (sample.length < target || sample.at(-1).time >= to || from >= to) return sample;

  // MT5 pages forward. A full page can end well before the requested right edge.
  // Search the newer half first and only backfill the remaining count from the left.
  const middle = Math.floor((from + to) / 2);
  const newer = await fetchLatestTickBarTicks(fetchTicks, ticker, middle + 1, to, target);
  const missing = target - newer.length;
  if (!missing) return newer;
  const older = sample.at(-1).time > middle
    ? sample.filter(tick => tick.time <= middle).slice(-missing)
    : await fetchLatestTickBarTicks(fetchTicks, ticker, from, middle, missing);
  return older.concat(newer);
}

async function loadTickBars(fetchTicks, request) {
  const { ticker, ticksPerBar, limit, from, to } = validateTickBarsRequest(request);
  // Request one extra bar so a leading partial sequence cannot displace a
  // requested completed bar from the latest viewport.
  const targetTicks = Math.min(MAX_TICKS_PER_TICK_BAR_REQUEST, (limit + 1) * ticksPerBar);
  let ticks = [];
  if (from !== undefined) {
    ticks = await fetchLatestTickBarTicks(fetchTicks, ticker, Math.ceil(from), Math.floor(to), targetTicks);
  } else {
    // MT5 has forward-only tick paging. Expand backward from now until enough
    // observations are available, then aggregate the latest sequence. This
    // happens exclusively in the worker, never on the chart renderer thread.
    let windowMs = 5 * 60_000;
    const maximumWindowMs = 30 * 24 * 60 * 60_000;
    let end = Math.floor(to);
    for (let attempt = 0; attempt < 14; attempt += 1) {
      const start = Math.max(0, Math.ceil(to - windowMs));
      const sample = await fetchLatestTickBarTicks(fetchTicks, ticker, start, end, targetTicks - ticks.length);
      ticks = sample.concat(ticks);
      if (ticks.length >= targetTicks || windowMs >= maximumWindowMs || start === 0) break;
      end = start - 1;
      windowMs = Math.min(maximumWindowMs, windowMs * 4);
    }
  }
  const bars = buildTickBars(ticks, ticksPerBar);
  return bars.length > limit ? bars.slice(-limit) : bars;
}

function buildProfile(bar, ticks, pipSize) {
  const levels = new Map();
  let previousPrice = bar.open;
  let previousDirection = 0;
  for (const tick of ticks) {
    const price = Number(tradePrice(tick).toPrecision(12));
    if (!Number.isFinite(price) || price <= 0) continue;
    const priorPrice = previousPrice;
    const direction = priorPrice === 0 ? 0 : price > priorPrice ? 1 : price < priorPrice ? -1 : previousDirection;
    if (direction !== 0) {
      const row = levels.get(price) ?? { price, downPips: 0, upPips: 0 };
      if (direction > 0) row.upPips += Math.abs(price - priorPrice) / pipSize;
      else row.downPips += Math.abs(price - priorPrice) / pipSize;
      levels.set(price, row);
    }
    previousPrice = price;
    if (priorPrice === 0 || price !== priorPrice) previousDirection = direction;
  }
  return {
    time: bar.time,
    high: bar.high,
    low: bar.low,
    levels: [...levels.values()],
    lastPrice: previousPrice,
    lastTickTime: Number(ticks.at(-1)?.time) || 0,
  };
}

// TAP (Time At Price) assigns the interval until the next observed tick to
// the currently known price.  Unlike a conventional TPO this is real elapsed
// time, in milliseconds, not a count inferred from the candle's OHLC shape.
function buildTapProfile(bar, ticks, endTime) {
  const levels = new Map();
  const addDuration = (price, durationMs) => {
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return;
    const key = Number(price.toPrecision(12));
    levels.set(key, (levels.get(key) || 0) + durationMs);
  };
  let price = Number(bar.open);
  let cursor = Number(bar.time);
  let lastTickTime = 0;
  for (const tick of ticks) {
    const tickTime = Math.max(cursor, Math.min(endTime, Number(tick.time)));
    addDuration(price, tickTime - cursor);
    const nextPrice = Number(tradePrice(tick).toPrecision(12));
    if (Number.isFinite(nextPrice) && nextPrice > 0) price = nextPrice;
    cursor = tickTime;
    lastTickTime = Math.max(lastTickTime, Number(tick.time) || 0);
  }
  addDuration(price, endTime - cursor);
  return {
    time: bar.time, high: bar.high, low: bar.low,
    levels: [...levels].map(([price, durationMs]) => ({ price, durationMs })),
    lastPrice: price, lastTickTime,
  };
}

// Never transfer an unbounded tick-price map into Chromium. The chart paints
// price rows, not individual ticks, so a compact row representation preserves
// the visual information while making IPC and renderer work strictly bounded.
function compactProfileForRenderer(profile, profileType, maxRows = 64) {
  const range = Math.max(Number.EPSILON, Number(profile.high) - Number(profile.low));
  const rows = new Map();
  for (const level of profile.levels) {
    const index = Math.max(0, Math.min(maxRows - 1, Math.floor((Number(level.price) - profile.low) / range * maxRows)));
    const row = rows.get(index) || {
      price: profile.low + (index + 0.5) * range / maxRows,
      downPips: 0, upPips: 0, durationMs: 0,
    };
    if (profileType === 'tap') row.durationMs += Math.max(0, Number(level.durationMs) || 0);
    else {
      row.downPips += Math.max(0, Number(level.downPips) || 0);
      row.upPips += Math.max(0, Number(level.upPips) || 0);
    }
    rows.set(index, row);
  }
  const levels = [...rows.values()].map(row => profileType === 'tap'
    ? { price: row.price, durationMs: row.durationMs }
    : { price: row.price, downPips: row.downPips, upPips: row.upPips });
  return { ...profile, levels };
}

function mergeTicks(...groups) {
  const ticks = new Map();
  for (const group of groups) {
    for (const tick of group) ticks.set(`${tick.time}:${tick.bid}:${tick.ask}:${tick.last}:${tick.flags ?? 0}`, tick);
  }
  return [...ticks.values()].sort((left, right) => left.time - right.time);
}

class FootprintTickService {
  constructor({ directory, fetchTicks }) {
    if (typeof directory !== 'string' || typeof fetchTicks !== 'function') throw new Error('Footprint tick storage and provider are required.');
    this.directory = directory;
    this.fetchTicks = fetchTicks;
    this.inFlight = new Map();
    this.profiles = new Map();
  }

  cacheFile(symbol, barTime) {
    const key = createHash('sha256').update(normalizeSymbol(symbol)).digest('hex');
    return path.join(this.directory, key, `${barTime}.json`);
  }

  async readCached(symbol, bar, from, to, pipSize) {
    try {
      const entry = JSON.parse(await fs.readFile(this.cacheFile(symbol, bar.time), 'utf8'));
      if (entry.symbol === normalizeSymbol(symbol) && entry.from === from && entry.to === to
        && entry.pipSize === pipSize && entry.complete && Array.isArray(entry.ticks)) return entry.ticks;
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    return null;
  }

  async save(symbol, bar, from, to, pipSize, ticks, complete) {
    const file = this.cacheFile(symbol, bar.time);
    let prior = [];
    try {
      const entry = JSON.parse(await fs.readFile(file, 'utf8'));
      if (entry.symbol === normalizeSymbol(symbol) && entry.from === from) prior = entry.ticks ?? [];
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    const body = JSON.stringify({ symbol: normalizeSymbol(symbol), from, to, pipSize, complete, ticks: mergeTicks(prior, ticks) });
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, body, 'utf8');
    await fs.rename(temporary, file);
  }

  async fetchRange(symbol, from, to) {
    const key = `${normalizeSymbol(symbol)}:${from}:${to}`;
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const loading = (async () => {
      let cursor = from;
      const ticks = [];
      let complete = false;
      for (let page = 0; page < MAX_PAGES_PER_RANGE && cursor <= to; page += 1) {
        const batch = await this.fetchTicks({ ticker: symbol, fromMsc: cursor, limit: TICKS_PER_PAGE });
        ticks.push(...batch.filter(tick => Number(tick.time) >= cursor && Number(tick.time) <= to));
        const lastTime = Number(batch.at(-1)?.time);
        if (batch.length < TICKS_PER_PAGE || !Number.isFinite(lastTime) || lastTime < cursor || lastTime >= to) {
          complete = true;
          break;
        }
        cursor = lastTime + 1;
      }
      ticks.sort((left, right) => left.time - right.time);
      return { ticks, complete };
    })().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, loading);
    return loading;
  }

  async getProfiles(request) {
    const { ticker, pipSize, bars, nextBarTime, profileType } = validateRequest(request);
    const ranges = bars.map((bar, index) => ({
      from: bar.time,
      to: Number.isFinite(bars[index + 1]?.time ?? nextBarTime)
        ? (bars[index + 1]?.time ?? nextBarTime) - 1
        : Date.now() + 2_000,
    }));
    const cached = await Promise.all(bars.map((bar, index) =>
      this.readCached(ticker, bar, ranges[index].from, ranges[index].to, pipSize)));
    const profiles = new Array(bars.length);
    for (let index = 0; index < bars.length; index += 1) {
      if (cached[index]) profiles[index] = profileType === 'tap'
        ? buildTapProfile(bars[index], cached[index], Math.min(Date.now(), ranges[index].to + 1))
        : buildProfile(bars[index], cached[index], pipSize);
    }
    let index = 0;
    while (index < bars.length) {
      if (cached[index]) {
        index += 1;
        continue;
      }
      const first = index;
      while (index + 1 < bars.length && !cached[index + 1]) index += 1;
      const last = index;
      const from = ranges[first].from;
      const to = ranges[last].to;
      const { ticks, complete } = await this.fetchRange(ticker, from, to);
      for (let barIndex = first; barIndex <= last; barIndex += 1) {
        const barTicks = ticks.filter(tick => tick.time >= ranges[barIndex].from && tick.time <= ranges[barIndex].to);
        await this.save(ticker, bars[barIndex], ranges[barIndex].from, ranges[barIndex].to, pipSize, barTicks, complete);
        profiles[barIndex] = profileType === 'tap'
          ? buildTapProfile(bars[barIndex], barTicks, Math.min(Date.now(), ranges[barIndex].to + 1))
          : buildProfile(bars[barIndex], barTicks, pipSize);
      }
      index = last + 1;
    }
    for (const profile of profiles) this.profiles.set(`${profileType}:${normalizeSymbol(ticker)}:${profile.time}`, profile);
    while (this.profiles.size > 2_000) this.profiles.delete(this.profiles.keys().next().value);
    return profiles.map(profile => compactProfileForRenderer(profile, profileType));
  }

  async updateLiveProfile(request) {
    const { ticker, pipSize, bars } = validateRequest({
      ticker: request?.ticker,
      pipSize: request?.pipSize,
      bars: request?.bar ? [request.bar] : [],
    });
    const bar = bars[0];
    const inputTicks = Array.isArray(request?.ticks) ? request.ticks : [];
    if (inputTicks.length > 20_000) throw new Error('Footprint live batch is too large.');
    const ticks = inputTicks.filter(tick => tick && Number.isFinite(Number(tick.time))
      && Number.isFinite(Number(tick.bid)) && Number.isFinite(Number(tick.ask))
      && Number.isFinite(Number(tick.last))).map(tick => ({
      time: Number(tick.time), bid: Number(tick.bid), ask: Number(tick.ask), last: Number(tick.last),
      volume: Number(tick.volume) || 0, volumeReal: Number(tick.volumeReal) || 0, flags: Number(tick.flags) || 0,
    }));
    const key = `footprint:${normalizeSymbol(ticker)}:${bar.time}`;
    let profile = this.profiles.get(key);
    if (!profile) [profile] = await this.getProfiles({ ticker, pipSize, bars: [bar] });
    const levels = new Map(profile.levels.map(level => [level.price, { ...level }]));
    let previousPrice = profile.lastPrice ?? bar.open;
    let previousDirection = 0;
    const fresh = ticks.filter(tick => tick.time > (profile.lastTickTime ?? 0)).sort((left, right) => left.time - right.time);
    for (const tick of fresh) {
      const rawPrice = tradePrice(tick);
      const price = Number(rawPrice.toPrecision(12));
      if (!Number.isFinite(price) || price <= 0) continue;
      const priorPrice = previousPrice;
      const direction = price > priorPrice ? 1 : price < priorPrice ? -1 : previousDirection;
      if (direction !== 0) {
        const level = levels.get(price) ?? { price, downPips: 0, upPips: 0 };
        if (direction > 0) level.upPips += Math.abs(price - priorPrice) / pipSize;
        else level.downPips += Math.abs(price - priorPrice) / pipSize;
        levels.set(price, level);
      }
      previousPrice = price;
      if (price !== priorPrice) previousDirection = direction;
    }
    profile = {
      ...profile,
      high: bar.high,
      low: bar.low,
      levels: [...levels.values()],
      lastPrice: previousPrice,
      lastTickTime: Math.max(profile.lastTickTime ?? 0, fresh.at(-1)?.time ?? 0),
    };
    this.profiles.set(key, profile);
    if (fresh.length) await this.appendLiveTicks(ticker, bar.time, fresh);
    return compactProfileForRenderer(profile, 'footprint');
  }

  async appendLiveTicks(symbol, barTime, ticks) {
    const file = path.join(this.directory, createHash('sha256').update(normalizeSymbol(symbol)).digest('hex'), `live-${barTime}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.appendFile(file, `${ticks.map(tick => JSON.stringify(tick)).join('\n')}\n`, 'utf8');
  }
}

module.exports = { FootprintTickService, buildProfile, loadTickBars, validateRequest };
