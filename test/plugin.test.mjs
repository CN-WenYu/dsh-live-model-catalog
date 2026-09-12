/**
 * Lifecycle wiring: one sync round, the command surface, and the module-B
 * discovery switch. Protocol-gate scenarios live in `protocol.test.mjs`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { apply } from '../lib/index.js';
import { LISTING, config, fakeContext, llmUser, run, undeclaredRoute } from './harness.mjs';

test('writes filled fields and allowlisted additions through settings.mutate', async () => {
  const harness = await run();
  try {
    assert.equal(harness.state.writes.length, 1, harness.state.log.join('\n'));
    const [write] = harness.state.writes;
    assert.equal(write.ns, 'llm-pi-ai');
    assert.equal(write.ops[0].op, 'set');
    assert.deepEqual(write.ops[0].path, ['providers', 'openrouter-mobcool', 'models']);
    assert.equal(write.revision, 2, 'the revision read is sent back as expectedRevision');

    const [first, ...rest] = write.ops[0].value;
    assert.equal(first.id, 'deepseek/deepseek-v4.1-flash');
    assert.equal(first.name, '我起的名字', 'a user-set name survives');
    assert.equal(first.contextWindow, 1000000, 'a user-set capacity survives');
    assert.equal(first.maxTokens, 384000, 'a missing capacity is filled');
    assert.deepEqual(first.input, ['text', 'image'], 'a missing modality is filled');
    assert.deepEqual(first.reasoningEfforts, { high: 'high', low: 'low' }, 'efforts are translated');
    assert.deepEqual(rest.map((model) => model.id), ['qwen/qwen9-future'], 'only allowlisted new ids are added');
  } finally {
    harness.restore();
  }
});

test('a second round writes nothing', async () => {
  const harness = await run();
  try {
    const before = harness.state.writes.length;
    assert.equal(before, 1);
    const result = await harness.state.command.handler({ rawInput: 'sync' });
    assert.equal(harness.state.writes.length, before, 'an unchanged round must not rewrite settings');
    assert.match(result.text, /无变化/);
  } finally {
    harness.restore();
  }
});

test('registers a /model-catalog command whose output reports the round', async () => {
  const harness = await run();
  try {
    assert.equal(harness.state.command.name, 'model-catalog');
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.equal(result.kind, 'success');
    assert.match(result.text, /openrouter-mobcool/);
    assert.match(result.text, /deepseek\/deepseek-v4\.1-flash/);
  } finally {
    harness.restore();
  }
});

test('leaves the discovery table alone while fixDiscovery is off', async () => {
  const harness = await run();
  try {
    const wrapper = harness.discoveries.get('llm-pi-ai');
    assert.deepEqual(await wrapper({ provider: 'openrouter' }), [{ id: 'snapshot/only' }]);
  } finally {
    harness.restore();
  }
});

test('fixDiscovery answers the button from the live endpoint', async () => {
  const harness = await run({ fixDiscovery: true });
  try {
    const wrapper = harness.discoveries.get('llm-pi-ai');
    const live = await wrapper({ provider: 'openrouter-mobcool' });
    assert.deepEqual(live.map((model) => model.id), LISTING.data.map((model) => model.id));
    assert.equal(live[0].contextWindow, 1048576);
    assert.deepEqual(await wrapper({ provider: 'some-other-route' }), [{ id: 'snapshot/only' }], 'unmanaged routes fall through');
  } finally {
    harness.restore();
  }
});

test('turning fixDiscovery off at runtime restores the official discovery', async () => {
  const harness = await run({ fixDiscovery: true });
  try {
    const wrapper = harness.discoveries.get('llm-pi-ai');
    assert.deepEqual(
      (await wrapper({ provider: 'openrouter-mobcool' })).map((model) => model.id),
      LISTING.data.map((model) => model.id),
      'the switch is on, so the button answers live',
    );

    Object.assign(harness.state.config, { fixDiscovery: false });
    harness.state.watch();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const restored = harness.discoveries.get('llm-pi-ai');
    assert.deepEqual(await restored({ provider: 'openrouter-mobcool' }), [{ id: 'snapshot/only' }], 'the official answer is back');
  } finally {
    harness.restore();
  }
});

test('the master switch gives the discovery table back too', async () => {
  const harness = await run({ fixDiscovery: true });
  try {
    const wrapper = harness.discoveries.get('llm-pi-ai');
    assert.deepEqual(
      (await wrapper({ provider: 'openrouter-mobcool' })).map((model) => model.id),
      LISTING.data.map((model) => model.id),
    );

    Object.assign(harness.state.config, { enabled: false });
    await harness.state.command.handler({ rawInput: 'sync' });

    assert.deepEqual(
      await harness.discoveries.get('llm-pi-ai')({ provider: 'openrouter-mobcool' }),
      [{ id: 'snapshot/only' }],
      'a plugin that owns nothing must not keep the wrapper installed',
    );
  } finally {
    harness.restore();
  }
});

test('a route added later joins the live scope without reinstalling the wrapper', async () => {
  const harness = await run({ fixDiscovery: true });
  try {
    const wrapper = harness.discoveries.get('llm-pi-ai');
    assert.deepEqual(await wrapper({ provider: 'route-later' }), [{ id: 'snapshot/only' }], 'not managed yet, so it falls through');

    harness.state.user.providers['route-later'] = {
      api: 'openai-responses',
      baseURL: 'https://later.example/v1',
      models: [{ id: 'x' }],
    };
    await harness.state.command.handler({ rawInput: 'sync' });

    assert.equal(harness.discoveries.get('llm-pi-ai'), wrapper, 'the same wrapper now covers the wider scope');
    assert.deepEqual(
      (await wrapper({ provider: 'route-later' })).map((model) => model.id),
      LISTING.data.map((model) => model.id),
    );
  } finally {
    harness.restore();
  }
});

test('a route with no models list is left unwritten and reported', async () => {
  const harness = fakeContext({
    llmUser: { providers: { bare: { baseURL: 'https://bare.example/v1' } } },
    config: { ...config },
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(LISTING), { status: 200 });
  try {
    apply(harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(harness.state.writes.length, 0);
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /models 列表/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('an endpoint failure is reported, not swallowed, and no write happens', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 500 });
  const harness = fakeContext({ llmUser, config: { ...config } });
  try {
    apply(harness.ctx);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(harness.state.writes.length, 0);
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /失败/);
    assert.match(result.text, /500/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a config change runs its own round, so a declared protocol lands without a restart', async () => {
  const harness = await run({}, LISTING, { llmUser: undeclaredRoute });
  try {
    assert.equal(harness.state.writes.length, 1, 'the first round can only fill');
    assert.deepEqual(harness.state.writes[0].ops.map((op) => op.path.join('.')), ['providers.openrouter.models']);

    Object.assign(harness.state.config, { routes: { openrouter: { api: 'openai-completions' } } });
    harness.state.watch();
    await new Promise((resolve) => setTimeout(resolve, 1700));

    assert.equal(harness.state.writes.length, 2, 'the config edit produced a round of its own');
    assert.deepEqual(
      harness.state.writes[1].ops.map((op) => op.path.join('.')),
      ['providers.openrouter.api', 'providers.openrouter.models'],
      'and that round is the one that declares the protocol and adds the model it enables',
    );
    assert.equal(harness.state.user.providers.openrouter.api, 'openai-completions');
    assert.deepEqual(
      harness.state.user.providers.openrouter.models.map((model) => model.id),
      ['deepseek/deepseek-v4.1-flash', 'qwen/qwen9-future'],
    );
  } finally {
    harness.restore();
  }
});

test('an unreadable listing protocol is skipped without touching the endpoint', async () => {
  const harness = await run({ routes: { 'openrouter-mobcool': { api: 'bedrock-converse-stream' } } });
  try {
    assert.equal(harness.calls.length, 0, 'a protocol DSH cannot list must not be probed at all');
    assert.equal(harness.state.writes.length, 0);
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /无法列举模型/);
    assert.match(result.text, /bedrock-converse-stream/);
  } finally {
    harness.restore();
  }
});

test('a raced write re-reads, re-plans, and keeps the change it never saw', async () => {
  let attempts = 0;
  const harness = await run({}, LISTING, {
    beforeWrite: (_ops, _index, state) => {
      attempts += 1;
      if (attempts > 1) return;
      // The GUI edited the same route between our read and our write, which is
      // exactly what `expectedRevision` exists to catch.
      state.user.providers['openrouter-mobcool'].models[0].name = 'GUI 改的名字';
      state.revision = 9;
      const conflict = new Error('settings namespace "llm-pi-ai" changed since it was read (expected revision 2, now 9)');
      conflict.code = 'SETTINGS_CONFLICT';
      throw conflict;
    },
  });
  try {
    assert.equal(harness.state.writes.length, 2, 'the refused write is retried');
    assert.equal(harness.state.writes[0].revision, 2, 'first attempt used the revision it read');
    assert.equal(harness.state.writes[1].revision, 9, 'the retry used the revision that won the race');
    const written = harness.state.writes[1].ops.at(-1).value;
    assert.equal(written[0].name, 'GUI 改的名字', 'the change this plugin never saw survives the re-plan');
    assert.equal(written[0].maxTokens, 384000, 'and the fill it came for still lands');
    assert.deepEqual(
      written.map((model) => model.id),
      ['deepseek/deepseek-v4.1-flash', 'qwen/qwen9-future'],
      'the retry is the re-planned full write, not the fills-only degrade path',
    );
  } finally {
    harness.restore();
  }
});

test('a refusal that arrived is not retried, and its retry-after is reported', async () => {
  const harness = await run({}, LISTING, {
    fetch: () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } }),
  });
  try {
    assert.equal(harness.calls.length, 1, 'asking again cannot change an answer, and on 429 it is what the endpoint forbade');
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /429/);
    assert.match(result.text, /retry-after 30/);
  } finally {
    harness.restore();
  }
});

test('a transport failure gets one more try', async () => {
  let attempts = 0;
  const harness = await run({}, LISTING, {
    fetch: () => {
      attempts += 1;
      if (attempts === 1) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify(LISTING), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  try {
    assert.equal(harness.calls.length, 2, 'a transport failure is worth one immediate retry');
    assert.equal(harness.state.writes.length, 1, 'and the retry carries the round to a normal write');
  } finally {
    harness.restore();
  }
});

test('an unreadable snapshot bound withholds additions instead of unbinding them', async () => {
  const harness = await run({ include: ['qwen/*'], addSince: 'snapshot' });
  try {
    assert.equal(harness.state.writes.length, 1);
    assert.deepEqual(
      harness.state.writes[0].ops.at(-1).value.map((model) => model.id),
      ['deepseek/deepseek-v4.1-flash'],
      'the test container cannot locate pi-ai, so the gate must fail closed',
    );
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /无法解析/);
    assert.match(result.text, /只补齐不新增/);
  } finally {
    harness.restore();
  }
});
