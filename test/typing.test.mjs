import assert from 'node:assert/strict';
import test from 'node:test';

import { canType, protocolAdvice, protocolConflicts, resolveProtocol } from '../lib/typing.js';

/** pi-ai's openrouter catalog as it really is: two protocols under one route. */
const openrouterApis = new Map([
  ['deepseek/deepseek-v4-flash-0731', 'openai-completions'],
  ['deepseek/deepseek-v4.1-flash', 'openai-completions'],
  ['anthropic/claude-3-haiku', 'anthropic-messages'],
]);

test('a declared route protocol types every model', () => {
  assert.equal(canType('openai-responses', 'anything/at-all', undefined, undefined), true);
});

test('a catalog twin types a model without any route protocol', () => {
  assert.equal(canType(undefined, 'deepseek/deepseek-v4-flash-0731', openrouterApis, undefined), true);
});

test('a catalog-wide protocol types a model the catalog does not describe', () => {
  const single = new Map([['a', 'openai-completions']]);
  assert.equal(canType(undefined, 'brand/new-model', single, 'openai-completions'), true);
});

test('a model the catalog cannot place stays untypeable', () => {
  assert.equal(canType(undefined, 'deepseek/deepseek-v4.1-flash-x', openrouterApis, undefined), false);
  assert.equal(canType(undefined, 'brand/new-model', undefined, undefined), false);
});

test('declaring a protocol that would re-point an existing model is refused', () => {
  const ids = ['deepseek/deepseek-v4-flash-0731', 'anthropic/claude-3-haiku'];
  const conflicts = protocolConflicts(ids, 'openai-completions', openrouterApis);
  assert.deepEqual(conflicts, [{ id: 'anthropic/claude-3-haiku', twin: 'anthropic-messages' }]);
});

test('a protocol every twin already agrees with has no conflicts', () => {
  assert.deepEqual(protocolConflicts(['deepseek/deepseek-v4.1-flash'], 'openai-completions', openrouterApis), []);
});

test('the route keeps its own declared protocol and nothing is written', () => {
  const resolved = resolveProtocol({
    route: 'openrouter',
    declaredApi: 'anthropic-messages',
    overrideApi: 'openai-completions',
    catalogApis: openrouterApis,
    ids: [...openrouterApis.keys()],
  });
  assert.equal(resolved.routeApi, 'anthropic-messages');
  assert.equal(resolved.write, undefined);
});

test('no override means no protocol is available and nothing is written', () => {
  const resolved = resolveProtocol({ route: 'openrouter', declaredApi: undefined, catalogApis: openrouterApis });
  assert.deepEqual({ routeApi: resolved.routeApi, write: resolved.write, conflicts: resolved.conflicts }, {
    routeApi: undefined,
    write: undefined,
    conflicts: [],
  });
});

test('a safe override becomes the protocol this plugin may write', () => {
  const resolved = resolveProtocol({
    route: 'openrouter',
    declaredApi: undefined,
    overrideApi: 'openai-completions',
    catalogApis: openrouterApis,
    ids: ['deepseek/deepseek-v4-flash-0731', 'brand/new-model'],
  });
  assert.equal(resolved.routeApi, 'openai-completions');
  assert.equal(resolved.write, 'openai-completions');
  assert.equal(resolved.detail, undefined);
});

test('a conflicting override writes nothing and names the models it would have re-pointed', () => {
  const resolved = resolveProtocol({
    route: 'openrouter',
    declaredApi: undefined,
    overrideApi: 'openai-completions',
    catalogApis: openrouterApis,
    ids: ['anthropic/claude-3-haiku'],
  });
  assert.equal(resolved.routeApi, undefined);
  assert.equal(resolved.write, undefined);
  assert.equal(resolved.conflicts.length, 1);
  assert.match(resolved.detail, /anthropic\/claude-3-haiku/);
  assert.match(resolved.detail, /anthropic-messages/);
});

test('the advice names the route and the place to declare it', () => {
  assert.match(protocolAdvice('openrouter'), /live-model-catalog\.routes\.openrouter\.api/);
});
