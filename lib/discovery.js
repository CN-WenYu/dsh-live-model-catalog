/**
 * Making the Models page's "fetch available models" consult the live endpoint.
 *
 * `dsh-llm-pi-ai` answers discovery from its installed catalog whenever the
 * provider id is one pi-ai ships, and never touches the network — so for the
 * built-in `openrouter` route the button can only ever return the models baked
 * into the running pi-ai build.
 *
 * There is no official extension point for this: the `llm` service exposes a
 * single event (`llm/stream`) and `registerModelDiscovery` refuses a second
 * registration for the same namespace. The one seam that exists is the
 * discovery table itself, keyed by settings namespace. That is an internal
 * field, so this module is written to fail loudly rather than silently: it
 * probes the contract, refuses to install if the shape moved, leaves the
 * official behavior untouched on any failure — and can put the official entry
 * back, so the switch that installed it also works at runtime.
 *
 * @module dsh-live-model-catalog/discovery
 */
import { LLM_NAMESPACE } from './constants.js';

/** Marks our wrapper so a re-read can tell an installed fix from a fresh original. */
const WRAPPER_MARK = Symbol.for('dsh-live-model-catalog/discovery-wrapper');

/** The official discovery the wrapper replaced, so the switch can be undone. */
const WRAPPED_ORIGINAL = Symbol.for('dsh-live-model-catalog/discovery-original');

/**
 * Probe the discovery-table contract.
 * @param ctx - plugin context.
 * @returns the table when the contract holds, else a reason.
 */
export function probeDiscovery(ctx) {
  const llm = typeof ctx?.get === 'function' ? ctx.get('llm') : undefined;
  if (llm === undefined || llm === null) return { ok: false, detail: 'the llm service is not available' };
  const table = llm.discoveries;
  if (!(table instanceof Map)) return { ok: false, detail: 'llm.discoveries is not a Map any more' };
  return { ok: true, table };
}

/**
 * Install (or re-assert) the discovery wrapper.
 *
 * Called once per sync round rather than once at mount: the wrapper must be
 * installed after `llm-pi-ai` registers its own discovery, and re-asserted if
 * that plugin reloads and replaces the entry.
 *
 * `isManaged` is consulted on every discovery call, so the caller can hand in a
 * predicate over a scope it keeps current — the installed wrapper never caches
 * the route set it was installed with.
 *
 * @param options - context, managed-route predicate, live fetcher, logger.
 * @returns the install status, for the report.
 */
export function ensureDiscovery({ ctx, isManaged, live, log }) {
  const probed = probeDiscovery(ctx);
  if (!probed.ok) return { status: 'unsupported', detail: probed.detail };

  const original = probed.table.get(LLM_NAMESPACE);
  if (typeof original !== 'function') {
    return { status: 'pending', detail: `"${LLM_NAMESPACE}" has not registered a discovery yet` };
  }
  if (original[WRAPPER_MARK] === true) return { status: 'installed', detail: 'live discovery in place' };

  const wrapper = async function liveModelCatalogDiscovery(request, signal) {
    if (signal?.aborted) return original(request, signal);
    const provider = request?.provider;
    if (typeof provider === 'string' && provider.length > 0 && isManaged(provider)) {
      try {
        const models = await live(provider, request, signal);
        if (Array.isArray(models) && models.length > 0) return models;
        log(`discovery: ${provider} answered with no models; falling back to the installed catalog`);
      } catch (error) {
        log(`discovery: live fetch for ${provider} failed (${error instanceof Error ? error.message : String(error)}); falling back`);
      }
    }
    return original(request, signal);
  };
  Object.defineProperty(wrapper, WRAPPER_MARK, { value: true });
  Object.defineProperty(wrapper, WRAPPED_ORIGINAL, { value: original });

  probed.table.set(LLM_NAMESPACE, wrapper);
  return { status: 'installed', detail: 'live discovery installed over the installed catalog' };
}

/**
 * Put the official discovery back.
 *
 * The switch has to mean something at runtime, not only on the next boot: once
 * this plugin has wrapped the table, a config edit turning `fixDiscovery` off
 * must restore the entry the wrapper replaced, or the report would say "关"
 * while the button was still answering from the endpoint.
 *
 * The recorded original is always the one this plugin wrapped: `llm-pi-ai`
 * cannot re-register over the wrapper (it would be refused as
 * DUPLICATE_DISCOVERY), so there is no newer registration to preserve. A
 * `llm-pi-ai` reload deletes the key outright, which also removes the wrapper —
 * the next round then installs a fresh one over the fresh original.
 *
 * @param options - plugin context.
 * @returns the removal status, for the report.
 */
export function removeDiscovery({ ctx }) {
  const probed = probeDiscovery(ctx);
  if (!probed.ok) return { status: 'unsupported', detail: probed.detail };
  const current = probed.table.get(LLM_NAMESPACE);
  if (typeof current !== 'function' || current[WRAPPER_MARK] !== true) {
    return { status: 'absent', detail: `"${LLM_NAMESPACE}" 上没有被本插件包装的发现` };
  }
  const original = current[WRAPPED_ORIGINAL];
  if (typeof original !== 'function') {
    return { status: 'unsupported', detail: '包装上没有可还原的官方发现' };
  }
  probed.table.set(LLM_NAMESPACE, original);
  return { status: 'removed', detail: '已还原官方发现' };
}
