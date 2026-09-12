/**
 * Deciding the wire protocol a route needs before it can accept a model its own
 * catalog cannot type.
 *
 * DSH resolves one model's protocol as `route.api ?? catalog twin's api ??
 * the one protocol the whole catalog agrees on`. A model the installed catalog
 * does not describe therefore has no answer at all when the route declares no
 * `api` and its catalog spans more than one protocol. A settings write is
 * validated as a whole, so a single untypeable entry refuses the entire round —
 * capability fills included, which is how a route can end up with neither the
 * new model nor its `reasoningEfforts`.
 *
 * The protocol is the owner's decision, never a guess: guessing wrong turns a
 * visible refused write into a model that fails every request. So this module
 * only reports what the route cannot type, and accepts the protocol declared
 * under `live-model-catalog.routes.<route>.api` after proving it would not
 * re-point a model whose catalog twin already speaks something else.
 *
 * Pure, so the policy is unit-tested rather than observed in production.
 *
 * @module dsh-live-model-catalog/typing
 */

/** Whether one model id can be typed on a route whose protocol is `routeApi`. */
export function canType(routeApi, id, catalogApis, catalogSharedApi) {
  if (typeof routeApi === 'string' && routeApi.length > 0) return true;
  if (catalogApis !== undefined && catalogApis.has(id)) return true;
  return typeof catalogSharedApi === 'string' && catalogSharedApi.length > 0;
}

/**
 * Ids whose catalog twin speaks a protocol other than `api`.
 *
 * DSH lets a route-level `api` win over the catalog twin, so declaring one
 * silently re-points every such model. That rewrites configuration the owner
 * wrote, which a fill-only plugin must refuse rather than perform.
 *
 * @param ids - every id the next write would contain.
 * @param api - the protocol that would be declared on the route.
 * @param catalogApis - the route's catalog as `id → api`, when pi-ai ships one.
 * @returns one `{ id, twin }` per id that would change protocol.
 */
export function protocolConflicts(ids, api, catalogApis) {
  if (catalogApis === undefined) return [];
  const conflicts = [];
  for (const id of ids) {
    const twin = catalogApis.get(id);
    if (twin !== undefined && twin !== api) conflicts.push({ id, twin });
  }
  return conflicts;
}

/**
 * Resolve the protocol a route may rely on for its out-of-catalog models.
 *
 * @param options - the route name, its declared `api`, the owner's override, its catalog twin protocols, and every id the next write would contain.
 * @returns `routeApi` in force, `write` when this plugin may add it, and either the blocking `conflicts` or the reason it declined.
 */
export function resolveProtocol({ route, declaredApi, overrideApi, catalogApis, ids = [] }) {
  if (typeof declaredApi === 'string' && declaredApi.length > 0) {
    return { routeApi: declaredApi, write: undefined, conflicts: [], detail: undefined };
  }
  if (typeof overrideApi !== 'string' || overrideApi.length === 0) {
    return { routeApi: undefined, write: undefined, conflicts: [], detail: undefined };
  }
  const conflicts = protocolConflicts(ids, overrideApi, catalogApis);
  if (conflicts.length > 0) {
    const named = conflicts.map((entry) => `${entry.id}（目录为 ${entry.twin}）`).join('、');
    return {
      routeApi: undefined,
      write: undefined,
      conflicts,
      detail: `live-model-catalog.routes.${route}.api="${overrideApi}" 会把既有模型的协议改写成 ${overrideApi}，因此未写入：${named}`,
    };
  }
  return { routeApi: overrideApi, write: overrideApi, conflicts: [], detail: undefined };
}

/**
 * What the owner can do about ids the route cannot type.
 * @param route - the route name.
 * @returns one actionable sentence for the report.
 */
export function protocolAdvice(route) {
  return `在 live-model-catalog.routes.${route}.api 声明该路由的协议（例如 openai-completions），插件会把它补写进 llm-pi-ai`;
}
