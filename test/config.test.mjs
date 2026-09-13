/**
 * The out-of-the-box contract: what a fresh install does without any config.
 *
 * These defaults are deliberately load-bearing — they are what "install it and
 * get the endpoint's new models" means — so they are pinned here rather than
 * left to the schema's silent values. This is the one suite that needs the
 * `schemastery` dependency, because that is what defines them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { Config } from '../lib/config.js';

const defaults = Config({});

test('a fresh install adds every vendor’s models, not only its own capabilities', () => {
  assert.deepEqual(defaults.include, ['*']);
});

test('and the add gate keeps that from becoming a history import', () => {
  assert.equal(defaults.addSince, 'snapshot');
});

test('moving aliases stay out of a pinned list', () => {
  assert.equal(defaults.skipAliases, true);
});

test('the fetch button is repaired out of the box too', () => {
  assert.equal(defaults.fixDiscovery, true);
});

test('filling is still scoped to the capability fields', () => {
  assert.deepEqual(defaults.fill, ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts']);
});

test('a route starts with no reasoning declaration and no listing override', () => {
  const route = Config({ routes: { sensenova: {} } }).routes.sensenova;
  assert.deepEqual(route.efforts, {}, 'nothing is assumed about a provider before the owner says so');
  assert.equal(route.listingPath, '');
  assert.equal(route.enabled, true);
});

test('a route declaration is kept exactly as written', () => {
  const route = Config({ routes: { sensenova: { efforts: { low: 'low', off: null }, listingPath: '/llm/models' } } }).routes.sensenova;
  assert.deepEqual(route.efforts, { low: 'low', off: null });
  assert.equal(route.listingPath, '/llm/models');
});

test('the conservative fallbacks survive', () => {
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.mode, 'auto');
  assert.deepEqual(defaults.exclude, []);
  assert.equal(defaults.intervalMinutes, 240);
  assert.equal(defaults.requestTimeoutSeconds, 20);
});
