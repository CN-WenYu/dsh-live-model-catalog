/**
 * The merge policy: fill gaps on configured entries, add only allowlisted ids.
 *
 * Two rules keep this safe to run unattended against a hand-curated
 * `settings.yaml`:
 * - an existing entry is only ever *filled*, never rewritten — a field the user
 *   set (or deliberately left to inherit) stays exactly as it is, and a route's
 *   declared efforts are a fallback the endpoint's own answer always outranks;
 * - a live id is only *added* when it matches `include`. Adding everything an
 *   endpoint advertises would turn a five-model route into a four-hundred-entry
 *   file nobody wants to read.
 *
 * Pure, so the policy is unit-tested rather than observed in production.
 *
 * @module dsh-live-model-catalog/merge
 */
import { FILLABLE_FIELDS, SNAPSHOT_BOUND } from './constants.js';
import { declaredEfforts, isAlias, translateEntry } from './translate.js';

/**
 * Match a model id against a glob. `*` spans any characters including `/` so
 * `deepseek/*` covers a whole vendor, and `?` matches one character.
 * @param id - the model id.
 * @param pattern - the glob.
 * @returns whether the id matches.
 */
export function globMatch(id, pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return false;
  const source = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`).test(id);
}

/** Deep equality over the JSON-compatible model entries this policy produces. */
function sameEntries(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Parse `addSince` into unix seconds.
 *
 * Accepts an ISO date (`2026-09-05`) or bare seconds, because the value a
 * reader wants to write is a date and the value the endpoint reports is a
 * timestamp.
 * @param value - configured bound, or empty/undefined for "no bound".
 * @returns seconds, or NaN when there is no usable bound.
 */
export function toSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== 'string' || value.trim().length === 0) return NaN;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const parsed = Date.parse(trimmed.length === 10 ? `${trimmed}T00:00:00Z` : trimmed);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
}

/**
 * Resolve the add gate for one round.
 *
 * `include` is what decides whether anything may be added at all; this bound is
 * the second gate a vendor glob needs, because `deepseek/*` matches a whole back
 * catalogue. When the snapshot date was asked for and cannot be read, the gate
 * must fail closed: an unresolvable bound silently becoming "no bound" would
 * turn a deliberately narrow whitelist into a bulk import of history.
 *
 * @param addSince - the configured value: an ISO date, unix seconds, or `snapshot`.
 * @param generatedAt - the located pi-ai catalog's `generatedAt`, when it was readable.
 * @returns the value to parse, whether additions must be withheld, and the reason to report.
 */
export function resolveAddSince(addSince, generatedAt) {
  if (addSince !== SNAPSHOT_BOUND) return { since: addSince, withhold: false, note: undefined };
  const usable =
    (typeof generatedAt === 'string' && generatedAt.length > 0) ||
    (typeof generatedAt === 'number' && Number.isFinite(generatedAt) && generatedAt > 0);
  if (usable) return { since: generatedAt, withhold: false, note: undefined };
  return {
    since: '',
    withhold: true,
    note: `addSince: "${SNAPSHOT_BOUND}" 无法解析（读不到 pi-ai 的快照生成时间），本轮只补齐不新增；可改用显式日期，或留空以真的不设下限`,
  };
}

/**
 * Whether a candidate is older than the configured bound and should be left out.
 *
 * A glob such as `deepseek/*` matches a vendor's whole back catalogue, so the
 * allowlist alone adds far more history than a hand-curated file wants.
 * `addSince` keeps only what is genuinely new. An entry the endpoint gives no
 * timestamp for is kept: dropping a model because a gateway omitted metadata
 * would be a silent failure, and silence is the one thing this plugin must not
 * trade in.
 */
function olderThan(entry, sinceSeconds) {
  if (!Number.isFinite(sinceSeconds)) return false;
  const created = entry?.raw?.created;
  if (typeof created !== 'number' || !Number.isFinite(created) || created <= 0) return false;
  return created < sinceSeconds;
}

/**
 * The fields one configured entry may take, and where each value comes from.
 *
 * Two sources feed the patch, in this order: the live listing (what the endpoint
 * reported) and the route's own declared efforts (what the owner states when the
 * endpoint is silent). The second exists because an endpoint that publishes no
 * reasoning metadata — or does not list the model at all — otherwise leaves
 * `reasoningEfforts` undeclared, and DSH then resolves every hand-declared model
 * on a route with no installed catalog as non-reasoning, so the composer offers
 * no effort levels. A model the endpoint never mentions can still take that one
 * declaration; it takes nothing else, because nothing else is known about it.
 *
 * @param entry - the configured model entry.
 * @param liveEntry - its live listing entry, when the endpoint lists it.
 * @param fillable - the fields this round may fill.
 * @param fallbackEfforts - preset for an endpoint that reasons without listing efforts.
 * @param declared - the route's normalized declared efforts, when it has any.
 * @returns the patches to merge into the entry, and the notes to report.
 */
function fillGaps(entry, liveEntry, fillable, fallbackEfforts, declared) {
  const { profile, notes } =
    liveEntry === undefined ? { profile: {}, notes: [] } : translateEntry(liveEntry, { fallbackEfforts });
  const patches = {};
  for (const field of fillable) {
    if (entry[field] !== undefined) continue;
    if (profile[field] === undefined) continue;
    patches[field] = profile[field];
  }
  const merged = [...notes];
  if (
    declared !== undefined &&
    fillable.includes('reasoningEfforts') &&
    entry.reasoningEfforts === undefined &&
    patches.reasoningEfforts === undefined
  ) {
    patches.reasoningEfforts = declared.efforts;
    merged.push(...declared.notes, '端点未提供推理档位表；已按本插件的路由档位声明补齐');
  }
  return { patches, notes: merged };
}

/**
 * Plan one route's next model list.
 *
 * A candidate the route cannot type is not planned at all: DSH validates a
 * settings write as a whole, so adding one untypeable entry would refuse the
 * fills that ride in the same write. Those ids come back as `needsProtocol` for
 * the report to explain.
 *
 * @param options - current configured entries, live entries, and policy knobs.
 * @returns the next list plus a per-id account of what happened.
 */
export function planRoute({
  current,
  live,
  include = [],
  fill = FILLABLE_FIELDS,
  fallbackEfforts,
  routeEfforts,
  addSince,
  isTypeable = () => true,
  allowAdditions = true,
  skipAliases = true,
}) {
  const sinceSeconds = toSeconds(addSince);
  const liveById = new Map();
  for (const entry of live) if (!liveById.has(entry.id)) liveById.set(entry.id, entry);

  const fillable = fill.filter((field) => FILLABLE_FIELDS.includes(field));
  const ignoredFill = fill.filter((field) => !FILLABLE_FIELDS.includes(field));
  const declared = declaredEfforts(routeEfforts);

  const next = [];
  const configured = new Set();
  const filled = [];
  const notAdvertised = [];
  const malformed = [];

  for (const entry of current) {
    const id = entry?.id;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || typeof id !== 'string' || id.length === 0) {
      malformed.push(typeof id === 'string' ? id : JSON.stringify(entry));
      next.push(entry);
      continue;
    }
    configured.add(id);
    const liveEntry = liveById.get(id);
    if (liveEntry === undefined) notAdvertised.push(id);

    const { patches, notes } = fillGaps(entry, liveEntry, fillable, fallbackEfforts, declared);
    if (Object.keys(patches).length > 0) {
      filled.push({ id, fields: Object.keys(patches), notes });
      next.push({ ...entry, ...patches });
    } else {
      next.push(entry);
    }
  }

  const added = [];
  const skipped = [];
  const tooOld = [];
  const aliases = [];
  const candidates = [];
  const needsProtocol = [];
  if (allowAdditions) {
    for (const entry of live) {
      if (configured.has(entry.id)) continue;
      if (!include.some((pattern) => globMatch(entry.id, pattern))) {
        skipped.push(entry.id);
        continue;
      }
      if (skipAliases && isAlias(entry)) {
        aliases.push(entry.id);
        continue;
      }
      if (olderThan(entry, sinceSeconds)) {
        tooOld.push(entry.id);
        continue;
      }
      candidates.push(entry.id);
      if (!isTypeable(entry.id)) {
        needsProtocol.push(entry.id);
        continue;
      }
      const { profile } = translateEntry(entry, { fallbackEfforts });
      next.push(profile);
      added.push(profile.id);
      configured.add(profile.id);
    }
  }

  return {
    next,
    changed: !sameEntries(current, next),
    added,
    filled,
    notAdvertised,
    skipped,
    tooOld,
    candidates,
    needsProtocol,
    aliases,
    ignoredFill,
    malformed,
  };
}
