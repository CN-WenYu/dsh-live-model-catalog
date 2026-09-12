/**
 * Turning one route's live listing into the exact plan a write will carry.
 *
 * This is the round's decision layer and it is deliberately free of `ctx`, the
 * network and the clock: everything it needs is passed in, so the policy —
 * what gets filled, what gets added, what a route cannot type, whether the
 * owner-declared protocol may be written — is unit-tested instead of only
 * observed through a whole round.
 *
 * The two passes exist because of one asymmetry in DSH: a settings write is
 * validated as a whole, so a single model the route cannot type refuses the
 * entire round, capability fills included. Pass one asks what the route can
 * already type; pass two runs only when the owner declared a protocol under
 * this plugin's `routes.<name>.api` and that protocol is provably safe to
 * declare (see `typing.js`).
 *
 * @module dsh-live-model-catalog/plan
 */
import { planRoute } from './merge.js';
import { canType, protocolAdvice, resolveProtocol } from './typing.js';

/**
 * Plan one route's update against the raw user layer.
 *
 * @param options - the route's typing facts, the config, the live listing, the resolved add gate, the raw user layer, and whether additions are allowed.
 * @returns the plan, or `{ reason }` when the route lost the list this built on.
 */
export function planRouteUpdate({ target, config, live, include, since, user, additions = true }) {
  const models = user?.providers?.[target.route]?.models;
  if (!Array.isArray(models)) return { reason: 'the route lost its models list since the read' };
  const configuredIds = models.map((entry) => entry?.id).filter((id) => typeof id === 'string');
  const common = {
    current: models,
    live,
    include,
    fill: config.fill,
    addSince: since,
    fallbackEfforts: config.defaultEfforts,
    allowAdditions: additions,
    skipAliases: config.skipAliases !== false,
  };

  const declared = planRoute({
    ...common,
    isTypeable: (id) => canType(target.declaredApi, id, target.catalogApis, target.catalogSharedApi),
  });
  const protocol = resolveProtocol({
    route: target.route,
    declaredApi: target.declaredApi,
    overrideApi: target.overrideApi,
    catalogApis: target.catalogApis,
    ids: [...configuredIds, ...declared.candidates],
  });
  const useDeclared = protocol.write !== undefined && declared.needsProtocol.length > 0;
  const planned = useDeclared
    ? planRoute({
        ...common,
        isTypeable: (id) => canType(protocol.routeApi, id, target.catalogApis, target.catalogSharedApi),
      })
    : declared;

  return {
    ...planned,
    routeApi: useDeclared ? protocol.write : undefined,
    protocolNote: useDeclared
      ? `已为 ${target.route} 补写 api: ${protocol.write}（来自 live-model-catalog.routes.${target.route}.api）`
      : protocol.detail,
    protocolAdvice: planned.needsProtocol.length > 0 ? protocolAdvice(target.route) : undefined,
    changed: planned.changed || useDeclared,
  };
}
