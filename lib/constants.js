/**
 * Dependency-free constants shared by every module.
 *
 * Kept apart from `config.js` on purpose: only the schema needs schemastery, so
 * the pure translation and merge layers — and their tests — load with no
 * `node_modules` at all. That is what lets `npm test` vet a DSH upgrade in
 * seconds, before anything is installed.
 *
 * @module dsh-live-model-catalog/constants
 */

/** This plugin's own settings namespace. */
export const NAMESPACE = 'live-model-catalog';

/** The DSH LLM namespace this plugin reads and writes; owned by dsh-llm-pi-ai. */
export const LLM_NAMESPACE = 'llm-pi-ai';

/**
 * Every reasoning level DSH's llm-pi-ai schema accepts as a `reasoningEfforts`
 * key, in escalation order. Mirrors `THINKING_LEVELS` in dsh-llm-pi-ai; a level
 * an endpoint advertises but this list lacks is reported, never written.
 */
export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Level → wire value used when an endpoint reports that a model reasons but
 * does not enumerate its efforts. `off: 'none'` is OpenRouter's explicit
 * disable; a valueless `off` would omit the parameter, which for a model that
 * thinks by default is not the same request.
 */
export const FALLBACK_EFFORTS = { off: 'none', high: 'high', max: 'max' };

/** Model-entry fields the sync is allowed to fill. */
export const FILLABLE_FIELDS = ['contextWindow', 'maxTokens', 'input', 'reasoningEfforts'];

/**
 * The `addSince` value meaning "only whatever the installed pi-ai snapshot
 * predates". A hand-typed date goes stale silently — it keeps excluding real
 * releases the day the snapshot moves past it — so the bound is anchored to the
 * snapshot's own generation date instead.
 */
export const SNAPSHOT_BOUND = 'snapshot';

/** Request modalities DSH models may declare. */
export const MODALITIES = ['text', 'image'];

/**
 * The protocols whose model listing is readable at all. Mirrors
 * `LISTABLE_PROTOCOLS` in dsh-llm-pi-ai: the platform refuses every other
 * protocol up front (`DISCOVERY_UNSUPPORTED`) rather than guessing at an
 * endpoint, and a route outside this set must be reported as unlistable
 * instead of being probed and failing with a confusing 404 or non-JSON error.
 */
export const LISTABLE_PROTOCOLS = new Set(['anthropic-messages', 'openai-completions', 'openai-responses']);
