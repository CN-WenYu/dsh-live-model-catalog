/**
 * The discovery scope against the REAL pi-ai catalog, in its own process.
 *
 * The other suites run with pi-ai unlocatable, which is the right default — the
 * pure policy must not depend on it. But the bug this file pins was invisible to
 * exactly that setup: `dsh-llm-pi-ai` publishes every catalog provider to the
 * Models page whether or not settings mention it, and its discovery answers those
 * ids from the shipped snapshot, so the button was dead for every built-in
 * provider the owner had not adopted yet.
 *
 * `builtinEndpoints()` anchors on `process.argv[1]`, so this file points that at
 * the real CLI before anything calls `apply()`, and skips when it is not known.
 * It lives in its own file because the anchor is process-global.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';
import { builtinEndpoints } from '../lib/endpoints.js';
import { LISTING, config, fakeContext } from './harness.mjs';

const anchor = process.env.DSH_CLI_ENTRY;

/** One declared route and nothing else — the owner has not adopted any built-in. */
const declaredOnly = {
  providers: {
    'openrouter-mobcool': {
      api: 'openai-responses',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OR_KEY',
      models: [{ id: 'deepseek/deepseek-v4.1-flash' }],
    },
  },
};

/** Start one apply() against a stubbed endpoint and let the startup round settle. */
async function boot({ llmUser }) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(LISTING), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const harness = fakeContext({ llmUser, config: { ...config, fixDiscovery: true, startupDelaySeconds: 0 } });
  apply(harness.ctx);
  await new Promise((resolve) => setTimeout(resolve, 30));
  return {
    harness,
    calls,
    restore: () => {
      harness.state.effects.forEach((dispose) => dispose?.());
      globalThis.fetch = realFetch;
    },
  };
}

test('an undeclared built-in provider is answered from its endpoint, not the snapshot', async (t) => {
  if (anchor === undefined) return t.skip('DSH_CLI_ENTRY not set');
  process.argv[1] = anchor;
  const { detail, table } = await builtinEndpoints(anchor);
  if (table.size === 0) return t.skip(`pi-ai could not be located: ${detail}`);

  const booted = await boot({ llmUser: declaredOnly });
  try {
    const wrapper = booted.harness.discoveries.get('llm-pi-ai');
    const answer = await wrapper({ provider: 'deepseek' });
    assert.deepEqual(
      answer.map((model) => model.id),
      LISTING.data.map((model) => model.id),
      'the live listing, not the installed catalog',
    );
    assert.match(booted.calls.at(-1), /^https:\/\/api\.deepseek\.com\/models$/, 'using the endpoint pi-ai ships for it');
  } finally {
    booted.restore();
  }
});

test('an unlistable protocol still goes back to the official answer, without a probe', async (t) => {
  if (anchor === undefined) return t.skip('DSH_CLI_ENTRY not set');
  process.argv[1] = anchor;
  const { table } = await builtinEndpoints(anchor);
  if (table.size === 0) return t.skip('pi-ai could not be located');

  const booted = await boot({ llmUser: declaredOnly });
  try {
    const wrapper = booted.harness.discoveries.get('llm-pi-ai');
    const before = booted.calls.length;
    assert.deepEqual(await wrapper({ provider: 'google' }), [{ id: 'snapshot/only' }], 'the platform names the remedy itself');
    assert.equal(booted.calls.length, before, 'a protocol DSH cannot read has no URL to ask for');
  } finally {
    booted.restore();
  }
});

test('the report counts the declared routes plus every provider pi-ai ships', async (t) => {
  if (anchor === undefined) return t.skip('DSH_CLI_ENTRY not set');
  process.argv[1] = anchor;
  const { table } = await builtinEndpoints(anchor);
  if (table.size === 0) return t.skip('pi-ai could not be located');

  const booted = await boot({ llmUser: declaredOnly });
  try {
    const result = await booted.harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /内置端点：pi-ai providers: \d+ \(anchored\)/);
    const counted = Number(/发现按钮：installed（接管 (\d+) 条路由）/.exec(result.text)?.[1]);
    // `openrouter-mobcool` is declared; every catalog provider is in scope too,
    // and any built-in the owner happens to have declared would already be counted.
    assert.ok(counted >= table.size, `expected at least ${table.size} routes in scope, got ${counted}`);
  } finally {
    booted.restore();
  }
});
