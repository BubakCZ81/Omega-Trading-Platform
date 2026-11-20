import assert from 'node:assert/strict';
import test from 'node:test';
import { StartupModuleIndex } from './startupModuleIndex.ts';

const silent = () => undefined;

test('a healthy module is reported ready', async () => {
  const index = new StartupModuleIndex(silent);
  index.register({ id: 'ok', label: 'OK', isReady: () => true });
  assert.deepEqual(await index.verifyAndRecover(), { ok: 'ready' });
});

test('a module that never becomes ready is retried, then reported failed', async () => {
  const records = [];
  const index = new StartupModuleIndex(entry => records.push(entry), 2);
  let recoveries = 0;
  index.register({
    id: 'broken',
    label: 'Broken',
    isReady: () => false,
    recover: () => { recoveries += 1; },
  });

  const result = await index.verifyAndRecover();
  assert.equal(result.broken, 'failed');
  assert.equal(recoveries, 2, 'recovery is attempted exactly the configured number of times');
  assert.ok(records.some(entry => entry.status === 'error'), 'the failure is recorded, not swallowed');
});

test('a module that becomes ready on recovery is reported recovered', async () => {
  const index = new StartupModuleIndex(silent, 2);
  let ready = false;
  index.register({ id: 'flakey', label: 'Flakey', isReady: () => ready, recover: () => { ready = true; } });
  assert.deepEqual(await index.verifyAndRecover(), { flakey: 'recovered' });
});

test('a throwing isReady fails that module only, never the whole pass', async () => {
  const index = new StartupModuleIndex(silent, 1);
  index.register({ id: 'boom', label: 'Boom', isReady: () => { throw new Error('bad probe'); } });
  index.register({ id: 'fine', label: 'Fine', isReady: () => true });
  const result = await index.verifyAndRecover();
  assert.equal(result.boom, 'failed');
  assert.equal(result.fine, 'ready', 'one broken probe must not hide the others');
});

test('an optional module without a recovery path is disabled, not failed', async () => {
  const index = new StartupModuleIndex(silent, 1);
  index.register({ id: 'opt', label: 'Optional', optional: true, isReady: () => false });
  assert.deepEqual(await index.verifyAndRecover(), { opt: 'disabled' });
});

test('a module whose recovery throws does not escape the pass', async () => {
  const index = new StartupModuleIndex(silent, 2);
  index.register({
    id: 'angry',
    label: 'Angry',
    isReady: () => false,
    recover: () => { throw new Error('recovery exploded'); },
  });
  assert.deepEqual(await index.verifyAndRecover(), { angry: 'failed' });
});

test('deferred modules are indexed but not force-loaded, and audited as deferred', async () => {
  const index = new StartupModuleIndex(silent);
  let loads = 0;
  index.registerDeferred({ id: 'lazy', label: 'Lazy', load: async () => { loads += 1; return 'module'; } });

  index.register({ id: 'eager', label: 'Eager', isReady: () => true });
  await index.verifyAndRecover();

  assert.equal(loads, 0, 'verifying must not fetch a deferred chunk');
  const audit = index.audit();
  assert.deepEqual(audit.deferred, ['lazy']);
  assert.ok(audit.ready.includes('eager'));
  assert.ok(index.inventory().some(entry => entry.id === 'lazy'));
});

test('loadDeferred fetches once and reuses the result', async () => {
  const index = new StartupModuleIndex(silent);
  let loads = 0;
  index.registerDeferred({ id: 'lazy', label: 'Lazy', load: async () => { loads += 1; return { value: 42 }; } });

  const first = await index.loadDeferred('lazy');
  const second = await index.loadDeferred('lazy');
  assert.deepEqual(first, { value: 42 });
  assert.deepEqual(second, { value: 42 });
  assert.equal(loads, 1, 'a second caller shares the first load instead of refetching');
  assert.equal(index.isDeferredLoaded('lazy'), true);
  assert.deepEqual(index.audit().deferred, []);
});

test('loadDeferred retries a failing loader and then resolves null', async () => {
  const index = new StartupModuleIndex(silent);
  let attempts = 0;
  index.registerDeferred({
    id: 'unreachable',
    label: 'Unreachable',
    load: async () => { attempts += 1; throw new Error('chunk 404'); },
  });

  const result = await index.loadDeferred('unreachable');
  assert.equal(result, null, 'the caller gets a null to fall back on, not a thrown error');
  assert.equal(attempts, 2, 'a failed chunk fetch is retried once');
  assert.equal(index.isDeferredLoaded('unreachable'), false);
});

test('loadDeferred on an unknown id is a no-op', async () => {
  const index = new StartupModuleIndex(silent);
  assert.equal(await index.loadDeferred('does-not-exist'), null);
});
