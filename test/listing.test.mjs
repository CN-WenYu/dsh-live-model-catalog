import assert from 'node:assert/strict';
import test from 'node:test';

import { listingUrl, parseListing } from '../lib/listing.js';

test('joins an OpenAI-compatible listing path', () => {
  assert.equal(listingUrl('https://openrouter.ai/api/v1', 'openai-completions'), 'https://openrouter.ai/api/v1/models');
  assert.equal(listingUrl('https://gateway.example/openai/v1/', 'openai-responses'), 'https://gateway.example/openai/v1/models');
});

test('normalizes the Anthropic root whether or not it carries /v1', () => {
  assert.equal(listingUrl('https://api.anthropic.com', 'anthropic-messages'), 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(listingUrl('https://api.anthropic.com/v1', 'anthropic-messages'), 'https://api.anthropic.com/v1/models?limit=1000');
});

test('reads the standard data array', () => {
  const entries = parseListing({ data: [{ id: 'a/one' }, { id: 'a/two', name: 'Two' }] });
  assert.deepEqual(entries.map((entry) => entry.id), ['a/one', 'a/two']);
  assert.equal(entries[1].raw.name, 'Two');
});

test('prefers the models-map key as the request id', () => {
  const entries = parseListing({ models: { 'alias/one': { id: 'canonical/other' } } });
  assert.equal(entries[0].id, 'alias/one');
  assert.equal(entries[0].raw.id, 'canonical/other');
});

test('data wins when both shapes are present', () => {
  const entries = parseListing({ data: [{ id: 'from/data' }], models: { 'from/map': {} } });
  assert.deepEqual(entries.map((entry) => entry.id), ['from/data']);
});

test('skips rows with no usable id rather than failing the listing', () => {
  const entries = parseListing({ data: [{ name: 'no id' }, { id: 'ok/one' }] });
  assert.deepEqual(entries.map((entry) => entry.id), ['ok/one']);
});

test('ignores primitive values in a models map', () => {
  const entries = parseListing({ models: { version: '2', 'ok/one': { id: 'ok/one' } } });
  assert.deepEqual(entries.map((entry) => entry.id), ['ok/one']);
});

test('refuses a body that is neither supported shape', () => {
  assert.throws(() => parseListing({ error: 'nope' }), /neither a "data" array nor a "models" object/);
  assert.throws(() => parseListing(null), /neither a "data" array nor a "models" object/);
});
