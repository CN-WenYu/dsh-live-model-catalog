/**
 * Discovering the endpoint of a provider pi-ai ships.
 *
 * A catalog route usually declares no `baseURL` — the profile omits it and DSH
 * fills it from pi-ai (`reuseCatalogProvider` does `spec.baseURL ?? base.baseUrl`).
 * Reading that value is what lets this plugin manage every built-in provider
 * instead of only the routes someone listed by hand.
 *
 * The same read yields each catalog model's wire protocol. That is what lets the
 * sync tell a route which of its advertised models it can already type and which
 * need a route-level `api` — see `typing.js`.
 *
 * The lookup is deliberately defensive, because it reaches into another
 * package's file layout:
 * 1. a bare import, which works wherever pi-ai is resolvable from this plugin;
 * 2. otherwise, find the pi-ai directory by walking up from `dsh-llm-pi-ai`'s
 *    resolved entry — the same path Node's own resolution would take;
 * 3. otherwise give up and say so. A route whose endpoint cannot be found is
 *    reported, and a `baseURL` in this plugin's config overrides everything.
 *
 * @module dsh-live-model-catalog/endpoints
 */
import { createRequire } from 'node:module';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const PACKAGE_ENTRY = ['node_modules', '@earendil-works', 'pi-ai', 'dist', 'index.js'];
/** The provider table lives beside the entry; both are derived from the located package. */
const PROVIDERS_SUBPATH = './providers/all.js';
/** The publish manifest beside the provider data, carrying `generatedAt`. */
const MANIFEST_SUBPATH = './data/.manifest.json';
/** How far up to look for a hoisted pi-ai; deeper nesting than this is not a layout Node resolves through anyway. */
const MAX_WALK = 6;

/**
 * Anchors tried in order. `process.argv[1]` is the booted app's entry — the dsh
 * CLI, which resolves every plugin package — so it leads. The rest are there so
 * the lookup still works when this module is driven outside that process (a
 * test harness, a dry-run script).
 */
function anchors() {
  return [process.argv[1], import.meta.url, join(process.cwd(), 'index.js')].filter(
    (anchor) => typeof anchor === 'string' && anchor.length > 0,
  );
}

