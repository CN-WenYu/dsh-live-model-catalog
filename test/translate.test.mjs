import assert from 'node:assert/strict';
import test from 'node:test';

import { effortMap, isAlias, translateEntry } from '../lib/translate.js';

/** The shape openrouter.ai/api/v1/models returned for deepseek/deepseek-v4.1-flash. */
const V41_FLASH = {
  id: 'deepseek/deepseek-v4.1-flash',
  name: 'DeepSeek: DeepSeek V4.1 Flash',
  context_length: 1048576,
  top_provider: { context_length: 1048576, max_completion_tokens: 384000 },
  architecture: { input_modalities: ['text', 'image'] },
  reasoning: { mandatory: false, default_enabled: true, supported_efforts: ['max', 'high', 'low'], default_effort: 'high' },
};

test('translates a full OpenRouter entry', () => {
  const { profile } = translateEntry({ id: V41_FLASH.id, raw: V41_FLASH });
  assert.deepEqual(profile, {
    id: 'deepseek/deepseek-v4.1-flash',
    name: 'DeepSeek: DeepSeek V4.1 Flash',
    contextWindow: 1048576,
    maxTokens: 384000,
    input: ['text', 'image'],
    reasoningEfforts: { max: 'max', high: 'high', low: 'low' },
  });
});

test('omits every field the endpoint did not report', () => {
  const { profile } = translateEntry({ id: 'vendor/plain', raw: { id: 'vendor/plain' } });
  assert.deepEqual(profile, { id: 'vendor/plain' });
});

test('drops "off" when reasoning is mandatory', () => {
  const map = effortMap({ mandatory: true, supported_efforts: ['none', 'high'] });
  assert.deepEqual(map.efforts, { high: 'high' });
});

test('maps "none" to an explicit off wire value', () => {
  const map = effortMap({ supported_efforts: ['none', 'xhigh'] });
  assert.deepEqual(map.efforts, { off: 'none', xhigh: 'xhigh' });
});

test('applies the preset when an endpoint reasons without listing efforts', () => {
  const map = effortMap({ mandatory: false }, { off: 'none', high: 'high', max: 'max' });
  assert.deepEqual(map.efforts, { off: 'none', high: 'high', max: 'max' });
  assert.deepEqual(map.notes, ['no effort list published; preset applied']);
});

test('reports an effort level DSH cannot express instead of guessing', () => {
  const map = effortMap({ supported_efforts: ['ultra', 'high'] });
  assert.deepEqual(map.efforts, { high: 'high' });
  assert.deepEqual(map.notes, ['unsupported effort "ultra" ignored']);
});

test('declares nothing when only "off" would be offered', () => {
  assert.equal(effortMap({ supported_efforts: ['none'] }), undefined);
  assert.equal(effortMap({ supported_efforts: [] }, {}), undefined);
});

test('declares nothing when the entry has no reasoning block', () => {
  assert.equal(effortMap(undefined), undefined);
  assert.equal(effortMap(null), undefined);
});

test('reads the enriched models map id from the key', () => {
  const { profile } = translateEntry({ id: 'alias/one', raw: { id: 'canonical/other', context_length: 200000 } });
  assert.equal(profile.id, 'alias/one');
  assert.equal(profile.contextWindow, 200000);
});

test('never claims a model accepts nothing', () => {
  const { profile } = translateEntry({ id: 'vendor/audio', raw: { architecture: { input_modalities: ['audio'] } } });
  assert.equal('input' in profile, false);
});

test('rejects an entry without an id', () => {
  assert.throws(() => translateEntry({ id: '', raw: {} }), /no usable id/);
});

test('an alias is recognised in the shape the endpoint actually publishes', () => {
  // OpenRouter marks `~<vendor>/<model>-latest` with an object, not a string.
  assert.equal(isAlias({ raw: { alias_target: { name: 'OpenAI: GPT-6 Astra', slug: 'openai/gpt-6-astra' } } }), true);
});

test('a string-shaped alias marker is accepted too', () => {
  assert.equal(isAlias({ raw: { alias_target: 'openai/gpt-6-astra' } }), true);
});

test('a real model is not an alias', () => {
  assert.equal(isAlias({ raw: { id: 'sakana/fugu-max', canonical_slug: 'sakana/fugu-max-20260911' } }), false);
  assert.equal(isAlias({ raw: {} }), false);
  assert.equal(isAlias({}), false);
  assert.equal(isAlias(undefined), false);
  assert.equal(isAlias({ raw: { alias_target: '' } }), false);
  assert.equal(isAlias({ raw: { alias_target: {} } }), false);
});
