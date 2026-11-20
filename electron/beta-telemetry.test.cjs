'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  BetaTelemetry,
  MAX_CRASH_REPORT_BYTES,
  MAX_CRASH_REPORTS_PER_HOUR,
  MAX_PENDING_REPORTS,
  buildCrashReport,
  safeCrashText,
  validatedBaseUrl,
} = require('./beta-telemetry.cjs');

test('crash report redacts secrets, identity, account values, and user paths', () => {
  const report = buildCrashReport({
    appVersion: '4.0.0',
    platform: 'win32',
    reason: 'renderer-crash',
    error: {
      name: 'Error',
      message: 'Bearer abc.def api_key=SECRET account=12345678 trader@example.com',
    },
    stack: 'at C:\\Users\\Bubak\\Omega\\bundle.js:22',
    consoleEntries: [
      { type: 'error', source: 'renderer', message: 'Broken UI' },
      { type: 'error', source: 'pine-editor', message: 'script source should not leave the device' },
      { type: 'error', source: 'broker', message: 'account values should not leave the device' },
    ],
    uuid: () => 'report-id',
  });
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes('abc.def'), false);
  assert.equal(serialized.includes('SECRET'), false);
  assert.equal(serialized.includes('12345678'), false);
  assert.equal(serialized.includes('trader@example.com'), false);
  assert.equal(serialized.includes('Bubak'), false);
  assert.equal(serialized.includes('script source should not leave the device'), false);
  assert.equal(serialized.includes('account values should not leave the device'), false);
  assert.equal(report.debugConsole.length, 1);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= MAX_CRASH_REPORT_BYTES);
});

test('crash report bounds stack and console history', () => {
  const report = buildCrashReport({
    error: { message: 'failure', stack: 'x'.repeat(30_000) },
    consoleEntries: Array.from({ length: 60 }, (_entry, index) => ({
      type: 'error',
      source: 'renderer',
      timestamp: `2026-01-01T00:00:${index}Z`,
      message: `entry-${index}-${'y'.repeat(800)}`,
    })),
  });
  assert.ok(report.debugConsole.length <= 20);
  assert.ok(report.error.stack.length <= 5000);
  assert.ok(Buffer.byteLength(JSON.stringify(report), 'utf8') <= MAX_CRASH_REPORT_BYTES);
});

test('telemetry requires a valid HTTPS backend URL', () => {
  assert.equal(validatedBaseUrl('http://example.test'), null);
  assert.equal(validatedBaseUrl('https://user:pass@example.test'), null);
  assert.equal(validatedBaseUrl('https://localhost:8443'), null);
  assert.equal(validatedBaseUrl('https://telemetry.example.test/api').toString(), 'https://telemetry.example.test/api/');
});

test('consent-off sends no login event or crash report', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omega-beta-telemetry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const requests = [];
  const telemetry = new BetaTelemetry({
    baseUrl: 'https://telemetry.example.test/',
    queuePath: path.join(directory, 'pending.json'),
    getAccessToken: async () => 'access-token',
    getConsent: () => false,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return { ok: true };
    },
  });
  assert.deepEqual(await telemetry.reportCrash({ error: new Error('test') }), { status: 'disabled' });
  assert.equal(requests.length, 0);
  await assert.rejects(fs.access(path.join(directory, 'pending.json')), { code: 'ENOENT' });
});

test('crash reports are redacted before network delivery and upload failure queues bounded data', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omega-beta-telemetry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, 'pending.json');
  const requests = [];
  let networkAvailable = false;
  const telemetry = new BetaTelemetry({
    baseUrl: 'https://telemetry.example.test/',
    queuePath,
    getAccessToken: async () => 'access-token-never-in-body',
    getConsent: () => true,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (!networkAvailable) throw new Error('network offline');
      return { ok: true };
    },
  });
  assert.deepEqual(await telemetry.reportCrash({
    reason: 'renderer-crash',
    error: new Error('Bearer hidden-token user@example.com account=12345678'),
    consoleEntries: [{ type: 'error', source: 'renderer', message: 'access_token=hidden-token' }],
  }), { status: 'queued' });

  const queuedText = await fs.readFile(queuePath, 'utf8');
  assert.equal(queuedText.includes('hidden-token'), false);
  assert.equal(queuedText.includes('user@example.com'), false);
  assert.equal(queuedText.includes('12345678'), false);
  assert.equal(queuedText.includes('access-token-never-in-body'), false);
  assert.ok(Buffer.byteLength(queuedText, 'utf8') <= 120 * 1024);
  assert.ok(requests.every((request) => request.options.headers.authorization === 'Bearer access-token-never-in-body'));

  networkAvailable = true;
  assert.deepEqual(await telemetry.flushPending(), { status: 'sent' });
  await assert.rejects(fs.access(queuePath), { code: 'ENOENT' });
  const crashRequest = requests.find((request) => request.url.endsWith('/v1/crash-reports'));
  assert.ok(crashRequest);
  assert.equal(crashRequest.options.body.includes('access-token-never-in-body'), false);
});

