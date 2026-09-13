# dsh-live-model-catalog

[English](README.en.md) | 中文

让 DSH 的 `llm-pi-ai` 路由始终跟着服务端自己的 `/models` 走：自动发现新模型，并自动补齐 `contextWindow` / `maxTokens` / `input` / `reasoningEfforts`（思考强度）。

它只通过 DSH 官方的 settings 接缝写配置，**不打补丁**；卸载插件后它写下的配置依然合法，DSH 原生照常工作。

---

## 为什么需要它

DSH 里有两个独立的缺口，症状不同、根因不同：

**① 内置提供方拿不到新模型。** `dsh-llm-pi-ai` 的模型发现（`lib/index.js` 的 `discoverModels`）只要发现 provider id 是 pi-ai 内置目录里有的，就直接返回随包发布的静态快照，**根本不发网络请求**。内置 `openrouter` 路由因此永远只能看到打包时那份 `@earendil-works/pi-ai` 快照里的模型——实测：快照 366 个，线上 443 个，`deepseek/deepseek-v4.1-flash` 不在快照里。

**② 自定义路由没有思考强度。** `resolveModelReasoning` 对"没有内置目录孪生条目"的手写模型返回 `{ reasoning: false }`，于是 composer 的思考档位选择器不出现；官方「模型」页又刻意不提供 `reasoningEfforts` 编辑框。而且能力继承是**按 provider 路由键**查目录的——路由只要不叫 `openrouter`，即使 model id 与目录完全一致也继承不到任何能力。

