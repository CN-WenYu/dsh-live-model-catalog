/**
 * dsh-live-model-catalog — keep `llm-pi-ai` routes in step with the endpoints
 * that actually serve them.
 *
 * Two gaps in DSH motivate this plugin:
 * 1. a route whose provider id pi-ai ships answers discovery from its installed
 *    catalog and never hits the network, so models released after that snapshot
 *    cannot be found from the GUI;
 * 2. a hand-declared model has no catalog twin, so `resolveModelReasoning`
 *    reports it as non-reasoning and the composer offers no effort levels.
 *
 * Both are fixed the same way: read each managed route's own `/models`, then
 * write the model ids and capability fields DSH already defines
 * (`contextWindow`, `maxTokens`, `input`, `reasoningEfforts`) through the
 * official settings seam. Nothing here patches DSH; the plugin can be removed
 * and the configuration it wrote stays valid.
 *
 * @module dsh-live-model-catalog
 */
import { Config } from './config.js';
import { LLM_NAMESPACE, NAMESPACE } from './constants.js';
import { fetchListing, resolveApiKey, worthRetrying } from './listing.js';
import { translateEntry } from './translate.js';
import { resolveAddSince } from './merge.js';
import { resolveTargets } from './routes.js';
import { builtinEndpoints } from './endpoints.js';
import { commitRouteModels, readNamespace } from './apply.js';
import { planRouteUpdate } from './plan.js';
import { ensureDiscovery, removeDiscovery } from './discovery.js';
import { renderReport } from './report.js';

export const name = 'dsh-live-model-catalog';
export const inject = ['settings'];

/** Live listings are shared between the two halves and reused briefly. */
const CACHE_TTL_MS = 60_000;
/**
 * Attempts per round. A second one only ever fires for a transport failure —
 * an HTTP answer is final for the round, which keeps a 429 from being doubled
 * and leaves the pace the endpoint asked for to the next round.
 */
const LISTING_ATTEMPTS = 2;

/** A picked listing, as the discovery seam expects it. */
function toDiscovered(entry) {
  const { profile } = translateEntry(entry);
  return {
    id: profile.id,
    ...(profile.name === undefined ? {} : { name: profile.name }),
    ...(profile.contextWindow === undefined ? {} : { contextWindow: profile.contextWindow }),
    ...(profile.maxTokens === undefined ? {} : { maxTokens: profile.maxTokens }),
  };
}

