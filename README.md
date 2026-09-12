# dsh-live-model-catalog

[English](README.en.md) | 中文

让 DSH 的 `llm-pi-ai` 路由始终跟着服务端自己的 `/models` 走：自动发现新模型，并自动补齐 `contextWindow` / `maxTokens` / `input` / `reasoningEfforts`（思考强度）。

它只通过 DSH 官方的 settings 接缝写配置，**不打补丁**；卸载插件后它写下的配置依然合法，DSH 原生照常工作。

---

## 为什么需要它

DSH 里有两个独立的缺口，症状不同、根因不同：

**① 内置提供方拿不到新模型。** `dsh-llm-pi-ai` 的模型发现（`lib/index.js` 的 `discoverModels`）只要发现 provider id 是 pi-ai 内置目录里有的，就直接返回随包发布的静态快照，**根本不发网络请求**。内置 `openrouter` 路由因此永远只能看到打包时那份 `@earendil-works/pi-ai` 快照里的模型——实测：快照 366 个，线上 443 个，`deepseek/deepseek-v4.1-flash` 不在快照里。

**② 自定义路由没有思考强度。** `resolveModelReasoning` 对"没有内置目录孪生条目"的手写模型返回 `{ reasoning: false }`，于是 composer 的思考档位选择器不出现；官方「模型」页又刻意不提供 `reasoningEfforts` 编辑框。而且能力继承是**按 provider 路由键**查目录的——路由只要不叫 `openrouter`，即使 model id 与目录完全一致也继承不到任何能力。

本插件的做法：读每条受管路由自己的 `GET {baseURL}/models`，把其中的模型 id 与能力字段写进 `llm-pi-ai`。

---

## 安装

大多数人用的就是 `web` profile（`dsh web` 是它的启动别名），所以下面直接写 `web`：

```sh
# 现在就能用：尚未发布到 npm，直接从仓库装
dsh plugin --profile web add github:CN-WenYu/dsh-live-model-catalog

# 发布到 npm 之后
dsh plugin --profile web add dsh-live-model-catalog

# 本地开发：link 安装，改代码即时生效
dsh plugin --profile web add link:<本仓库路径>
```

示例——安装后重启，插件才会加载：

```sh
dsh plugin --profile web add github:CN-WenYu/dsh-live-model-catalog
dsh web
```

示例——profile 不叫 `web` 时，把它换成 `$DSH_HOME/profiles/` 下的目录名（例如 `tui`）：

```sh
dsh plugin --profile tui add github:CN-WenYu/dsh-live-model-catalog
dsh --profile tui
```

装完**必须重启正在运行的 profile**。卸载：

```sh
dsh plugin --profile web remove dsh-live-model-catalog
```

示例——卸载后同样要重启，运行中的进程才会不再加载本插件：

```sh
dsh plugin --profile web remove dsh-live-model-catalog
dsh web
```

### 装完就能拿到新模型吗

**能，但有一条前提：这条路由得先有 `models` 列表。** 插件的默认值就是朝"开箱即用"配的：

| 默认 | 值 | 作用 |
|---|---|---|
| `include` | `['*']` | 所有厂商的模型都允许新增（不再只限某个厂商） |
| `addSince` | `'snapshot'` | 只新增**比本机 pi-ai 快照更新**的模型——这是让"全开"不至于变成一次导入 85 条历史的闸门 |
| `skipAliases` | `true` | 端点自称别名的 id（如 `~openai/*-latest`）不写入配置，它们会随端点漂移 |
| `fixDiscovery` | `true` | 「获取可用模型」按钮直接走实时端点 |

于是新装的人走这一条路就够了：