能力还有第三种情况，插件也补不了：**端点自己在 `/models` 里不说推理元数据**。商汤日日新就是这种——它的模型清单只给 `id/type/owner/created_at`，既没有上下文长度，也没有任何 reasoning 字段，而且商汤**不在 pi-ai 内置目录里**（`sense/nova` 匹配 0 个 provider、0 个模型），所以"模型和官方一样"也继承不到。这时唯一的来源是**你自己声明**：见下文「[端点不说推理：`routes.<name>.efforts`](#端点不说推理routesnameefforts)」。

本插件的做法：读每条受管路由自己的 `GET {baseURL}/models`，把其中的模型 id 与能力字段写进 `llm-pi-ai`；端点沉默的字段由你按路由声明，插件负责写进去，并保证端点的答案永远优先。

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
2. 打开 **设置 → 模型 → 你的路由 → 「获取可用模型」**（现在实时，列出端点上全部模型）。**内置提供方也一样**：哪怕你还没把它添加进 settings，这个按钮也已经走端点，而不是随包快照；
3. **采纳一次** → 这条路由此有了 `models` 列表（DSH 的采纳只拷 `id/name/contextWindow/maxTokens`，缺的 `input`/`reasoningEfforts` 插件会在 1.5 秒内补齐）；
4. 之后每轮同步都会自动补上**比快照新的新模型**；要收窄就把 `include` 改成 `['deepseek/*','qwen/*']` 这类白名单，要连别名一起收就把 `skipAliases` 设 `false`；
5. 若这条路由的**目录跨了多种协议**（`openrouter`、`github-copilot` 是这种），加一行 `routes.<name>.api`（报告会直接点名要什么）；
6. 若这个提供方**不在 pi-ai 目录里、且端点不报推理元数据**（商汤这类），加一行 `routes.<name>.efforts`，否则它的思考档位永远不会出现。

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
  routes: {}                 # 逐路由覆盖，见下文「跨协议目录的路由」与「端点不说推理」
  # 例：
  # routes:
  #   openrouter:
  #     api: openai-completions              # 让该路由能真的接纳目录外的新模型
  #   sensenova:
  #     efforts: { low: low, high: high }    # 端点不说推理时，由你声明档位
  #     listingPath: https://api.sensenova.cn/v1/llm/models   # 模型清单不在 {baseURL}/models 时
  include: ['*']              # 允许被"新增"的 id 白名单；['*'] = 所有厂商；留空 = 只补齐不新增
  addSince: 'snapshot'        # 只新增 pi-ai 快照之后发布的模型；也可写日期/秒；留空 = 不设下限
  skipAliases: true           # 端点自称别名的 id 不写入配置（会在端点侧漂移）
  fill: [contextWindow, maxTokens, input, reasoningEfforts]
  fixDiscovery: true                  # 见下文「模块 B」（默认开；可运行期关掉）
  startupDelaySeconds: 5
  intervalMinutes: 240                # 0 = 只在启动时跑一次
```

**范围是发现出来的，不是写死的，而且是两个范围**：

| 范围 | 包含 | 用在哪 |
|---|---|---|
| **写入范围**（模块 A） | `llm-pi-ai.providers` 里**已声明**的路由 + `routes` 里点名的 | 补齐能力、追加新模型——只会写你已经写过的路由 |
| **发现范围**（模块 B） | 上面那些 **＋ pi-ai 内置目录里的全部 provider**（内置目录通常 32 条，实测如此） | 只回答「获取可用模型」按钮，从不写配置 |

发现范围故意更宽，因为「获取可用模型」最有用的时刻恰恰是**你还没添加那个内置提供方**：DSH 会把 pi-ai 的每个 provider 都列在「模型」页上（哪怕你 settings 里一个都没写），而它的官方发现对这些 id 一律返回随包快照。内置 provider 在 profile 里通常不写 `baseURL`，插件的端点解析顺序是

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
| `routes.<name>.efforts` | 该路由的推理档位声明（`档位: wire 值`）；只在端点沉默时生效，端点的答案永远优先 | `{}` |
| `routes.<name>.listingPath` | 模型清单不在 `{baseURL}/models` 时的覆盖；相对路径拼在 `baseURL` 后，绝对 URL 原样使用 | `''` |
| `include` | 允许自动新增的 id glob；`*` 跨 `/` | `['*']`（所有厂商） |
| `addSince` | 只新增该日期/时间戳之后发布的模型；`snapshot` = pi-ai 快照的生成时间 | `'snapshot'` |
| `fill` | 允许补齐的字段 | 全部四个 |
| `defaultEfforts` | 端点**报了 `reasoning` 对象但没给档位表**时的全局预设（逐路由的 `efforts` 是它之外的补充，覆盖"端点什么都没说"） | `{off: none, high: high, max: max}` |
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

档位的来源有优先级，**高优先级永远覆盖低优先级**：

| 顺序 | 来源 | 生效条件 |
|---|---|---|
| 1 | 模型条目里已有的 `reasoningEfforts` | 你已经写了——插件**只补不改**，绝不覆盖 |
| 2 | 端点 `/models` 里的 `reasoning.supported_efforts` | 端点报了档位表（`none` → `off`）；`reasoning.mandatory: true` 时不提供"关闭" |
| 3 | `defaultEfforts` 全局预设 | 端点报了 `reasoning` 对象但没给档位表 |
| 4 | `routes.<name>.efforts` 路由声明 | 端点什么都没说（或压根没列出这个模型） |

报告里每个补齐都会带出它自己的说明行（`! …`），所以"档位从哪来的"不用猜。

### 端点不说推理：`routes.<name>.efforts`

商汤日日新这类端点，模型清单里既没有上下文长度也没有 reasoning 字段；而 DSH 的能力继承又只看 provider 路由键，商汤不在 pi-ai 目录里，继承不到任何东西。**唯一可行的办法是声明**：

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

`llm-pi-ai` 里的 `models` 保持干净（只写 id 和端点不给的容量），档位声明放在插件自己的 `routes` 下——这样"哪些是端点说的、哪些是你声明的"一眼可分，而且插件会在报告里写明它按声明补了哪几条。

几个要点：

- **只在端点沉默时生效**。端点哪天开始报 `supported_efforts`，端点的答案立刻接管，声明自动退居二线；不需要你删配置。
- **`reasoningEfforts` 写 `false` 就是不补**。路由级别的声明会套到该路由每个缺 `reasoningEfforts` 的模型条目上，若某个模型其实不推理（或你不想要档位），在那条模型上写 `reasoningEfforts: false` 即可——DSH 把它读作"非推理模型"，插件也会跳过它。
- **`off` 要么不写，要么写 `off: null`**。不写 = 不提供"关闭"；`off: null` = 选关闭时干脆不发这个参数。别写 `off: none`——商汤文档里没有 `"none"` 这个值。
- **值就是发给端点的 wire 值**。商汤兼容模式文档里的正式参数是 `reasoning_effort: "medium"`，而 pi-ai 对非特殊 host 默认 `supportsReasoningEffort: true` + `thinkingFormat: 'openai'`，所以上面这份声明会真的发出 `reasoning_effort: "low|medium|high"`。
- **走字符串 `thinking` 的模型要另配 compat**。若某模型在商汤网关上的开关是 `thinking` / `enable_thinking`（而不是 `reasoning_effort`），在那条模型条目上加 `compat: { thinkingFormat: string-thinking }`，并让档位值等于该字段要的字符串（`compat.thinkingFormat` 与 `compat.supportsReasoningEffort` 都是 DSH 允许配置的字段）。
- **只补"已声明"的模型**。本轮才新发现的 id 不会套用声明（新发现的模型可能不推理，批量标记是错的）；它写进配置后，下一轮就是"已声明条目"，自愈那一轮会把档位补上。

### 模型清单不在 `/models` 上：`routes.<name>.listingPath`

插件（和 DSH 自己）对 `openai-completions` 拼的清单地址是 `{baseURL}/models`。有些服务不是这样——商汤兼容模式的对话端点是 `/compatible-mode/v2`，模型清单却在 `/v1/llm/models`（[官方文档](https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/Models/GetModelList)），根都不一样：

```yaml
live-model-catalog:
  routes:
    sensenova:
      listingPath: https://api.sensenova.cn/v1/llm/models   # 绝对 URL：原样使用
    internal-gw:
      listingPath: /catalog/v2/models                       # 相对路径：拼在 baseURL 后面
```

清单读不到时路由会报 `失败（… answered 404）`，其余路由不受影响。

---

## 它做什么、不做什么

**模块 A（默认启用，只用官方 API）**

- 对每条受管路由抓 `{baseURL}/models`，解析标准 `data` 数组或富信息 `models` 对象；
- **只增只改**：已存在的模型条目只补缺失字段（你手写的 `name`、`contextWindow`、`reasoningEfforts` 一律不动），新 id 只在 `include` 命中且不早于 `addSince` 时才追加；
- **新增先过协议关**：路由给不了目录外模型协议时，不写也不猜，报告点名并给处置；万一写入仍被 DSH 整体拒绝，自动退回"只写补齐"，不牵连已能落地的部分；
- 无变化就不写，`settings.yaml` 不会每次启动都被改写；
- 写入带 `expectedRevision`，与 GUI 编辑撞车时重读重算，不会覆盖你没见过的改动；
- **自愈**：DSH 自己的「采纳」只拷 `id/name/contextWindow/maxTokens`，会把 `input` 和 `reasoningEfforts` 丢掉；插件监听 `llm-pi-ai` 的变化，1.5 秒后自动补回来；
- **端点沉默的字段由你声明**：`routes.<name>.efforts` / `.listingPath` 是"端点没说的部分由你说"，永远不覆盖端点的答案。

**模块 B（`fixDiscovery`，默认开启）**

内置目录路由的「获取可用模型」由 `dsh-llm-pi-ai` 直接返回静态快照，且**没有官方扩展点**——`llm` 服务只暴露一个 `llm/stream` waterfall，`registerModelDiscovery` 对同一命名空间会抛 `DUPLICATE_DISCOVERY`。唯一可行的是包装 `llm.discoveries` 这张表。

这是一个**内部字段**，所以模块 B 写成了"能坏就坏得响亮"：启动时探测契约，形状变了就只打一条警告并完全退回官方行为，模块 A 不受影响。

- **默认开，因为它决定"装了是否就有反应"**；代价是碰了一个内部字段，所以三条性质必须同时成立：**启动探测契约**（形状变了只告警、不安装）、**失败只降级**（实时抓取失败回退官方答案）、**运行期可关**。
- **开关在运行期也生效**：把 `fixDiscovery` 改成 `false` 会立刻把官方发现放回去（还原的是当初被包装的那一个），不需要重启；重启后也不会残留。
- **范围是每轮现算的，而且比你配置过的更宽**：包装器每次被调用才去问"这条路由现在归我管吗"。范围 = 你声明的路由 **＋ pi-ai 内置目录里的全部 provider**，所以那些**你还没添加**的内置提供方（pi-ai 会照样把它们列在「模型」页上，官方发现对这些 id 一律回快照）点按钮也是实时的。这个更宽的范围**只用于回答按钮，从不写配置**——未声明的内置 provider 没有 `models` 列表，插件不会凭空替你创建一条路由。
- **协议不可列举就交回官方**：像 `google-generative-ai` 这类 DSH 自己就没有清单读取方式的协议，插件不去猜 URL，直接放行让官方给出它那句"请手工录入模型"。
- **报告会说它接管了几条**：`发现按钮：installed（接管 32 条路由）`。这个数字是诊断按钮是否生效的第一现场——`0` 说明插件一条路由都没管住；比「模型」页上的 provider 数少，通常是 pi-ai 定位失败（同一份报告里的 `内置端点：` 那行会说明原因）。
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
[live-model-catalog]     ~ sensenova-6.7-flash-lite → reasoningEfforts
[live-model-catalog]       ! 端点未提供推理档位表；已按本插件的路由档位声明补齐
[live-model-catalog] 发现按钮：installed（接管 32 条路由） — live discovery installed over the installed catalog
```

`接管 32 条路由` 是"发现范围"的大小：你声明的路由数 + pi-ai 内置 provider 数。端点解析失败时它会小得多，同一份报告里的「内置端点」行会说明原因。

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
| 思考档位还是不出现 | 该模型的 `reasoningEfforts` 是否被写上（看报告里的 `~` 行）。没有 `~` 行说明端点没提推理、也没有路由声明 → 加 `routes.<name>.efforts` |
| `routes.<name>.efforts` 写了却没进选择器 | 该条目是不是已经有 `reasoningEfforts`（**已有的一律不动**，包括 `false`）；`fill` 里是否还留着 `reasoningEfforts`；那个模型是不是本轮才新发现的（下一轮才补） |
| 按钮仍返回旧列表 | `fixDiscovery` 是否为 `true`；报告里的「发现按钮」行说了什么、**接管几条路由**；若那个内置提供方还没添加，接管数应等于内置 provider 总数（约 32） |
| 按钮报 404 / 返回的模型明显不对 | 该服务的模型清单不在 `{baseURL}/models`；用 `routes.<name>.listingPath` 指到正确位置（可以是绝对 URL） |
| 报告的 `~` 行下没有说明行 | 那是 0.1.0 的行为（补齐的翻译注释被丢掉了）；0.2.0 起每个补齐都会带出 `! …` 说明 |
| 内置端点解析失败 | 报告首行会写；此时内置路由需要手写 `baseURL`。（已知坑：若 `argv[1]` 是 PATH 上的符号链接而锚点没 `realpath`，会把"能定位"误判成"定位失败"，现象就是内置路由全部 `失败（no baseURL）`；已修并有专门用符号链接跑的回归测试） |

---

## DSH 升级后怎么修

这个插件的设计目标就是"坏了你能自己修"：

```sh
npm test           # 163 个离线用例，不联网，秒级
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
lib/routes.js      路由事实解析（端点/协议/目录协议/声明）+ 两个范围（写入 / 发现）
lib/apply.js       唯一写入路径（settings.mutate + 冲突重试）
lib/discovery.js   模块 B：契约探测 + 包装
lib/report.js      报告渲染
lib/index.js       生命周期：启动/定时/命令/自愈
```

---

## 边界

- 只支持 `openai-completions` / `openai-responses` / `anthropic-messages` 三种可列举的协议（与官方 discovery 一致）；其余协议**先判定再跳过**，不去探测。
- 不会写 `compat`：pi-ai 会按 baseURL 自动识别 openrouter（`detectCompat` 匹配 `openrouter.ai`），无需声明；确实需要的（例如走字符串 `thinking` 字段的模型）由你在**模型条目**上写 `compat`，插件不碰。
- **`routes.<name>.efforts` 只补"已声明"的条目**，不给本轮新发现的 id 套用（新发现的一批里可能混着不推理的模型，批量标记是错的）；它们写进配置后的下一轮会被补上。
- **只读一份配置，不猜端点**：推理档位要么来自端点，要么来自你的声明。插件不会因为模型名字像某个官方模型就替它假定能力——DSH 的能力继承本来就是按 provider 路由键查的，插件不越过这条线。
- 不处理路由级 `reasoning`（默认档位）——那是一个可选项，需要时手动写 `llm-pi-ai.providers.<route>.reasoning: high`。
- 只读**用户层**的 `models`：从组合 base 继承来的模型列表不会被改写。
- **`input` 按端点覆盖目录**：模态的优先级是「端点名单 → 目录孪生条目 → 路由 `defaultInput`」，而 DSH 缺省的 `defaultInput` 只有 `["text"]`——所以补齐通常是**加**能力（文本模型在目录里只有 text、线上报 text+image），但也会覆盖目录里给的更宽集合。DSH 的模态词表只有 `text`/`image`，线上报的 `video` 不会被携带。想让目录/默认值说了算，就把 `input` 从 `fill` 里去掉；要在某一条上强制，直接写 `input`（你写过的字段永不覆盖）。
- **不写成本与缓存计费**：`llm-pi-ai` 的模型 schema 里没有 cost 字段，成本只能从 pi-ai 目录继承；自定义路由的模型因此恒为 0 成本（含 cacheRead / cacheWrite）。这是上游 schema 的边界，本插件既不写也**不猜价**。
- **配置是用户级的**：写的是 `~/.dsh/settings.yaml`，而插件是按 profile 安装的。所以只有装了本插件的 profile 会刷新这份共享配置；其他 profile 会读到同样的模型但不会刷新它（配置本身始终合法，见 R6）。
- 模型下线**只报告不删除**：端点不再列出的条目会被点名，但不会从你的配置里消失。
- **不写入端点的移动别名**：列表里带 `alias_target` 的 id（如 `~openai/gpt-astra-latest`）默认跳过并点名——写进静态配置会让它随端点悄悄改变含义。想照收就 `skipAliases: false`。

## 许可

MIT
