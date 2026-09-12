/**
 * The round's decision layer, tested without a context, a socket or a clock.
 *
 * Two passes exist because DSH validates a settings write as a whole: one model
 * the route cannot type would refuse the fills that share the write. These cases
 * pin what each pass may decide.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { planRouteUpdate } from '../lib/plan.js';

const config = {
  fill: ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'],
  defaultEfforts: { off: 'none', high: 'high', max: 'max' },
};

const live = [
  { id: 'known/model', raw: { context_length: 1000, top_provider: { max_completion_tokens: 100 } } },
  { id: 'deepseek/brand-new', raw: { context_length: 2000, reasoning: { supported_efforts: ['high'] }, created: 1900000000 } },
];

/** A target shaped like `resolveTargets` produces. */
const target = (fields) => ({
  route: 'openrouter',
  declaredApi: undefined,
  overrideApi: undefined,
  catalogApis: undefined,
  catalogSharedApi: undefined,
  ...fields,
});

const user = (models) => ({ providers: { openrouter: { models } } });

test('fills gaps and adds allowlisted ids the route can already type', () => {
  const plan = planRouteUpdate({
    target: target({ declaredApi: 'openai-completions' }),
    config,
    live,
    include: ['deepseek/*'],
    since: '',
    user: user([{ id: 'known/model', name: '我起的名字' }]),
  });
  assert.deepEqual(plan.filled, [{ id: 'known/model', fields: ['contextWindow', 'maxTokens'], notes: [] }]);
  assert.deepEqual(plan.added, ['deepseek/brand-new']);
  assert.equal(plan.routeApi, undefined, 'a declared protocol means nothing to write');
  assert.equal(plan.changed, true);
});

test('a route that cannot type a candidate reports it instead of adding it', () => {
  const plan = planRouteUpdate({
    target: target({ catalogApis: new Map([['known/model', 'openai-completions']]), catalogSharedApi: undefined }),
    config,
    live,
    include: ['deepseek/*'],
    since: '',
    user: user([{ id: 'known/model' }]),
  });
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.needsProtocol, ['deepseek/brand-new']);
  assert.deepEqual(plan.candidates, ['deepseek/brand-new']);
  assert.match(plan.protocolAdvice, /live-model-catalog\.routes\.openrouter\.api/);
  assert.equal(plan.routeApi, undefined, 'nothing is written without an explicit declaration');
});

test('a declared protocol is used, and reported, exactly when it unblocks a candidate', () => {
  const plan = planRouteUpdate({
    target: target({ overrideApi: 'openai-completions' }),
    config,
    live,
    include: ['deepseek/*'],
    since: '',
    user: user([{ id: 'known/model' }]),
  });
  assert.equal(plan.routeApi, 'openai-completions');
  assert.match(plan.protocolNote, /补写 api: openai-completions/);
  assert.deepEqual(plan.added, ['deepseek/brand-new'], 'the second pass accepts what the first could not type');
  assert.deepEqual(plan.needsProtocol, []);
  assert.equal(plan.changed, true);
});

test('a declared protocol is not written when nothing needed it', () => {
  const plan = planRouteUpdate({
    target: target({ overrideApi: 'openai-completions' }),
    config,
    live,
    include: [],
    since: '',
    user: user([{ id: 'known/model' }]),
  });
  assert.equal(plan.routeApi, undefined, 'no gratuitous protocol write');
  assert.equal(plan.protocolNote, undefined);
  assert.deepEqual(plan.added, []);
});

test('a protocol that would re-point an existing model is refused, and it says which', () => {
  const plan = planRouteUpdate({
    target: target({
      overrideApi: 'openai-completions',
      catalogApis: new Map([['known/model', 'anthropic-messages']]),
    }),
    config,
    live,
    include: ['deepseek/*'],
    since: '',
    user: user([{ id: 'known/model' }]),
  });
  assert.equal(plan.routeApi, undefined);
  assert.deepEqual(plan.added, []);
  assert.match(plan.protocolNote, /known\/model（目录为 anthropic-messages）/);
});

test('the add gate is passed through, and withholding it means no candidates at all', () => {
  const base = { target: target({ declaredApi: 'openai-completions' }), config, live, user: user([{ id: 'known/model' }]) };
  assert.deepEqual(planRouteUpdate({ ...base, include: ['deepseek/*'], since: '' }).added, ['deepseek/brand-new']);
  const withheld = planRouteUpdate({ ...base, include: [], since: '' });
  assert.deepEqual(withheld.added, []);
  assert.deepEqual(withheld.candidates, []);
  const dated = planRouteUpdate({ ...base, include: ['deepseek/*'], since: '2031-01-01' });
  assert.deepEqual(dated.added, [], 'the new model is older than the bound');
  assert.deepEqual(dated.tooOld, ['deepseek/brand-new']);
});

test('additions:false leaves only the fills, which is what the retry needs', () => {
  const plan = planRouteUpdate({
    target: target({ declaredApi: 'openai-completions' }),
    config,
    live,
    include: ['deepseek/*'],
    since: '',
    user: user([{ id: 'known/model' }]),
    additions: false,
  });
  assert.deepEqual(plan.added, []);
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.filled, [{ id: 'known/model', fields: ['contextWindow', 'maxTokens'], notes: [] }]);
  assert.equal(plan.changed, true);
});

test('a route that lost its models list reports the reason instead of a plan', () => {
  const plan = planRouteUpdate({
    target: target({ declaredApi: 'openai-completions' }),
    config,
    live,
    include: [],
    since: '',
    user: { providers: { openrouter: {} } },
  });
  assert.equal(plan.next, undefined);
  assert.match(plan.reason, /lost its models list/);
});