1. 装好、重启；
2. 打开 **设置 → 模型 → 你的路由 → 「获取可用模型」**（现在实时，列出端点上全部模型）；
3. **采纳一次** → 这条路由此有了 `models` 列表（DSH 的采纳只拷 `id/name/contextWindow/maxTokens`，缺的 `input`/`reasoningEfforts` 插件会在 1.5 秒内补齐）；
4. 之后每轮同步都会自动补上**比快照新的新模型**；要收窄就把 `include` 改成 `['deepseek/*','qwen/*']` 这类白名单，要连别名一起收就把 `skipAliases` 设 `false`；
5. 若这条路由的**目录跨了多种协议**（`openrouter`、`github-copilot` 是这种），再加一行 `routes.<name>.api`（报告会直接点名要什么）。

### 兼容性

已在 **DSH `0.1.5-rc.1` + pi-ai `0.85.1`** 上实测。它贴着下面这些契约写，升级 DSH 后出问题先看它们：

- DSH settings：`register / describe()（原始 user 层）/ mutate(ops, expectedRevision)`、`SETTINGS_CONFLICT`
- `dsh-llm-pi-ai`：`llm.discoveries` 表（模块 B，**唯一碰内部字段的地方**，契约不符只告警并退回官方）、`THINKING_LEVELS`、`LISTABLE_PROTOCOLS`、模型协议解析顺序（路由 `api` → 目录孪生 → 目录唯一协议）
- pi-ai：`providers/all`（`builtinProviders` / `getBuiltinModels`）与 `data/.manifest.json` 的 `generatedAt`

升级后先跑 `npm test`（离线、秒级），再重启看报告首行；模块 B 出问题就 `fixDiscovery: false`（运行期即生效）。

---

## 配置

写在 `~/.dsh/settings.yaml`（插件自己注册 `live-model-catalog` 命名空间）：

```yaml
live-model-catalog:
  mode: auto                 # auto = llm-pi-ai 下所有路由都管；listed = 只管理 routes 里点名的
  exclude: []                # 想放过的路由（auto 模式下生效），如 ['local', '*-experimental']
  routes: {}                 # 逐路由覆盖，见下文「跨协议目录的路由」
  # 例：{ openrouter: { api: 'openai-completions' } }   ← 让该路由能真的接纳目录外的新模型
  include: ['*']              # 允许被"新增"的 id 白名单；['*'] = 所有厂商；留空 = 只补齐不新增
  addSince: 'snapshot'        # 只新增 pi-ai 快照之后发布的模型；也可写日期/秒；留空 = 不设下限
  skipAliases: true           # 端点自称别名的 id 不写入配置（会在端点侧漂移）
  fill: [contextWindow, maxTokens, input, reasoningEfforts]
  fixDiscovery: true                  # 见下文「模块 B」（默认开；可运行期关掉）
  startupDelaySeconds: 5
  intervalMinutes: 240                # 0 = 只在启动时跑一次
```

**范围是发现出来的，不是写死的**：`mode: auto`（默认）会把 `llm-pi-ai.providers` 里的每个路由都纳入，包括 pi-ai 内置提供方——内置路由在 profile 里通常不写 `baseURL`，插件的端点解析顺序是

```
本插件的 routes.<name>.baseURL  →  llm-pi-ai 该路由的 baseURL  →  pi-ai 内置提供方表
```

第三层通过一个有守卫的解析链拿到（优先裸 import；否则把锚点 `realpath` 后再从 `dsh-llm-pi-ai` 的解析结果向上找 `node_modules/@earendil-works/pi-ai`——PATH 上的 `dsh` 是符号链接，不解析成真实路径就找不到；两者都失败就只在报告里说明），所以内置 `openrouter` 这类路由无需你手写端点。报告里每条路由都会标出端点来自哪一层。

**列取协议也来自路由事实，不是猜的**：`routes.<name>.api` → 该路由的 `api` → pi-ai 目录里这些模型唯一一致的协议 → 兜底 `openai-completions`。这一步很要紧，因为**列取的 URL 与鉴权都跟协议走**：给一条内置 `anthropic` 路由（profile 里通常只写 `apiKeyEnv`）猜 `openai-completions`，就会去请求 `api.anthropic.com/models` 并带 bearer，而不是 `/v1/models?limit=1000` + `x-api-key`——一条本来完全可管理的路由会变成每轮一个看不懂的失败。协议若不在官方可列举的三种之内，插件**先判定再跳过**，不去探测。

