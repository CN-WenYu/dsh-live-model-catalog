# dsh-live-model-catalog

English | [中文](README.md)

Keep DSH's `llm-pi-ai` routes in step with each endpoint's own `/models`: discover new models automatically, and fill in `contextWindow` / `maxTokens` / `input` / `reasoningEfforts` (thinking levels) as the endpoint reports them.

It writes configuration only through DSH's official settings seam — **it patches nothing**. Uninstall the plugin and the configuration it wrote still loads, with DSH working as it always did.

---

## Why it exists

Two independent gaps in DSH, with different symptoms and different root causes:

**① A built-in provider never sees new models.** `dsh-llm-pi-ai`'s model discovery (`discoverModels` in its `lib/index.js`) returns the static snapshot shipped in `@earendil-works/pi-ai` whenever the provider id is one pi-ai ships — **it does not touch the network at all**. So the built-in `openrouter` route can only ever show the models that were packaged: measured on one machine, 366 in the snapshot against 443 on the endpoint, with `deepseek/deepseek-v4.1-flash` absent from the snapshot.

**② A hand-written route has no thinking levels.** `resolveModelReasoning` returns `{ reasoning: false }` for a model with no catalog twin, so the composer offers no effort selector — and the official Models page deliberately has no `reasoningEfforts` field. Capability inheritance is also looked up **by provider route key**: a route not named `openrouter` inherits nothing, even for a model id the catalog describes exactly.

What this plugin does: read each managed route's own `GET {baseURL}/models`, and write those model ids and capability fields into `llm-pi-ai`.

---

## Install

```sh
dsh plugin --profile <your profile> add dsh-live-model-catalog   # from npm
dsh plugin --profile <your profile> add link:<this repo>          # local development (link install; edits take effect immediately)
```

**Restart the running profile afterwards.** To remove:

```sh
dsh plugin --profile <your profile> remove dsh-live-model-catalog
```

### Do I get new models right after installing?

**Yes — with one precondition: the route must already declare a `models` list.** The defaults are tuned so that an install works out of the box:

| Default | Value | What it does |
|---|---|---|
| `include` | `['*']` | Every vendor's models may be added (not just one vendor's) |
| `addSince` | `'snapshot'` | Only models **newer than your installed pi-ai snapshot** are added — the gate that keeps "everything" from becoming an 85-entry history import |
| `skipAliases` | `true` | Ids the endpoint marks as aliases (e.g. `~openai/*-latest`) are not written into your config; they drift on the endpoint's side |
| `fixDiscovery` | `true` | The **"Fetch available models"** button answers from the live endpoint |

So a fresh install needs only this path:

