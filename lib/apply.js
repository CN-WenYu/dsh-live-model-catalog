/**
 * The only write path: `ctx.settings.mutate` on the `llm-pi-ai` namespace.
 *
 * Everything here goes through DSH's documented settings seam, which is what
 * makes the plugin removable: it writes fields the `llm-pi-ai` schema already
 * defines, so deleting the plugin leaves a configuration that still loads. Two
 * fields are ever written — the route's `models`, and (only for a route that
 * declares none of its own) the protocol the owner asked this plugin to declare
 * so DSH can type a model the catalog does not describe.
 *
 * Path ops carry an `expectedRevision`, so a write that raced a GUI edit is
 * refused rather than applied on top of a document this plugin never saw; the
 * caller re-reads and re-plans, which is cheap because the plan is pure.
 *
 * @module dsh-live-model-catalog/apply
 */
import { LLM_NAMESPACE } from './constants.js';

/** Read one namespace's descriptor (raw user section + revision). */
export function readNamespace(settings, ns) {
  if (settings === undefined || typeof settings?.describe !== 'function') return undefined;
  let descriptors;
  try {
    descriptors = settings.describe();
  } catch {
    return undefined;
  }
  if (!Array.isArray(descriptors)) return undefined;
  const found = descriptors.find((descriptor) => descriptor?.ns === ns);
  return found ?? undefined;
}

/**
 * The first value in a plan that DSH would refuse to persist, if any.
 *
 * DSH's write path requires JSON-shaped data, and YAML is happy to produce
 * things that are not: an unquoted `created: 2026-09-05` is a `Date`, and a
 * `@`-prefixed tag can be a class instance. Handing those to `mutate` produces
 * a TypeError naming a JSON path, which tells the reader nothing about the line
 * they wrote. Finding it here lets the report name the entry and the field, so
 * the fix is "quote it in settings.yaml" rather than a stack trace.
 *
 * `undefined` is treated as absent, not as an offence: it is droppable rather
 * than fatal, and flagging it would refuse writes DSH would accept.
 *
 * @param value - the planned payload.
 * @param path - accumulated path, for the message.
 * @returns `{ path, kind }` for the first offender, or `undefined`.
 */
export function findNonJsonValue(value, path = []) {
  if (value === null || value === undefined) return undefined;
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return undefined;
  if (kind === 'number') return Number.isFinite(value) ? undefined : { path, kind: 'NaN/Infinity' };
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const found = findNonJsonValue(item, [...path, String(index)]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (kind === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return { path, kind: value.constructor?.name ?? 'class instance' };
    for (const [key, item] of Object.entries(value)) {
      const found = findNonJsonValue(item, [...path, key]);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  return { path, kind };
}

/**
 * Plan-then-write one route's `models` list, retrying a raced write.
 *
 * `planFrom` receives the CURRENT raw user section on every attempt, so a retry
 * re-plans against the document that actually won the race instead of replaying
 * a stale decision.
 *
 * A plan may also carry `routeApi`: the protocol the owner declared under this
 * plugin's config, which a route needs before DSH can type a model its catalog
 * does not describe. It travels in the same op list so the protocol and the
 * models it enables land together or not at all.
 *
 * @param options - settings provider, route name, planner, attempt budget.
 * @returns a status plus the last plan, for reporting.
 */
export async function commitRouteModels({ settings, route, planFrom, attempts = 3 }) {
  if (settings === undefined || typeof settings?.mutate !== 'function') {
    return { status: 'unavailable', detail: 'the settings service does not expose mutate()' };
  }
  let lastPlan;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const descriptor = readNamespace(settings, LLM_NAMESPACE);
    if (descriptor === undefined) {
      return { status: 'unavailable', detail: `the "${LLM_NAMESPACE}" namespace is not registered` };
    }
    const plan = planFrom(descriptor.user);
    lastPlan = plan;
    if (plan?.next === undefined) return { status: 'skipped', plan, detail: plan?.reason };
    if (!plan.changed) return { status: 'unchanged', plan };

    const offending = findNonJsonValue(plan.next);
    if (offending !== undefined) {
      const where = offending.path.length === 0 ? 'models' : `models.${offending.path.join('.')}`;
      return {
        status: 'failed',
        plan,
        detail: `配置里的 ${where} 是 ${offending.kind}，不是 JSON 兼容值；在 settings.yaml 里把它写成字符串（加引号，例如 '2026-09-05'）后重跑`,
      };
    }

    const ops = [];
    if (typeof plan.routeApi === 'string' && plan.routeApi.length > 0) {
      ops.push({ op: 'set', path: ['providers', route, 'api'], value: plan.routeApi });
    }
    ops.push({ op: 'set', path: ['providers', route, 'models'], value: plan.next });

    try {
      await settings.mutate(LLM_NAMESPACE, ops, descriptor.revision);
      return { status: 'written', plan };
    } catch (error) {
      if (error?.code === 'SETTINGS_CONFLICT') continue;
      return { status: 'failed', plan, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return { status: 'conflict', plan: lastPlan, detail: `gave up after ${attempts} attempts` };
}
