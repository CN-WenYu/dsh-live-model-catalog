# dsh-live-model-catalog —— 需求说明书（供独立审查）

> 本文是给**没有参与开发、也没有本次对话上下文**的审查者看的。所有代码引用都指向本机可读的路径，请直接打开核对；所有数字都可用文末命令复现。
>
> 审查目标：**质疑需求本身是否抓对了根因、是否完整、优先级是否正确、非目标是否合理、验收标准是否可判定**，并指出有没有更简单或更正确的替代方案（包括"本就不该自研"）。

---

## 1. 背景：要解决的两个真实缺口

### 缺口 ①　内置提供方的模型目录是静态快照

`dsh-llm-pi-ai` 的模型发现实现（`<DSH>/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js`）：

```js
// :2272
async function discoverModels(request, storedProfile) {
	if (request.provider !== void 0) {
		const installed = catalogModels(request.provider);   // :2274  读本地内置目录
		if (installed.size > 0) return [...installed.values()]...  // :2275  直接返回，不发网络请求
	}
	if (request.baseURL === void 0 || ...) throw ...
	// 只有"目录里没有的 provider"才会走到下面的 fetch
```

`catalogModels`（:369-373）读的是 `@earendil-works/pi-ai/providers/all` 的 `getBuiltinModels()`，即随包发布的静态数据文件 `dist/providers/data/*.json`。

本机实测（pi-ai `0.85.1`，`providers/data/.manifest.json` 的 `generatedAt = 2026-09-05T11:58:56Z`）：

| 项 | 值 |
|---|---|
| 内置 `openrouter.json` 条目数 | **366**（`openai-completions` 351 + `anthropic-messages` 15） |
| 同一时刻 `https://openrouter.ai/api/v1/models` | **439** |
| `deepseek/deepseek-v4.1-flash`（用户实际要用的模型） | ❌ 不在快照里 / ✅ 在线上 |
| npm 上 pi-ai 最新版 | `0.85.1`（= 已装版本，**升级无法解决**） |

补充事实：`GET {baseURL}/models` 的**列表 URL 规则已经存在**（:2283 起，`openai-completions` → `{base}/models`），即"能上网拿"这条路径是现成的，只是被目录短路绕过了。

### 缺口 ②　手写路由的模型没有思考强度

`resolveModelReasoning`（:562-585）：

```js
const efforts = entry.reasoningEfforts;
if (efforts === void 0) return { reasoning: base?.reasoning ?? false };   // :564
```

`base` 是"同 id 的内置目录条目"。**手写模型没有目录孪生条目 → `reasoning: false` → composer 的思考档位选择器不渲染**（`getSupportedThinkingLevels` 短路成 `["off"]`）。

两处加重这个问题：

- 能力继承按 **provider 路由键**查目录：`catalogModels(provider)` 用的是路由名。路由只要不叫 `openrouter`（例如 `openrouter-mobcool`），即使 model id 与目录完全一致也继承不到 `reasoning` / `input`。
- 官方「模型」页**刻意**不提供 `reasoningEfforts` 编辑框（`dsh-client-ui-settings-models/lib/client.js:1128` 注释："There is deliberately no reasoning-effort control, here or on the editor card"），字段只存在于 `settings.yaml`（schema 见 :967、:974）。

### 缺口 ③（同源，顺带受损）　输入模态

同一套"按路由键查目录"的逻辑，让自定义路由的视觉模型静默退化成纯文本（社区报告 #1992）。用户自己的 `amd-radeon` 路由实测就是这样（见 §6）。

### 缺口 ④　端点自己不说推理能力（缺口 ② 的第三种情形）

缺口 ② 假设"端点会报 `reasoning`，插件只是没去读"。还有一类端点**什么都不报**：商汤日日新的模型清单（`GET https://api.sensenova.cn/v1/llm/models`，见[官方文档](https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/Models/GetModelList)）只给 `id / object / type / owned_by / permission / root / parent / created_at / updated_at`——**没有上下文长度，没有任何 reasoning 字段**，且 `created_at` 是 ISO 字符串而非 unix `created`。实测把这份响应喂给插件的 `translateEntry`：

```
translateEntry(...) → {"id":"sensenova-6.7-flash-lite"}     // 只有 id
planRoute(...).filled = []                                   // 一个字段都补不上
planRoute(...).changed = false
```

同时商汤**不在 pi-ai 目录里**（`sense` / `nova` 匹配 0 个 provider、0 个模型），所以 §1 缺口 ② 那句"能力继承按路由键查目录"在这里连"孪生条目"都不存在。但商汤官方 OpenAI 兼容模式文档里 **`reasoning_effort: "medium"` 是正式请求参数**——即"该支持，但没有任何自动来源"。这类提供方（自建网关同理）只能由用户**按路由声明**档位，插件的责任是把它写进去、并在端点哪天开始报档位时让位。

