/**
 * Plugin configuration — the `live-model-catalog` settings namespace schema.
 *
 * Everything the sync does is decided here, so behavior changes are usually a
 * config edit rather than a code edit. That is deliberate: this plugin exists
 * because its owner must be able to repair it quickly after a DSH upgrade.
 *
 * @module dsh-live-model-catalog/config
 */
import z from 'schemastery';

import { FALLBACK_EFFORTS, FILLABLE_FIELDS, SNAPSHOT_BOUND } from './constants.js';

const routeConfig = z.object({
  enabled: z.boolean().default(true),
  baseURL: z.string().default(''),
  /**
   * The route's wire protocol. Read as the listing protocol, and — when the
   * `llm-pi-ai` route declares none of its own — declared on that route so DSH
   * can type a model its catalog does not describe. Never guessed: leaving this
   * empty means an untypeable model is reported instead of added.
   */
  api: z.string().default(''),
  apiKeyEnv: z.string().default(''),
  /**
   * This route's reasoning levels, as `level → wire value`. A declaration, not a
   * guess: it applies only where the endpoint's own listing says nothing — no
   * reasoning metadata, or no mention of the model at all — and an endpoint that
   * does publish its efforts always outranks it. Needed because DSH inherits a
   * model's capability by route key from the installed catalog, so a route pi-ai
   * does not ship (SenseNova, an internal gateway) inherits nothing, and its
   * endpoint usually publishes no effort table either.
   */
  efforts: z.dict(z.union([z.string(), z.const(null)])).default({}),
  /**
   * Where this route lists its models, when that is not `${baseURL}/models`. A
   * path is appended to `baseURL`; an absolute `http(s)` URL is used verbatim.
   */
  listingPath: z.string().default(''),
});

export const Config = z.object({
  /** Master switch; `false` makes every entry point a no-op. */
  enabled: z.boolean().default(true),
  /**
   * Which routes to manage. `auto` (the default) manages every provider
   * declared under `llm-pi-ai`, minus `exclude`; `listed` manages only the
   * names under `routes`.
   */
  mode: z.union(['auto', 'listed']).default('auto'),
  /** Route-name globs to leave alone in `auto` mode (`local`, `*-experimental`). */
  exclude: z.array(z.string()).default([]),
  /**
   * Per-route overrides. In `listed` mode this is the target list; in `auto`
   * mode these entries only adjust a route that discovery already found.
   */
  routes: z.dict(routeConfig).default({}),
  /**
   * Id globs allowed to be ADDED. The default is every vendor's models, because
   * that is what "keep the route in step with the endpoint" means out of the
   * box; `addSince` is what keeps that from becoming a bulk history import, and
   * `skipAliases` keeps moving aliases out of a pinned list.
   */
  include: z.array(z.string()).default(['*']),
  /**
   * Leave out ids the listing itself marks as aliases (`alias_target`), which
   * point at a different model over time and so do not belong in a pinned list.
   * Set false to take the endpoint's aliases literally.
   */
  skipAliases: z.boolean().default(true),
  /**
   * Only add models published at or after this date (`2026-09-05`), unix
   * timestamp, or the literal `snapshot` — the located pi-ai catalog's own
   * `generatedAt`, which follows DSH upgrades on its own. Empty = no bound,
   * which lets a vendor glob drag in its whole back catalogue; if a `snapshot`
   * bound cannot be read, additions are withheld rather than unbounded.
   */
  addSince: z.string().default(SNAPSHOT_BOUND),
  /** Per-model fields that may be filled when the configured entry omits them. */
  fill: z.array(z.string()).default([...FILLABLE_FIELDS]),
  /** Effort preset for models that reason but publish no effort list. */
  defaultEfforts: z.dict(z.union([z.string(), z.const(null)])).default({ ...FALLBACK_EFFORTS }),
  /**
   * Make the Models page's "fetch available models" consult the live endpoint.
   * On by default so an install works out of the box; it is still contract-
   * probed, failure-degrading, and switchable at runtime (see README).
   */
  fixDiscovery: z.boolean().default(true),
  /** Delay before the first sync, so boot never waits on the network. */
  startupDelaySeconds: z.number().default(5),
  /** Repeat period in minutes; `0` syncs once at startup only. */
  intervalMinutes: z.number().default(240),
  /** Per-request timeout in seconds. */
  requestTimeoutSeconds: z.number().default(20),
});
