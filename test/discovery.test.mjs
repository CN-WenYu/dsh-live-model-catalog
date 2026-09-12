import assert from 'node:assert/strict';
import test from 'node:test';

import { ensureDiscovery, probeDiscovery, removeDiscovery } from '../lib/discovery.js';

/** The official discovery the wrapper must be able to put back. */
const original = async () => [{ id: 'snapshot/only' }];

function harness(table = new Map([['llm-pi-ai', original]])) {
  const log = [];
  return {
    table,
    log,
    ctx: { get: (name) => (name === 'llm' ? { discoveries: table } : undefined) },
  };
}

const managed = (routes) => (provider) => routes.includes(provider);

test('installs a wrapper that answers live for managed routes and falls through for the rest', async () => {
  const h = harness();
  const state = ensureDiscovery({
    ctx: h.ctx,
    log: (message) => h.log.push(message),
    isManaged: managed(['openrouter']),
    live: async (provider) => [{ id: `${provider}/live` }],
  });
  assert.equal(state.status, 'installed');
  const wrapper = h.table.get('llm-pi-ai');
  assert.notEqual(wrapper, original);
  assert.deepEqual(await wrapper({ provider: 'openrouter' }), [{ id: 'openrouter/live' }]);
  assert.deepEqual(await wrapper({ provider: 'other' }), [{ id: 'snapshot/only' }]);
});

test('a failing live fetch falls back to the official answer instead of throwing', async () => {
  const h = harness();
  ensureDiscovery({
    ctx: h.ctx,
    log: (message) => h.log.push(message),
    isManaged: managed(['openrouter']),
    live: async () => {
      throw new Error('boom');
    },
  });
  const wrapper = h.table.get('llm-pi-ai');
  assert.deepEqual(await wrapper({ provider: 'openrouter' }), [{ id: 'snapshot/only' }]);
  assert.match(h.log.join('\n'), /boom/);
});

test('the managed predicate is consulted per call, so a widened scope needs no reinstall', async () => {
  const h = harness();
  const routes = ['openrouter'];
  ensureDiscovery({
    ctx: h.ctx,
    log: () => {},
    isManaged: managed(routes),
    live: async (provider) => [{ id: `${provider}/live` }],
  });
  const wrapper = h.table.get('llm-pi-ai');
  assert.deepEqual(await wrapper({ provider: 'added-later' }), [{ id: 'snapshot/only' }]);
  routes.push('added-later');
  assert.deepEqual(await wrapper({ provider: 'added-later' }), [{ id: 'added-later/live' }]);
});

test('re-asserting keeps the wrapper already in the table', () => {
  const h = harness();
  const options = { ctx: h.ctx, log: () => {}, isManaged: managed([]), live: async () => [] };
  ensureDiscovery(options);
  const first = h.table.get('llm-pi-ai');
  assert.equal(ensureDiscovery(options).status, 'installed');
  assert.equal(h.table.get('llm-pi-ai'), first);
});

test('removing puts exactly the wrapped original back', async () => {
  const h = harness();
  ensureDiscovery({ ctx: h.ctx, log: () => {}, isManaged: managed(['openrouter']), live: async () => [{ id: 'live' }] });
  assert.equal(removeDiscovery({ ctx: h.ctx }).status, 'removed');
  assert.equal(h.table.get('llm-pi-ai'), original);
});

test('removing when nothing was wrapped changes nothing', () => {
  const h = harness();
  const state = removeDiscovery({ ctx: h.ctx });
  assert.equal(state.status, 'absent');
  assert.equal(h.table.get('llm-pi-ai'), original);
});

test('removing a fresh registration after an llm-pi-ai reload is left alone', () => {
  const h = harness();
  ensureDiscovery({ ctx: h.ctx, log: () => {}, isManaged: managed([]), live: async () => [] });
  // llm-pi-ai reloads: its disposer deletes the key, then it registers afresh.
  const reloaded = async () => [{ id: 'reloaded' }];
  h.table.set('llm-pi-ai', reloaded);
  assert.equal(removeDiscovery({ ctx: h.ctx }).status, 'absent');
  assert.equal(h.table.get('llm-pi-ai'), reloaded);
});

test('a container without an llm service reports unsupported instead of throwing', () => {
  assert.equal(probeDiscovery({ get: () => undefined }).ok, false);
  assert.equal(probeDiscovery({ get: () => ({ discoveries: {} }) }).ok, false);
  assert.equal(removeDiscovery({ ctx: { get: () => undefined } }).status, 'unsupported');
});

test('a namespace with no discovery yet is pending, not installed', () => {
  const h = harness(new Map());
  const state = ensureDiscovery({ ctx: h.ctx, log: () => {}, isManaged: managed([]), live: async () => [] });
  assert.equal(state.status, 'pending');
  assert.equal(h.table.size, 0);
});