| 字段 | 作用 | 默认 |
|---|---|---|
| `mode` | `auto` = 自动纳管 `llm-pi-ai` 下所有路由；`listed` = 只管理 `routes` 点名的 | `auto` |
| `exclude` | `auto` 模式下要放过的路由名 glob | `[]` |
| `routes.<name>` | 逐路由覆盖 `enabled/baseURL/api/apiKeyEnv`；`api` 同时决定该路由能否接纳目录外的新模型，见下文 | 无 |
| `include` | 允许自动新增的 id glob；`*` 跨 `/` | `['*']`（所有厂商） |
| `addSince` | 只新增该日期/时间戳之后发布的模型；`snapshot` = pi-ai 快照的生成时间 | `'snapshot'` |
| `fill` | 允许补齐的字段 | 全部四个 |
| `defaultEfforts` | 端点说"会推理"但没给档位表时使用的预设 | `{off: none, high: high, max: max}` |
| `skipAliases` | 端点标为别名的 id 是否跳过（`alias_target`） | `true` |
| `fixDiscovery` | 是否同时修「获取可用模型」按钮 | `true` |
| `intervalMinutes` | 周期刷新；`0` 关闭 | `240` |
| `requestTimeoutSeconds` | 单次请求超时 | `20` |

> **必须先有 `models` 列表。** 只在路由**已经声明** `models` 时才写入：如果某路由靠继承拿整个内置目录，写 `models` 会把它替换成你写的那几条（DSH 的语义是"替换"而非"扩展"）。这种情况插件会跳过并在报告里说明。

> **新增是三道闸门。** `include` 默认 `['*']`（所有厂商），但另有两道兜着：`addSince` 默认 `'snapshot'`——取的是**已装 pi-ai 目录自己的生成时间**（读 `dist/providers/data/.manifest.json` 的 `generatedAt`），DSH 升级 pi-ai 时它自己跟着走，不用你记着改日期。实例（实测）：默认组合在快照为 2026-09-05 的机器上，对 OpenRouter 第一轮**新增 7 条真实新模型**、**跳过 16 条端点别名**（`~openai/*-latest` 这类会漂移的 id，逐条点名）、**挡住 415 条早于快照的历史**。想只补不增就把 `include` 写成 `[]`。
>
> 如果 `snapshot` 读不到（pi-ai 定位失败），插件**只补不增**并在报告里说明——一个解析不了的闸门绝不会变成敞开的闸门。想真的不设下限，把 `addSince` 显式写成空。

### 跨协议目录的路由：为什么有时要写 `routes.<name>.api`

DSH 给一个模型定协议的顺序是 **路由 `api` → 目录里同 id 条目的 `api` → 整条目录唯一协议**。于是**目录里没有的模型**在两种情况下没有协议可用：路由自己没声明 `api`，而该路由的目录又跨了不止一种协议（典型就是内置 `openrouter`——366 条里同时有 `openai-completions` 与 `anthropic-messages`）。

更麻烦的是 DSH 对一次配置写入**整体校验**：这样一个条目会让**整轮写入被拒**，连本来能安全写进去的 `input` / `reasoningEfforts` 一起丢掉。插件因此做两件事：

1. 这种候选模型**不进入写入**，改为在报告里点名，并给出一句可照抄的处置（`需声明协议：…`）；
2. 你在 `live-model-catalog.routes.<route>.api` 里声明协议后，插件把它**和 `models` 放进同一笔写入**补进 `llm-pi-ai`——只在该路由原本没有 `api` 时写，而且会先核对：**若声明它会改掉任何既有模型的协议，就拒绝写入并说明是哪些模型**。

