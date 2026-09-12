import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveTargets, userRoute } from '../lib/routes.js';

const llmUser = {
  providers: {
    local: { api: 'openai-responses', baseURL: 'http://localhost:3000/v1', models: [{ id: 'a' }] },
    'openrouter-mobcool': { api: 'openai-responses', baseURL: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OR_KEY', models: [{ id: 'b' }] },
    openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', models: [{ id: 'c' }] },
    bare: { models: [{ id: 'd' }] },
  },
};

const builtin = new Map([
  ['openrouter', 'https://openrouter.ai/api/v1'],
  ['anthropic', 'https://api.anthropic.com'],
]);

const routesOf = (targets) => targets.map((target) => target.route);

test('auto mode manages every declared route', () => {
  const targets = resolveTargets({ config: { mode: 'auto' }, llmUser, builtin });
  assert.deepEqual(routesOf(targets), ['local', 'openrouter-mobcool', 'openrouter', 'bare']);
});

test('exclude removes a route in auto mode', () => {
  const targets = resolveTargets({ config: { mode: 'auto', exclude: ['local', 'bare*'] }, llmUser, builtin });
  assert.deepEqual(routesOf(targets), ['openrouter-mobcool', 'openrouter']);
});

test('listed mode manages only the configured names', () => {
  const targets = resolveTargets({ config: { mode: 'listed', routes: { openrouter: {} } }, llmUser, builtin });
  assert.deepEqual(routesOf(targets), ['openrouter']);
});

test('an endpoint falls back config → route → built-in catalog', () => {
  const targets = resolveTargets({ config: { mode: 'auto' }, llmUser, builtin });
  const byRoute = Object.fromEntries(targets.map((target) => [target.route, target]));
  assert.equal(byRoute.local.baseURL, 'http://localhost:3000/v1');
  assert.equal(byRoute.local.endpointSource, 'route');
  assert.equal(byRoute.openrouter.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(byRoute.openrouter.endpointSource, 'catalog');
  assert.equal(byRoute.bare.baseURL, undefined);
  assert.equal(byRoute.bare.endpointSource, undefined);
});

test('a configured baseURL wins over the catalog', () => {
  const targets = resolveTargets({
    config: { mode: 'auto', routes: { openrouter: { baseURL: 'https://proxy.example/v1' } } },
    llmUser,
    builtin,
  });
  const openrouter = targets.find((target) => target.route === 'openrouter');
  assert.equal(openrouter.baseURL, 'https://proxy.example/v1');
  assert.equal(openrouter.endpointSource, 'config');
});

test('protocol and credential default to the route entry', () => {
  const targets = resolveTargets({ config: { mode: 'auto' }, llmUser, builtin });
  const openrouter = targets.find((target) => target.route === 'openrouter');
  assert.equal(openrouter.api, 'openai-completions');
  assert.equal(openrouter.apiKeyEnv, 'OPENROUTER_API_KEY');
  assert.equal(openrouter.hasModelsList, true);
});

test('a route without a models list is still a target, flagged as unwritable', () => {
  const targets = resolveTargets({ config: { mode: 'auto' }, llmUser: { providers: { x: { baseURL: 'https://x.example' } } }, builtin });
  assert.equal(targets[0].hasModelsList, false);
});

test('a route can be disabled per route', () => {
  const targets = resolveTargets({ config: { mode: 'auto', routes: { local: { enabled: false } } }, llmUser, builtin });
  assert.equal(targets.find((target) => target.route === 'local').enabled, false);
});

test('userRoute ignores a non-object entry', () => {
  assert.equal(userRoute({ providers: { weird: 'nope' } }, 'weird'), undefined);
  assert.equal(userRoute(undefined, 'anything'), undefined);
});

test('a route reports the protocol its catalog twins agree on', () => {
  const catalog = new Map([
    ['deepseek', new Map([['a', 'openai-completions'], ['b', 'openai-completions']])],
    [
      'openrouter',
      new Map([
        ['c', 'openai-completions'],
        ['d', 'anthropic-messages'],
      ]),
    ],
  ]);
  const targets = resolveTargets({ config: { mode: 'auto' }, llmUser: { providers: { deepseek: {}, openrouter: {} } }, builtin, catalog });
  const byRoute = Object.fromEntries(targets.map((target) => [target.route, target]));
  assert.equal(byRoute.deepseek.catalogSharedApi, 'openai-completions');
  assert.equal(byRoute.deepseek.catalogApis.get('a'), 'openai-completions');
  assert.equal(byRoute.openrouter.catalogSharedApi, undefined, 'a catalog spanning two protocols decides nothing');
  assert.equal(byRoute.openrouter.catalogApis.get('d'), 'anthropic-messages');
});

test('declared and configured protocols stay distinguishable', () => {
  const targets = resolveTargets({
    config: { mode: 'auto', routes: { openrouter: { api: 'openai-completions' } } },
    llmUser: { providers: { openrouter: { api: 'anthropic-messages', models: [{ id: 'c' }] } } },
    builtin,
  });
  assert.equal(targets[0].declaredApi, 'anthropic-messages');
  assert.equal(targets[0].overrideApi, 'openai-completions');
  assert.equal(targets[0].api, 'openai-completions', 'the override wins for the listing, as before');
});

test('a route with neither protocol falls back to openai-completions for the listing only', () => {
  const targets = resolveTargets({ config: { mode: 'auto' }, llmUser: { providers: { bare: { models: [{ id: 'd' }] } } }, builtin });
  assert.equal(targets[0].api, 'openai-completions');
  assert.equal(targets[0].declaredApi, undefined, 'nothing is declared, so nothing may be assumed');
  assert.equal(targets[0].overrideApi, undefined);
});

test('the listing protocol comes from the shipped catalog when the route declares none', () => {
  const catalog = new Map([['anthropic', new Map([['claude-x', 'anthropic-messages']])]]);
  const targets = resolveTargets({
    config: { mode: 'auto' },
    llmUser: { providers: { anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' } } },
    builtin: new Map([['anthropic', 'https://api.anthropic.com']]),
    catalog,
  });
  assert.equal(targets[0].api, 'anthropic-messages', 'guessing openai-completions asks the wrong URL with the wrong header');
  assert.equal(targets[0].listable, true);
});

test('a catalog that spans protocols still falls back, and stays listable', () => {
  const catalog = new Map([
    [
      'openrouter',
      new Map([
        ['a', 'openai-completions'],
        ['b', 'anthropic-messages'],
      ]),
    ],
  ]);
  const targets = resolveTargets({ config: { mode: 'auto' }, llmUser: { providers: { openrouter: {} } }, builtin, catalog });
  assert.equal(targets[0].catalogSharedApi, undefined);
  assert.equal(targets[0].api, 'openai-completions');
  assert.equal(targets[0].listable, true);
});

test('a protocol with no readable listing is marked unlistable', () => {
  const targets = resolveTargets({
    config: { mode: 'auto' },
    llmUser: { providers: { google: { apiKeyEnv: 'GOOGLE_API_KEY' } } },
    builtin: new Map([['google', 'https://generativelanguage.googleapis.com/v1beta']]),
    catalog: new Map([['google', new Map([['gemini-x', 'google-generative-ai']])]]),
  });
  assert.equal(targets[0].api, 'google-generative-ai');
  assert.equal(targets[0].listable, false, 'DSH refuses this protocol up front; so must we');
});