1. Install, restart.
2. Open **Settings → Models → your route → "Fetch available models"** (now live: it lists everything the endpoint advertises).
3. **Adopt once** → the route now has a `models` list. (DSH's adopt copies only `id/name/contextWindow/maxTokens`; the plugin fills in the missing `input` / `reasoningEfforts` within 1.5 s.)
4. Every later round adds **whatever is newer than the snapshot**. To narrow it, set `include` to a vendor allowlist such as `['deepseek/*','qwen/*']`; to take the aliases too, set `skipAliases: false`.
5. If the route's **catalog spans more than one protocol** (`openrouter` and `github-copilot` do), add one `routes.<name>.api` line — the report names exactly what it needs.

### Compatibility

Measured on **DSH `0.1.5-rc.1` + pi-ai `0.85.1`**. It is written against the contracts below; look there first when a DSH upgrade breaks something:

- DSH settings: `register` / `describe()` (the raw user layer) / `mutate(ops, expectedRevision)`, and `SETTINGS_CONFLICT`
- `dsh-llm-pi-ai`: the `llm.discoveries` table (module B, **the only internal field it touches** — a shape change only warns and falls back to the official answer), `THINKING_LEVELS`, `LISTABLE_PROTOCOLS`, and the protocol resolution order (route `api` → catalog twin → the catalog's single protocol)
- pi-ai: `providers/all` (`builtinProviders` / `getBuiltinModels`) and `generatedAt` in `data/.manifest.json`

After an upgrade: run `npm test` (offline, seconds), restart, read the first line of the report. If module B is the problem, set `fixDiscovery: false` (effective at runtime, no restart).

---

## Configuration

Written to `~/.dsh/settings.yaml` (the plugin registers its own `live-model-catalog` namespace):

```yaml
live-model-catalog:
  mode: auto                 # auto = every route under llm-pi-ai; listed = only the names under routes
  exclude: []                # route names to leave alone in auto mode, e.g. ['local', '*-experimental']
  routes: {}                 # per-route overrides, see "Routes whose catalog spans protocols"
  # e.g. { openrouter: { api: 'openai-completions' } }   ← lets that route accept a model its catalog cannot type
  include: ['*']              # id allowlist for ADDITIONS; ['*'] = every vendor; empty = fill only
  addSince: 'snapshot'        # only add models published after this; a date/unix seconds also work; empty = no bound
  skipAliases: true           # ids the endpoint marks as aliases are not written (they drift)
  fill: [contextWindow, maxTokens, input, reasoningEfforts]
  fixDiscovery: true                  # see "Module B" below (on by default; switchable at runtime)
  startupDelaySeconds: 5
  intervalMinutes: 240                # 0 = run once at startup only
```

**Scope is discovered, not hard-coded**: `mode: auto` (the default) includes every route under `llm-pi-ai.providers`, built-in providers included. A built-in route normally declares no `baseURL`, so the endpoint resolution order is

```
this plugin's routes.<name>.baseURL  →  the route's baseURL in llm-pi-ai  →  pi-ai's built-in provider table
```

The third layer comes from a guarded lookup chain (a bare import first; otherwise the anchor is `realpath`-resolved and pi-ai is located by walking up from `dsh-llm-pi-ai`'s resolved entry — `dsh` on `PATH` is a symlink, so without resolving it the package cannot be found; if both fail, the report says so), which is why a built-in route like `openrouter` needs no hand-written endpoint. The report marks which layer supplied each route's endpoint.

**The listing protocol also comes from route facts, never a guess**: `routes.<name>.api` → the route's own `api` → the one protocol the catalog's models agree on → `openai-completions` as a last resort. This matters because **both the listing URL and its auth follow the protocol**: guessing `openai-completions` for a built-in `anthropic` route (whose profile usually declares only `apiKeyEnv`) asks for `api.anthropic.com/models` with a bearer token instead of `/v1/models?limit=1000` with `x-api-key` — turning a perfectly manageable route into one unreadable failure per round. A protocol outside the three DSH can list is **recognised and skipped**, never probed.

| Field | What it does | Default |
|---|---|---|
| `mode` | `auto` = every route under `llm-pi-ai`; `listed` = only the names under `routes` | `auto` |
| `exclude` | Route-name globs to leave alone in `auto` mode | `[]` |
| `routes.<name>` | Per-route overrides of `enabled/baseURL/api/apiKeyEnv`; `api` also decides whether the route can accept an out-of-catalog model | none |
| `include` | Id globs allowed to be added; `*` spans `/` | `['*']` (every vendor) |
| `addSince` | Only add models published after this date/timestamp; `snapshot` = pi-ai's own generation time | `'snapshot'` |
| `fill` | Which fields may be filled | all four |
| `defaultEfforts` | Preset used when an endpoint reasons but publishes no effort list | `{off: none, high: high, max: max}` |
| `skipAliases` | Skip ids the endpoint marks as aliases (`alias_target`) | `true` |
| `fixDiscovery` | Whether to repair the "Fetch available models" button too | `true` |
| `intervalMinutes` | Refresh period; `0` disables it | `240` |
| `requestTimeoutSeconds` | Per-request timeout | `20` |

> **The route must declare `models` first.** Writing happens only for a route that **already declares** `models`: if a route inherits the whole built-in catalog, writing `models` replaces it with just the entries you write (DSH's semantics are "replace", not "extend"). Such a route is skipped, and the report says so.

> **Additions pass three gates.** `include` defaults to `['*']` (every vendor), but two more hold it back: `addSince` defaults to `'snapshot'` — **your installed pi-ai catalog's own generation time** (read from `generatedAt` in `dist/providers/data/.manifest.json`), which follows a DSH upgrade by itself, so nobody has to remember to edit a date. Measured: with a 2026-09-05 snapshot, the default combination adds **7 genuinely new models** on the first round against OpenRouter, **skips 16 endpoint aliases** (the drifting `~openai/*-latest` kind, each named), and **gates 415 older entries** behind `addSince`. To fill without adding anything, set `include` to `[]`.
>
> If `snapshot` cannot be read (pi-ai could not be located), the plugin **fills but adds nothing** and says so — a gate that cannot be resolved must never become an open one. To genuinely remove the bound, set `addSince` to an explicit empty value.

### Routes whose catalog spans protocols: why `routes.<name>.api` is sometimes needed

DSH resolves a model's protocol in this order: **the route's `api` → the `api` of the catalog entry with the same id → the one protocol the whole catalog agrees on**. So a model the catalog does not describe has no protocol at all when the route declares no `api` and its catalog spans more than one protocol — built-in `openrouter` is exactly that case (its 366 entries are `openai-completions` and `anthropic-messages`).

Worse, DSH validates a settings write **as a whole**: one such entry refuses the entire round, taking the `input` / `reasoningEfforts` that could safely have been written down with it. The plugin therefore does two things:

1. It **keeps such a candidate out of the write** and names it in the report with a copy-pasteable remedy (`needs a protocol: …`).
2. Once you declare the protocol under `live-model-catalog.routes.<route>.api`, it writes that protocol and `models` **in the same write** — only when the route declares no `api` of its own, and only after checking that declaring it **would not re-point any existing model's protocol** (if it would, the write is refused and the models are named).

You declare the protocol; the plugin does not guess. Guessing wrong means every request for that model fails — worse than one visible refusal. And if a write is refused by DSH for any other reason, the plugin automatically retries as "fills only", keeping whatever could land safely and leaving the refusal reason in the report (`additions refused, fills kept`).

### Making thinking levels actually selectable

The semantics of `reasoningEfforts` on a model entry:

```yaml
reasoningEfforts:
  off: none      # key = the level in the selector; value = the wire value actually sent to the endpoint
  low: low       # an undeclared level is unsupported and never appears in the selector
  high: high
```

The plugin translates these from the endpoint's `reasoning.supported_efforts` (`none` → `off`); a model with `reasoning.mandatory: true` is never offered "off". When an endpoint reasons but publishes no level list, the `defaultEfforts` preset is used and the report says so.

---

## What it does and does not do

**Module A (on by default, official APIs only)**

- Fetches `{baseURL}/models` for every managed route and parses either the standard `data` array or the richer `models` object.
- **Fill-only, append-only**: an existing entry only gains missing fields (a `name`, `contextWindow` or `reasoningEfforts` you wrote is never touched), and a new id is appended only when it matches `include` and is not older than `addSince`.
- **Additions pass the protocol gate first**: when a route cannot type an out-of-catalog model, nothing is written and nothing is guessed — the report names it and gives the remedy. If a write is still refused as a whole, the plugin falls back to fills-only, without sinking the part that could land.
- No change means no write: `settings.yaml` is not rewritten on every start.
- Writes carry `expectedRevision`, so a race with a GUI edit re-reads and re-plans instead of overwriting a change it never saw.
- **Self-healing**: DSH's own "adopt" copies only `id/name/contextWindow/maxTokens`, dropping `input` and `reasoningEfforts`; the plugin watches `llm-pi-ai` and fills them back in 1.5 s later.

**Module B (`fixDiscovery`, on by default)**

For a built-in catalog route, "fetch available models" is answered by `dsh-llm-pi-ai` straight from the static snapshot, and there is **no official extension point** — the `llm` service exposes a single `llm/stream` waterfall, and `registerModelDiscovery` throws `DUPLICATE_DISCOVERY` for an already-registered namespace. The only seam is wrapping the `llm.discoveries` table.

That is an **internal field**, so module B is written to fail loudly rather than silently: it probes the contract at startup, and if the shape moved it only logs a warning and leaves the official behaviour untouched, with module A unaffected.

- **It defaults on because it decides whether an install reacts at all**; the price is touching an internal field, so all three properties must hold: the contract is **probed at startup** (a shape change warns and does not install), **any failure only degrades** (a failed live fetch falls back to the official answer), and it is **switchable at runtime**.
- **The switch works at runtime**: setting `fixDiscovery` to `false` puts the official discovery back immediately (the very one that was wrapped); nothing survives a restart either.
- **Its scope is recomputed per call**: the wrapper asks "is this route mine now?" on every invocation, so a route you add later is covered by the live list **without reinstalling the wrapper**.
- If the official implementation ever gains live discovery, turn the switch off.

---

## Diagnostics

```sh
# inside a DSH session
/model-catalog status     # the last round's report
/model-catalog sync       # run a round now
```

One line per route in the startup log. **The report itself is rendered in Chinese** — the sample below is verbatim output, so here is the glossary you need to read it:

```
[live-model-catalog] live-model-catalog —— 触发：startup
[live-model-catalog] 白名单：*（仅新增 pi-ai 快照之后发布）　补齐字段：contextWindow, maxTokens, input, reasoningEfforts　修按钮：开
[live-model-catalog] - openrouter：已写入
[live-model-catalog]     线上 443 个模型；新增 7；补齐 0；未列出 0；白名单外 0；早于 addSince 415；跳过别名 16
[live-model-catalog]     + sakana/fugu-max
[live-model-catalog]     ~ deepseek/deepseek-v4.1-flash → input, reasoningEfforts
```

| Chinese | Meaning |
|---|---|
| `触发` | trigger (`startup` / `interval` / `command` / `settings-change` / `config-change`) |
| `白名单` / `补齐字段` / `修按钮` | allowlist / fields that may be filled / the fetch button |
| `已写入` / `无变化` / `已跳过` / `失败` | written / unchanged / skipped / failed |
| `已写入（新增被拒，已保住补齐）` | written, additions refused, fills kept |
| `线上` / `新增` / `补齐` | models on the endpoint / added / filled |
| `未列出` / `白名单外` / `早于 addSince` | delisted / outside the allowlist / older than `addSince` |
| `跳过别名` / `需声明协议` | aliases skipped / models that need a declared protocol |
| `发现按钮` | the fetch button (`installed` / `pending` / `unsupported` / `absent` / `removed`) |
| `配置里的 … 是 …，不是 JSON 兼容值`, `无法列举模型`, `端点已不再列出` | see the symptom table below |

A fully English report would need the labels in `lib/report.js` to be localised; today they are not.

## Refresh cadence and failure retries

| Item | Current behaviour | Why |
|---|---|---|
| When it fetches | Once at startup (after `startupDelaySeconds`) + every `intervalMinutes` (default 240) + 1.5 s after any `llm-pi-ai` change + `/model-catalog sync` | Model releases are infrequent, and one round per four hours is four requests for four routes; "I want it now" is covered by the command and the self-heal |
| In-process cache | 60 s per `route + endpoint` | Module A and the fetch button share one fetch; repeated clicks do not hammer the endpoint |
| An HTTP refusal (401/403/404/**429**, …) | **Not retried**; reported as-is, with `Retry-After` shown | An answer that arrived is an answer — asking again cannot change it, and for 429 it is exactly what the endpoint forbade |
| A transport failure (DNS / refused connection / timeout) | Retried **once**, immediately; then reported | These are usually one-off blips, and no endpoint is waiting for us to back off |
| A caller cancellation (`abort`) | Never retried | The caller already said stop |
| The next round | When the period comes; a failure neither accelerates nor doubles it | Visible failure plus a manual `sync` is enough; invisible backoff would hide problems |

| Symptom | Where to look |
|---|---|
| Nothing happened at all | Is the route listed in the report; does `exclude` leave it out |
| `无法列举模型` (protocol cannot list models) | That route's protocol is not one of `openai-completions` / `openai-responses` / `anthropic-messages` (the same boundary as official discovery); it is skipped, not probed. To manage it, declare a listable protocol under `routes.<name>.api` |
| `no baseURL` (already English) | None of the three endpoint layers resolved (the report's "built-in endpoints" line says why); add it under `routes.<name>.baseURL` |
| One route keeps failing | Leave it out with `exclude`; the report carries the reason (401 / timeout / not JSON), and 429/503 include `retry-after` |
| 401/403 | Can that route's `apiKeyEnv` be resolved from credentials or the environment |
| Too many models were added | Narrow `include`; keep `addSince` at `snapshot` (or an explicit date) |
| `addSince: "snapshot" 无法解析` (the snapshot bound could not be resolved) | pi-ai's snapshot time was unreadable, so this round fills without adding; write an explicit date to restore additions, or leave it empty to genuinely remove the bound |
| `端点已不再列出` (the endpoint no longer lists these) | Those models are gone from the endpoint (**never deleted automatically**); delete the entries yourself, or leave the whole route out with `exclude` |
| `不是 JSON 兼容值` (is not a JSON-compatible value) | That field in `settings.yaml` parsed into something YAML allows and JSON does not (most often an **unquoted date** → `Date`); quote it as a string (e.g. `'2026-09-05'`). The plugin catches it before writing and names the entry and field |
| `需声明协议：…` (needs a protocol) | The route's catalog spans protocols and it declares no `api`; declare it under `live-model-catalog.routes.<name>.api` and run again |
| `新增被拒` (additions refused) | DSH refused the write as a whole (the reason is on that line); the fills did land, so fix the reason and run again |
| Still no thinking levels | Was `reasoningEfforts` written for that model (see the `~` lines) |
| The button still returns the old list | Is `fixDiscovery` `true`; what does the report's "fetch button" line say |
| Built-in endpoint resolution failed | The report's first lines say so, and built-in routes then need a written `baseURL`. (Known trap: when `argv[1]` is a symlink on `PATH` and the anchor is not `realpath`-resolved, "found" is misreported as "not found", and every built-in route fails with `no baseURL`; fixed, with a regression test that runs through a symlink) |

---

## Repairing it after a DSH upgrade

This plugin's design goal is that you can fix it yourself:

```sh
npm test           # 132 offline cases, no network, seconds
npm run check      # syntax check
```

- **Tests fail** → look first at `lib/translate.js` (endpoint metadata shape), `lib/merge.js` (merge policy), `lib/typing.js` (protocol decisions) or `lib/plan.js` (per-round planning). Those layers are pure functions: fix and re-run `npm test`.
- **Just want the pure logic fast**: copy `lib/` and `test/{apply,merge,typing,plan,translate,listing,routes,report}.test.mjs` into any empty directory and run `node --test "test/*.test.mjs"` (**no `node_modules` needed**).
- **A service name changed** → the error names it (`settings` / `credentials` / `llm` / `commands`); fix `ctx.get(...)` in `lib/index.js` and the matching module.
- **Module B reports `unsupported`** → the `llm.discoveries` shape moved; turn `fixDiscovery` off to recover (effective at runtime, no restart). To redo it, read `probeDiscovery` in `lib/discovery.js`.
- After an edit, re-run `dsh plugin --profile <your profile> add link:<path>` (pnpm installs a snapshot) and restart the profile.

Layering (every layer can be replaced on its own):

```
lib/constants.js   dependency-free constants (pure layers import no schemastery, so their tests need no node_modules)
lib/endpoints.js   built-in provider endpoints and catalog protocols (guarded lookup chain, degrades on failure)
lib/config.js      the configuration schema
lib/listing.js     fetching the listing (URL/auth rules aligned with official discovery)
lib/translate.js   endpoint entry → DSH model fields        ← change here when metadata shapes move
lib/merge.js       fill-only/append-only policy + the addSince gate + the protocol gate   ← change here when policy moves
lib/typing.js      route protocol decisions (the addition gate for cross-protocol catalogs, and the safety check)
lib/plan.js        the two-pass per-round plan (pure: no ctx, no network, no clock)
lib/routes.js      route facts (endpoint / key / protocol / catalog protocols)
lib/apply.js       the only write path (settings.mutate + conflict retry)
lib/discovery.js   module B: contract probe + wrapper
lib/report.js      report rendering
lib/index.js       lifecycle: startup / interval / command / self-heal
```

---

## Boundaries

- Only the three listable protocols are supported — `openai-completions` / `openai-responses` / `anthropic-messages` (the same boundary as official discovery); any other protocol is **recognised and skipped**, never probed.
- It does not write `compat`: pi-ai detects openrouter from the baseURL (`detectCompat` matches `openrouter.ai`), so there is nothing to declare.
- It does not manage the route-level `reasoning` default — that is optional; write `llm-pi-ai.providers.<route>.reasoning: high` yourself when you want it.
- It reads only the **user layer**'s `models`: a list inherited from a composition base is never rewritten.
- **`input` follows the endpoint over the catalog**: modality precedence is "endpoint list → catalog twin → the route's `defaultInput`", and DSH's default `defaultInput` is only `["text"]` — so a fill usually **adds** capability (a model the catalog calls text-only, while the endpoint reports text+image), though it also overrides a wider set from the catalog. DSH's modality vocabulary is only `text`/`image`, so a `video` the endpoint reports is not carried. To let the catalog/defaults win, drop `input` from `fill`; to force one entry, write its `input` (a field you wrote is never overwritten).
- **No cost or cache accounting**: `llm-pi-ai`'s model schema has no cost field, so cost can only be inherited from the pi-ai catalog; a model on a custom route is therefore always zero cost (cacheRead / cacheWrite included). That is an upstream schema boundary — the plugin neither writes it nor **guesses a price**.
- **Configuration is user-level**: it writes `~/.dsh/settings.yaml`, while the plugin is installed per profile. So only the profile that has the plugin refreshes that shared configuration; another profile reads the same models without refreshing them (the configuration itself always stays loadable).
- **A delisted model is reported, not deleted**: entries the endpoint no longer advertises are named, but never removed from your configuration.
- **Endpoint aliases are not written**: ids carrying `alias_target` (such as `~openai/gpt-astra-latest`) are skipped by default and named — writing one into a static configuration would let its meaning change behind your back. Set `skipAliases: false` to take them too.

## License

MIT