附带一个独立问题：插件（与 DSH 自己）对 `openai-completions` 拼的清单地址是 `{baseURL}/models`；商汤兼容模式的对话端点在 `/compatible-mode/v2`，模型清单却在 `/v1/llm/models`，**根都不一样**，按默认拼法必然 404。

### 社区与上游状态（说明"为什么不是等上游修"）

- 官方讨论区已有多份同问题报告：[#122](https://github.com/deepseek-ai/deepseek-harness/discussions/122)、[#4071](https://github.com/deepseek-ai/deepseek-harness/discussions/4071)（标题同时命中两个缺口）、[#4685](https://github.com/deepseek-ai/deepseek-harness/discussions/4685)、[#3957](https://github.com/deepseek-ai/deepseek-harness/discussions/3957)。#4071 给出的根因分析与本文件 §1 完全一致。
- 公开仓库 `deepseek-ai/deepseek-harness`：`/issues/new` 与 `/pulls` 均为 **creation is restricted**，且 `0 Open / 0 Closed` PR —— **无法提交上游修复**（社区在 #341 反复呼吁开放）。
- 现有社区插件（`dsh-catalog-refresh`、`@aiwayds/dsh-model-sync`、`dsh-reasoning-effort`、`dsh-better-reasoning-effort` 等）可部分覆盖，但**用户明确要求自研**，理由是：这类插件的维护状态不可控，坏了自己改不动、也不能及时发版。这一点被记录为需求 R7，请审查者独立评估其合理性。

---

## 2. 需求（每条都应可判定）

| # | 需求 | 验收标准（可客观判定） |
|---|---|---|
| **R1** | 受管路由的模型目录与端点保持一致 | **前置条件**：该路由已声明 `models` 列表；目录里没有的模型还需要该路由（或 `live-model-catalog.routes.<name>.api`）能给出协议。满足前置时，快照之后发布的模型（如 `deepseek/deepseek-v4.1-flash`）无需手工编辑即出现在 `llm-pi-ai` 配置中，且随后能被正常选中与请求 |
| **R2** | 手写/自定义路由的模型具备可选的思考档位 | composer 出现 Effort 菜单；子 agent / 任务继承同一条 `models` 条目，因此同样可选（档位属于模型，不属于会话）；每个档位发出的正是端点要求的 wire 值（插件的责任是把这个 dict 声明对，实际发送属 DSH 的 dispatch）；`reasoning.mandatory: true` 的模型不提供"关闭" |
| **R3** | 不因路由命名而丢失能力声明 | 视觉模型在配置里得到 `input: [text, image]`；端点声明推理能力时得到 `reasoningEfforts` |
| **R4** | 范围自动发现，不硬编码 | 新增一个 `llm-pi-ai` 路由后，**无需修改插件配置**即被纳入；「纳入」= 出现在该轮报告里（写入，或带原因的跳过：未声明 `models`、协议不可列举、被禁用），**不存在"静默不管"的路由**；排除靠 `exclude` |
| **R5** | 写入安全，绝不破坏既有配置 | 只增只改；用户手写字段（`name`/`contextWindow`/`reasoningEfforts`…）不被覆盖；无变化不写；与 GUI 并发编辑冲突时不得覆盖未见过的改动 |
| **R6** | 可移除 | 卸载插件后 `settings.yaml` 仍然合法、DSH 原生可正常加载运行 |
| **R7** | 可自行修复（本项目的**首要**动机） | ① 零构建步骤：`translate` / `merge` / `typing` / `listing` / `routes` 在**没有 `node_modules`** 时即可测试；② 不改 DSH 源码、不 patch 进程内模块、不 fork pi-ai（模块 B 是唯一受控例外：默认开启，但必须同时满足 R9 的四条不变量——契约探测、失败降级、运行期可关、范围现算）；③ 对 DSH / pi-ai 的所有耦合集中在 `lib/endpoints.js`（裸 import → 定位查找 → 失败降级）与 `lib/listing.js`（刻意对齐官方 discovery 的 URL/鉴权规则）两处，任何失效只降级为"该路由需要手写 `baseURL`"或"需要声明协议"，并在报告里可见；④ 离线测试秒级可跑 |
| **R8** | 失败可见 | 每条路由的抓取/写入结果（成功/无变化/跳过/失败+原因）都出现在启动日志与 `/model-catalog` 输出里；**需要你动手处置的桶必须点名到 id**（新增、补齐、新增被拒、需声明协议、端点已不再列出），只有纯计数意义的桶（白名单外、早于 addSince）才允许只给数量 |
| **R9** | 不侵入官方运行时 | 主路径只走官方 `ctx.settings.mutate`；唯一例外（修发现按钮）**可以默认开启**（分享场景要求"装上就有反应"，见 §5），但必须同时满足四条：① 启动探测契约，形状不符只告警不安装；② 任何失败只降级为官方答案；③ **运行期可关**并在关闭时原样放回官方发现；④ 受管范围每次调用现算，不冻结 |
| **R10** | 端点沉默的能力可按路由声明（缺口 ④） | `routes.<name>.efforts` 声明档位后，该路由每条**已声明**且缺 `reasoningEfforts` 的模型条目都得到该 dict，报告对每条补齐给出来源说明；声明**只在该路由端点沉默时生效**，端点报出档位表即自动让位（无需删配置）；声明**不覆盖**任何已有 `reasoningEfforts`（含 `false`）；一个只含 `off` 或含非法 wire 值的声明**不写入**并在报告里说明，绝不产生会被 DSH 整体拒绝的字段 |
| **R11** | 未声明的内置提供方，按钮也走端点（缺口 ① 的完整闭合） | 「获取可用模型」对 pi-ai 内置目录里的**全部** provider 走实时端点，**包括尚未写入 `llm-pi-ai.providers` 的那些**；该更宽范围**只回答发现、不写配置**（未声明路由没有 `models` 列表，不允许被创建）；`mode: listed` 保持窄范围承诺；协议不可列举的路由交回官方给出它自己的"请手工录入"提示，不去猜 URL |
| **R12** | 清单地址可按路由覆盖 | `routes.<name>.listingPath` 支持相对路径（拼在 `baseURL` 后）与绝对 URL（原样使用），使对话端点与模型清单不同根的服务（商汤 `/compatible-mode/v2` + `/v1/llm/models`）也能被同步 |

## 3. 非目标（明确不做）

1. 不做自己的 LLM adapter / 不注册自有 provider 路由（那等于自己维护一套模型分发）。
2. 不改 DSH 源码、不 patch 进程内模块、不 fork pi-ai（因此上游升级不会被我们的补丁阻断）。
3. 不代替用户点"采纳"：不主动改 UI 选择状态，只把配置写对。
4. 不管理路由级默认档位（`llm-pi-ai.providers.<route>.reasoning`）——需要时由用户手写，README 说明。
5. 不支持无法列举模型的协议（bedrock / vertex / azure / codex 等，与官方 discovery 的边界一致）——**这是靠预先判定落地、而不是靠"试了再失败"**：镜像官方的 `LISTABLE_PROTOCOLS`，集合外的协议直接跳过并在报告里说明，绝不对端点发这次请求。
6. 不做模型下线删除（端点不再列出的模型**点名报告**，不擅自删配置）。
7. **不写成本与缓存计费**：`llm-pi-ai` 的模型 schema（`modelFields = {name, contextWindow, maxTokens, input, reasoningEfforts, compat}`）**没有 cost 字段**——成本只能从 pi-ai 目录的孪生条目继承（`resolveEntry` 里是 `cost: base?.cost ?? NO_COST`）。因此自定义路由上的模型恒为 0 成本，含 cacheRead / cacheWrite 命中语义。要修得动上游 schema，本插件既不写、也不猜价（端点确实会给 `pricing`，猜错比 0 成本更危险）。
8. **不认识 profile 边界**：写的是用户级的 `~/.dsh/settings.yaml`（`live-model-catalog` 与 `llm-pi-ai` 两段），而插件是按 profile 安装的。所以只有装了本插件的 profile 会刷新这份共享配置；其他 profile 读到同样的模型但不会刷新它。R6 保证此时配置仍合法可加载，故不做 profile 间协调。

## 4. 设计约束（都由 R5/R6/R7/R9 推导而来）

- **写路径唯一**：`ctx.settings.mutate('llm-pi-ai', ops, expectedRevision)`，只写两个字段——`['providers',route,'models']`，以及（仅当该路由没有自己的 `api`、你已在 `routes.<name>.api` 里声明协议、且声明它不会改掉任何既有模型的协议时）`['providers',route,'api']`。读的是 `describe()` 里的**原始 user 层**（`user` + `revision`），不是解析后的值，避免把 schema 默认值物化成显式配置。
- **新增模型必须先过协议闸门**：DSH 按「路由 `api` → 目录孪生条目的 `api` → 整条目录唯一协议」定协议，且一次写入**整体校验**。目录跨协议时，目录外的模型无协议可用，一条这样的条目会拒掉整轮写入（连补齐一起丢）。因此：定不了协议的候选**不进入写入、只报告并给处置**；你在 `routes.<name>.api` 声明后与 `models` 同笔写入；写入若仍被整体拒绝，退回"只写补齐"，保住已能安全落地的部分。
- **必须要求该路由已声明 `models` 列表**：DSH 的 `models` 是"替换"而非"扩展"，对继承整个内置目录的路由写 `models` 会把目录缩成几条。此类路由**跳过并报告**。
- **列取协议来自路由事实，不是猜的**：`routes.<name>.api` → 路由 `api` → 目录里这些模型唯一一致的协议 → 兜底 `openai-completions`。列取的 URL 与鉴权都跟协议走，所以对一条内置 `anthropic` 路由（profile 里通常只写 `apiKeyEnv`）猜 `openai-completions`，会去请求 `api.anthropic.com/models` 并带 bearer，而不是 `/v1/models?limit=1000` + `x-api-key`——一条本来可管理的路由会变成每轮一个看不懂的失败（实测见 §6）。协议不在官方可列举集合内时**先判定再跳过**，不探测。
- **新增闸门默认收紧、且失败即收紧**：`include` 默认空（只补不增——风险高的那一半必须显式开启）；`addSince` 默认 `'snapshot'` = 已装 pi-ai 目录自己的 `generatedAt`（读 `dist/providers/data/.manifest.json`），随 DSH 升级自走，取代会静默过期的硬编码日期。`snapshot` 读不到时**只补不增**并报告原因——**一个解析不了的闸门绝不允许变成敞开的闸门**。实测等价：`addSince: 'snapshot'` 与手写 `'2026-09-05'` 在快照日期为 2026-09-05 的机器上产出完全相同的计划。
- **重试只针对传输失败**：HTTP 回答（含 401 / 404 / **429**）不重试——到达的回答就是答案，对 429 再问一次正是端点明令禁止的；`Retry-After` 原样进报告，而不是自己发明隐形退避。只有 DNS / 连接被拒 / 超时重试 1 次；调用方 `abort` 永不重试。失败既不加速下一轮也不加倍惩罚。
- **唯一依赖** `schemastery`（DSH 注册 settings 命名空间必须要一个 schema），且只有 `lib/config.js` import 它。纯逻辑层（constants、apply、translate、merge、typing、plan、listing、routes、report）因此能**在没有 `node_modules` 的目录里直接跑**——实测把 `lib/` 与这 8 个纯层测试文件拷进空目录：**112 通过 / 0 失败**。只有接线测试（假 ctx + stub fetch）会经过 `config.js`，需要 schemastery 这一项依赖。
- **两个范围，一宽一窄，且写不出去的范围只用于读**：写入范围 = 已声明路由 ∪ `routes` 点名（只有它们有 `models` 列表可补、可增）；发现范围 = 写入范围 ∪ pi-ai 内置目录的全部 provider。发现范围更宽是因为 R11 的场景（按钮最有用的时候正是还没添加那个内置提供方），而它**不写配置**——未声明路由没有 `models` 列表，`hasModelsList` 守卫在写入侧同样拦住它。`mode: listed` 对两者都保持窄语义。
- **声明是"补端点没说的一半"，不是"覆盖端点"**：`routes.<name>.efforts` 只在端点沉默（没报 `reasoning` 对象或压根没列出该模型）时生效，优先级低于模型条目已有的 `reasoningEfforts`、低于端点自己的档位表、也低于端点"报了推理但没给档位表"时的 `defaultEfforts`。校验与端点路径**共用同一套**（`declaredEfforts` / `effortMap`）：非法 level、非 `off` 的空值一律丢弃并报告，因为 DSH 对模型条目整体校验，一个坏字段会拒掉整轮写入。声明只作用于**已声明条目**——本轮新发现的 id 不套用（新发现的一批可能混着不推理的模型），下一轮自愈时补上。
- **不可列举的协议一律交回官方**：模块 B 的实时分支对 `listable === false` 的路由直接返回 `undefined`，让官方抛出它那句"请手工录入模型"，而不是拿 `openai-completions` 的 URL 去猜（R9②的同一条原则：只降级，不发明）。
- **模块 B 的代价已知**：`llm` 服务只暴露 `llm/stream` 一个 waterfall，`registerModelDiscovery` 对同一命名空间会抛 `DUPLICATE_DISCOVERY`（`dsh-llm/lib/index.js:1924`），因此让"发现按钮"实时**没有官方扩展点**，只能包装 `llm.discoveries` 这张表（运行时可得，但无文档承诺）。因为默认开启，R9 的四条不变量是硬约束而非加分项。

## 5. 已实现的行为规格

**模块 A（默认启用）**：对每条受管路由 `GET {baseURL}/models` → 解析 `data` 数组或 `models` 对象 → 翻译为 DSH 模型字段 → 合并 → 写回。

"合并 → 写回"之间还有一道**协议闸门**（见 §4 第二条）：路由给不出协议的候选模型不进入写入，报告点名并给出 `routes.<name>.api` 的处置；声明协议后与 `models` 同笔写入；写入若仍被 DSH 整体拒绝，自动退回只写补齐。

字段来源（OpenRouter 实测响应）：`context_length` / `top_provider.max_completion_tokens` → `contextWindow` / `maxTokens`；`architecture.input_modalities` → `input`；**`reasoning.supported_efforts` → `reasoningEfforts`**（`none` → `off`；`mandatory: true` 时去掉 `off`；端点只说"会推理"而不列举档位时使用可配置预设）。

`input`（模态）的优先级：**端点名单 → 目录孪生条目 → 路由 `defaultInput`**（DSH 缺省 `["text"]`，见 `dsh-llm-pi-ai:906`）。所以按线上补齐可能**加**能力（目录只给 text、线上报 text+image），也可能**覆盖**目录给的更宽集合；DSH 的模态词表只有 `text`/`image`，线上报的 `video` 不会携带。要让目录/默认值说了算，把 `input` 从 `fill` 里去掉；要在某一条上强制，直接写 `input`（用户写过的字段永不覆盖）。

合并策略：已有的只补缺失字段；新 id 仅在 `include` 白名单命中、不早于 `addSince`、且未被端点标为别名（`alias_target`，默认跳过并点名）时追加（`addSince` 默认锚定 pi-ai 快照时间，读不到则只补不增）；无变化不写；写冲突（`SETTINGS_CONFLICT`）重读重算，最多 3 次。端点不再列出的已配模型**点名报告、原样保留**（R8/§3.6）。

节奏：启动一次 + 每 `intervalMinutes`（默认 240）+ `llm-pi-ai` 变化后 1.5 秒自愈 + `/model-catalog sync`；同一 `路由+端点` 进程内缓存 60 秒（模块 A 与发现按钮共用）；HTTP 拒绝不重试且回显 `Retry-After`，传输失败重试 1 次。

自愈：监听 `settings/updated`，`llm-pi-ai` 变化后 1.5 秒补一轮——因为 DSH 自己的"采纳"只拷 `id/name/contextWindow/maxTokens`（`client.js:538-545`），会丢掉 `input` 与 `reasoningEfforts`。

**模块 B（`fixDiscovery`，默认开启）**：包装 `llm.discoveries['llm-pi-ai']`，对发现范围内的路由改走实时抓取，失败回退原函数；启动时探测契约，形状变了只告警不安装。开关在**运行期**即生效（关闭时把当初被包装的官方发现原样放回），包装器的范围**每次调用现算**——后加的路由无需重装即被覆盖。范围按 R11 取"已声明 ∪ 内置目录全部 provider"，不可列举的协议交回官方。报告在「发现按钮」行给出该范围的大小（`接管 N 条路由`），这是"按钮是否真的生效"的第一现场。

**声明式补齐（R10/R12）**：`routes.<name>.efforts` 在端点沉默时补齐 `reasoningEfforts`，报告在对应 `~` 行下给出 `! 端点未提供推理档位表；已按本插件的路由档位声明补齐`；`routes.<name>.listingPath` 覆盖清单地址（相对路径拼 `baseURL`，绝对 URL 原样）。

**范围（R4）**：`mode: auto` 纳管 `llm-pi-ai.providers` 下所有路由（`exclude` 排除）；列取协议解析顺序 = 插件覆盖 → 该路由 `api` → **目录唯一协议** → 兜底 `openai-completions`（集合外即跳过，不探测）；端点解析顺序 = 插件覆盖 → 该路由 `baseURL` → **pi-ai 内置提供方表**（运行时锚点先 `realpath` 再解析——PATH 上的 CLI 是符号链接，`createRequire` 不跟随它；随后通过对 `dsh-llm-pi-ai` 解析位置向上查找 `node_modules/@earendil-works/pi-ai` 定位，纯逻辑失败即降级为"该内置路由需要手写 baseURL"）。

## 6. 已验证的证据

| 验证 | 结果 |
|---|---|
| 单元 + 接线测试 | `npm test` → 163 个用例：**158 通过、0 失败、5 跳过**（跳过的是两条"内置端点解析"用例与三条 `test/discovery-scope.test.mjs`——后者要真实 pi-ai 目录才能验证"未声明的内置提供方也走端点"；两者都由 `DSH_CLI_ENTRY` 驱动，带上后 **163 全通过**，已实测）。覆盖：翻译、合并、轮次规划的两遍决策、列表解析、范围解析、端点与目录协议解析、路由协议判定、addSince 解析、报告渲染、发现包装的安装/还原/范围现算，以及用假 ctx + stub fetch 跑通 `apply()` 全链路（含协议补写、协议冲突拒绝、写入被整体拒绝后退回补齐、运行期关闭发现开关、后加路由进入实时范围、HTTP 拒绝不重试与传输失败重试一次）；0.2.0 新增覆盖：`declaredEfforts` 的非法值处理、端点沉默/未列出两种情形下的声明补齐与"端点优先"、`resolveDiscoveryTargets` 的宽范围与 `listed`/`exclude`/`enabled:false` 边界、`listingPath` 两种拼法、每个补齐的说明行渲染、不可列举协议交回官方；`npm run check` 通过 |
| 协议闸门（只读演练，真实 settings + 真实 openrouter 端点） | 未声明 `routes.openrouter.api` 时：`openrouter` 只写 5 条补齐、报告 `需声明协议 1` 并点名 `deepseek/deepseek-v4.1-flash` 与处置，**不写 v4.1**；声明 `routes.openrouter.api: openai-completions` 后：一笔写入两个 op（`api` + 6 条 models，含 `deepseek/deepseek-v4.1-flash`），报告 `+ deepseek/deepseek-v4.1-flash` 与"已补写 api"。两次演练均未落盘 |
| 只读演练（真实 settings + 真实凭据） | `local` 线上 14 / `openrouter-mobcool` 439（补齐 5）/ `amd-radeon` 5（补齐 3 个 `input`）/ `openrouter[catalog]` 439（补齐 5） |
| ⚠️ 上一条对 `openrouter` 的"新增 `deepseek/deepseek-v4.1-flash`"曾被当成已验证 | **是错的**：`openrouter` 的目录跨 `openai-completions` / `anthropic-messages` 两种协议、路由自己没声明 `api`，DSH 的严格写入校验会以 `model "…" needs an api` **整体拒绝**该笔写入（连 5 条补齐一起丢）。只读演练不经过 `settings.mutate`，所以没暴露。现已修复，见下行 |
| 无 `node_modules` 可测（R7①） | 把 `lib/` 与 `test/{apply,merge,typing,plan,translate,listing,routes,report}.test.mjs` 拷到空目录后 `node --test`：**112 通过 / 0 失败**（该目录下确实没有 `node_modules`） |
| `addSince` 闸门 | 不加时白名单会一次新增 68 个历史模型；加 `2026-09-05` 后降为 0（只保留真正比快照新的） |
| 列取协议推导（用真实 pi-ai 目录跑 `resolveTargets`） | 未声明 `api` 的内置路由：`anthropic` → `anthropic-messages`（`https://api.anthropic.com/v1/models?limit=1000`）、`deepseek` → `openai-completions`、`google` → `google-generative-ai`（**判为不可列举 → 跳过，不发这次请求**）。修复前三条都会用 `openai-completions`：`anthropic` 会请求 `api.anthropic.com/models` 并带 bearer，是一轮一个看不懂的失败 |
| 分享默认值实测（**schema 默认值** + 真实 settings + 真实 openrouter 端点） | 目录 366 / 线上 443 / 目录外 85。默认组合（`include: ['*']`、`addSince: 'snapshot'`、`skipAliases: true`、`fixDiscovery: true`）第一轮：**新增 7 条真实新模型**（`sakana/*`×2、`inclusionai/*`×2、`inception/*`、`nex-agi/*`×2），**跳过 16 条端点别名并逐条点名**，**415 条早于快照**被闸门挡住，发现按钮 `installed`。对比 `include: ['deepseek/*','qwen/*']` 只新增 1 条——对用 openai/anthropic 的人等于没反应，这是默认改用 `['*']` 的依据 |
| ⚠️ 别名标记的形状（同一类盲点） | 端点给的是 **对象** `{ name, slug }` 而不是字符串；早期按字符串实现（且单测 fixture 也写成字符串）导致"测试全绿、生产不生效"，被"用 schema 默认值跑真实端点"的演练抓出。修复后：真实端点识别出 16 条别名，`isAlias` 同时接受对象与字符串两种形状，单测用**真实形状**钉住 |
| `input` 优先级实测（真实 settings + 真实 openrouter 端点） | 5 条未写 `input` 的模型：目录与线上 3 条相同、2 条**线上更宽**（`[text,image,video]`），**收窄 0 条**。结合 DSH 缺省 `DEFAULT_INPUT = ["text"]` 可判定：补齐在常见情形是**加**能力，故**不加**"防收窄"守卫（加了会把"纠正只在文本上正确的模型"退回成过度声明） |
| 非 JSON 值（接线） | 条目里放一个未加引号的 YAML 日期（`Date`）→ 在写入前被拦下，报告点名 `models.0.created 是 Date` 并给出"加引号"的处置；`settings.mutate` **未被调用** |
| ⚠️ **内置端点解析在生产形态下必然失败**（本轮由用户实测暴露，已修） | 真实进程的 `process.argv[1]` 是 `~/.npm-global/bin/dsh`——**PATH 上的符号链接**，而 `createRequire` 不跟随符号链接 → `MODULE_NOT_FOUND` → 目录定位失败 → `openrouter`（settings 未写 `baseURL`，靠目录）每轮 `失败（no baseURL）`，**什么都不写**。此前所有演练都把 `argv[1]` 换成真实路径，因此从未复现。修复：锚点增加 `realpathSync` 变体；回归测试**用符号链接**跑（`builtinEndpoints(link)`）。修复后同一锚点：`pi-ai providers: 32 (anchored)`，`openrouter` 端点来自 catalog，计划 `+ deepseek/deepseek-v4.1-flash` |
| R5 并发冲突（接线） | 首笔以 revision 2 被拒（模拟 GUI 同时改名并推进到 9）→ 重读重算 → 第二笔带 revision 9，**保留它没见过的改名**，且仍带新增（证明走的是冲突重试而非"只写补齐"降级） |
| `addSince: snapshot` 等价性（只读演练，真实 settings + 真实 pi-ai） | 解析出 `generatedAt = 2026-09-05T11:58:56.761Z`；与手写 `'2026-09-05'` 产出**完全相同**的计划（新增 1 = `deepseek/deepseek-v4.1-flash`）。pi-ai 快照无法定位时：只补不增 + 报告写明原因（有单测钉住） |
| ⚠️ **内置 provider 未声明时按钮仍回快照**（漏洞，0.2.0 修） | 旧实现把「发现范围」等同于「写入范围」= `llm-pi-ai.providers` 的键 ∪ `routes` 的键。而 DSH 会把 pi-ai 的**全部** provider 列在「模型」页（`directoryEntries` 遍历 `catalogProviderIds()`），点这些还没添加的卡片时 `request.provider` 是那个 id，`isManaged` 为假 → 放行 → 官方 `discoverModels` 命中内置目录短路 → **快照**。用真实目录跑 `resolveTargets({providers:{}})` 得 **0 条**，即"一个都没管"。修复：新增 `resolveDiscoveryTargets`（未声明 provider 用目录 baseURL + 目录共识协议合成 target，只读不写）。同一目录下现在得 **32 条**（29 条可列举）。接线演练（真实 pi-ai 目录 + stub fetch，只声明了一条非内置路由）：问未声明的内置 `deepseek` → 实际请求 `https://api.deepseek.com/models` 并返回线上 3 条（**不再回快照**）；问 `google`（不可列举）→ 交回官方答案且**不发请求**；报告 `内置端点：pi-ai providers: 32 (anchored)`、`发现按钮：installed（接管 33 条路由）` |
| ⚠️ **端点不报推理 → 插件静默什么都不补**（缺口 ④ 实测，0.2.0 修） | 把商汤文档的 `/v1/llm/models` 响应形状喂给 `translateEntry`：输出只有 `{"id":…}`，`planRoute().filled = []`、`changed = false`——能力一个都补不上，思考档位自然永远不出现。且 `sense`/`nova` 在 pi-ai 目录里匹配 **0** 个 provider / 0 个模型，继承路径也断。修复：`routes.<name>.efforts` 声明 + `listingPath` 覆盖；单测与接线测试各钉住一条 |
| 安装 | `dsh plugin --profile web add link:...` 成功；`bundles` 已含本插件；`node_modules` 是 symlink（改代码即时生效）；`dsh --profile web --dump-config` 已包含 `id: live-model-catalog` |
| 尚未验证 | **真实 profile 运行**（进程未重启，插件未加载；磁盘上的 `settings.yaml` 至今未被插件写过） |

## 7. 开放问题（请审查者判断）

1. `addSince` 默认空 = 白名单会拖入整条产品线历史；默认值该不该设、设成什么？
2. 模块 B 值得存在吗？（唯一的内部字段依赖 vs "按钮返回旧列表"这个体验缺口）
3. 模型下线的处理（只报告不删除）是否够？
4. 端点限流/缓存策略（当前：进程内 60 秒缓存 + 240 分钟周期 + 启动一次）是否合理？
5. 是否需要覆盖 `dsh-llm-deepseek` 等**其他 namespace** 的路由？（当前只写 `llm-pi-ai`）
6. 与官方 [#3752](https://github.com/deepseek-ai/deepseek-harness/discussions/3752) 提出的 active-refresh 设计、以及 `dsh-model-sync` / `dsh-catalog-refresh` 相比，自研的净收益是否成立？

> **第二轮审查后已处置**：Q1 / Q2 / Q3 / Q4 / Q5 / Q6 —— 见下。
>
> - **Q1（`addSince` 默认值）**：已定并实现。`include` 默认 **空**（只补不增）；`addSince` 默认 **`'snapshot'`**，锚定已装 pi-ai 的 `generatedAt`（随 DSH 升级自走，取代会静默过期的硬编码日期）；`snapshot` 读不到则**只补不增**并报告。实测与手写日期等价（§6）。
> - **Q2（模块 B 值不值得存在）**：保留，但补掉两个实测缺陷——开关**运行期生效**（关闭时原样放回官方发现），受管范围**每次调用现算**（不再冻结安装时的路由集）。主开关 `enabled: false` 同样会还原。
> - **Q3（下线只报告是否够）**：不够，已**点名到 id**。R8 相应收紧为"需要读者动手的桶必须点名"。
> - **Q4（限流/缓存）**：缓存与周期合理（4 路由 × 4h = 4 次请求，可忽略；60s 缓存让模块 A 与按钮共用一次抓取），**重试策略不合理并已改**：HTTP 回答（含 429）不再盲重试，`Retry-After` 进报告；只有传输失败重试 1 次；调用方 abort 永不重试。失败不加速下一轮，避免隐形退避掩盖问题。
> - **Q5（其他 namespace）**：列为非目标 §3.8 前先核实过：`llm-deepseek` 确有同类静态目录（`DEFAULT_MODELS` 硬编码、`listModels` 不联网），但模型 schema 完全不同（`inputModalities`、路由级单一 `reasoningEffort`、`models` 带 schema 默认值 → 现有 `hasModelsList` 守卫会误判），扩展不是复制粘贴。
> - **Q6（自研净收益）**：成立，但理由要改写——不是"社区插件维护不可控"（见下），而是**数据源 + 协议闸门 + 写入语义 + 零构建**四条。见本节对照表。

另修正一处早期判断：`input` 补齐在常见情形**不会**收窄能力（DSH 缺省 `DEFAULT_INPUT = ["text"]`，实测 0 条收窄），因此不加"防收窄"守卫，改为把优先级与 `fill` 旋钮写清（§5）。

补充 Q6 的第三方事实（`npm view` + `npm pack` 后读源码，2026-09 实测）：

| 包 | 最近发布 | 体积 / 构建 | 与 R1+R2 的关系 |
|---|---|---|---|
| `dsh-catalog-refresh` 0.5.0 | 2026-08-30 | 18 KB，零依赖，无构建 | **直接 patch 进程内 pi-ai 的 `MODELS` 注册表**，再往 `llm-pi-ai.headers` 写一个 stamp 触发重解析。R1 覆盖最全（连发现按钮一起修，且不往配置里塞 400 条模型），代价正是 §3.2 排除的那一条：patch 内部模块。**若哪天愿意放宽 §3.2，这是最省配置的路线。** 无 revision/冲突处理、无 `addSince` |
| `@aiwayds/dsh-model-sync` 0.4.0 | 2026-09-11 | 69 KB，需 `tsc` 构建，9 个测试文件 | 与本品最重叠：走 `settings.mutate` + `expectedRevision` + `SETTINGS_CONFLICT` 重试，也用 `modelOverrides`（并知道"DSH 拒绝 models 与非空 overrides 并存"）。但**数据源是 `https://pi.dev/api/models/providers/<route>` 网关**，不是路由自己的 `{baseURL}/models`；且对**跨协议目录是"丢弃无法投递的条目"**（README 的 "drop logic for mixed-protocol routes"、`dropUnserviceable`）——即 `openrouter` 上的 v4.1 它会丢，本插件则通过补写路由 `api` 让它落地 |
| `dsh-better-reasoning-effort` 0.3.9 | 2026-09-10 | 848 KB，需构建 host+client | 走**内置知识库**：按 id/name 模式硬编码各模型的档位与 wire 拼写，再叠加端点信号与协议推断（正是本项目刻意不做的"猜"）。体积与维护面最大 |

三个包都在近两周内发布过，所以"社区插件维护状态不可控"作为**一般性**理由站不住；净收益的真正来源是：① 数据源是**你这条路由自己的端点**（对 `local` / `amd-radeon` 这类自建端点，pi.dev 网关无从覆盖）；② 目录外模型**靠声明协议落地而不是被丢弃**；③ 只走官方 settings 接缝、带 revision 与逐路由可见报告；④ 零构建步骤 + 全部耦合集中在两处且可降级（R7）。反过来，若把"配置里不留模型列表"看得比"不 patch 内部模块"更重要，则应选 `dsh-catalog-refresh` 的路线——那是一个真正的取舍，不是优劣。

## 8. 审查指南（建议按此顺序）

1. **复核根因**：打开 §1 引用的行号，确认两个缺口的描述与代码一致；如有出入，指出。
2. **质疑需求**：R1–R12 有没有遗漏？（例如成本字段、缓存命中语义、子 agent 的模型/档位继承、多 profile、`/model` 命令与 UI 的一致性）
3. **质疑非目标**：§3 里哪一条其实应该做？
4. **质疑验收标准**：哪条不可判定或不可复现？
5. **质疑实现是否满足需求**：重点看 `lib/merge.js`（只增只改是否真的安全）、`lib/typing.js`（协议闸门与"改写既有模型协议"的安全核对）、`lib/apply.js`（写路径与冲突处理）、`lib/index.js`（生命周期、自愈是否会成环）、`lib/discovery.js`（契约探测、运行期还原、范围是否冻结）。
6. **评估替代方案**：有没有更简单/更少代码/更少维护成本的路径达到 R1+R2？

## 9. 复现与自测命令

```sh
npm test                 # 163 个离线用例，不联网
npm run check            # 语法检查
DSH_CLI_ENTRY="$(command -v dsh | xargs realpath)" npm test   # 额外覆盖内置端点解析
# 注意：只读演练若要复现生产，argv[1] 必须是 PATH 上的符号链接（`command -v dsh`），
#       而不是它指向的真实路径——否则会掩盖"锚点不跟随符号链接"这类缺陷

# 只读核对根因（不要修改这些文件；DSH=<dsh 安装目录>）
ls  "$DSH/node_modules/@earendil-works/pi-ai/dist/providers/data/"
sed -n '2270,2290p' "$DSH/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"   # 内置发现短路
sed -n '560,586p'   "$DSH/node_modules/@deepseek-ai/dsh-llm-pi-ai/lib/index.js"   # 手写模型的 reasoning 解析
curl -s https://openrouter.ai/api/v1/models | python3 -c "import sys,json;print(len(json.load(sys.stdin)['data']))"
```

**请勿修改** `~/.dsh` 下的任何文件与 DSH 安装目录；如需实验请在 `/tmp` 下进行。
