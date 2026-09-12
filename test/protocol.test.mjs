/**
 * The protocol gate: a route that cannot type a model its catalog does not
 * describe must report it rather than let DSH refuse the whole write — and a
 * write refused for any other reason must not sink the fills it carried.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { LISTING, run, undeclaredRoute } from './harness.mjs';

test('a model the route cannot type is reported instead of added, and the fill still lands', async () => {
  const harness = await run({}, LISTING, { llmUser: undeclaredRoute });
  try {
    assert.equal(harness.state.writes.length, 1, 'only the safe write happens');
    const [{ ops }] = harness.state.writes;
    assert.deepEqual(ops.map((op) => op.path.join('.')), ['providers.openrouter.models'], 'no protocol is written unasked');
    assert.deepEqual(ops[0].value.map((model) => model.id), ['deepseek/deepseek-v4.1-flash'], 'the untypeable candidate stays out');
    assert.equal(ops[0].value[0].maxTokens, 384000, 'the fill it travelled with survives');
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /需声明协议：qwen\/qwen9-future/);
    assert.match(result.text, /live-model-catalog\.routes\.openrouter\.api/);
  } finally {
    harness.restore();
  }
});

test('a declared route protocol is written with the models it enables, in one write', async () => {
  const overrides = { routes: { openrouter: { api: 'openai-completions' } } };
  const harness = await run(overrides, LISTING, { llmUser: undeclaredRoute });
  try {
    assert.equal(harness.state.writes.length, 1);
    const [{ ops }] = harness.state.writes;
    assert.deepEqual(
      ops.map((op) => op.path),
      [
        ['providers', 'openrouter', 'api'],
        ['providers', 'openrouter', 'models'],
      ],
      'the protocol and the models it enables travel in one mutate',
    );
    assert.equal(ops[0].value, 'openai-completions');
    assert.deepEqual(ops[1].value.map((model) => model.id), ['deepseek/deepseek-v4.1-flash', 'qwen/qwen9-future']);
    assert.equal(harness.state.user.providers.openrouter.api, 'openai-completions');

    const first = await harness.state.command.handler({ rawInput: '' });
    assert.match(first.text, /补写 api: openai-completions/);

    const second = await harness.state.command.handler({ rawInput: 'sync' });
    assert.equal(harness.state.writes.length, 1, 'the protocol is declared once, not every round');
    assert.match(second.text, /无变化/);
  } finally {
    harness.restore();
  }
});

test('a route protocol the owner already declared is never overwritten', async () => {
  const declared = {
    providers: {
      'openrouter-mobcool': {
        api: 'openai-responses',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'K',
        models: [{ id: 'deepseek/deepseek-v4.1-flash' }],
      },
    },
  };
  const harness = await run({ routes: { 'openrouter-mobcool': { api: 'openai-completions' } } }, LISTING, { llmUser: declared });
  try {
    assert.equal(harness.state.writes.length, 1);
    assert.deepEqual(harness.state.writes[0].ops.map((op) => op.path.join('.')), ['providers.openrouter-mobcool.models']);
    assert.equal(harness.state.user.providers['openrouter-mobcool'].api, 'openai-responses');
  } finally {
    harness.restore();
  }
});

test('names a configured model the endpoint no longer lists, and keeps it', async () => {
  const gone = {
    providers: {
      'openrouter-mobcool': {
        api: 'openai-responses',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'K',
        models: [{ id: 'deepseek/deepseek-v4.1-flash' }, { id: 'gone/model' }],
      },
    },
  };
  const harness = await run({ include: [] }, LISTING, { llmUser: gone });
  try {
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /未列出 1/);
    assert.match(result.text, /端点已不再列出（保留未删除）：gone\/model/);
    assert.deepEqual(
      harness.state.user.providers['openrouter-mobcool'].models.map((model) => model.id),
      ['deepseek/deepseek-v4.1-flash', 'gone/model'],
      'a delisted model is reported, never deleted',
    );
  } finally {
    harness.restore();
  }
});

test('a value YAML made non-JSON is refused by name, before the write', async () => {
  const dated = {
    providers: {
      'openrouter-mobcool': {
        api: 'openai-responses',
        baseURL: 'https://openrouter.ai/api/v1',
        apiKeyEnv: 'K',
        // `created: 2026-09-05` written without quotes parses as a Date.
        models: [{ id: 'deepseek/deepseek-v4.1-flash', created: new Date('2026-09-05') }],
      },
    },
  };
  const harness = await run({}, LISTING, { llmUser: dated });
  try {
    assert.equal(harness.state.writes.length, 0, 'DSH would refuse this payload, so it is never sent');
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /models\.0\.created 是 Date/);
    assert.match(result.text, /加引号/);
  } finally {
    harness.restore();
  }
});

test('an alias the endpoint publishes is reported, not pinned into the config', async () => {
  const aliasListing = {
    data: [
      ...LISTING.data,
      { id: '~openai/gpt-astra-latest', name: 'OpenAI GPT Astra Latest', created: 1900000000, alias_target: { name: 'OpenAI: GPT Astra', slug: 'openai/gpt-astra' } },
    ],
  };
  const harness = await run({ include: ['*'] }, aliasListing);
  try {
    const written = harness.state.writes.at(-1).ops.at(-1).value.map((model) => model.id);
    assert.equal(written.includes('~openai/gpt-astra-latest'), false, 'a moving alias must not enter a pinned list');
    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /跳过别名 1/);
    assert.match(result.text, /~openai\/gpt-astra-latest/);
  } finally {
    harness.restore();
  }
});

test('a write refused as a whole is retried without the additions', async () => {
  const refusal = 'llm-pi-ai: provider "openrouter-mobcool" model "qwen/qwen9-future" needs an api';
  const harness = await run({}, LISTING, {
    beforeWrite: (ops) => {
      if (ops.at(-1).value.some((model) => model.id === 'qwen/qwen9-future')) {
        const error = new Error(refusal);
        error.code = 'SETTINGS_INVALID';
        throw error;
      }
    },
  });
  try {
    assert.equal(harness.state.writes.length, 2, 'the refused plan is followed by a fill-only retry');
    assert.deepEqual(harness.state.writes[0].ops.at(-1).value.map((model) => model.id), [
      'deepseek/deepseek-v4.1-flash',
      'qwen/qwen9-future',
    ]);
    assert.deepEqual(harness.state.writes[1].ops.at(-1).value.map((model) => model.id), ['deepseek/deepseek-v4.1-flash']);
    assert.deepEqual(harness.state.user.providers['openrouter-mobcool'].models.map((model) => model.id), [
      'deepseek/deepseek-v4.1-flash',
    ]);

    const result = await harness.state.command.handler({ rawInput: '' });
    assert.match(result.text, /已写入（新增被拒，已保住补齐）/);
    assert.match(result.text, /✗ qwen\/qwen9-future/);
    assert.match(result.text, /needs an api/);
  } finally {
    harness.restore();
  }
});
