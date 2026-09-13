import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDiscoveryTargets, resolveTargets, userRoute } from '../lib/routes.js';

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

test('a route carries its declared efforts and listing path into the target', () => {
  const targets = resolveTargets({
    config: { mode: 'auto', routes: { sensenova: { efforts: { low: 'low' }, listingPath: '/llm/models' } } },
    llmUser: { providers: { sensenova: { baseURL: 'https://api.sensenova.cn/v1', models: [{ id: 'sensenova-6.7-flash-lite' }] } } },
  });
  assert.deepEqual(targets[0].efforts, { low: 'low' });
  assert.equal(targets[0].listingPath, '/llm/models');
});

test('and declares neither when the owner wrote neither', () => {
  const targets = resolveTargets({ config: { mode: 'auto' }, llmUser: { providers: { local: { models: [] } } } });
  assert.deepEqual(targets[0].efforts, {});
  assert.equal(targets[0].listingPath, undefined);
});

test('a built-in provider joins the discovery scope before it is ever declared', () => {
  const scope = resolveDiscoveryTargets({ config: { mode: 'auto' }, llmUser: { providers: {} }, builtin });
  assert.deepEqual(routesOf(scope), ['openrouter', 'anthropic']);
  assert.equal(scope[0].baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(scope[0].endpointSource, 'catalog');
  assert.equal(scope[0].api, 'openai-completions');
  assert.equal(scope[0].hasModelsList, false, 'there is no declared list, so this route is never written to');
});

test('but it never becomes a write target, so nothing is created behind the owner’s back', () => {
  assert.deepEqual(resolveTargets({ config: { mode: 'auto' }, llmUser: { providers: {} }, builtin }), []);
});

test('a declared route appears once in the discovery scope, with its declared facts', () => {
  const scope = resolveDiscoveryTargets({ config: { mode: 'auto' }, llmUser, builtin });
  assert.deepEqual(routesOf(scope), ['local', 'openrouter-mobcool', 'openrouter', 'bare', 'anthropic']);
  assert.equal(scope.find((target) => target.route === 'openrouter').baseURL, 'https://openrouter.ai/api/v1');
});

test('exclude and a per-route disable still narrow the discovery scope', () => {
  const excluded = resolveDiscoveryTargets({ config: { mode: 'auto', exclude: ['anthropic'] }, llmUser: { providers: {} }, builtin });
  assert.deepEqual(routesOf(excluded), ['openrouter']);
  const perRoute = resolveDiscoveryTargets({
    config: { mode: 'auto', routes: { anthropic: { enabled: false } } },
    llmUser: { providers: {} },
    builtin,
  });
  // `syncDiscovery` only adds enabled targets, so that is the list that matters.
  assert.deepEqual(
    perRoute.filter((target) => target.enabled).map((target) => target.route),
    ['openrouter'],
  );
});

test('listed mode keeps its promise and adds no catalog provider', () => {
  const scope = resolveDiscoveryTargets({ config: { mode: 'listed', routes: { anthropic: {} } }, llmUser: { providers: {} }, builtin });
  assert.deepEqual(routesOf(scope), ['anthropic'], 'only because the owner listed it, not because pi-ai ships it');
});

test('a disabled plugin owns no discovery scope at all', () => {
  assert.deepEqual(resolveDiscoveryTargets({ config: { mode: 'auto', enabled: false }, llmUser: { providers: {} }, builtin }), []);
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