/** The real file a path points at, or `undefined` when it does not resolve. */
function safeRealpath(path) {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Every path one anchor is reachable through: the path itself, and the real file
 * it points at.
 *
 * `createRequire` does not follow a symlink, so resolving a globally installed
 * CLI by the name on `PATH` (`~/.npm-global/bin/dsh`) fails even though the same
 * path resolved through `realpath` sits right beside the package tree. Missing
 * that made every shipped-provider lookup fail in the real process while passing
 * in every test that handed in the resolved path — the exact blind spot this
 * function exists to close.
 *
 * @param anchor - one candidate anchor: a path or a `file:` URL.
 * @returns the deduplicated variants to try.
 */
export function anchorVariants(anchor) {
  const variants = [];
  for (const candidate of [anchor, safeRealpath(anchor)]) {
    if (typeof candidate === 'string' && candidate.length > 0 && !variants.includes(candidate)) variants.push(candidate);
  }
  return variants;
}

/** Locate pi-ai's directory by walking up from a resolved dsh package entry. */
function locateFromAnchor(anchor) {
  let require_;
  try {
    require_ = createRequire(anchor);
  } catch {
    return undefined;
  }
  for (const specifier of ['@deepseek-ai/dsh-llm-pi-ai', '@deepseek-ai/dsh']) {
    let entry;
    try {
      entry = require_.resolve(specifier);
    } catch {
      continue;
    }
    let dir = dirname(entry);
    for (let step = 0; step < MAX_WALK && dir !== dirname(dir); step += 1, dir = dirname(dir)) {
      const candidate = join(dir, ...PACKAGE_ENTRY);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Read when the located pi-ai build's catalog was generated.
 *
 * This is the honest anchor for "only models newer than the snapshot": the date
 * moves on its own when DSH upgrades pi-ai, so nobody has to remember to edit a
 * hand-typed bound. Absent is reported as absent — the caller decides what an
 * unresolvable gate means, and must not let it become an open one.
 *
 * @param moduleUrl - the pi-ai `providers/all` module reference.
 * @returns the manifest's `generatedAt`, or `undefined`.
 */
function readGeneratedAt(moduleUrl) {
  try {
    const manifest = JSON.parse(readFileSync(new URL(MANIFEST_SUBPATH, moduleUrl), 'utf8'));
    const generatedAt = manifest?.generatedAt;
    if (typeof generatedAt === 'string' && generatedAt.length > 0) return generatedAt;
    if (typeof generatedAt === 'number' && Number.isFinite(generatedAt) && generatedAt > 0) return generatedAt;
  } catch {
    /* An unreadable manifest is a missing bound, not a broken sync. */
  }
  return undefined;
}

/**
 * Read one pi-ai provider table: each built-in provider's endpoint, its shipped
 * models' wire protocols, and when that catalog was generated.
 * @param moduleUrl - the pi-ai `providers/all` module reference.
 * @returns `table` (`id → baseUrl`), `models` (`id → (modelId → api)`), and `generatedAt`.
 */
async function readProviderCatalog(moduleUrl) {
  const mod = await import(moduleUrl);
  if (typeof mod?.builtinProviders !== 'function') throw new Error('providers/all does not export builtinProviders()');
  const providers = mod.builtinProviders();
  if (!Array.isArray(providers)) throw new Error('builtinProviders() did not return an array');
  const readModels = typeof mod.getBuiltinModels === 'function' ? mod.getBuiltinModels : undefined;
  const table = new Map();
  const models = new Map();
  for (const provider of providers) {
    if (typeof provider?.id !== 'string') continue;
    if (typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0) table.set(provider.id, provider.baseUrl);
    if (readModels === undefined) continue;
    let listed;
    try {
      listed = readModels(provider.id);
    } catch {
      /* A provider whose data file will not load simply has no typing facts. */
      listed = undefined;
    }
    if (!Array.isArray(listed)) continue;
    const byId = new Map();
    for (const model of listed) {
      if (typeof model?.id === 'string' && typeof model.api === 'string') byId.set(model.id, model.api);
    }
    if (byId.size > 0) models.set(provider.id, byId);
  }
  return { table, models, generatedAt: readGeneratedAt(moduleUrl) };
}

/**
 * Resolve every built-in provider's endpoint and catalog protocols.
 *
 * Never throws: an unreadable pi-ai is a degraded mode where only routes with
 * a configured or declared `baseURL` are manageable, and the reason is carried
 * into the report rather than swallowed. An empty `models` map is likewise a
 * degraded mode: no route can then be shown to type a new model, so the sync
 * reports the protocol it needs instead of guessing one. A missing
 * `generatedAt` only costs the `addSince: snapshot` bound.
 *
 * @param anchor - module reference used as the resolution base, e.g. `process.argv[1]`.
 * @returns the endpoint table, the catalog protocols, the snapshot date, and a human-readable account of how they were obtained.
 */
export async function builtinEndpoints(anchor = process.argv[1]) {
  try {
    const { table, models, generatedAt } = await readProviderCatalog('@earendil-works/pi-ai/providers/all');
    return { table, models, generatedAt, detail: `pi-ai providers: ${table.size}` };
  } catch {
    /* Fall through to the anchored lookup. */
  }

  let located;
  const seeds = anchor === undefined ? anchors() : [anchor];
  for (const candidate of seeds.flatMap((seed) => anchorVariants(seed))) {
    located = locateFromAnchor(candidate);
    if (located !== undefined) break;
  }
  if (located === undefined) {
    return {
      table: new Map(),
      models: new Map(),
      generatedAt: undefined,
      detail: 'could not locate @earendil-works/pi-ai; built-in routes need a configured baseURL',
    };
  }
  try {
    const { table, models, generatedAt } = await readProviderCatalog(new URL(PROVIDERS_SUBPATH, pathToFileURL(located)).href);
    return { table, models, generatedAt, detail: `pi-ai providers: ${table.size} (anchored)` };
  } catch (error) {
    return {
      table: new Map(),
      models: new Map(),
      generatedAt: undefined,
      detail: `could not read pi-ai's provider table (${error instanceof Error ? error.message : String(error)})`,
    };
  }
}
