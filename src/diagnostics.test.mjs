import assert from 'node:assert/strict';
import test from 'node:test';
import { recentCaughtFailures, reportCaughtError, resetCaughtFailures } from './diagnostics.ts';

test('a failure is reported once and the identical repeat is throttled', () => {
  resetCaughtFailures();
  const first = reportCaughtError('test:source', new Error('boom'));
  const second = reportCaughtError('test:source', new Error('boom'));
  assert.equal(first, true, 'the first occurrence is reported');
  assert.equal(second, false, 'an identical failure inside the window is throttled');
});

test('different sources are reported independently', () => {
  resetCaughtFailures();
  assert.equal(reportCaughtError('test:a', new Error('same')), true);
  assert.equal(reportCaughtError('test:b', new Error('same')), true);
});

test('reporting never throws, whatever the error looks like', () => {
  resetCaughtFailures();
  assert.doesNotThrow(() => reportCaughtError('test:weird', undefined));
  assert.doesNotThrow(() => reportCaughtError('test:weird', null));
  assert.doesNotThrow(() => reportCaughtError('test:weird', { nope: true }));
  assert.doesNotThrow(() => reportCaughtError('test:weird', 'a string'));
  const circular = {};
  circular.self = circular;
  assert.doesNotThrow(() => reportCaughtError('test:circular', circular));
});

test('recent failures keep the source and the message for the diagnostics view', () => {
  resetCaughtFailures();
  reportCaughtError('test:visible', new Error('something broke'), 'while loading');
  const recent = recentCaughtFailures();
  assert.equal(recent.length, 1);
  assert.equal(recent[0].source, 'test:visible');
  assert.match(recent[0].message, /something broke/);
});

test('the throttle can be reset, so a fixed problem is reported again later', () => {
  resetCaughtFailures();
  assert.equal(reportCaughtError('test:reset', new Error('x')), true);
  assert.equal(reportCaughtError('test:reset', new Error('x')), false);
  resetCaughtFailures();
  assert.equal(reportCaughtError('test:reset', new Error('x')), true);
});
