'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_CRASH_REPORT_BYTES = 20 * 1024;
const MAX_PENDING_REPORTS = 10;
const MAX_PENDING_BYTES = 120 * 1024;
const MAX_CONSOLE_ENTRIES = 20;
const MAX_CRASH_REPORTS_PER_HOUR = 20;

function safeCrashText(value, maxLength = 1000) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(access[_ -]?token|refresh[_ -]?token|id[_ -]?token|api[_ -]?key|client[_ -]?secret|private[_ -]?key|credential|secret|password|authorization)\b(\s*[:=]\s*)["']?[^\s"',;]+["']?/gi, '$1$2[REDACTED]')
    .replace(/\b(account|login|ticket|account[_ -]?id)\b(\s*[:=]\s*)["']?[\w-]+["']?/gi, '$1$2[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, '[REDACTED_TOKEN]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_KEY]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]')
    .replace(/\b\d{6,}\b/g, '[NUMBER]')
    .replace(/([a-z]:\\Users\\)[^\\\s]+/gi, '$1[USER]')
    .replace(/(\/home\/)[^/\s]+/g, '$1[USER]')
    .replace(/(\/Users\/)[^/\s]+/g, '$1[USER]')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?[REDACTED]')
    .slice(0, maxLength);
}

function safeConsoleEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries
    .filter((entry) => entry && typeof entry === 'object')
    .filter((entry) => {
      const source = `${entry.source ?? ''} ${entry.category ?? ''}`.toLowerCase();
      return !/\b(pine|script|broker|mt5|alpaca|trading|orders?)\b/.test(source);
    })
    .filter((entry) => entry.status === 'error' || entry.type === 'error' || entry.type === 'process')
    .slice(-MAX_CONSOLE_ENTRIES)
    .map((entry) => ({
      timestamp: safeCrashText(String(entry.timestamp ?? entry.time ?? ''), 40),
      source: safeCrashText(String(entry.source ?? entry.category ?? 'app'), 120),
      type: safeCrashText(String(entry.type ?? 'error'), 40),
      message: safeCrashText(String(entry.message ?? entry.error ?? ''), 500),
    }));
}

function buildCrashReport({
  appVersion,
  platform,
  occurredAt = new Date().toISOString(),
  reason = 'application-error',
  error,
  stack,
  consoleEntries,
  uuid = crypto.randomUUID,
} = {}) {
  const report = {
    reportId: uuid(),
    appVersion: safeCrashText(String(appVersion ?? 'unknown'), 80),
    platform: safeCrashText(String(platform ?? 'unknown'), 40),
    occurredAt: safeCrashText(String(occurredAt), 40),
    reason: safeCrashText(String(reason), 80),
    error: {
      name: safeCrashText(String(error?.name ?? 'Error'), 120),
      message: safeCrashText(String(error?.message ?? error ?? 'Unknown application error'), 1000),
      stack: safeCrashText(String(stack ?? error?.stack ?? ''), 5000),
    },
    debugConsole: safeConsoleEntries(consoleEntries),
  };
  while (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_CRASH_REPORT_BYTES && report.debugConsole.length) {
    report.debugConsole.shift();
  }
  if (Buffer.byteLength(JSON.stringify(report), 'utf8') > MAX_CRASH_REPORT_BYTES) {
    report.error.stack = report.error.stack.slice(0, 1000);
    report.error.message = report.error.message.slice(0, 500);
  }
  return report;
}

function validatedBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return null;
    const hostname = url.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname.endsWith('.localhost')
      || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '::1') return null;
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
    return url;
  } catch {
    return null;
  }
}

class BetaTelemetry {
  constructor({
    baseUrl,
    queuePath,
    fetchImpl = globalThis.fetch,
    getAccessToken,
    getConsent,
    appVersion = 'unknown',
    platform = process.platform,
    now = Date.now,
    uuid = crypto.randomUUID,
  }) {
    this.baseUrl = validatedBaseUrl(baseUrl);
    this.queuePath = queuePath;
    this.fetchImpl = fetchImpl;
    this.getAccessToken = getAccessToken;
    this.getConsent = getConsent;
    this.appVersion = appVersion;
    this.platform = platform;
    this.now = now;
    this.uuid = uuid;
    this.queueChain = Promise.resolve();
    this.flushInFlight = null;
    this.recentCrashReportTimes = [];
  }

  configured() {
    return Boolean(this.baseUrl);
  }

