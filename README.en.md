# dsh-live-model-catalog

English | [中文](README.md)

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.1-4c6ef5.svg)](#requirements)
[![no build step](https://img.shields.io/badge/build-none-2f9e44.svg)](#development)

Keeps every DSH `llm-pi-ai` route in step with the endpoint's own `GET {baseURL}/models`: **built-in providers finally list what the endpoint serves**, and `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` (thinking levels) are filled in for you.

It writes configuration only through DSH's official settings seam — **no patching, no forking, no DSH source changes**. Everything it writes is a field the `llm-pi-ai` schema already defines, so uninstalling the plugin leaves a configuration that still loads and a DSH that still works.

> This is the English mirror of [`README.md`](README.md); the two are kept in step section for section. The report the plugin prints is Chinese-only — see the glossary under [Troubleshooting](#troubleshooting).

---

## Table of contents

- [Features](#features)
- [Why it exists](#why-it-exists)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Advanced configuration](#advanced-configuration)
- [Troubleshooting](#troubleshooting)
- [Boundaries and non-goals](#boundaries-and-non-goals)
- [Development](#development)
- [License](#license)

## Features

- **Live model catalog**: the Models page's "fetch available models" asks the endpoint even for a built-in provider (`openrouter`, `deepseek`, …), instead of reading the snapshot packaged with pi-ai.
- **Capability fills**: `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` from what the endpoint discloses, so a hand-written model can offer thinking levels in the composer.
- **Thinking levels you can declare**: translated from the endpoint's `reasoning.supported_efforts` when it publishes one, and declarable per route when it publishes nothing (SenseNova and friends).
- **Fill-only, append-only**: an existing entry only gains missing fields; a value you wrote is never touched, and no change means no write.
- **Safe writes**: every write carries `expectedRevision`, so a race with a GUI edit re-reads and re-plans instead of overwriting a change it never saw.
- **Visible failures**: every route's outcome (written / unchanged / skipped / failed + reason) lands in the report, and anything that needs your action is **named by model id**.

## Why it exists

Three gaps in DSH, with different symptoms and different root causes:

**① A built-in provider never sees new models.** `dsh-llm-pi-ai`'s discovery returns the static snapshot shipped in `@earendil-works/pi-ai` whenever the provider id is one pi-ai ships — **it does not touch the network at all**. Measured on one machine: without the plugin, asking `openrouter` returns **366 snapshot entries and makes 0 network requests**; with the plugin, the same call returns the **live list after 1 request to `openrouter.ai/api/v1/models`**.

**② A hand-written route has no thinking levels.** `resolveModelReasoning` returns `{ reasoning: false }` for a model with no catalog twin, so the composer offers no effort selector — and the official Models page deliberately has no `reasoningEfforts` field. Capability inheritance is also looked up **by provider route key**: a route not named `openrouter` inherits nothing, even for a model id the catalog describes exactly.

**③ Some endpoints say nothing at all.** A few `/models` replies are just a list of ids (SenseNova's gives `id/type/owner/created_at`, no context length and no reasoning field), and those providers are not in pi-ai's catalog either — so there is nothing to inherit. The only source is **your declaration**; see [Advanced configuration](#advanced-configuration).

What the plugin does: read each managed route's own `/models`, and write those model ids and capability fields into `llm-pi-ai`. Where the endpoint is silent you declare the answer, the plugin writes it, and **the endpoint's own answer always wins**.

## Requirements

| Item | Requirement |
|---|---|
| DSH | measured on `0.1.5-rc.1` (run `npm test` first on anything else) |
| pi-ai | measured on `0.85.1` |
| Build | none — no build step, no bundling |
| Runtime deps | `schemastery` only (registering a settings namespace requires a schema; it comes with the plugin, nothing to prepare) |
| Profile | `$DSH_HOME/profiles/<name>` (most people use `web`) |

It is written against these contracts; look at them first when a DSH upgrade breaks something:

- **DSH settings**: `register` / `describe()` (the raw user layer) / `mutate(ops, expectedRevision)` / `SETTINGS_CONFLICT`;
- **`dsh-llm-pi-ai`**: the `llm.discoveries` table (the only internal field touched), `THINKING_LEVELS`, `LISTABLE_PROTOCOLS`, and the protocol resolution order (route `api` → catalog twin → the catalog's single protocol);
- **pi-ai**: `providers/all`'s `builtinProviders` / `getBuiltinModels`, and `generatedAt` in `data/.manifest.json`.

## Install

```sh
# from the repository (not published to npm yet)
dsh plugin --profile web add github:CN-WenYu/dsh-live-model-catalog

# pinned to one commit (reproducible)
dsh plugin --profile web add "github:CN-WenYu/dsh-live-model-catalog#<commit-sha>"

# local development: a link install, so code edits take effect immediately (still needs a restart)
dsh plugin --profile web add link:<path-to-this-repo>
```

**The running profile must be restarted** — plugins are loaded at boot:

```sh
dsh web          # or: dsh --profile <your profile>
```

If your profile is not `web`, use the directory name under `$DSH_HOME/profiles/` (for example `tui`). Uninstalling also needs a restart:

```sh
dsh plugin --profile web remove dsh-live-model-catalog
dsh web
```

## Quick start

1. Install, **restart** the profile.
2. Open **Settings → Models → your route → "Fetch available models"**. It now lists what the endpoint serves — **built-in providers included**, even before you add one to your settings.
3. **Adopt once**; the route now has a `models` list. (DSH's adopt copies only `id/name/contextWindow/maxTokens`; the plugin fills the missing `input` / `reasoningEfforts` within 1.5 s.)
4. Every later round adds models newer than your pi-ai snapshot on its own.

Two configuration lines you may need:

- the route's **catalog spans protocols** (`openrouter`, `github-copilot`) → add `routes.<name>.api`, or it cannot accept a model the catalog does not describe;
- the provider is **not in pi-ai's catalog and its endpoint reports no reasoning** (SenseNova) → add `routes.<name>.efforts`, or its thinking levels never appear.

> **One known trap (built-in + multi-protocol routes).** Without an `api`, **the GUI's save is refused** by DSH with `provider "openrouter" model "…" needs an api`: the Models page renders its protocol control only for a provider the catalog does *not* describe, and DSH only accepts a protocol at the route level. Fix it first — see the first entry under [Advanced configuration](#advanced-configuration).

## Configuration

Written to `~/.dsh/settings.yaml` (the plugin registers its own `live-model-catalog` namespace):

```yaml
live-model-catalog:
  mode: auto                 # auto = every route under llm-pi-ai; listed = only the names under routes
  exclude: []                # route names to leave alone in auto mode, e.g. ['local', '*-experimental']
  routes: {}                 # per-route overrides, see "Advanced configuration"
  include: ['*']             # id allowlist for ADDITIONS; empty = fill only
  addSince: 'snapshot'       # only add models published after this; a date/unix seconds also work; empty = no bound
  skipAliases: true          # ids the endpoint marks as aliases are not written (they drift)
  fill: [contextWindow, maxTokens, input, reasoningEfforts]
  defaultEfforts: { off: none, high: high, max: max }
  fixDiscovery: true                  # whether to take over the "fetch available models" button
  startupDelaySeconds: 5              # delay before the first round
  intervalMinutes: 240                # refresh period; 0 = run once at startup only
  requestTimeoutSeconds: 20
```

| Field | What it does | Default |
|---|---|---|
| `mode` | `auto` = every route under `llm-pi-ai`; `listed` = only the names under `routes` | `auto` |
| `exclude` | Route-name globs to leave alone in `auto` mode | `[]` |
| `routes.<name>` | Per-route overrides of `enabled` / `baseURL` / `api` / `apiKeyEnv` | none |
| `routes.<name>.efforts` | This route's thinking-level declaration (`level: wire value`); applies only where the endpoint is silent | `{}` |
| `routes.<name>.listingPath` | Where to list models when that is not `{baseURL}/models` | `''` |
| `include` | Id globs allowed to be added; `*` spans `/` | `['*']` (every vendor) |
| `addSince` | Only add models published after this date/timestamp; `snapshot` = pi-ai's own generation time | `'snapshot'` |
| `fill` | Which fields may be filled | all four |
| `defaultEfforts` | Global preset used when an endpoint **reports a `reasoning` object but no effort list** (a route's own `efforts` covers the endpoint saying nothing at all) | `{off: none, high: high, max: max}` |
| `skipAliases` | Skip ids the endpoint marks as aliases (`alias_target`) | `true` |
| `fixDiscovery` | Whether to take over the "fetch available models" button | `true` |
| `startupDelaySeconds` / `intervalMinutes` | First-round delay / refresh period | `5` / `240` |
| `requestTimeoutSeconds` | Per-request timeout | `20` |

> **A prerequisite for writing: the route must already declare `models`.** DSH's `models` means "replace", not "extend", so writing one for a route that inherits the whole built-in catalog would shrink it to the entries you write. Such a route is **skipped, not written**, and the report says so.
>
> **Additions pass three gates.** `include` defaults to `['*']` (every vendor), but `addSince` defaults to `'snapshot'` — **your installed pi-ai catalog's own generation time** (read from `generatedAt` in `dist/providers/data/.manifest.json`), which follows a DSH upgrade by itself, so nobody has to remember to edit a date; ids the endpoint marks as aliases are skipped. Measured: with a 2026-09-05 snapshot, the default combination adds **7 genuinely new models** on the first round against OpenRouter, **skips 16 endpoint aliases** (the drifting `~openai/*-latest` kind, each named), and **gates 415 older entries**. To fill without adding anything, set `include` to `[]`.
>
> **An unreadable `snapshot` fails closed.** When pi-ai cannot be located the bound cannot be resolved, so the round **fills but adds nothing** and says why — a gate that cannot be resolved must never become an open one. To genuinely remove the bound, set `addSince` to an explicit empty value.

## How it works

One round does two things: **writes configuration** (module A) and **answers "fetch available models"** (module B). Both share a single fetch.

### Two different scopes

| Scope | Contains | Used for |
|---|---|---|
| **Write scope** (module A) | routes **declared** under `llm-pi-ai.providers`, plus any named under `routes` | filling capabilities and adding models — **only ever writes to routes you already wrote** |
| **Discovery scope** (module B) | the above **＋ every provider pi-ai ships** (32 on the machine this was measured on) | answering the button, **and never writing configuration** |

The discovery scope is deliberately wider, because the button is most useful **before** you have added a built-in provider: DSH lists every pi-ai provider on the Models page whether or not your settings mention it, and its own discovery answers those ids from the snapshot. An undeclared built-in provider has no `models` list, so that wider scope **cannot create a route behind your back**.

### Module A: writing

- Fetches `{baseURL}/models` for every managed route and parses either the standard `data` array or the richer `models` object;
- **Fill-only, append-only**: an existing entry only gains missing fields (a `name`, `contextWindow` or `reasoningEfforts` you wrote is never touched); a new id is appended only when it matches `include`, is not older than `addSince`, and is not marked as an alias;
- **Additions pass the protocol gate first**: when a route cannot type an out-of-catalog model, nothing is written and nothing is guessed — the report names it and gives the remedy. If a write is still refused as a whole, the plugin falls back to fills-only, without sinking the part that could land;
- **No change means no write**: `settings.yaml` is not rewritten on every start;
- **Writes carry `expectedRevision`**, so a race with a GUI edit re-reads and re-plans instead of overwriting a change it never saw;
- **Self-healing**: DSH's own "adopt" copies only `id/name/contextWindow/maxTokens`, dropping `input` and `reasoningEfforts`; the plugin watches `llm-pi-ai` and fills them back within 1.5 s (idempotent, so it cannot loop).

### Module B: discovery (`fixDiscovery`)

For a built-in route the button is answered from the static snapshot, and there is **no official extension point** — the `llm` service exposes a single `llm/stream` waterfall, and `registerModelDiscovery` throws `DUPLICATE_DISCOVERY` for an already-registered namespace. The only seam is wrapping the `llm.discoveries` table.

That is an **internal field**, so module B is written to fail loudly rather than silently, and all four properties hold:

- **the contract is probed at startup**: a shape change only warns and installs nothing, leaving module A unaffected;
- **any failure only degrades**: a failed live fetch falls back to the official answer;
- **switchable at runtime**: setting `fixDiscovery: false` puts the official discovery back immediately (the very one that was wrapped), no restart, and nothing survives one either;
- **the scope is recomputed per call**: it is not frozen at install time, so a route added later is covered without reinstalling the wrapper.

Two more properties: **an unlistable protocol goes back to the official answer** (for protocols DSH itself cannot read a listing for — `google-generative-ai`, say — the plugin does not invent a URL, so the platform's own "enter this provider's models by hand" message is what you see), and the report's `发现按钮：installed（接管 32 条路由）` line is the first place to look when the button misbehaves.

If the official implementation ever gains live discovery, turn the switch off.

### How the endpoint and the protocol are resolved

```
endpoint: this plugin's routes.<name>.baseURL  →  the route's baseURL in llm-pi-ai  →  pi-ai's built-in provider table
protocol: this plugin's routes.<name>.api      →  the route's api  →  the one protocol its catalog agrees on  →  openai-completions
```

The third endpoint layer comes from a guarded lookup chain (a bare import first; otherwise the anchor is `realpath`-resolved and pi-ai is located by walking up from `dsh-llm-pi-ai`'s resolved entry — `dsh` on `PATH` is a symlink, so without resolving it the package cannot be found; if both fail, the report says so). That is why a built-in route like `openrouter` needs no hand-written endpoint, and the report marks which layer supplied each route's endpoint.

**Why the protocol cannot be guessed**: both the listing URL and its auth follow the protocol. Guessing `openai-completions` for a built-in `anthropic` route (whose profile usually declares only `apiKeyEnv`) asks for `api.anthropic.com/models` with a bearer token instead of `/v1/models?limit=1000` with `x-api-key` — turning a perfectly manageable route into one unreadable failure per round. A protocol outside the three DSH can list is **recognised and skipped**, never probed.

## Advanced configuration

### Routes whose catalog spans protocols: `routes.<name>.api`

DSH resolves a model's protocol as **the route's `api` → the catalog entry's `api` → the one protocol the whole catalog agrees on**. A model the catalog does not describe therefore has nothing to fall back on when the route declares no `api` and its catalog spans more than one protocol — built-in `openrouter` is exactly that case (366 entries: `openai-completions` **and** `anthropic-messages`).

Worse, DSH validates a settings write **as a whole**: one such entry refuses the entire round, taking the `input` / `reasoningEfforts` that could safely have been written down with it. So the plugin does two things:

1. It **keeps such a candidate out of the write** and names it in the report with a copy-pasteable remedy (`needs a protocol: …`);
2. Once you declare it under `routes.<name>.api`, it writes that protocol **and `models` in the same write** — only when the route declares no `api` of its own, and only after checking that declaring it **would not re-point any existing model's protocol** (if it would, the write is refused and the models are named).

You declare the protocol; the plugin does not guess. Guessing wrong means every request for that model fails — worse than one visible refusal. And if a write is refused by DSH for any other reason, the plugin automatically retries as "fills only", keeping whatever could land safely and leaving the refusal reason in the report (`additions refused, fills kept`).

**If your route is built-in + multi-protocol and the GUI save fails with `needs an api`**, use either route:

| Approach | Steps |
|---|---|
| **Let the plugin write it** (recommended) | ① In the GUI, **adopt once from the models the catalog already describes** (that save succeeds, because those models have catalog twins) → ② add `routes.<name>.api: openai-completions` → ③ run `/model-catalog sync`: the plugin writes `api` and the out-of-catalog model **in one write** |
| **Write the line yourself** | Add `api: openai-completions` under `llm-pi-ai.providers.<route>` in `~/.dsh/settings.yaml` (the Models page renders no protocol control for a built-in provider, so this is the only place) |

### When the endpoint won't say: `routes.<name>.efforts`

Some endpoints publish neither context length nor any reasoning metadata in their model list — SenseNova is one — and because DSH inherits capability by provider route key, a provider pi-ai does not ship inherits nothing even when its model ids match the official catalog. **Declaring it is the only way**:

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

The `models` list under `llm-pi-ai` stays clean (ids plus the capacities the endpoint does not give), and the level declaration lives under the plugin's own `routes` — so "what the endpoint said" and "what you declared" stay visibly separate, and the report states which entries it filled from the declaration.

Levels have a precedence, and **a higher source always wins**:

| # | Source | Applies when |
|---|---|---|
| 1 | `reasoningEfforts` already on the model entry | you wrote it — the plugin is **fill-only** and never overwrites |
| 2 | the endpoint's `reasoning.supported_efforts` | the endpoint publishes a level list (`none` → `off`); `reasoning.mandatory: true` drops "off" |
| 3 | the `defaultEfforts` global preset | the endpoint reports a `reasoning` object but no level list |
| 4 | a `routes.<name>.efforts` declaration | the endpoint says nothing at all, or does not even list the model |

Every fill carries its own explanation line (`! …`) in the report, so where a level came from is never a guess.

- **It applies only where the endpoint is silent.** The day the endpoint starts publishing `supported_efforts`, its answer takes over and your declaration drops to second place; nothing to delete.
- **`reasoningEfforts: false` on a model means "don't fill this one".** A route-level declaration reaches every entry missing the field; a model that does not actually reason (or one you want left alone) opts out with `false`, which DSH reads as "non-reasoning model".
- **`off` is either absent or `off: null`.** Absent = "off" is not offered; `off: null` = choosing "off" sends nothing at all. Do not write `off: none` unless the endpoint really accepts that value.
- **The value is the wire spelling.** SenseNova's OpenAI-compatible mode documents `reasoning_effort: "medium"`, and pi-ai defaults to `supportsReasoningEffort: true` + `thinkingFormat: 'openai'` for a host it does not special-case, so the declaration above really does send `reasoning_effort: "low|medium|high"`.
- **A model switched by a string `thinking` field needs `compat` too.** If the gateway toggles it with `thinking` / `enable_thinking` instead, add `compat: { thinkingFormat: string-thinking }` to that model entry and make the level value the string that field expects (DSH allows configuring both `compat.thinkingFormat` and `compat.supportsReasoningEffort`).
- **Only already-declared models are filled.** An id discovered this round is not handed the declaration (a freshly discovered batch may mix reasoning and non-reasoning models); once it is written, the next round sees it as a declared entry and the self-healing pass fills it.

### When the listing is not at `/models`: `routes.<name>.listingPath`

For `openai-completions`, the plugin (and DSH itself) builds the listing URL as `{baseURL}/models`. Some services disagree — SenseNova's OpenAI-compatible chat base is `/compatible-mode/v2` while its model list lives at `/v1/llm/models` ([docs](https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/Models/GetModelList)), a different root entirely:

```yaml
live-model-catalog:
  routes:
    sensenova:
      listingPath: https://api.sensenova.cn/v1/llm/models   # absolute URL: used verbatim
    internal-gw:
      listingPath: /catalog/v2/models                       # path: appended to baseURL
```

A route whose listing cannot be read reports `failed (… answered 404)`; other routes are unaffected.

## Troubleshooting

### Commands and the report

```sh
# inside a DSH session
/model-catalog status     # the last round's report
/model-catalog sync       # run a round now
```

One line per route in the startup log. **The report itself is rendered in Chinese**, so here is a sample with the labels annotated:

```
[live-model-catalog] live-model-catalog —— 触发：startup                              # trigger
[live-model-catalog] 白名单：*（仅新增 pi-ai 快照之后发布）　补齐字段：…　修按钮：开    # allowlist / fillable fields / button
[live-model-catalog] - openrouter：已写入                                            # per-route status
[live-model-catalog]     线上 443 个模型；新增 7；补齐 0；未列出 0；…                  # endpoint / added / filled / …
[live-model-catalog]     + sakana/fugu-max                                           # an added id
[live-model-catalog]     ~ deepseek/deepseek-v4.1-flash → input, reasoningEfforts    # a filled entry
[live-model-catalog]       ! 端点未提供推理档位表；已按本插件的路由档位声明补齐          # why it was filled
[live-model-catalog] 发现按钮：installed（接管 32 条路由） — …                         # wrapper + routes it owns
```

`接管 32 条路由` is the size of the discovery scope (declared routes + pi-ai's providers), and it is the first place to look when the button misbehaves: `0` means the plugin owns no route at all, and a count below the number of providers on the Models page usually means pi-ai could not be located — the `内置端点：` line of the same report says why. Every fill carries its own `!` note, so where a value came from is never a guess.

| Chinese | Meaning |
|---|---|
| `触发` | trigger (`startup` / `interval` / `command` / `settings-change` / `config-change`) |
| `白名单` / `补齐字段` / `修按钮` | allowlist / fields that may be filled / the fetch button |
| `已写入` / `无变化` / `已跳过` / `失败` | written / unchanged / skipped / failed |
| `已写入（新增被拒，已保住补齐）` | written, additions refused, fills kept |
| `线上` / `新增` / `补齐` | models on the endpoint / added / filled |
| `未列出` / `白名单外` / `早于 addSince` | delisted / outside the allowlist / older than `addSince` |
| `跳过别名` / `需声明协议` | aliases skipped / models that need a declared protocol |
| `发现按钮` | the fetch button (`installed` / `pending` / `unsupported` / `absent` / `removed`), followed by `（接管 N 条路由）` = how many routes it owns |
| `端点未提供推理档位表；已按本插件的路由档位声明补齐` | the endpoint published no effort table; filled from this plugin's `routes.<name>.efforts` declaration |

A fully English report would need the labels in `lib/report.js` to be localised; today they are not.

### Common symptoms

| Symptom | Where to look |
|---|---|
| Nothing happened at all | Is the route listed in the report; does `exclude` leave it out |
| `无法列举模型` (protocol cannot list models) | That route's protocol is not one of `openai-completions` / `openai-responses` / `anthropic-messages` (the same boundary as official discovery); it is skipped, not probed. To manage it, declare a listable protocol under `routes.<name>.api` |
| `no baseURL` (already English) | None of the three endpoint layers resolved (the report's "built-in endpoints" line says why); add it under `routes.<name>.baseURL` |
| One route keeps failing | Leave it out with `exclude`; the report carries the reason (401 / timeout / not JSON), and 429/503 include `retry-after` |
| 401 / 403 | Can that route's `apiKeyEnv` be resolved from credentials or the environment |
| `需声明协议：…` (needs a protocol) | The route's catalog spans protocols and it declares no `api`; see the first entry under Advanced configuration |
| **The GUI save fails with `needs an api`** | Same cause: a built-in, multi-protocol route with no `api`, and the Models page offers no control for it. Two remedies in the table under Advanced configuration |
| `新增被拒` (additions refused) | DSH refused the write as a whole (the reason is on that line); the fills did land, so fix the reason and run again |
| Too many models were added | Narrow `include`; keep `addSince` at `snapshot` (or an explicit date) |
| `addSince: "snapshot" 无法解析` | pi-ai's snapshot time was unreadable, so this round fills without adding; write an explicit date to restore additions, or leave it empty to genuinely remove the bound |
| `端点已不再列出` (the endpoint no longer lists these) | Those models are gone from the endpoint (**never deleted automatically**); delete the entries yourself, or leave the whole route out with `exclude` |
| `不是 JSON 兼容值` (not a JSON-compatible value) | That field in `settings.yaml` parsed into something YAML allows and JSON does not (most often an **unquoted date** → `Date`); quote it as a string (e.g. `'2026-09-05'`). The plugin catches it before writing and names the entry and field |
| Still no thinking levels | Is there a `~` line for that model? No `~` line means the endpoint said nothing and no route declaration exists → add `routes.<name>.efforts` |
| `routes.<name>.efforts` is declared but the selector is still empty | Does that entry already carry `reasoningEfforts` (**anything existing is never touched**, `false` included); is `reasoningEfforts` still in `fill`; was that model only discovered this round (it is filled next round) |
| The button still returns the old list | Is `fixDiscovery` `true`; what does the report's "fetch button" line say, and **how many routes does it own**; for a built-in provider you have not added, that count should equal the number of providers pi-ai ships (about 32) |
| The button 404s, or returns obviously wrong models | That service's model list is not at `{baseURL}/models`; point `routes.<name>.listingPath` at the right place (an absolute URL is allowed) |
| Built-in endpoint resolution failed | The report's first lines say so, and built-in routes then need a written `baseURL`. (Known trap, fixed: when `argv[1]` is a symlink on `PATH` and the anchor is not `realpath`-resolved, "found" is misreported as "not found" and every built-in route fails with `no baseURL`; there is a regression test that runs through a symlink) |

### Refresh cadence and failure retries

| Item | Current behaviour | Why |
|---|---|---|
| When it fetches | Once at startup (after `startupDelaySeconds`) + every `intervalMinutes` (default 240) + 1.5 s after any `llm-pi-ai` change + `/model-catalog sync` | Model releases are infrequent, and one round per four hours is four requests for four routes; "I want it now" is covered by the command and the self-heal |
| In-process cache | 60 s per `route + endpoint` | Module A and the fetch button share one fetch; repeated clicks do not hammer the endpoint |
| An HTTP refusal (401/403/404/**429**, …) | **Not retried**; reported as-is, with `Retry-After` shown | An answer that arrived is an answer — asking again cannot change it, and for 429 it is exactly what the endpoint forbade |
| A transport failure (DNS / refused connection / timeout) | Retried **once**, immediately; then reported | These are usually one-off blips, and no endpoint is waiting for us to back off |
| A caller cancellation (`abort`) | Never retried | The caller already said stop |
| The next round | When the period comes; a failure neither accelerates nor doubles it | Visible failure plus a manual `sync` is enough; invisible backoff would hide problems |

## Boundaries and non-goals

- Only the three listable protocols are supported — `openai-completions` / `openai-responses` / `anthropic-messages` (the same boundary as official discovery); any other protocol is **recognised and skipped**, never probed.
- **No guessing**: a protocol comes either from your declaration or from route facts; a thinking level comes either from the endpoint or from your declaration. It never assumes capability because a model's id resembles an official one — DSH's capability inheritance is keyed by provider route, and the plugin does not step over that line.
- **It does not write `compat`**: pi-ai detects it from the baseURL (for example `openrouter.ai` → `thinkingFormat: 'openrouter'`). When one really is needed (a model toggled by a string `thinking` field, say), you write `compat` on the **model entry** and the plugin leaves it alone.
- **`routes.<name>.efforts` only fills models you already declared**, never ids discovered in the same round (a freshly discovered batch may mix reasoning and non-reasoning models, so marking them all would be wrong); they are filled on the next round, once written.
- **`input` follows the endpoint over the catalog**: modality precedence is "endpoint list → catalog twin → the route's `defaultInput`", and DSH's default `defaultInput` is only `["text"]` — so a fill usually **adds** capability (a model the catalog calls text-only, while the endpoint reports text+image), though it also overrides a wider set from the catalog. DSH's modality vocabulary is only `text`/`image`, so a `video` the endpoint reports is not carried. To let the catalog/defaults win, drop `input` from `fill`; to force one entry, write its `input` (a field you wrote is never overwritten).
- **No cost or cache accounting**: `llm-pi-ai`'s model schema has no cost field, so cost can only be inherited from the pi-ai catalog; a model on a custom route is therefore always zero cost (cacheRead / cacheWrite included). That is an upstream schema boundary — the plugin neither writes it nor **guesses a price**.
- **No route-level default effort**: `llm-pi-ai.providers.<route>.reasoning` is optional; write it yourself when you want it.
- **It reads only the user layer's `models`**: a list inherited from a composition base is never rewritten.
- **A delisted model is reported, not deleted**: entries the endpoint no longer advertises are named, but never removed from your configuration.
- **Endpoint aliases are not written**: ids carrying `alias_target` (such as `~openai/gpt-astra-latest`) are skipped by default and named — writing one into a static configuration would let its meaning change behind your back. Set `skipAliases: false` to take them too.
- **Configuration is user-level**: it writes `~/.dsh/settings.yaml`, while the plugin is installed per profile. So only the profile that has the plugin refreshes that shared configuration; another profile reads the same models without refreshing them (the configuration itself always stays loadable).
- No LLM adapter of its own, no self-registered provider routes, no DSH source changes, no in-process patching, no pi-ai fork.

## Development

```sh
npm test           # 163 offline cases, no network, seconds (5 need a real pi-ai catalog and skip by default)
npm run check      # syntax check

# additionally cover the cases that need a real pi-ai catalog (endpoint lookup, discovery scope)
DSH_CLI_ENTRY="$(command -v dsh | xargs realpath)" npm test   # 163/163, 0 skipped
```

**Almost all of the logic needs no `node_modules`**: copy `lib/` and `test/{apply,merge,typing,plan,translate,listing,routes,report}.test.mjs` into any empty directory and run `node --test "test/*.test.mjs"` (measured: 112 passing). Only the wiring tests (fake ctx + stub fetch) go through `config.js`, which needs `schemastery`.

Layering — every layer can be replaced on its own:

```
lib/constants.js   dependency-free constants and the one shared reader (pure layers import no schemastery)
lib/config.js      the configuration schema (the only place schemastery is imported)
lib/endpoints.js   built-in provider endpoints and catalog protocols (guarded lookup chain, degrades on failure)
lib/listing.js     fetching the listing (URL/auth rules aligned with official discovery)
lib/translate.js   endpoint entry → DSH model fields        ← change here when metadata shapes move
lib/merge.js       fill-only/append-only policy + the addSince gate + the protocol gate   ← change here when policy moves
lib/typing.js      route protocol decisions (the addition gate for cross-protocol catalogs, and the safety check)
lib/plan.js        the two-pass per-round plan (pure: no ctx, no network, no clock)
lib/routes.js      route facts (endpoint / key / protocol / catalog protocols) + the two scopes
lib/apply.js       the only write path (settings.mutate + conflict retry)
lib/discovery.js   module B: contract probe + wrapper
lib/report.js      report rendering
lib/index.js       lifecycle: startup / interval / command / self-heal
```

**After a DSH upgrade**: run `npm test` first (offline, seconds), then read the first line of the report.

- **Tests fail** → look first at `lib/translate.js` (endpoint metadata shape), `lib/merge.js` (merge policy), `lib/typing.js` (protocol decisions) or `lib/plan.js` (per-round planning). Those layers are pure functions: fix and re-run `npm test`.
- **A service name changed** → the error names it (`settings` / `credentials` / `llm` / `commands`); fix `ctx.get(...)` in `lib/index.js` and the matching module.
- **Module B reports `unsupported`** → the `llm.discoveries` shape moved; turn `fixDiscovery` off to recover (effective at runtime, no restart). To redo it, read `probeDiscovery` in `lib/discovery.js`.
- After an edit, re-run `dsh plugin --profile web add link:<path>` (pnpm installs a snapshot) and restart the profile (for example `dsh web`).

The full design rationale, requirement list and recorded measurements live in [`docs/REQUIREMENTS.md`](docs/REQUIREMENTS.md) (Chinese).

## License

[MIT](LICENSE)