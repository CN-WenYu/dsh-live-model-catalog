/**
 * The write boundary: what reaches `settings.mutate`, and what is refused
 * before it gets there. Pure, so it needs no `node_modules` and no process.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { findNonJsonValue } from '../lib/apply.js';

class Tagged {
  constructor(value) {
    this.value = value;
  }
}

test('accepts everything DSH can persist', () => {
  assert.equal(findNonJsonValue([{ id: 'a/b', name: 'x', contextWindow: 1000, input: ['text'], nested: { ok: true, n: null } }]), undefined);
  assert.equal(findNonJsonValue([]), undefined);
  assert.equal(findNonJsonValue(null), undefined);
  assert.equal(findNonJsonValue(undefined), undefined, 'absent is droppable, not fatal');
  assert.equal(findNonJsonValue({ maybe: undefined }), undefined);
});

test('finds a YAML date and names where it sits', () => {
  const found = findNonJsonValue([{ id: 'a/b' }, { id: 'c/d', created: new Date('2026-09-05') }]);
  assert.deepEqual(found, { path: ['1', 'created'], kind: 'Date' });
});

test('finds class instances, non-finite numbers and functions', () => {
  assert.deepEqual(findNonJsonValue([{ id: 'a', extra: new Tagged(1) }]), { path: ['0', 'extra'], kind: 'Tagged' });
  assert.deepEqual(findNonJsonValue([{ id: 'a', n: Number.NaN }]), { path: ['0', 'n'], kind: 'NaN/Infinity' });
  assert.deepEqual(findNonJsonValue([{ id: 'a', fn: () => {} }]), { path: ['0', 'fn'], kind: 'function' });
  assert.deepEqual(findNonJsonValue([{ id: 'a', big: 1n }]), { path: ['0', 'big'], kind: 'bigint' });
});

test('reports the outermost offender first', () => {
  const found = findNonJsonValue([{ id: 'a', when: new Date(), also: new Date() }]);
  assert.deepEqual(found, { path: ['0', 'when'], kind: 'Date' });
});