协议由你声明、插件不猜：猜错意味着那个模型的每次请求都失败，比一次可见的拒绝更糟。即使写入仍被 DSH 因别的原因整体拒绝，插件也会自动退回"只写补齐"，保住已经能安全落地的部分，并把拒绝原因留在报告里（`新增被拒，已保住补齐`）。

### 让思考强度真正可选

模型条目里 `reasoningEfforts` 的语义：

```yaml
reasoningEfforts:
  off: none      # 键 = 选择器里的档位；值 = 实际发给端点的 wire 值
  low: low       # 未声明的档位 = 不支持，不会出现在选择器里
  high: high
```

本插件把它从端点的 `reasoning.supported_efforts` 自动翻译过来（`none` → `off`）；`reasoning.mandatory: true` 的模型不会提供"关闭"。端点没给档位表时使用 `defaultEfforts` 预设，并在报告里标注。

---

## 它做什么、不做什么

**模块 A（默认启用，只用官方 API）**

- 对每条受管路由抓 `{baseURL}/models`，解析标准 `data` 数组或富信息 `models` 对象；
- **只增只改**：已存在的模型条目只补缺失字段（你手写的 `name`、`contextWindow`、`reasoningEfforts` 一律不动），新 id 只在 `include` 命中且不早于 `addSince` 时才追加；
- **新增先过协议关**：路由给不了目录外模型协议时，不写也不猜，报告点名并给处置；万一写入仍被 DSH 整体拒绝，自动退回"只写补齐"，不牵连已能落地的部分；
- 无变化就不写，`settings.yaml` 不会每次启动都被改写；
- 写入带 `expectedRevision`，与 GUI 编辑撞车时重读重算，不会覆盖你没见过的改动；
- **自愈**：DSH 自己的「采纳」只拷 `id/name/contextWindow/maxTokens`，会把 `input` 和 `reasoningEfforts` 丢掉；插件监听 `llm-pi-ai` 的变化，1.5 秒后自动补回来。

**模块 B（`fixDiscovery`，默认开启）**

内置目录路由的「获取可用模型」由 `dsh-llm-pi-ai` 直接返回静态快照，且**没有官方扩展点**——`llm` 服务只暴露一个 `llm/stream` waterfall，`registerModelDiscovery` 对同一命名空间会抛 `DUPLICATE_DISCOVERY`。唯一可行的是包装 `llm.discoveries` 这张表。

这是一个**内部字段**，所以模块 B 写成了"能坏就坏得响亮"：启动时探测契约，形状变了就只打一条警告并完全退回官方行为，模块 A 不受影响。

- **默认开，因为它决定"装了是否就有反应"**；代价是碰了一个内部字段，所以三条性质必须同时成立：**启动探测契约**（形状变了只告警、不安装）、**失败只降级**（实时抓取失败回退官方答案）、**运行期可关**。
- **开关在运行期也生效**：把 `fixDiscovery` 改成 `false` 会立刻把官方发现放回去（还原的是当初被包装的那一个），不需要重启；重启后也不会残留。
- **范围是每轮现算的**：包装器每次被调用才去问"这条路由现在归我管吗"，所以你后加的路由**不需要重装包装器**就会被实时列表覆盖。
- 官方哪天自己支持了实时发现，把这个开关关掉即可。

---

