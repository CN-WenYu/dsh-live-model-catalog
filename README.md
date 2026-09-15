# dsh-live-model-catalog

[English](README.en.md) | 中文

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.1-4c6ef5.svg)](#前置条件)
[![no build step](https://img.shields.io/badge/build-none-2f9e44.svg)](#开发)

让 DSH 的 `llm-pi-ai` 路由始终跟着端点自己的 `GET {baseURL}/models` 走：**内置提供方也能列出线上模型**，并自动补齐 `contextWindow` / `maxTokens` / `input` / `reasoningEfforts`（思考强度）。

它只通过 DSH 官方的 settings 接缝写配置——**不打补丁、不改 DSH 源码、不 fork pi-ai**。它写下的都是 `llm-pi-ai` schema 里本来就有的字段，所以卸载插件之后配置依然合法，DSH 原生照常工作。

---

## 目录

- [特性](#特性)
- [为什么需要它](#为什么需要它)
- [前置条件](#前置条件)
- [安装](#安装)
- [快速开始](#快速开始)
- [配置](#配置)
- [工作原理](#工作原理)
- [进阶配置](#进阶配置)
- [排错](#排错)
- [边界与非目标](#边界与非目标)
- [开发](#开发)
- [许可](#许可)

## 特性

- **模型目录实时**：内置提供方（`openrouter`、`deepseek`…）的「获取可用模型」直接问端点，而不是读随 pi-ai 打包的静态快照；
- **自动补齐能力**：把端点声明的 `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` 写进配置，手写模型也能在 composer 里选思考档位；
- **思考档位可声明**：端点报 `reasoning.supported_efforts` 就自动翻译；端点沉默的（商汤这类），由你按路由声明一次；
- **只增只改**：已存在的模型条目只补缺失字段，你写过的值一律不动；没有变化就不写文件；
- **写入安全**：每笔写入带 `expectedRevision`，与 GUI 同时编辑时重读重算，不覆盖你没见过的改动；
- **失败可见**：每条路由的结果（写入 / 无变化 / 跳过 / 失败+原因）都会进报告，需要你动手的项**点名到模型 id**。

## 为什么需要它

DSH 里有三个缺口，症状不同、根因也不同：

**① 内置提供方拿不到新模型。** `dsh-llm-pi-ai` 的模型发现只要发现 provider id 是 pi-ai 内置目录里有的，就直接返回随包发布的静态快照，**根本不发网络请求**。实测本机：不装插件时对 `openrouter` 发起发现 → 返回 **366 条快照、0 次网络请求**；装上插件后同一个调用 → **线上列表、1 次请求到 `openrouter.ai/api/v1/models`**。

**② 自定义路由没有思考强度。** `resolveModelReasoning` 对"没有内置目录孪生条目"的手写模型返回 `{ reasoning: false }`，于是 composer 的档位选择器不渲染；官方「模型」页又**刻意**不提供 `reasoningEfforts` 编辑框。而且能力继承是**按 provider 路由键**查目录的——路由只要不叫 `openrouter`，即使 model id 与目录完全一致也继承不到任何能力。

**③ 端点自己不说推理。** 有些端点的 `/models` 只给一串 id（商汤日日新的清单只有 `id/type/owner/created_at`，既没有上下文长度也没有 reasoning 字段），而它又不在 pi-ai 目录里，所以没有任何可继承的来源。这种只能**由你声明**——见「[进阶配置](#进阶配置)」。

本插件的做法：读每条受管路由自己的 `/models`，把模型 id 与能力字段写进 `llm-pi-ai`；端点沉默的部分由你声明，插件负责写进去，并保证**端点的答案永远优先**。

## 前置条件

| 项 | 要求 |
|---|---|
| DSH | `0.1.5-rc.1` 实测通过（更早/更新的版本请先跑 `npm test`） |
| pi-ai | `0.85.1` 实测通过 |
| 构建 | 无。零构建步骤、无打包 |
| 运行时依赖 | 只有 `schemastery`（注册 settings 命名空间必须给一个 schema；安装插件时一起装上，不需要你准备） |
| profile | `$DSH_HOME/profiles/<name>`（多数人用的是 `web`） |

它贴着下面这些契约写，升级 DSH 后出问题先看它们：

- **DSH settings**：`register / describe()`（读原始 user 层）/ `mutate(ops, expectedRevision)` / `SETTINGS_CONFLICT`；
- **`dsh-llm-pi-ai`**：`llm.discoveries` 表（唯一触碰内部字段的地方）、`THINKING_LEVELS`、`LISTABLE_PROTOCOLS`、模型协议解析顺序（路由 `api` → 目录孪生条目 → 目录唯一协议）；
- **pi-ai**：`providers/all` 的 `builtinProviders` / `getBuiltinModels`，以及 `data/.manifest.json` 的 `generatedAt`。

## 安装

```sh
# 从仓库安装（尚未发布到 npm）
dsh plugin --profile web add github:CN-WenYu/dsh-live-model-catalog

# 钉在某个提交上（可复现）
dsh plugin --profile web add "github:CN-WenYu/dsh-live-model-catalog#<commit-sha>"

# 本地开发：link 安装，改代码即时生效（仍需重启 profile）
dsh plugin --profile web add link:<本仓库路径>
```

**装完必须重启正在运行的 profile**，插件只在启动时加载：

```sh
dsh web          # 或 dsh --profile <你的 profile 名>
```

profile 不叫 `web` 时，把 `--profile` 换成 `$DSH_HOME/profiles/` 下的目录名（例如 `tui`）。卸载同样要先移除再重启：

```sh
dsh plugin --profile web remove dsh-live-model-catalog
dsh web
```

## 快速开始

1. 装好、**重启** profile。
2. 打开 **设置 → 模型 → 你的路由 → 「获取可用模型」**，现在它列的是端点上的全部模型——**内置提供方也一样**，哪怕你还没把它添加进 settings。
3. **采纳一次**，这条路由由此有了 `models` 列表。（DSH 的采纳只拷 `id/name/contextWindow/maxTokens`，缺的 `input` / `reasoningEfforts` 插件会在 1.5 秒内补齐。）
4. 之后每轮同步都会自动补上比 pi-ai 快照更新的新模型。

两条按需追加的配置：

- 路由的**目录跨了多种协议**（`openrouter`、`github-copilot` 是这种）→ 加一行 `routes.<name>.api`，否则它无法接纳目录外的新模型；
- 提供方**不在 pi-ai 目录里、端点也不报推理**（商汤这类）→ 加一行 `routes.<name>.efforts`，否则思考档位永远不出现。

> **注意（内置 + 跨协议路由的一个坑）。** 目录跨协议的内置路由在缺 `api` 时，**GUI 的「保存」会被 DSH 拒绝**，报 `provider "openrouter" model "…" needs an api`。原因是「模型」页只对**不在目录里的** provider 渲染协议选择框，而 DSH 要求协议只能是路由级的。解药是先补上 `api`，两种做法见「[进阶配置](#进阶配置)」第一条。

## 配置

写在 `~/.dsh/settings.yaml`（插件注册自己的 `live-model-catalog` 命名空间）：

```yaml
live-model-catalog:
  mode: auto                 # auto = llm-pi-ai 下所有路由都管；listed = 只管理 routes 里点名的
  exclude: []                # 想放过的路由（auto 模式下生效），如 ['local', '*-experimental']
  routes: {}                 # 逐路由覆盖，见「进阶配置」
  include: ['*']             # 允许被"新增"的 id 白名单；留空 = 只补齐不新增
  addSince: 'snapshot'       # 只新增 pi-ai 快照之后发布的模型；也可写日期/秒；留空 = 不设下限
  skipAliases: true          # 端点自称别名的 id 不写入配置（会随端点漂移）
  fill: [contextWindow, maxTokens, input, reasoningEfforts]
  defaultEfforts: { off: none, high: high, max: max }
  fixDiscovery: true                  # 是否同时接管「获取可用模型」按钮
  startupDelaySeconds: 5              # 启动后延迟多久跑第一轮
  intervalMinutes: 240                # 周期刷新；0 = 只在启动时跑一次
  requestTimeoutSeconds: 20
```

| 字段 | 作用 | 默认 |
|---|---|---|
| `mode` | `auto` = 自动纳管 `llm-pi-ai` 下所有路由；`listed` = 只管理 `routes` 点名的 | `auto` |
| `exclude` | `auto` 模式下要放过的路由名 glob | `[]` |
| `routes.<name>` | 逐路由覆盖 `enabled` / `baseURL` / `api` / `apiKeyEnv` | 无 |
| `routes.<name>.efforts` | 该路由的推理档位声明（`档位: wire 值`）；只在端点沉默时生效 | `{}` |
| `routes.<name>.listingPath` | 模型清单不在 `{baseURL}/models` 时的覆盖 | `''` |
| `include` | 允许自动新增的 id glob；`*` 跨 `/` | `['*']`（所有厂商） |
| `addSince` | 只新增该日期/时间戳之后发布的模型；`snapshot` = pi-ai 快照自己的生成时间 | `'snapshot'` |
| `fill` | 允许补齐的字段 | 全部四个 |
| `defaultEfforts` | 端点**报了 `reasoning` 对象但没给档位表**时的全局预设 | `{off: none, high: high, max: max}` |
| `skipAliases` | 端点标为别名的 id 是否跳过（`alias_target`） | `true` |
| `fixDiscovery` | 是否同时接管「获取可用模型」按钮 | `true` |
| `startupDelaySeconds` / `intervalMinutes` | 第一轮延迟 / 周期 | `5` / `240` |
| `requestTimeoutSeconds` | 单次请求超时 | `20` |

> **写入前提：该路由必须先有 `models` 列表。** DSH 的 `models` 语义是"替换"而非"扩展"，对一条靠继承拿整个内置目录的路由写 `models` 会把目录缩成你写的那几条。所以这类路由**只跳过、不写入**，并在报告里说明。
>
> **新增有三道闸门。** `include` 默认 `['*']`（所有厂商），但 `addSince` 默认 `'snapshot'`——取的是**已装 pi-ai 目录自己的生成时间**，DSH 升级 pi-ai 时它跟着走，不需要你改日期；端点标为别名的 id 默认跳过。实测（快照 2026-09-05 的机器，OpenRouter 第一轮）：**新增 7 条真实新模型**、**跳过 16 条端点别名**（逐条点名）、**挡住 415 条早于快照的历史**。想只补不增就把 `include` 写成 `[]`。
>
> **读不到 `snapshot` 时只会更严。** pi-ai 定位失败时 `addSince` 解析不出来，插件**只补不增**并说明原因——一个解析不了的闸门绝不会变成敞开的闸门。想真的不设下限，把 `addSince` 显式写成空。

## 工作原理

一轮同步做两件事：**写配置**（模块 A）和**回答「获取可用模型」**（模块 B）。两者共用一次抓取。

### 两个范围不一样

| 范围 | 包含 | 用在哪 |
|---|---|---|
| **写入范围**（模块 A） | `llm-pi-ai.providers` 里**已声明**的路由 + `routes` 里点名的 | 补齐能力、追加新模型——**只会写你已经写过的路由** |
| **发现范围**（模块 B） | 上面那些 **＋ pi-ai 内置目录里的全部 provider**（实测 32 条） | 只回答按钮，**从不写配置** |

发现范围故意更宽，因为按钮最有用的时刻恰恰是**你还没添加那个内置提供方**：DSH 会把 pi-ai 的每个 provider 都列在「模型」页上（哪怕 settings 里一个都没写），而它的官方发现对这些 id 一律回快照。未声明的内置 provider 没有 `models` 列表，所以这条更宽的范围**不可能凭空替你创建路由**。

### 模块 A：写入

- 对每条受管路由抓 `{baseURL}/models`，解析标准 `data` 数组或富信息 `models` 对象；
- **只增只改**：已存在的模型条目只补缺失字段；新 id 仅在 `include` 命中、不早于 `addSince`、未被标为别名时追加；
- **新增先过协议关**：路由给不出目录外模型的协议时，不写也不猜，报告点名并给处置；万一整笔写入仍被 DSH 拒绝，自动退回"只写补齐"，不牵连已能落地的部分；
- **无变化不写**，且每笔写入带 `expectedRevision`；
- **自愈**：DSH 自己的「采纳」只拷 `id/name/contextWindow/maxTokens`，会丢掉 `input` 与 `reasoningEfforts`；插件监听 `llm-pi-ai` 变化，1.5 秒后补回来（幂等，不会成环）。

### 模块 B：发现（`fixDiscovery`）

内置路由的按钮由 `dsh-llm-pi-ai` 直接回静态快照，而**没有官方扩展点**——`llm` 服务只暴露一个 `llm/stream` waterfall，`registerModelDiscovery` 对同一命名空间会抛 `DUPLICATE_DISCOVERY`。唯一可行的是包装 `llm.discoveries` 这张表。

这是一个**内部字段**，所以模块 B 写成"能坏就坏得响亮"，四条性质同时成立：

- **启动探测契约**：形状变了只打一条警告并完全不安装，模块 A 不受影响；
- **失败只降级**：实时抓取失败就回退官方答案；
- **运行期可关**：改成 `fixDiscovery: false` 会立刻把官方发现放回去，不需要重启，重启后也不残留；
- **范围每次调用现算**：不冻结安装时的路由集，后加的路由无需重装包装器就被覆盖。

另外：**协议不可列举就交回官方**（`google-generative-ai` 这类 DSH 自己就没有清单读取方式，插件不猜 URL），报告里的 `发现按钮：installed（接管 32 条路由）` 是诊断按钮是否生效的第一现场。

### 端点与协议的解析顺序

```
端点：本插件的 routes.<name>.baseURL  →  llm-pi-ai 该路由的 baseURL  →  pi-ai 内置提供方表
协议：本插件的 routes.<name>.api      →  该路由的 api  →  目录里这些模型唯一一致的协议  →  openai-completions
```

第三层端点靠一条有守卫的解析链拿到（优先裸 import；否则把锚点 `realpath` 后再从 `dsh-llm-pi-ai` 的解析位置向上找 —— PATH 上的 `dsh` 是符号链接，不解析成真实路径就找不到；两者都失败就只在报告里说明），所以内置 `openrouter` 这类路由不需要你手写端点。

**协议为什么不能猜**：列取的 URL 与鉴权都跟协议走。给一条内置 `anthropic` 路由（profile 里通常只写 `apiKeyEnv`）猜 `openai-completions`，就会去请求 `api.anthropic.com/models` 并带 bearer，而不是 `/v1/models?limit=1000` + `x-api-key`——一条本来完全可管理的路由会变成每轮一个看不懂的失败。协议不在官方可列举的三种之内时，插件**先判定再跳过**，不去探测。

## 进阶配置

### 跨协议目录的路由：`routes.<name>.api`

DSH 给一个模型定协议的顺序是 **路由 `api` → 目录里同 id 条目的 `api` → 整条目录唯一协议**。所以**目录里没有的模型**在两种情况下一无所有：路由自己没声明 `api`，而它的目录又跨了不止一种协议（典型是内置 `openrouter`：366 条里同时有 `openai-completions` 与 `anthropic-messages`）。

更麻烦的是 DSH 对一次配置写入**整体校验**：这样一条模型会让**整轮写入被拒**，连本来能安全写进去的 `input` / `reasoningEfforts` 一起丢掉。

插件因此做两件事：

1. 这种候选模型**不进入写入**，改为在报告里点名并给出一句可照抄的处置（`需声明协议：…`）；
2. 你在 `routes.<name>.api` 里声明之后，插件把它**和 `models` 放进同一笔写入**——只在该路由原本没有 `api` 时写，而且会先核对：**若声明它会改掉任何既有模型的协议，就拒绝写入并说明是哪些模型**。

协议由你声明、插件不猜：猜错意味着那个模型的每次请求都失败，比一次可见的拒绝更糟。

**如果你是"内置 + 跨协议"路由，且 GUI 保存报 `needs an api`**，按下面任一顺序做：

| 做法 | 步骤 |
|---|---|
| **让插件写**（推荐） | ① 先在 GUI 里**采纳一次目录里已有的模型**（这一步会成功，那些模型在目录里有生条目）→ ② 加 `routes.<name>.api: openai-completions` → ③ `/model-catalog sync`，插件把 `api` 与目录外的新模型**同笔写入** |
| **自己写一行** | 直接在 `~/.dsh/settings.yaml` 的 `llm-pi-ai.providers.<route>` 下加 `api: openai-completions`（DSH 的「模型」页对内置 provider 不渲染协议选择框，所以只能这样声明） |

### 端点不说推理：`routes.<name>.efforts`

商汤日日新这类端点，模型清单里既没有上下文长度也没有 reasoning 字段，而且不在 pi-ai 目录里——**没有任何可继承的来源，只能声明**：

```yaml
llm-pi-ai:
  providers:
    sensenova:
      api: openai-completions
      baseURL: https://api.sensenova.cn/compatible-mode/v2
      apiKeyEnv: SENSENOVA_API_KEY
      models:
        - id: sensenova-6.7-flash-lite
          contextWindow: 262144
          maxTokens: 65536

live-model-catalog:
  routes:
    sensenova:
      efforts: { low: low, medium: medium, high: high }
```

`llm-pi-ai` 里的 `models` 保持干净（只写 id 和端点不给的容量），档位声明放在插件自己的 `routes` 下——"哪些是端点说的、哪些是你声明的"一眼可分，报告里也会写明它按声明补了哪几条。

档位的来源有优先级，**高优先级永远覆盖低优先级**：

| 顺序 | 来源 | 生效条件 |
|---|---|---|
| 1 | 模型条目里已有的 `reasoningEfforts` | 你已经写了——插件**只补不改**，绝不覆盖 |
| 2 | 端点 `/models` 里的 `reasoning.supported_efforts` | 端点报了档位表（`none` → `off`）；`reasoning.mandatory: true` 时不提供"关闭" |
| 3 | `defaultEfforts` 全局预设 | 端点报了 `reasoning` 对象但没给档位表 |
| 4 | `routes.<name>.efforts` 路由声明 | 端点什么都没说，或压根没列出这个模型 |

几个要点：

- **只在端点沉默时生效**。端点哪天开始报 `supported_efforts`，端点的答案立刻接管，无需删配置；
- **`reasoningEfforts: false` 就是不补**。声明会套到该路由每个缺档位的条目上，某个模型其实不推理（或你不想要档位）就在那条上写 `false`，DSH 读作"非推理模型"，插件也会跳过；
- **`off` 要么不写，要么写 `off: null`**。不写 = 不提供"关闭"；`off: null` = 选关闭时干脆不发这个参数。别写 `off: none`，除非端点真的认这个值；
- **值就是发给端点的 wire 值**。商汤兼容模式文档里的正式参数是 `reasoning_effort: "medium"`，而 pi-ai 对非特殊 host 默认 `supportsReasoningEffort: true` + `thinkingFormat: 'openai'`，所以上面那份声明会真的发出 `reasoning_effort: "low|medium|high"`；
- **走字符串 `thinking` 的模型要另配 `compat`**。若某模型在网关上的开关是 `thinking` / `enable_thinking`，在那条模型条目上加 `compat: { thinkingFormat: string-thinking }`，并让档位值等于该字段要的字符串；
- **只补"已声明"的条目**。本轮才新发现的 id 不套用声明（新发现的一批里可能混着不推理的模型，批量标记是错的）；它写进配置后，下一轮自愈会把档位补上。

### 模型清单不在 `/models` 上：`routes.<name>.listingPath`

插件（和 DSH 自己）对 `openai-completions` 拼的清单地址是 `{baseURL}/models`。有些服务不是这样——商汤兼容模式的对话端点在 `/compatible-mode/v2`，模型清单却在 `/v1/llm/models`（[官方文档](https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/Models/GetModelList)），根都不一样：

```yaml
live-model-catalog:
  routes:
    sensenova:
      listingPath: https://api.sensenova.cn/v1/llm/models   # 绝对 URL：原样使用
    internal-gw:
      listingPath: /catalog/v2/models                       # 相对路径：拼在 baseURL 后面
```

清单读不到时只有这条路由报 `失败（… answered 404）`，其余路由不受影响。

## 排错

### 命令与报告

```sh
# 在 DSH 会话里
/model-catalog status     # 看上一轮结果
/model-catalog sync       # 立刻跑一轮
```

启动日志每个路由一行，例如：

```
[live-model-catalog] live-model-catalog —— 触发：startup
[live-model-catalog] 白名单：*（仅新增 pi-ai 快照之后发布）　补齐字段：contextWindow, maxTokens, input, reasoningEfforts　修按钮：开
[live-model-catalog] - openrouter：已写入
[live-model-catalog]     线上 443 个模型；新增 7；补齐 0；未列出 0；白名单外 0；早于 addSince 415；跳过别名 16
[live-model-catalog]     + sakana/fugu-max
[live-model-catalog]     ~ deepseek/deepseek-v4.1-flash → input, reasoningEfforts
[live-model-catalog]     ~ sensenova-6.7-flash-lite → reasoningEfforts
[live-model-catalog]       ! 端点未提供推理档位表；已按本插件的路由档位声明补齐
[live-model-catalog] 发现按钮：installed（接管 32 条路由） — live discovery installed over the installed catalog
```

`接管 32 条路由` 是发现范围的大小（你声明的路由数 + pi-ai 内置 provider 数）——它是"按钮是否真的生效"的第一现场：`0` 说明插件一条都没管住；比「模型」页上的 provider 数少，通常是 pi-ai 定位失败，同一份报告里的 `内置端点：` 行会说明原因。每个补齐都会在自己的 `~` 行下带一条 `!` 说明，所以"值是从哪来的"不用猜。

### 常见症状

| 症状 | 先看哪里 |
|---|---|
| 什么都没发生 | 报告里是否列出该路由；`exclude` 是否把它排除了 |
| 报告里出现 `无法列举模型` | 该路由的协议不在 `openai-completions` / `openai-responses` / `anthropic-messages` 之内（与官方 discovery 同边界）；跳过、不探测。要管它就得先在 `routes.<name>.api` 里声明一个可列举的协议 |
| 提示 `no baseURL` | 端点三层都没解析出来（报告里的「内置端点」行会说明原因），在该路由的 `routes.<name>.baseURL` 里补上 |
| 某个路由总失败 | 用 `exclude` 放过它；报告里会写失败原因（401 / 超时 / 返回不是 JSON），429、503 还会带上 `retry-after` |
| 提示 401 / 403 | 该路由的 `apiKeyEnv` 能否在凭据或环境变量里解析 |
| 报告里出现 `需声明协议：…` | 该路由的目录跨多种协议而自己没声明 `api`；见「进阶配置」第一条 |
| **GUI 保存报 `needs an api`** | 同上：内置 + 跨协议路由缺 `api`，而「模型」页不提供该控件。两种做法见「进阶配置」第一条的表格 |
| 报告里出现 `新增被拒` | 写入被 DSH 整体校验拒绝（原因就在这一行）；补齐已落盘，按原因处理后重跑 |
| 新增了太多模型 | 收窄 `include`；`addSince` 用默认的 `snapshot` 或显式日期 |
| 报告里出现 `addSince: "snapshot" 无法解析` | 读不到 pi-ai 的快照时间，本轮只补不增；写显式日期即可恢复，或留空以真的不设下限 |
| 报告里出现 `端点已不再列出` | 这些模型端点已不提供（**不会自动删**）；要清就自己删条目，或用 `exclude` 放过整条路由 |
| 提示"不是 JSON 兼容值" | `settings.yaml` 里那个字段被 YAML 解析成了非 JSON 值（最常见是**未加引号的日期** → `Date`）；加引号写成字符串（如 `'2026-09-05'`）。插件会在写入前就拦下并点名到条目与字段 |
| 思考档位还是不出现 | 看该模型有没有 `~` 行。没有 `~` 行说明端点没提推理、也没有路由声明 → 加 `routes.<name>.efforts` |
| `routes.<name>.efforts` 写了却没进选择器 | 该条目是不是已经有 `reasoningEfforts`（**已有的一律不动**，包括 `false`）；`fill` 里是否还留着 `reasoningEfforts`；那个模型是不是本轮才新发现的（下一轮才补） |
| 按钮仍返回旧列表 | `fixDiscovery` 是否为 `true`；报告里「发现按钮」行说了什么、**接管几条路由** |
| 按钮报 404 / 返回的模型明显不对 | 该服务的模型清单不在 `{baseURL}/models`；用 `routes.<name>.listingPath` 指到正确位置（可以是绝对 URL） |
| 内置端点解析失败 | 报告首行会写；此时内置路由需要手写 `baseURL`。（已知坑：若 `argv[1]` 是 PATH 上的符号链接而锚点没 `realpath`，会把"能定位"误判成"定位失败"，现象是内置路由全部 `失败（no baseURL）`；已修并有专门用符号链接跑的回归测试） |

### 刷新节奏与失败重试

| 项 | 行为 | 为什么 |
|---|---|---|
| 抓取时机 | 启动一次（延迟 `startupDelaySeconds`）+ 每 `intervalMinutes` + `llm-pi-ai` 变化后 1.5 秒自愈 + `/model-catalog sync` | 模型上新是低频事件；4 小时一轮对 4 条路由就是 4 次请求。而"我马上要"由命令和自愈覆盖 |
| 进程内缓存 | 同一个 `路由+端点` 60 秒 | 模块 A 与「发现按钮」共用一次抓取；连点按钮不会连着打端点 |
| HTTP 拒绝（401 / 403 / 404 / **429** 等） | **不重试**，直接进报告；`Retry-After` 原样显示 | 已经到达的回答就是答案，再问一次不会变；对 429 再问一次正是端点明令禁止的 |
| 传输失败（DNS / 连接被拒 / 超时） | 立刻再试 **1 次**，仍失败则进报告 | 这类失败常常是一次性抖动，且没有端点在等我们退避 |
| 调用方取消（`abort`） | 永不重试 | 调用方已经说停了 |
| 下一轮 | 周期到时再来；失败不加速也不加倍 | 失败可见 + 手动 `sync` 足够；隐形退避只会掩盖问题 |

## 边界与非目标

- 只支持 `openai-completions` / `openai-responses` / `anthropic-messages` 三种可列举的协议（与官方 discovery 同一边界）；其余协议**先判定再跳过**，不去探测。
- **不猜协议、不猜能力**：协议要么你声明，要么来自路由事实；推理档位要么来自端点，要么来自你的声明。不会因为模型名像某个官方模型就替它假定能力。
- **不写 `compat`**：pi-ai 会按 baseURL 自动识别（例如 `openrouter.ai` → `thinkingFormat: 'openrouter'`），无需声明；确实需要的由你在**模型条目**上写，插件不碰。
- **`routes.<name>.efforts` 只补"已声明"的条目**，不给本轮新发现的 id 套用（新发现的一批里可能混着不推理的模型）。
- **`input` 按端点覆盖目录**：优先级是「端点名单 → 目录孪生条目 → 路由 `defaultInput`」，而 DSH 缺省的 `defaultInput` 只有 `["text"]`——所以补齐通常是**加**能力，但也会覆盖目录里给的更宽集合。DSH 的模态词表只有 `text`/`image`，线上报的 `video` 不会携带。想让目录/默认值说了算，就把 `input` 从 `fill` 里去掉。
- **不写成本与缓存计费**：`llm-pi-ai` 的模型 schema 里没有 cost 字段，成本只能从 pi-ai 目录继承；自定义路由的模型因此恒为 0 成本。这是上游 schema 的边界，本插件既不写也不猜价。
- **不处理路由级默认档位**（`llm-pi-ai.providers.<route>.reasoning`）：那是可选项，需要时手写。
- **只读用户层**：从组合 base 继承来的 `models` 列表不会被改写。
- **模型下线只报告不删除**：端点不再列出的条目会被点名，但不会从配置里消失。
- **不写入端点的移动别名**：带 `alias_target` 的 id（如 `~openai/*-latest`）默认跳过并点名——写进静态配置会让它随端点悄悄改变含义。
- **配置是用户级的**：写的是 `~/.dsh/settings.yaml`，而插件是按 profile 安装的。所以只有装了本插件的 profile 会刷新这份共享配置；其他 profile 会读到同样的模型但不会刷新它（配置本身始终合法）。
- 不做自己的 LLM adapter、不注册自有 provider 路由、不改 DSH 源码、不 patch 进程内模块、不 fork pi-ai。

## 开发

```sh
npm test           # 163 个离线用例，不联网，秒级（5 个需要真实 pi-ai 目录的用例默认跳过）
npm run check      # 语法检查

# 额外覆盖需要真实 pi-ai 的用例（内置端点解析、发现范围）
DSH_CLI_ENTRY="$(command -v dsh | xargs realpath)" npm test   # 163/163，0 跳过
```

**几乎全部逻辑都不需要 `node_modules`**：把 `lib/` 和 `test/{apply,merge,typing,plan,translate,listing,routes,report}.test.mjs` 拷进任意空目录，`node --test "test/*.test.mjs"` 就能跑（实测 112 通过）。只有接线测试（假 ctx + stub fetch）会经过 `config.js`，需要 `schemastery`。

代码分层，每层都可以单独替换：

```
lib/constants.js   无依赖常量与最小的共享读取器（纯层不 import schemastery，测试无需 node_modules）
lib/config.js      配置 schema（唯一依赖 schemastery 的地方）
lib/endpoints.js   内置提供方端点与目录协议解析（有守卫的解析链，失败即降级）
lib/listing.js     取模型清单（URL/鉴权规则与官方 discovery 对齐）
lib/translate.js   端点条目 → DSH 模型字段        ← 端点元数据形状变了改这里
lib/merge.js       只增只改策略 + addSince 闸门    ← 合并策略变了改这里
lib/typing.js      路由协议判定（跨协议目录时的新增闸门与安全核对）
lib/plan.js        轮次规划的两遍决策（纯函数，不碰 ctx/网络/时钟）
lib/routes.js      路由事实解析 + 写入范围/发现范围
lib/apply.js       唯一写入路径（settings.mutate + 冲突重试）
lib/discovery.js   模块 B：契约探测与包装
lib/report.js      报告渲染
lib/index.js       生命周期：启动 / 定时 / 命令 / 自愈
```

**DSH 升级后怎么修**：先跑 `npm test`（秒级、离线），再看报告首行。

- **测试挂了** → 先看 `lib/translate.js`（端点元数据形状变了）、`lib/merge.js`（合并策略）、`lib/typing.js`（协议判定）或 `lib/plan.js`（轮次规划）；这几层是纯函数，改完跑 `npm test` 即可。
- **服务名变了** → 报错会点名（`settings` / `credentials` / `llm` / `commands`），改 `lib/index.js` 与对应模块里的 `ctx.get(...)`。
- **模块 B 报 `unsupported`** → `llm.discoveries` 的形状变了，先把 `fixDiscovery` 关掉即可恢复（运行期生效，无需重启）；要重做就看 `lib/discovery.js` 的 `probeDiscovery`。
- 改完执行 `dsh plugin --profile web add link:<该路径>`（pnpm 是快照安装，需重跑）并重启 profile。

更完整的设计说明、需求条目与实测证据记录在 [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md)。

## 许可

[MIT](LICENSE)