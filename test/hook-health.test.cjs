'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadTs = require('./load-ts.cjs');
const {
  HookHealthWatchdog,
  FIRST_HOOK_GRACE_MS,
  SILENT_HOOK_GRACE_MS
} = loadTs('src/main/hookHealth.ts');

const member = (props = {}) => ({
  id: 'kelly', ptyId: 'pty-kelly', expectsHooks: true, lastOutputAt: 1000, ...props
});

test('first hook is expected only after terminal output plus grace', () => {
  const health = new HookHealthWatchdog();
  assert.deepEqual(health.inspect([member({ lastOutputAt: 0 })], 1000), []);
  assert.deepEqual(health.inspect([member()], 1000), []);
  assert.deepEqual(health.inspect([member()], 1000 + FIRST_HOOK_GRACE_MS - 1), []);
  assert.deepEqual(health.inspect([member()], 1000 + FIRST_HOOK_GRACE_MS), [
    { agentId: 'kelly', state: 'missing' }
  ]);
  assert.deepEqual(health.inspect([member()], 1000 + FIRST_HOOK_GRACE_MS + 1), [], 'warn once');
  assert.equal(health.isOutOfSight('kelly'), true);
});

test('late hook restores monitoring and clears the unhealthy state', () => {
  const health = new HookHealthWatchdog();
  health.inspect([member()], 1000);
  health.inspect([member()], 1000 + FIRST_HOOK_GRACE_MS);
  assert.deepEqual(health.noteHook('kelly', 1000 + FIRST_HOOK_GRACE_MS + 10), {
    agentId: 'kelly', state: 'recovered'
  });
  assert.equal(health.isOutOfSight('kelly'), false);
  assert.equal(health.noteHook('kelly', 1000 + FIRST_HOOK_GRACE_MS + 11), null);
});

test('no warning for hookless custom providers', () => {
  const health = new HookHealthWatchdog();
  const a = member({ expectsHooks: false });
  assert.deepEqual(health.inspect([a], 1000), []);
  assert.deepEqual(health.inspect([a], 1000 + FIRST_HOOK_GRACE_MS * 4), []);
});

test('a working agent with stopped hooks warns after sustained silence', () => {
  const health = new HookHealthWatchdog();
  health.inspect([member()], 1000);
  health.noteHook('kelly', 1200);
  assert.deepEqual(health.inspect([member({ lastOutputAt: 1700 })], 1200 + SILENT_HOOK_GRACE_MS - 1), []);
  const at = 1200 + SILENT_HOOK_GRACE_MS;
  assert.deepEqual(health.inspect([member({ lastOutputAt: at - 1 })], at), [
    { agentId: 'kelly', state: 'missing' }
  ]);
});

test('no warning for an idle worker whose hooks stopped', () => {
  const health = new HookHealthWatchdog();
  health.inspect([member()], 1000);
  health.noteHook('kelly', 1200);
  assert.deepEqual(health.inspect([member({ lastOutputAt: 1700 })], 1200 + SILENT_HOOK_GRACE_MS + 10), []);
});

test('stop watching after PTY disappears and restart gets a fresh grace', () => {
  const health = new HookHealthWatchdog();
  health.inspect([member()], 1000);
  health.inspect([member()], 1000 + FIRST_HOOK_GRACE_MS);
  assert.equal(health.isOutOfSight('kelly'), true);
  health.inspect([], 1000 + FIRST_HOOK_GRACE_MS + 1);
  assert.equal(health.isOutOfSight('kelly'), false);
  assert.deepEqual(health.inspect([member({ ptyId: 'new-kelly' })], 90000), []);
});

test('SessionStart preceding first fleet census is not lost', () => {
  const health = new HookHealthWatchdog();
  health.noteHook('kelly', 1000);
  health.inspect([member({ lastOutputAt: 1200 })], 1200);
  assert.deepEqual(health.inspect([member({ lastOutputAt: 1200 })], 1200 + FIRST_HOOK_GRACE_MS), []);
});
