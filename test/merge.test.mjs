import assert from 'node:assert/strict';
import test from 'node:test';

import { globMatch, planRoute, resolveAddSince, toSeconds } from '../lib/merge.js';

const live = [
  { id: 'deepseek/deepseek-v4.1-flash', raw: { context_length: 1048576, top_provider: { max_completion_tokens: 384000 }, reasoning: { supported_efforts: ['high'] } } },
  { id: 'qwen/qwen3.9-flash', raw: { context_length: 1000000, architecture: { input_modalities: ['text', 'image'] } } },
  { id: 'meta/llama-9', raw: { context_length: 128000 } },
];

test('glob matching spans a vendor and a suffix', () => {
  assert.equal(globMatch('deepseek/deepseek-v4.1-flash', 'deepseek/*'), true);
  assert.equal(globMatch('qwen/qwen3.8-flash', 'qwen/qwen3.*-flash'), true);
  assert.equal(globMatch('meta/llama-9', 'qwen/*'), false);
  assert.equal(globMatch('anything', ''), false);
});

test('fills only the gaps on an existing entry', () => {
  const current = [{ id: 'deepseek/deepseek-v4.1-flash', name: '我起的名字', contextWindow: 200000, reasoningEfforts: { off: null, high: 'high' } }];
  const plan = planRoute({ current, live, include: [], fallbackEfforts: { off: 'none' } });
  const entry = plan.next[0];
  assert.equal(entry.name, '我起的名字', 'a user-set name survives');
  assert.equal(entry.contextWindow, 200000, 'a user-set context window survives');
  assert.deepEqual(entry.reasoningEfforts, { off: null, high: 'high' }, 'a user-set effort dict survives');
  assert.equal(entry.maxTokens, 384000, 'the missing maxTokens is filled');
  assert.deepEqual(plan.filled, [{ id: 'deepseek/deepseek-v4.1-flash', fields: ['maxTokens'], notes: [] }]);
});

test('adds allowlisted ids and reports the rest as skipped', () => {
  const plan = planRoute({ current: [{ id: 'deepseek/deepseek-v4.1-flash' }], live, include: ['qwen/*'] });
  assert.deepEqual(plan.added, ['qwen/qwen3.9-flash']);
  assert.deepEqual(plan.skipped, ['meta/llama-9']);
  assert.deepEqual(
    plan.next.map((entry) => entry.id),
    ['deepseek/deepseek-v4.1-flash', 'qwen/qwen3.9-flash'],
  );
});

test('reports no change when nothing moved', () => {
  const current = [{ id: 'deepseek/deepseek-v4.1-flash', contextWindow: 1048576, maxTokens: 384000, reasoningEfforts: { high: 'high' } }];
  const plan = planRoute({ current, live: [live[0]], include: [], fallbackEfforts: { off: 'none' } });
  assert.equal(plan.changed, false);
});

test('reports a configured id the endpoint no longer lists', () => {
  const plan = planRoute({ current: [{ id: 'gone/model' }], live, include: [] });
  assert.deepEqual(plan.notAdvertised, ['gone/model']);
  assert.equal(plan.changed, false);
});

test('reports an unknown fill field instead of silently ignoring it', () => {
  const plan = planRoute({ current: [], live: [], include: [], fill: ['maxTokens', 'pricing'] });
  assert.deepEqual(plan.ignoredFill, ['pricing']);
});

test('passes a malformed configured entry through untouched', () => {
  const plan = planRoute({ current: [{ name: 'no id here' }], live, include: [] });
  assert.equal(plan.next.length, 1);
  assert.equal(plan.malformed.length, 1);
  assert.equal(plan.changed, false);
});

test('addSince keeps a vendor glob from dragging in the back catalogue', () => {
  const dated = [
    { id: 'deepseek/deepseek-v4.1-flash', raw: { created: 1789021285 } },
    { id: 'deepseek/deepseek-chat', raw: { created: 1700000000 } },
    { id: 'deepseek/no-timestamp', raw: {} },
  ];
  const plan = planRoute({ current: [], live: dated, include: ['deepseek/*'], addSince: '2026-09-01' });
  assert.deepEqual(plan.added, ['deepseek/deepseek-v4.1-flash', 'deepseek/no-timestamp']);
  assert.deepEqual(plan.tooOld, ['deepseek/deepseek-chat']);
});

