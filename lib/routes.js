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
import { LISTABLE_PROTOCOLS } from './constants.js';
import { globMatch } from './merge.js';

/** First non-empty string of the candidates. */
function firstText(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

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
 * Build the sync targets.
 *
 * The listing protocol is resolved the way DSH resolves a model's protocol —
 * this plugin's override, then the route's own `api`, then the one protocol the
 * shipped catalog agrees on — because the listing URL and its auth follow the
 * protocol. Guessing `openai-completions` for a shipped route that is not
 * OpenAI-shaped asks the wrong URL with the wrong header, which is how a
 * perfectly manageable route (an `anthropic` profile is just `apiKeyEnv`) turns
 * into a permanent, unreadable failure.
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

    const configuredURL = firstText(override.baseURL);
    const declaredURL = firstText(declared?.baseURL);
    const catalogURL = firstText(builtin.get(route));
    const baseURL = configuredURL ?? declaredURL ?? catalogURL;

    const declaredApi = firstText(declared?.api);
    const overrideApi = firstText(override.api);
    const catalogApis = catalog.get(route);
    const catalogSharedApi = sharedApi(catalogApis);
    const api = overrideApi ?? declaredApi ?? catalogSharedApi ?? 'openai-completions';

    targets.push({
      route,
      enabled: config?.enabled !== false && override.enabled !== false,
      baseURL,
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
      models,
      hasModelsList: models !== undefined,
    });
  }
  return targets;
}
