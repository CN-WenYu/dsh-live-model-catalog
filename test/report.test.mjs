import assert from 'node:assert/strict';
import test from 'node:test';

import { renderReport } from '../lib/report.js';

function makeReport(routes, extra = {}) {
  return {
    trigger: 'startup',
    config: { include: ['deepseek/*'], addSince: '2026-09-05', fill: ['input'], fixDiscovery: false },
    routes,
    ...extra,
  };
}

const route = (fields) => ({
  route: 'openrouter',
  status: 'written',
  added: [],
  refused: [],
  filled: [],
  needsProtocol: [],
  notAdvertised: [],
  skipped: 0,
  tooOld: 0,
  notes: [],
  liveCount: 10,
  ...fields,
});

test('names every model the endpoint dropped instead of only counting them', () => {
  const text = renderReport(
    makeReport([
      route({
        notAdvertised: ['auto', 'minimax/minimax-m2.7:free', 'z-ai/glm-5.2:free'],
      }),
    ]),
  );
  assert.match(text, /未列出 3/);
  assert.match(text, /端点已不再列出（保留未删除）：auto、minimax\/minimax-m2\.7:free、z-ai\/glm-5\.2:free/);
});

test('prints each fill with the translation note that explains it', () => {
  const text = renderReport(
    makeReport([
      route({
        filled: [
          { id: 'sensenova-6.7-flash-lite', fields: ['reasoningEfforts'], notes: ['端点未提供推理档位表；已按本插件的路由档位声明补齐'] },
          { id: 'qwen/qwen3.8-flash', fields: ['input', 'reasoningEfforts'], notes: ['unsupported effort "ultra" ignored'] },
        ],
      }),
    ]),
  );
  assert.match(text, /~ sensenova-6\.7-flash-lite → reasoningEfforts\n      ! 端点未提供推理档位表；已按本插件的路由档位声明补齐/);
  assert.match(text, /~ qwen\/qwen3\.8-flash → input, reasoningEfforts\n      ! unsupported effort "ultra" ignored/);
});

test('names the aliases it refused to pin', () => {
  const text = renderReport(makeReport([route({ aliases: ['~openai/gpt-astra-latest'] })]));
  assert.match(text, /跳过别名 1/);
  assert.match(text, /端点的移动别名（未写入配置，可在 skipAliases: false 下照收）：~openai\/gpt-astra-latest/);
});

test('stays quiet about delisted models when there are none', () => {
  const text = renderReport(makeReport([route({ notAdvertised: [] })]));
  assert.match(text, /未列出 0/);
  assert.doesNotMatch(text, /端点已不再列出/);
});

test('reports a refused addition as refused, with the refusal reason', () => {
  const text = renderReport(
    makeReport([
      route({
        status: 'written',
        degraded: true,
        detail: 'llm-pi-ai: provider "openrouter" model "qwen/qwen9-future" needs an api',
        refused: ['qwen/qwen9-future'],
      }),
    ]),
  );
  assert.match(text, /已写入（新增被拒，已保住补齐）/);
  assert.match(text, /新增 0（被拒 1）/);
  assert.match(text, /✗ qwen\/qwen9-future（新增被拒，未被写入）/);
  assert.match(text, /needs an api/);
});

test('names the models that need a protocol and the way to declare it', () => {
  const text = renderReport(
    makeReport([
      route({
        status: 'unchanged',
        added: [],
        needsProtocol: ['deepseek/deepseek-v4.1-flash'],
        protocolAdvice: '在 live-model-catalog.routes.openrouter.api 声明该路由的协议（例如 openai-completions）',
      }),
    ]),
  );
  assert.match(text, /需声明协议 1/);
  assert.match(text, /! 需声明协议：deepseek\/deepseek-v4\.1-flash —— 在 live-model-catalog\.routes\.openrouter\.api/);
});

test('surfaces a protocol the plugin wrote, and the discovery state when it is on', () => {
  const text = renderReport(
    makeReport([route({ added: ['deepseek/deepseek-v4.1-flash'], protocolNote: '已为 openrouter 补写 api: openai-completions' })], {
      discovery: { status: 'installed', detail: 'live discovery in place' },
    }),
  );
  assert.match(text, /\+ deepseek\/deepseek-v4\.1-flash/);
  assert.match(text, /\* 已为 openrouter 补写 api: openai-completions/);
  assert.match(text, /发现按钮：installed/);
});

test('renders a route with no live count without inventing one', () => {
  const { liveCount, ...bare } = route({ status: 'skipped', detail: '该路由未声明 models 列表' });
  const text = renderReport(makeReport([bare]));
  assert.match(text, /已跳过（该路由未声明 models 列表）/);
  assert.doesNotMatch(text, /线上/);
});

test('says so when no route is manageable', () => {
  const text = renderReport(makeReport([]));
  assert.match(text, /没有可管理的 llm-pi-ai 路由/);
});

test('labels each kind of add gate in words', () => {
  const gate = (addSince) => {
    const report = makeReport([]);
    return renderReport({ ...report, config: { ...report.config, addSince } });
  };
  assert.match(gate('snapshot'), /仅新增 pi-ai 快照之后发布/);
  assert.match(gate('2026-09-05'), /仅新增 2026-09-05 之后发布/);
  assert.doesNotMatch(gate(''), /仅新增/);
});