test('an empty addSince applies no bound', () => {
  const plan = planRoute({ current: [], live: [{ id: 'a/old', raw: { created: 1 } }], include: ['a/*'], addSince: '' });
  assert.deepEqual(plan.added, ['a/old']);
  assert.deepEqual(plan.tooOld, []);
});

test('accepts a unix timestamp as the bound', () => {
  assert.equal(toSeconds('1789021285'), 1789021285);
  assert.equal(toSeconds('2026-09-01'), Math.floor(Date.parse('2026-09-01T00:00:00Z') / 1000));
  assert.ok(Number.isNaN(toSeconds('')));
  assert.ok(Number.isNaN(toSeconds('not a date')));
});

test('a candidate the route cannot type is reported instead of added', () => {
  const plan = planRoute({
    current: [{ id: 'deepseek/deepseek-v4.1-flash', contextWindow: 1 }],
    live,
    include: ['qwen/*', 'meta/*'],
    isTypeable: (id) => id === 'meta/llama-9',
  });
  assert.deepEqual(plan.added, ['meta/llama-9'], 'a typeable candidate still lands');
  assert.deepEqual(plan.needsProtocol, ['qwen/qwen3.9-flash']);
  assert.deepEqual(plan.candidates, ['qwen/qwen3.9-flash', 'meta/llama-9']);
  assert.deepEqual(plan.filled, [{ id: 'deepseek/deepseek-v4.1-flash', fields: ['maxTokens', 'reasoningEfforts'], notes: [] }]);
  assert.equal(plan.changed, true);
  assert.deepEqual(plan.next.map((entry) => entry.id), ['deepseek/deepseek-v4.1-flash', 'meta/llama-9']);
});

test('candidates are only the ids that passed both the allowlist and the date gate', () => {
  const plan = planRoute({
    current: [],
    live,
    include: ['qwen/*', 'meta/*'],
    addSince: '2026-01-01',
    isTypeable: () => false,
  });
  assert.deepEqual(plan.candidates, ['qwen/qwen3.9-flash', 'meta/llama-9']);
  assert.deepEqual(plan.needsProtocol, ['qwen/qwen3.9-flash', 'meta/llama-9']);
  assert.deepEqual(plan.skipped, ['deepseek/deepseek-v4.1-flash']);
  assert.deepEqual(plan.added, []);
});

test('allowAdditions false plans only the fills', () => {
  const plan = planRoute({
    current: [{ id: 'deepseek/deepseek-v4.1-flash' }],
    live,
    include: ['qwen/*'],
    allowAdditions: false,
  });
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.needsProtocol, []);
  assert.deepEqual(plan.next.map((entry) => entry.id), ['deepseek/deepseek-v4.1-flash']);
  assert.equal(plan.changed, true);
});

test('an id the endpoint marks as an alias is left out of a pinned list', () => {
  const withAlias = [
    ...live,
    { id: '~openai/gpt-astra-latest', raw: { alias_target: { name: 'OpenAI: GPT Astra', slug: 'openai/gpt-astra' }, created: 1900000000 } },
  ];
  const plan = planRoute({ current: [], live: withAlias, include: ['*'], isTypeable: () => true });
  assert.deepEqual(plan.aliases, ['~openai/gpt-astra-latest']);
  assert.equal(plan.added.includes('~openai/gpt-astra-latest'), false);
  assert.equal(plan.added.length, 3, 'the real models are still added');
});

test('skipAliases false takes the endpoint literally', () => {
  const withAlias = [{ id: '~openai/gpt-astra-latest', raw: { alias_target: { slug: 'openai/gpt-astra' } } }];
  const plan = planRoute({ current: [], live: withAlias, include: ['*'], isTypeable: () => true, skipAliases: false });
  assert.deepEqual(plan.added, ['~openai/gpt-astra-latest']);
  assert.deepEqual(plan.aliases, []);
});

test('an untypeable candidate leaves a fill-only plan unchanged when nothing else moved', () => {
  const plan = planRoute({
    current: [{ id: 'a/b', name: 'x' }],
    live: [{ id: 'a/b', raw: {} }, { id: 'qwen/new', raw: {} }],
    include: ['qwen/*'],
    isTypeable: () => false,
  });
  assert.equal(plan.changed, false, 'nothing writable changed, so no write should happen');
  assert.deepEqual(plan.needsProtocol, ['qwen/new']);
  assert.deepEqual(plan.added, []);
});

