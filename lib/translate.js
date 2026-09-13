/**
 * Translating one live listing entry into the model profile DSH stores.
 *
 * Pure and side-effect free, because this is the layer that will need fixing
 * when a provider changes its metadata shape — a unit test here is faster than
 * a restart, and it is the fastest way to tell whether a DSH upgrade broke us.
 *
 * @module dsh-live-model-catalog/translate
 */
import { FALLBACK_EFFORTS, MODALITIES, THINKING_LEVELS } from './constants.js';

/** A positive integer field, or `undefined` when absent or unusable. */
function positive(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return Math.round(candidate);
  }
  return undefined;
}

/** A non-empty string field, or `undefined`. */
function text(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return undefined;
}

/** Read an array of strings, or `undefined` when the shape is not one. */
function strings(value) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => typeof item === 'string' && item.length > 0);
}

/**
 * Normalize an owner-declared level → wire dict into DSH's `reasoningEfforts`.
 *
 * This is the same shape `effortMap` builds from an endpoint's answer, so the
 * two can share one validation: declared levels carry the wire spelling
 * dispatch sends, `null` is legal only on `off` (where it means "send the
 * parameter's absence"), and a level DSH cannot express is dropped with a note
 * rather than guessed at. A dict that offers nothing beyond `off` is refused
 * outright — DSH rejects such an entry, and a single rejected field refuses the
 * whole settings write.
 *
 * @param efforts - the configured `level → wire` dict, when the owner wrote one.
 * @returns the dict and notes, or `undefined` when nothing should be declared.
 */
export function declaredEfforts(efforts) {
  if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts)) return undefined;
  const notes = [];
  const kept = {};
  for (const [level, wire] of Object.entries(efforts)) {
    if (!THINKING_LEVELS.includes(level)) {
      notes.push(`unsupported effort "${level}" ignored`);
      continue;
    }
    if (wire === null) {
      if (level !== 'off') {
        notes.push(`reasoningEfforts.${level} 需要 wire 值；只有 off 可以为空`);
        continue;
      }
      kept.off = null;
      continue;
    }
    if (typeof wire !== 'string' || wire.length === 0) {
      notes.push(`reasoningEfforts.${level} 的值必须是非空字符串`);
      continue;
    }
    kept[level] = wire;
  }
  if (!Object.keys(kept).some((level) => level !== 'off')) return undefined;
  return { efforts: kept, notes };
}

/**
 * Map an endpoint's reasoning metadata onto DSH's `reasoningEfforts` dict.
 *
 * The dict's keys are selectable levels and its values the wire spelling
 * dispatch sends. Two asymmetries matter:
 * - `off` with a value sends that value; `off: null` omits the parameter
 *   entirely. `none` from an endpoint means "disable", so it becomes `off:
 *   'none'` rather than a valueless key.
 * - A level DSH does not know is dropped, not guessed at, and reported so the
 *   reader learns the endpoint moved rather than silently losing a level.
 *
 * @param reasoning - the entry's `reasoning` object, when it has one.
 * @param fallbackEfforts - preset used when the endpoint reasons but publishes no effort list.
 * @returns the dict, notes, or `undefined` when nothing should be declared.
 */
export function effortMap(reasoning, fallbackEfforts = FALLBACK_EFFORTS) {
  if (reasoning === null || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
    return undefined;
  }
  const notes = [];
  const declared = strings(reasoning.supported_efforts);
  const efforts = {};

  if (declared !== undefined && declared.length > 0) {
    for (const raw of declared) {
      const level = raw === 'none' ? 'off' : raw;
      if (!THINKING_LEVELS.includes(level)) {
        notes.push(`unsupported effort "${raw}" ignored`);
        continue;
      }
      efforts[level] = level === 'off' ? 'none' : level;
    }
  } else {
    const preset = declaredEfforts(fallbackEfforts);
    if (preset !== undefined) {
      Object.assign(efforts, preset.efforts);
      notes.push(...preset.notes, 'no effort list published; preset applied');
    }
  }

  // Reasoning a model cannot turn off must not offer "off": declining the one
  // level the endpoint refuses is better than a control that cannot do it.
  if (reasoning.mandatory === true) delete efforts.off;

  // A dict whose only selectable level is `off` says nothing DSH did not
  // already assume, so it is left absent instead of written as noise.
  if (!Object.keys(efforts).some((level) => level !== 'off')) return undefined;

  return { efforts, notes };
}

/**
 * Whether the listing itself calls this id an alias of something else.
 *
 * A gateway that publishes `-latest`-style ids marks them (`alias_target` on
 * OpenRouter, an object like `{ name, slug }`), and such an id resolves to a
 * different model over time. Writing
 * one into a pinned `models` entry would make the configuration mean something
 * new every release, so the sync leaves them out by default — and reports them,
 * because "why is my model not listed" must not be a guess.
 *
 * @param entry - the listing entry.
 * @returns whether the endpoint marked it as an alias.
 */
export function isAlias(entry) {
  const target = entry?.raw?.alias_target;
  // OpenRouter publishes `{ name, slug }`; keep accepting a bare string so a
  // gateway that spells it that way is not silently treated as a real model.
  if (typeof target === 'string') return target.length > 0;
  return target !== null && typeof target === 'object' && !Array.isArray(target) && Object.keys(target).length > 0;
}

/**
 * Translate one `{ id, raw }` listing entry into a stored model profile.
 *
 * Only fields the endpoint actually reported are emitted; an absent field stays
 * absent so the entry keeps inheriting whatever the catalog or the route says.
 * That is what keeps this merge-only: it can fill a gap, never overwrite a
 * value someone chose.
 *
 * @param entry - the listing entry.
 * @param options - preset efforts for endpoints that publish none.
 * @returns the profile fragment (always carrying `id`) and notes.
 */
export function translateEntry(entry, options = {}) {
  const id = entry?.id;
  if (typeof id !== 'string' || id.length === 0) throw new Error('listing entry has no usable id');
  const raw = entry.raw ?? {};
  const profile = { id };
  const notes = [];

  const name = text(raw.name, raw.display_name, raw.displayName);
  if (name !== undefined) profile.name = name;

  const contextWindow = positive(
    raw.context_length,
    raw.context_window,
    raw.contextWindow,
    raw.limit?.context,
    raw.top_provider?.context_length,
    raw.max_input_tokens,
  );
  if (contextWindow !== undefined) profile.contextWindow = contextWindow;

  const maxTokens = positive(
    raw.top_provider?.max_completion_tokens,
    raw.max_completion_tokens,
    raw.max_output_tokens,
    raw.maxTokens,
    raw.max_tokens,
    raw.limit?.output,
  );
  if (maxTokens !== undefined) profile.maxTokens = maxTokens;

  const modalities = strings(raw.architecture?.input_modalities) ?? strings(raw.input_modalities) ?? strings(raw.input);
  if (modalities !== undefined) {
    const input = MODALITIES.filter((modality) => modalities.includes(modality));
    // An empty list would claim "accepts nothing", which is an answer DSH acts
    // on; absence is how this layer says "no opinion".
    if (input.length > 0) profile.input = input;
  }

  const reasoning = effortMap(raw.reasoning, options.fallbackEfforts);
  if (reasoning !== undefined) {
    profile.reasoningEfforts = reasoning.efforts;
    notes.push(...reasoning.notes);
  }

  return { profile, notes };
}
