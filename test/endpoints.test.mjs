import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { anchorVariants, builtinEndpoints } from '../lib/endpoints.js';

/** A directory that removes itself, for the symlink shapes production actually has. */
async function withTempDir(run) {
  const dir = mkdtempSync(join(tmpdir(), 'lmc-anchor-'));
  try {
    return await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('degrades instead of throwing when pi-ai cannot be located', async () => {
  const result = await builtinEndpoints('/nonexistent/anchor/index.js');
  assert.ok(result.table instanceof Map);
  assert.equal(result.table.size, 0);
  assert.ok(result.models instanceof Map, 'an unreadable catalog yields no typing facts, not a crash');
  assert.equal(result.models.size, 0);
  assert.equal(result.generatedAt, undefined);
  assert.match(result.detail, /could not locate/);
});

test('offers the real file behind a symlinked anchor', async () => {
  await withTempDir((dir) => {
    const target = join(dir, 'entry.js');
    const link = join(dir, 'dsh');
    writeFileSync(target, '// entry\n');
    symlinkSync(target, link);
    // macOS resolves `os.tmpdir()` through /private, so compare in real terms.
    assert.deepEqual(anchorVariants(link), [link, realpathSync(target)]);
  });
});

test('keeps an unresolvable anchor as the only variant', () => {
  assert.deepEqual(anchorVariants('/nope/never'), ['/nope/never']);
  assert.deepEqual(anchorVariants(undefined), []);
});

test('resolves the running install’s provider table when anchored at the dsh CLI', async (t) => {
  const anchor = process.env.DSH_CLI_ENTRY;
  if (anchor === undefined) return t.skip('DSH_CLI_ENTRY not set');
  const result = await builtinEndpoints(anchor);
  assert.ok(result.table.size > 0, result.detail);
  assert.match(result.table.get('openrouter'), /^https:\/\//);
  assert.equal(
    result.models.get('openrouter').get('deepseek/deepseek-v4-flash-0731'),
    'openai-completions',
    'each catalog model’s protocol is carried, because that is what decides typability',
  );
  assert.ok(result.generatedAt, 'the snapshot date is what anchors an addSince of "snapshot"');
});

test('resolves through a symlinked CLI anchor — the shape a real install boots with', async (t) => {
  const anchor = process.env.DSH_CLI_ENTRY;
  if (anchor === undefined) return t.skip('DSH_CLI_ENTRY not set');
  // `node ~/.npm-global/bin/dsh web` puts a symlink on PATH in argv[1], and
  // createRequire does not follow it: without the realpath variant, every
  // shipped-provider lookup fails in production while passing in every test that
  // hands in the resolved path. That is exactly what this case pins.
  await withTempDir(async (dir) => {
    const link = join(dir, 'dsh');
    symlinkSync(anchor, link);
    const result = await builtinEndpoints(link);
    assert.ok(result.table.size > 0, result.detail);
    assert.equal(result.table.get('openrouter'), 'https://openrouter.ai/api/v1');
  });
});
