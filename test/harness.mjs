/**
 * Shared fixtures for the host-half wiring tests.
 *
 * `apply()` is driven against a fake context and a stubbed network, so a whole
 * round — config → route scope → fetch → plan → settings.mutate → report →
 * command → discovery wrapper — runs without a DSH process and without a socket.
 * Kept apart from the suites so each one stays a readable list of scenarios.
 */
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

export const LISTING = {
  data: [
    {
      id: 'deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek: DeepSeek V4.1 Flash',
      context_length: 1048576,
      top_provider: { max_completion_tokens: 384000 },
      architecture: { input_modalities: ['text', 'image'] },
      reasoning: { supported_efforts: ['high', 'low'] },
      created: 1789021285,
    },
    { id: 'qwen/qwen9-future', name: 'Qwen: Qwen9 Future', context_length: 1000, created: 1900000000 },
    { id: 'deepseek/deepseek-chat', name: 'DeepSeek: Chat', created: 1700000000 },
  ],
};

export function setPath(target, path, value) {
  let node = target;
  for (const key of path.slice(0, -1)) {
    if (node[key] === undefined || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[path[path.length - 1]] = value;
}

/** A context with exactly the services the plugin reaches for, and nothing else. */
export function fakeContext({ llmUser, config, beforeWrite }) {
  // `beforeWrite(ops, index, state)` may throw to act out a refusal; it gets the
  // state so a test can model a concurrent edit without closing over a binding
  // that does not exist yet.
  const state = {
    user: structuredClone(llmUser),
    revision: 2,
    writes: [],
    log: [],
    effects: [],
    command: undefined,
    listeners: new Map(),
    watch: undefined,
    // The live plugin config, mutable so a test can act out a config edit.
    config,
  };

  const settings = {
    register: (_ns, schema) => ({
      get: () => schema(config),
      watch: (callback) => {
        state.watch = callback;
        return () => {};
      },
    }),
    get: (ns) => (ns === 'llm-pi-ai' ? state.user : undefined),
    describe: () => [{ ns: 'llm-pi-ai', user: state.user, value: state.user, revision: state.revision, applies: 'live' }],
    mutate: async (ns, ops, revision) => {
      state.writes.push({ ns, ops, revision });
      // DSH validates the whole namespace before persisting, so a throw here is
      // exactly how an untypeable model surfaces in production.
      beforeWrite?.(ops, state.writes.length - 1, state);
      for (const op of ops) if (op.op === 'set') setPath(state.user, op.path, op.value);
      state.revision += 1;
    },
  };

  const discoveries = new Map([['llm-pi-ai', async () => [{ id: 'snapshot/only' }]]]);

  const ctx = {
    settings,
    logger: { info: (message) => state.log.push(message), warn: (message) => state.log.push(message) },
    get: (name) => {
      if (name === 'settings') return settings;
      if (name === 'credentials') return { resolve: async () => ({ value: 'test-key' }) };
      if (name === 'llm') return { discoveries };
      return undefined;
    },
    effect: (execute) => {
      const disposer = execute();
      state.effects.push(disposer);
      return () => disposer?.();
    },
    on: (event, listener) => {
      state.listeners.set(event, listener);
      return () => {};
    },
    inject: (deps, callback) => {
      if (deps.includes('commands')) {
        callback({ commands: { register: (definition) => { state.command = definition; return () => {}; } } });
      }
      return () => {};
    },
  };

  return { ctx, state, discoveries };
}

export const config = {
  enabled: true,
  mode: 'auto',
  exclude: [],
  routes: {},
  include: ['deepseek/*', 'qwen/*'],
  addSince: '2026-01-01',
  fill: ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'],
  defaultEfforts: { off: 'none', high: 'high', max: 'max' },
  fixDiscovery: false,
  startupDelaySeconds: 0,
  intervalMinutes: 0,
  requestTimeoutSeconds: 5,
};

export const llmUser = {
  providers: {
    'openrouter-mobcool': {
      api: 'openai-responses',
      baseURL: 'https://openrouter.ai/api/v1',
      apiKeyEnv: 'OR_KEY',
      models: [{ id: 'deepseek/deepseek-v4.1-flash', name: '我起的名字', contextWindow: 1000000 }],
    },
  },
};

/** A route that declares no protocol of its own — the built-in `openrouter` shape. */
export const undeclaredRoute = {
  providers: {
    openrouter: {
      apiKeyEnv: 'OPENROUTER_API_KEY',
      baseURL: 'https://openrouter.ai/api/v1',
      models: [{ id: 'deepseek/deepseek-v4.1-flash', name: '我起的名字' }],
    },
  },
};

/** Run one apply() against a stubbed endpoint and let the startup round settle. */
export async function run(configOverrides = {}, listing = LISTING, hooks = {}) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    if (hooks.fetch !== undefined) return hooks.fetch(String(url), init, calls.length);
    assert.match(String(url), /\/models$/);
    return new Response(JSON.stringify(listing), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const harness = fakeContext({
    llmUser: hooks.llmUser ?? llmUser,
    config: { ...config, ...configOverrides },
    beforeWrite: hooks.beforeWrite,
  });
  try {
    apply(harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { ...harness, calls, restore: () => { globalThis.fetch = realFetch; } };
  } catch (error) {
    globalThis.fetch = realFetch;
    throw error;
  }
}
