/**
 * Deciding which routes to manage, and what each one needs to be read live.
 *
 * Scope is discovered, not hardcoded: by default every provider declared under
 * `llm-pi-ai` is managed (minus `exclude`), because a hand-maintained list of
 * routes is exactly the kind of thing that goes stale. `mode: listed` restores
 * the narrow behavior for anyone who wants it.
 *
 * Endpoint facts are resolved in one order — this plugin's override, then the
 * route's own `llm-pi-ai` entry, then pi-ai's built-in provider table — so a
 * built-in route that declares no `baseURL` (the normal case) is still
 * manageable, and the report always says which layer supplied it.
 *
 * @module dsh-live-model-catalog/routes
 */
import { firstText, LISTABLE_PROTOCOLS } from './constants.js';
import { globMatch } from './merge.js';

/**
 * One route's `llm-pi-ai` entry as the USER layer declares it.
 *
 * The raw user layer, not the resolved value: only a route the owner actually
 * curated should be written back to, and a `models` list inherited from a
 * composition base is not something this plugin may replace.
 */
export function userRoute(llmUser, route) {
  const providers = llmUser?.providers;
  if (providers === null || typeof providers !== 'object') return undefined;
  const entry = providers[route];
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  return entry;
}

/** Every route name the configured mode puts in scope. */
function routeNames({ config, llmUser }) {
  const overrides = config?.routes ?? {};
  if (config?.mode === 'listed') return Object.keys(overrides);
  const declared = Object.keys(llmUser?.providers ?? {});
  return [...new Set([...declared, ...Object.keys(overrides)])];
}

/**
 * The one protocol a route's catalog models agree on, when they agree.
 *
 * Only then can DSH type a model the catalog does not describe without the route
 * naming a protocol itself; a catalog spanning two protocols has no such answer.
 * @param catalogApis - the route's catalog as `id → api`, when pi-ai ships one.
 * @returns the shared protocol, or `undefined`.
 */
function sharedApi(catalogApis) {
  if (catalogApis === undefined) return undefined;
  const apis = new Set(catalogApis.values());
  return apis.size === 1 ? [...apis][0] : undefined;
}

/**
 * One route's endpoint facts, resolved in the one fixed order every caller uses:
 * this plugin's override, then the route's own `llm-pi-ai` entry, then pi-ai's
 * built-in provider table, then the protocol the shipped catalog agrees on.
 *
 * The protocol is resolved the way DSH resolves a model's protocol, because the
 * listing URL and its auth follow the protocol. Guessing `openai-completions` for
 * a shipped route that is not OpenAI-shaped asks the wrong URL with the wrong
 * header, which is how a perfectly manageable route (an `anthropic` profile is
 * just `apiKeyEnv`) turns into a permanent, unreadable failure.
 *
 * @param options - the route name, its config override, its declared entry, and both pi-ai tables.
 * @returns the endpoint, protocol, and owner-declared knobs for one route.
 */
function targetFacts({ route, override, declared, builtin, catalog }) {
  const configuredURL = firstText(override.baseURL);
  const declaredURL = firstText(declared?.baseURL);
  const catalogURL = firstText(builtin.get(route));
  const declaredApi = firstText(declared?.api);
  const overrideApi = firstText(override.api);
  const catalogApis = catalog.get(route);
  const catalogSharedApi = sharedApi(catalogApis);
  const api = overrideApi ?? declaredApi ?? catalogSharedApi ?? 'openai-completions';
  return {
    baseURL: configuredURL ?? declaredURL ?? catalogURL,
    endpointSource:
      configuredURL !== undefined ? 'config' : declaredURL !== undefined ? 'route' : catalogURL !== undefined ? 'catalog' : undefined,
    api,
    /** Whether this protocol's listing is readable at all; mirrors DSH's own boundary. */
    listable: LISTABLE_PROTOCOLS.has(api),
    /** The protocol the owner declared on the `llm-pi-ai` route itself. */
    declaredApi,
    /** The protocol the owner declared under this plugin's `routes.<name>.api`. */
    overrideApi,
    /** Catalog model protocols for this route, when pi-ai describes it. */
    catalogApis,
    /** The protocol every catalog model of this route agrees on, when they agree. */
    catalogSharedApi,
    apiKeyEnv: firstText(override.apiKeyEnv, declared?.apiKeyEnv),
    /** Where this route lists its models, when `${baseURL}/models` is not it. */
    listingPath: firstText(override.listingPath),
    /** The route's declared reasoning levels, applied only where the endpoint is silent. */
    efforts: override.efforts ?? {},
  };
}

/**
 * Build the sync targets: the routes this plugin may write to.
 *
 * Only a route the owner declared under `llm-pi-ai` has a `models` list to fill,
 * so only those are targets here. pi-ai's own providers join the DISCOVERY scope
 * instead — see {@link resolveDiscoveryTargets}.
 *
 * @param options - plugin config, the `llm-pi-ai` user layer, pi-ai's endpoint table, and its catalog protocols.
 * @returns one target per in-scope route, in discovery order.
 */
export function resolveTargets({ config, llmUser, builtin = new Map(), catalog = new Map() }) {
  const overrides = config?.routes ?? {};
  const exclude = Array.isArray(config?.exclude) ? config.exclude : [];
  const targets = [];

  for (const route of routeNames({ config, llmUser })) {
    if (config?.mode !== 'listed' && exclude.some((pattern) => globMatch(route, pattern))) continue;
    const override = overrides[route] ?? {};
    const declared = userRoute(llmUser, route);
    const models = Array.isArray(declared?.models) ? declared.models : undefined;

    targets.push({
      route,
      enabled: config?.enabled !== false && override.enabled !== false,
      ...targetFacts({ route, override, declared, builtin, catalog }),
      models,
      hasModelsList: models !== undefined,
    });
  }
  return targets;
}

/**
 * Build the DISCOVERY scope: every route this plugin may answer
 * "fetch available models" for.
 *
 * Wider than {@link resolveTargets} by exactly one case, and it is the case the
 * button exists for: a provider pi-ai ships that the owner has not declared yet.
 * `dsh-llm-pi-ai` publishes every catalog provider to the Models page whether or
 * not it is configured, and its discovery answers those from the installed
 * catalog without touching the network — so before an adoption, the live list
 * could only ever be the snapshot. Such a route has no `models` list and is
 * therefore never written to: it is resolvable for discovery and nothing else.
 *
 * `mode: listed` keeps its promise and adds nothing — that mode exists precisely
 * to narrow the scope.
 *
 * @param options - plugin config, the `llm-pi-ai` user layer, pi-ai's endpoint table, and its catalog protocols.
 * @returns the declared targets plus one synthesized target per undeclared catalog provider.
 */
export function resolveDiscoveryTargets({ config, llmUser, builtin = new Map(), catalog = new Map() }) {
  const targets = resolveTargets({ config, llmUser, builtin, catalog });
  if (config?.mode === 'listed' || config?.enabled === false) return targets;

  const overrides = config?.routes ?? {};
  const exclude = Array.isArray(config?.exclude) ? config.exclude : [];
  const covered = new Set(targets.map((target) => target.route));
  const scope = [...targets];
  for (const route of builtin.keys()) {
    if (covered.has(route)) continue;
    const override = overrides[route] ?? {};
    if (override.enabled === false) continue;
    if (exclude.some((pattern) => globMatch(route, pattern))) continue;
    scope.push({
      route,
      enabled: true,
      ...targetFacts({ route, override, declared: undefined, builtin, catalog }),
      models: undefined,
      hasModelsList: false,
    });
  }
  return scope;
}