test('crash-report queue retains failed deliveries and caps the number of records', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omega-beta-telemetry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, 'pending.json');
  const telemetry = new BetaTelemetry({
    baseUrl: 'https://telemetry.example.test/',
    queuePath,
    getAccessToken: async () => null,
    getConsent: () => true,
    uuid: (() => {
      let next = 0;
      return () => `report-${++next}`;
    })(),
  });
  for (let index = 0; index < MAX_PENDING_REPORTS + 3; index += 1) {
    assert.deepEqual(await telemetry.reportCrash({ error: new Error(`failure-${index}`) }), { status: 'queued' });
  }
  const queue = JSON.parse(await fs.readFile(queuePath, 'utf8'));
  assert.equal(queue.length, MAX_PENDING_REPORTS);
  assert.equal(queue[0].report.error.message, 'failure-3');
});

test('crash report uploads are rate limited even when a renderer repeats errors', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omega-beta-telemetry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const telemetry = new BetaTelemetry({
    baseUrl: 'https://telemetry.example.test/',
    queuePath: path.join(directory, 'pending.json'),
    getAccessToken: async () => null,
    getConsent: () => true,
    now: () => Date.UTC(2026, 0, 1),
  });
  for (let index = 0; index < MAX_CRASH_REPORTS_PER_HOUR; index += 1) {
    assert.equal((await telemetry.reportCrash({ error: new Error('renderer failure') })).status, 'queued');
  }
  assert.deepEqual(await telemetry.reportCrash({ error: new Error('repeat') }), { status: 'rate-limited' });
});

test('failed delivery stays queued and missing configuration never claims successful reporting', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omega-beta-telemetry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const telemetry = new BetaTelemetry({
    queuePath: path.join(directory, 'pending.json'),
    getAccessToken: async () => 'access-token',
    getConsent: () => true,
    fetchImpl: async () => ({ ok: false }),
  });
  assert.equal((await telemetry.reportCrash({ error: new Error('not delivered') })).status, 'not-configured');
});

test('tampered local crash queue is sanitized again before upload', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'omega-beta-telemetry-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const queuePath = path.join(directory, 'pending.json');
  await fs.writeFile(queuePath, JSON.stringify([{
    queuedAt: new Date().toISOString(),
    report: {
      reportId: 'existing-id',
      appVersion: '4.0.0',
      platform: 'win32',
      occurredAt: new Date().toISOString(),
      reason: 'renderer-crash',
      error: { name: 'Error', message: 'Bearer sensitive.token and user@example.com', stack: '' },
      debugConsole: [{ source: 'renderer', type: 'error', message: 'refresh_token=local-secret' }],
      rawCredentials: 'must be discarded',
    },
  }]), 'utf8');
  let uploaded;
  const telemetry = new BetaTelemetry({
    baseUrl: 'https://telemetry.example.test/',
    queuePath,
    getAccessToken: async () => 'header-token',
    getConsent: () => true,
    fetchImpl: async (_url, options) => {
      uploaded = options.body;
      return { ok: true };
    },
  });
  assert.deepEqual(await telemetry.flushPending(), { status: 'sent' });
  assert.equal(uploaded.includes('sensitive.token'), false);
  assert.equal(uploaded.includes('user@example.com'), false);
  assert.equal(uploaded.includes('local-secret'), false);
  assert.equal(uploaded.includes('must be discarded'), false);
});

test('redaction handles credentials assigned in structured console output', () => {
  assert.equal(safeCrashText('refresh_token=do-not-upload').includes('do-not-upload'), false);
  assert.equal(safeCrashText('https://example.test/callback?code=secret').includes('secret'), false);
  assert.equal(safeCrashText('secret=never-upload').includes('never-upload'), false);
});