## 诊断与自查

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
```

## 刷新节奏与失败重试

| 项 | 现在的行为 | 为什么 |
|---|---|---|
| 抓取时机 | 启动一次（延迟 `startupDelaySeconds`）+ 每 `intervalMinutes`（默认 240）+ 每次 `llm-pi-ai` 变化后 1.5 秒自愈 + `/model-catalog sync` | 模型上新是低频事件；4 小时一轮对 4 条路由就是 4 次请求，代价可忽略，而"我马上要"由命令和自愈覆盖 |
| 进程内缓存 | 同一个 `路由+端点` 60 秒 | 模块 A 与「发现按钮」共用一次抓取；连点按钮不会连着打端点 |
| HTTP 拒绝（401/403/404/**429** 等） | **不重试**，直接进报告；`Retry-After` 原样显示 | 已经到达的回答就是答案，再问一次不会变；对 429 再问一次正是端点明令禁止的 |
| 传输失败（DNS/连接被拒/超时） | 立刻再试 **1 次**，仍失败则进报告 | 这类失败常常是一次性抖动，且没有端点在等我们退避 |
| 调用方取消（`abort`） | 永不重试 | 调用方已经说停了 |
| 下一轮 | 周期到时再来；失败不加速也不加倍 | 失败可见 + 手动 `sync` 足够，不做会掩盖问题的隐形退避 |

| 症状 | 先看哪里 |
|---|---|
| 什么都没发生 | 报告里是否列出该路由；`exclude` 是否把它排除了 |
| 报告里出现 `无法列举模型` | 该路由的协议不在 `openai-completions` / `openai-responses` / `anthropic-messages` 之内（与官方 discovery 同边界）；跳过、不探测。要管它得先让它在 `routes.<name>.api` 里声明一个可列举协议 |
| 提示 `no baseURL` | 端点三层都没解析出来（报告里的「内置端点」行会说明），在该路由的 `routes.<name>.baseURL` 里补上 |
| 某个路由总失败 | 用 `exclude` 放过它；报告里会写失败原因（401/超时/返回不是 JSON），429/503 还会带上 `retry-after` |
| 提示 401/403 | 该路由的 `apiKeyEnv` 是否能在凭据或环境变量里解析 |
| 新增了太多模型 | 收窄 `include`；`addSince` 用默认的 `snapshot`（或显式日期） |
| 报告里出现 `addSince: "snapshot" 无法解析` | 读不到 pi-ai 的快照时间，本轮只补不增；写显式日期即可恢复，或留空以真的不设下限 |
| 报告里出现 `端点已不再列出` | 这些模型端点已不提供（**不会自动删**）；要清就自己删条目，或用 `exclude` 放过整条路由 |
| 提示"不是 JSON 兼容值" | `settings.yaml` 里那个字段被 YAML 解析成了非 JSON 值（最常见是**未加引号的日期** → `Date`）；加引号写成字符串（如 `'2026-09-05'`）即可，插件会在写入前就拦下并点名到条目与字段 |
| 提示 `需声明协议：…` | 该路由的目录跨多种协议且自己没声明 `api`；按提示在 `live-model-catalog.routes.<name>.api` 里声明后重跑 |
| 报告里出现 `新增被拒` | 写入被 DSH 整体校验拒绝（原因此行会写）；补齐已落盘，按原因处理后重跑 |
| 思考档位还是不出现 | 该模型的 `reasoningEfforts` 是否被写上（看报告里的 `~` 行） |
| 按钮仍返回旧列表 | `fixDiscovery` 是否为 `true`；报告里的「发现按钮」行说了什么 |
| 内置端点解析失败 | 报告首行会写；此时内置路由需要手写 `baseURL`。（已知坑：若 `argv[1]` 是 PATH 上的符号链接而锚点没 `realpath`，会把"能定位"误判成"定位失败"，现象就是内置路由全部 `失败（no baseURL）`；已修并有专门用符号链接跑的回归测试） |

---

## DSH 升级后怎么修

这个插件的设计目标就是"坏了你能自己修"：

```sh
npm test           # 132 个离线用例，不联网，秒级
npm run check      # 语法检查
```

- **测试挂了** → 先看 `lib/translate.js`（端点元数据形状变了）、`lib/merge.js`（合并策略）、`lib/typing.js`（协议判定）或 `lib/plan.js`（轮次规划）；这几层是纯函数，改完跑 `npm test` 即可。
- **只想快跑纯逻辑**：把 `lib/` 和 `test/{apply,merge,typing,plan,translate,listing,routes,report}.test.mjs` 拷到任意空目录，`node --test "test/*.test.mjs"` 就能跑（**不需要 `node_modules`**）。
- **服务名变了** → 报错会点名（`settings` / `credentials` / `llm` / `commands`），改 `lib/index.js` 与对应模块里的 `ctx.get(...)`。
- **模块 B 报 `unsupported`** → 说明 `llm.discoveries` 形状变了，把 `fixDiscovery` 关掉即可恢复（运行期即生效，无需重启）；要重做就看 `lib/discovery.js` 的 `probeDiscovery`。
- 改完执行 `dsh plugin --profile web add link:<该路径>`（pnpm 是快照安装，需重跑）并重启 profile（例如 `dsh web`）。

代码分层（每层都可以单独替换）：

```
lib/constants.js   无依赖常量（纯层不 import schemastery，测试无需 node_modules）
lib/endpoints.js   内置提供方端点与目录协议解析（有守卫的解析链，失败即降级）
lib/config.js      配置 schema
lib/listing.js     取列表（URL/鉴权规则与官方 discovery 对齐）
lib/translate.js   端点条目 → DSH 模型字段        ← 元数据形状变了改这里
lib/merge.js       只增只改策略 + addSince 闸门 + 协议闸门   ← 策略变了改这里
lib/typing.js      路由协议判定（跨协议目录时的新增闸门与安全核对）
lib/plan.js        轮次规划的两遍决策（纯函数，不碰 ctx/网络/时钟）
lib/routes.js      路由事实解析（端点/key/协议/目录协议）
lib/apply.js       唯一写入路径（settings.mutate + 冲突重试）
lib/discovery.js   模块 B：契约探测 + 包装
lib/report.js      报告渲染
lib/index.js       生命周期：启动/定时/命令/自愈
```

---

## 边界

- 只支持 `openai-completions` / `openai-responses` / `anthropic-messages` 三种可列举的协议（与官方 discovery 一致）；其余协议**先判定再跳过**，不去探测。
- 不会写 `compat`：pi-ai 会按 baseURL 自动识别 openrouter（`detectCompat` 匹配 `openrouter.ai`），无需声明。
- 不处理路由级 `reasoning`（默认档位）——那是一个可选项，需要时手动写 `llm-pi-ai.providers.<route>.reasoning: high`。
- 只读**用户层**的 `models`：从组合 base 继承来的模型列表不会被改写。
- **`input` 按端点覆盖目录**：模态的优先级是「端点名单 → 目录孪生条目 → 路由 `defaultInput`」，而 DSH 缺省的 `defaultInput` 只有 `["text"]`——所以补齐通常是**加**能力（文本模型在目录里只有 text、线上报 text+image），但也会覆盖目录里给的更宽集合。DSH 的模态词表只有 `text`/`image`，线上报的 `video` 不会被携带。想让目录/默认值说了算，就把 `input` 从 `fill` 里去掉；要在某一条上强制，直接写 `input`（你写过的字段永不覆盖）。
- **不写成本与缓存计费**：`llm-pi-ai` 的模型 schema 里没有 cost 字段，成本只能从 pi-ai 目录继承；自定义路由的模型因此恒为 0 成本（含 cacheRead / cacheWrite）。这是上游 schema 的边界，本插件既不写也**不猜价**。
- **配置是用户级的**：写的是 `~/.dsh/settings.yaml`，而插件是按 profile 安装的。所以只有装了本插件的 profile 会刷新这份共享配置；其他 profile 会读到同样的模型但不会刷新它（配置本身始终合法，见 R6）。
- 模型下线**只报告不删除**：端点不再列出的条目会被点名，但不会从你的配置里消失。
- **不写入端点的移动别名**：列表里带 `alias_target` 的 id（如 `~openai/gpt-astra-latest`）默认跳过并点名——写进静态配置会让它随端点悄悄改变含义。想照收就 `skipAliases: false`。

## 许可

MIT