  async post(route, payload, accessToken) {
    if (!this.configured() || typeof this.fetchImpl !== 'function') return false;
    const url = new URL(route, this.baseUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return response.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async readQueue() {
    try {
      const queue = JSON.parse(await fs.readFile(this.queuePath, 'utf8'));
      if (!Array.isArray(queue)) return [];
      return queue
        .filter((item) => item?.report && typeof item.report.reportId === 'string')
        .slice(-MAX_PENDING_REPORTS)
        .map((item) => {
          const stored = item.report;
          const reportId = safeCrashText(stored.reportId, 120) || this.uuid();
          return {
            queuedAt: safeCrashText(String(item.queuedAt ?? ''), 40),
            report: buildCrashReport({
              appVersion: stored.appVersion,
              platform: stored.platform,
              occurredAt: stored.occurredAt,
              reason: stored.reason,
              error: stored.error,
              stack: stored.error?.stack,
              consoleEntries: stored.debugConsole,
              uuid: () => reportId,
            }),
          };
        });
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw new Error('Pending crash reports could not be read.');
    }
  }

  async writeQueue(queue) {
    if (!this.queuePath) throw new Error('Pending crash report storage is not configured.');
    await fs.mkdir(path.dirname(this.queuePath), { recursive: true });
    let bounded = queue.slice(-MAX_PENDING_REPORTS);
    while (bounded.length && Buffer.byteLength(JSON.stringify(bounded), 'utf8') > MAX_PENDING_BYTES) {
      bounded.shift();
    }
    if (bounded.length === 0) {
      await fs.rm(this.queuePath, { force: true });
      return;
    }
    const temporaryPath = `${this.queuePath}.${this.uuid()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, JSON.stringify(bounded), { encoding: 'utf8', mode: 0o600 });
      await fs.rename(temporaryPath, this.queuePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  async enqueue(report) {
    const operation = this.queueChain.then(async () => {
      const queue = await this.readQueue();
      queue.push({ queuedAt: new Date(this.now()).toISOString(), report });
      await this.writeQueue(queue);
    });
    this.queueChain = operation.catch(() => undefined);
    await operation;
  }

  async clearPending() {
    const operation = this.queueChain.then(async () => {
      if (this.queuePath) await fs.rm(this.queuePath, { force: true });
    });
    this.queueChain = operation.catch(() => undefined);
    await operation;
  }

  async reportCrash(input) {
    if (!this.getConsent?.()) return { status: 'disabled' };
    if (!this.configured()) return { status: 'not-configured' };
    const now = this.now();
    this.recentCrashReportTimes = this.recentCrashReportTimes.filter((timestamp) => now - timestamp < 60 * 60_000);
    if (this.recentCrashReportTimes.length >= MAX_CRASH_REPORTS_PER_HOUR) return { status: 'rate-limited' };
    this.recentCrashReportTimes.push(now);
    const report = buildCrashReport({
      ...input,
      appVersion: input?.appVersion ?? this.appVersion,
      platform: input?.platform ?? this.platform,
      uuid: this.uuid,
    });
    try {
      const accessToken = await this.getAccessToken?.();
      if (accessToken && await this.post('v1/crash-reports', report, accessToken)) {
        return { status: 'sent' };
      }
      await this.enqueue(report);
      return { status: 'queued' };
    } catch {
      return { status: 'failed' };
    }
  }

  async flushPending() {
    if (this.flushInFlight) return this.flushInFlight;
    this.flushInFlight = (async () => {
      if (!this.getConsent?.() || !this.configured()) return { status: 'skipped' };
      try {
        const accessToken = await this.getAccessToken?.();
        if (!accessToken) return { status: 'skipped' };
        await this.queueChain;
        const queue = await this.readQueue();
        let sent = 0;
        for (; sent < queue.length; sent += 1) {
          if (!await this.post('v1/crash-reports', queue[sent].report, accessToken)) break;
        }
        if (sent > 0) await this.writeQueue(queue.slice(sent));
        return { status: sent === queue.length ? 'sent' : 'pending' };
      } catch {
        return { status: 'failed' };
      }
    })().finally(() => {
      this.flushInFlight = null;
    });
    return this.flushInFlight;
  }
}

module.exports = {
  BetaTelemetry,
  MAX_CRASH_REPORT_BYTES,
  MAX_CRASH_REPORTS_PER_HOUR,
  MAX_PENDING_REPORTS,
  buildCrashReport,
  safeConsoleEntries,
  safeCrashText,
  validatedBaseUrl,
};