export function apply(ctx) {
  const scope = ctx.settings.register(NAMESPACE, Config, { applies: 'live' });
  const cache = new Map();
  let endpoints;
  let timer;
  let startupTimer;
  let watchTimer;
  let running;
  let lastReport;

  const log = (message, level = 'info') => {
    const logger = ctx.logger;
    if (typeof logger?.[level] === 'function') logger[level](`[live-model-catalog] ${message}`);
  };

  const config = () => {
    const value = scope.get();
    return { ...value, fill: Array.isArray(value.fill) ? value.fill : [] };
  };

  const llmUser = () => readNamespace(ctx.get('settings'), LLM_NAMESPACE)?.user;

  /**
   * pi-ai's provider endpoints, resolved once per process and retried while
   * empty. This is what lets a built-in route with no `baseURL` in its profile
   * be managed without anyone listing it by hand.
   */
  const endpointTable = async () => {
    if (endpoints === undefined || endpoints.table.size === 0) endpoints = await builtinEndpoints();
    return endpoints;
  };

  const targetsNow = async (cfg) => {
    const resolved = await endpointTable();
    return resolveTargets({ config: cfg, llmUser: llmUser(), builtin: resolved.table, catalog: resolved.models });
  };

  /** Fetch one route's live listing, briefly cached so both halves share it. */
  const listingFor = async (target, { baseURL, api, apiKey, signal } = {}) => {
    const key = `${target.route}|${baseURL ?? target.baseURL ?? ''}`;
    const cached = cache.get(key);
    if (cached !== undefined && Date.now() - cached.at < CACHE_TTL_MS) return cached.entries;

    const effectiveBaseURL = baseURL ?? target.baseURL;
    if (typeof effectiveBaseURL !== 'string' || effectiveBaseURL.length === 0) {
      throw new Error('no baseURL: set it on the route or under live-model-catalog.routes');
    }
    const effectiveApi = api ?? target.api;
    const effectiveKey = apiKey ?? (await resolveApiKey(ctx, target.apiKeyEnv));

    let lastError;
    for (let attempt = 1; attempt <= LISTING_ATTEMPTS; attempt += 1) {
      try {
        const entries = await fetchListing({
          baseURL: effectiveBaseURL,
          api: effectiveApi,
          apiKey: effectiveKey,
          timeoutMs: Number(config().requestTimeoutSeconds) * 1000,
          signal,
        });
        cache.set(key, { at: Date.now(), entries });
        return entries;
      } catch (error) {
        lastError = error;
        if (!worthRetrying(error, signal)) break;
      }
    }
    throw lastError;
  };

  /** Plan and commit one route. */
  const syncRoute = async (target, cfg, settings) => {
    const base = {
      route: target.route,
      endpointSource: target.endpointSource,
      added: [],
      refused: [],
      filled: [],
      needsProtocol: [],
      aliases: [],
      notAdvertised: [],
      skipped: 0,
      tooOld: 0,
      notes: [],
    };
    if (!target.enabled) return { ...base, status: 'skipped', detail: 'disabled' };
    if (!target.listable) {
      return {
        ...base,
        status: 'skipped',
        detail: `该路由的协议 "${target.api}" 无法列举模型（与官方 discovery 的边界一致；要在 routes.${target.route}.api 里改协议），已跳过`,
      };
    }
    if (!target.hasModelsList) {
      return {
        ...base,
        status: 'skipped',
        detail: '该路由未声明 models 列表；写入 models 会替换整个内置目录，因此跳过',
      };
    }

    const live = await listingFor(target);

    // The add gate, resolved once per round: a snapshot bound is read from the
    // located pi-ai build, and an unreadable one withholds additions rather
    // than becoming an open gate.
    const bound = resolveAddSince(cfg.addSince, (await endpointTable()).generatedAt);
    const include = bound.withhold ? [] : cfg.include;
    const planFor = (user, additions) =>
      planRouteUpdate({ target, config: cfg, live, include, since: bound.since, user, additions });

    let result = await commitRouteModels({ settings, route: target.route, planFrom: (user) => planFor(user) });
    let degraded = false;
    if (result.status === 'failed' && (result.plan?.added?.length ?? 0) > 0) {
      // A whole-write refusal must not sink the fills it also carried: retry
      // without the additions, and keep the refusal on the report.
      const safe = await commitRouteModels({
        settings,
        route: target.route,
        planFrom: (user) => planFor(user, false),
      });
      if (safe.status === 'written') {
        degraded = true;
        result = { ...result, status: 'written' };
      }
    }
    const plan = result.plan ?? {};
    const written = !degraded;
    return {
      ...base,
      status: result.status,
      detail: result.detail,
      degraded,
      liveCount: live.length,
      added: written ? plan.added ?? [] : [],
      refused: written ? [] : plan.added ?? [],
      filled: plan.filled ?? [],
      needsProtocol: plan.needsProtocol ?? [],
      aliases: plan.aliases ?? [],
      protocolNote: written ? plan.protocolNote : undefined,
      protocolAdvice: plan.protocolAdvice,
      notAdvertised: plan.notAdvertised ?? [],
      skipped: (plan.skipped ?? []).length,
      tooOld: (plan.tooOld ?? []).length,
      notes: [
        ...(bound.note === undefined ? [] : [bound.note]),
        ...(plan.ignoredFill ?? []).map((field) => `忽略未知补齐字段 "${field}"`),
        ...(plan.malformed ?? []).map((id) => `配置里的模型条目无法识别：${id}`),
      ],
    };
  };

  /**
   * The route scope the discovery wrapper reads at call time.
   *
   * Mutated in place rather than replaced: the installed wrapper closes over the
   * predicate that reads this Set, so a round that widens the scope becomes
   * visible to the wrapper already in the table without reinstalling it.
   */
  const managedRoutes = new Set();

  /**
   * Refresh the discovery wrapper's scope, install or remove it, and say what
   * happened. Deliberately network-free: it resolves route facts only, so the
   * switch can react to a config edit immediately instead of at the next round.
   */
  const syncDiscovery = async (cfg) => {
    managedRoutes.clear();
    for (const target of await targetsNow(cfg)) if (target.enabled) managedRoutes.add(target.route);
    // The master switch wins over the module-B switch: a disabled plugin owns
    // nothing, so an installed wrapper must go back to the official entry.
    if (cfg.enabled === false || cfg.fixDiscovery !== true) return removeDiscovery({ ctx });
    return ensureDiscovery({
      ctx,
      log,
      isManaged: (provider) => managedRoutes.has(provider),
      live: async (provider, request, signal) => {
        const target = (await targetsNow(config())).find((item) => item.route === provider);
        if (target === undefined) return undefined;
        const entries = await listingFor(target, {
          baseURL: request?.baseURL,
          api: request?.api,
          apiKey: request?.apiKey,
          signal,
        });
        return entries.map(toDiscovered);
      },
    });
  };

  /** One full round; never rejects. */
  const doSync = async (trigger) => {
    const cfg = config();
    const report = {
      trigger,
      config: { include: cfg.include, addSince: cfg.addSince, fill: cfg.fill, fixDiscovery: cfg.fixDiscovery === true },
      routes: [],
      discovery: undefined,
    };
    try {
      if (cfg.enabled === false) {
        log('disabled by config; nothing to do');
      } else {
        const settings = ctx.get('settings');
        const descriptor = readNamespace(settings, LLM_NAMESPACE);
        if (descriptor === undefined) {
          log(`namespace "${LLM_NAMESPACE}" is not registered yet`, 'warn');
        } else {
          const endpointsResolved = await endpointTable();
          report.endpoints = endpointsResolved.detail;
          const targets = resolveTargets({
            config: cfg,
            llmUser: descriptor.user,
            builtin: endpointsResolved.table,
            catalog: endpointsResolved.models,
          });
          if (targets.length === 0) log('no llm-pi-ai routes to manage');
          for (const target of targets) {
            try {
              report.routes.push(await syncRoute(target, cfg, settings));
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              report.routes.push({
                route: target.route,
                status: 'failed',
                detail: message,
                added: [],
                refused: [],
                filled: [],
                needsProtocol: [],
                aliases: [],
                notAdvertised: [],
                skipped: 0,
                notes: [],
              });
              log(`${target.route}: ${message}`, 'warn');
            }
          }
        }
      }

      // Outside the enabled check on purpose: turning the plugin off must also
      // give the discovery table back.
      const discovery = await syncDiscovery(cfg);
      if (cfg.fixDiscovery === true && cfg.enabled !== false) {
        report.discovery = discovery;
        if (discovery.status !== 'installed') log(`discovery fix: ${discovery.status} — ${discovery.detail}`, 'warn');
      } else if (discovery.status === 'removed') {
        report.discovery = discovery;
        log('discovery fix: 已还原官方发现（fixDiscovery 关闭）');
      }
    } catch (error) {
      log(`round failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`, 'warn');
    }
    lastReport = report;
    return report;
  };

  const runSync = (trigger) => {
    if (running !== undefined) return running;
    running = doSync(trigger).finally(() => {
      running = undefined;
    });
    return running;
  };

  const arm = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    const cfg = config();
    const minutes = Number(cfg.intervalMinutes);
    if (cfg.enabled === false || !Number.isFinite(minutes) || minutes <= 0) return;
    timer = setTimeout(async () => {
      const report = await runSync('interval');
      log(renderReport(report).split('\n')[0]);
      arm();
    }, Math.max(1, minutes) * 60_000);
    timer.unref?.();
  };

  // Boot: never block startup on the network, and never hold a short-lived
  // process (a headless one-shot task) open waiting for a sync.
  const delaySeconds = Number(config().startupDelaySeconds);
  startupTimer = setTimeout(async () => {
    const report = await runSync('startup');
    for (const line of renderReport(report).split('\n')) log(line);
    arm();
  }, (Number.isFinite(delaySeconds) ? Math.max(0, delaySeconds) : 5) * 1000);
  startupTimer.unref?.();

  ctx.effect(
    () => () => {
      if (timer !== undefined) clearTimeout(timer);
      if (startupTimer !== undefined) clearTimeout(startupTimer);
      if (watchTimer !== undefined) clearTimeout(watchTimer);
    },
    'live-model-catalog timers',
  );

  // A debounced round, shared by the two things that mean "the answer may have
  // changed": an `llm-pi-ai` edit, and an edit to this plugin's own config.
  //
  // Self-healing is why the first exists: DSH's own "fetch available models"
  // adopt path copies only id/name/contextWindow/maxTokens, so a model adopted
  // from the picker lands without `input` or `reasoningEfforts`. The round is
  // idempotent, so the write it may perform cannot loop.
  const scheduleRound = (trigger) => {
    if (watchTimer !== undefined) clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      watchTimer = undefined;
      void runSync(trigger);
    }, 1500);
    watchTimer.unref?.();
  };

  scope.watch(() => {
    arm();
    // Declaring a route protocol is the config edit that matters most, and it
    // only pays off once a round runs: re-arming the interval alone would leave
    // the reader waiting up to `intervalMinutes` for the effect of what they
    // just typed.
    scheduleRound('config-change');
    // The discovery wrapper is the one thing that must react immediately: it is
    // this plugin's only internal-API touch, and leaving it live after the
    // switch reads "关" would make the report disagree with the button.
    // `syncDiscovery` resolves route facts only, so this costs no network call.
    void syncDiscovery(config())
      .then((state) => {
        if (state.status === 'removed') log('discovery fix: 已还原官方发现（fixDiscovery 关闭）');
        else if (state.status === 'installed' && config().fixDiscovery === true) log('discovery fix: 已接管「获取可用模型」');
      })
      .catch((error) => log(`discovery fix: ${error instanceof Error ? error.message : String(error)}`, 'warn'));
  });

  ctx.on('settings/updated', (ns) => {
    if (ns === LLM_NAMESPACE) scheduleRound('settings-change');
  });

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'model-catalog',
      description: '同步 llm-pi-ai 路由的实时模型目录；`/model-catalog status` 查看上次结果',
      input: { hint: 'status | sync' },
      handler: async (invocation) => {
        const argument = String(invocation?.rawInput ?? '').trim().toLowerCase();
        const report = argument.startsWith('s') ? await runSync('command') : lastReport;
        if (report === undefined) return { kind: 'error', text: '还没有跑过同步；用 /model-catalog sync 立即执行一轮。' };
        return { kind: 'success', text: renderReport(report) };
      },
    });
  });
}