test('a snapshot bound resolves to the located catalog date', () => {
  const resolved = resolveAddSince('snapshot', '2026-09-05T11:58:56.761Z');
  assert.equal(resolved.since, '2026-09-05T11:58:56.761Z');
  assert.equal(resolved.withhold, false);
  assert.equal(resolved.note, undefined);
  assert.equal(toSeconds(resolved.since), Math.floor(Date.parse('2026-09-05T11:58:56.761Z') / 1000));
});

test('a snapshot bound accepts a unix timestamp too', () => {
  assert.equal(resolveAddSince('snapshot', 1789021285).since, 1789021285);
});

test('an unreadable snapshot withholds additions instead of unbinding them', () => {
  for (const missing of [undefined, '', 0, null]) {
    const resolved = resolveAddSince('snapshot', missing);
    assert.equal(resolved.withhold, true, `generatedAt=${String(missing)} must fail closed`);
    assert.match(resolved.note, /无法解析/);
  }
});

test('an explicit bound and an empty bound are passed through untouched', () => {
  assert.deepEqual(resolveAddSince('2026-09-05', undefined), { since: '2026-09-05', withhold: false, note: undefined });
  assert.deepEqual(resolveAddSince('', undefined), { since: '', withhold: false, note: undefined });
});

test('a route declaration fills the reasoning capability an endpoint never publishes', () => {
  const plan = planRoute({
    current: [{ id: 'qwen/qwen3.9-flash' }],
    live,
    include: [],
    fill: ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'],
    routeEfforts: { low: 'low', high: 'high' },
  });
  assert.deepEqual(plan.next[0].reasoningEfforts, { low: 'low', high: 'high' });
  assert.deepEqual(plan.filled, [
    {
      id: 'qwen/qwen3.9-flash',
      fields: ['contextWindow', 'input', 'reasoningEfforts'],
      notes: ['端点未提供推理档位表；已按本插件的路由档位声明补齐'],
    },
  ]);
});

test('the endpoint’s own effort table outranks the route declaration', () => {
  const plan = planRoute({
    current: [{ id: 'deepseek/deepseek-v4.1-flash' }],
    live,
    include: [],
    fill: ['reasoningEfforts'],
    routeEfforts: { low: 'low', medium: 'medium' },
  });
  assert.deepEqual(plan.next[0].reasoningEfforts, { high: 'high' });
});

test('a declared effort fills a model the endpoint does not list at all', () => {
  const plan = planRoute({ current: [{ id: 'gone/model' }], live, include: [], fill: ['reasoningEfforts'], routeEfforts: { high: 'high' } });
  assert.deepEqual(plan.notAdvertised, ['gone/model']);
  assert.deepEqual(plan.next[0].reasoningEfforts, { high: 'high' });
  assert.equal(plan.changed, true, 'the declaration alone is still a change worth writing');
});

test('and brings nothing else with it, because nothing else is known about that model', () => {
  const plan = planRoute({
    current: [{ id: 'gone/model' }],
    live,
    include: [],
    fill: ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'],
    routeEfforts: { high: 'high' },
  });
  assert.deepEqual(plan.filled, [
    { id: 'gone/model', fields: ['reasoningEfforts'], notes: ['端点未提供推理档位表；已按本插件的路由档位声明补齐'] },
  ]);
});

test('a model that opted out with reasoningEfforts: false keeps the opt-out', () => {
  const plan = planRoute({ current: [{ id: 'qwen/qwen3.9-flash', reasoningEfforts: false }], live, include: [], routeEfforts: { high: 'high' } });
  assert.equal(plan.next[0].reasoningEfforts, false);
});

test('declaring efforts does nothing when reasoningEfforts is not a fillable field', () => {
  const plan = planRoute({ current: [{ id: 'qwen/qwen3.9-flash' }], live, include: [], fill: ['contextWindow'], routeEfforts: { high: 'high' } });
  assert.equal('reasoningEfforts' in plan.next[0], false);
});

test('an unusable declared dict is dropped rather than written half-valid', () => {
  const plan = planRoute({ current: [{ id: 'qwen/qwen3.9-flash' }], live, include: [], fill: ['reasoningEfforts'], routeEfforts: { high: null } });
  assert.equal('reasoningEfforts' in plan.next[0], false);
  assert.equal(plan.changed, false);
});
