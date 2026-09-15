/**
 * Reading a provider's model listing, the same way DSH's own discovery reads it.
 *
 * The URL and auth rules mirror `dsh-llm-pi-ai/discovery` on purpose: this
 * plugin must see exactly the list the Models page would see, or the two
 * disagree about what the endpoint serves. `parseListing` stays pure so the
 * shapes can be unit-tested without a network.
 *
 * @module dsh-live-model-catalog/listing
 */
// Only the schemastery-free leaf is imported, so this module and its tests stay
// loadable with no `node_modules` at all.
import { firstText } from './constants.js';

/** Largest listing accepted, matching dsh-llm-pi-ai's ceiling. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** Stable API version required by Anthropic's model-listing endpoint. */
const ANTHROPIC_VERSION = '2023-06-01';

/** User agent so a gateway operator can tell where the traffic comes from. */
const USER_AGENT = 'dsh-live-model-catalog';

/**
 * Join an endpoint base with its protocol's listing path. The base is treated
 * as a prefix, not a URL to resolve against, so a deployment path such as
 * `https://gateway.example/openai/v1` keeps its segments.
 *
 * `listingPath` overrides that default for the services whose model listing is
 * not where their protocol says it is. Two spellings are accepted, because both
 * shapes exist in the wild:
 * - a path, appended to the base (`/llm/models` → `{base}/llm/models`), for a
 *   service that lists somewhere else under the same root;
 * - an absolute `http(s)` URL, used verbatim, for a service whose listing and
 *   chat endpoints live under different roots — SenseNova's OpenAI-compatible
 *   chat base is `/compatible-mode/v2` while its model list is `/v1/llm/models`
 *   (https://www.sensecore.cn/help/docs/model-as-a-service/nova/overview/Models/GetModelList).
 *
 * @param baseURL - the route's configured endpoint.
 * @param api - wire protocol; Anthropic lists at a different path and root.
 * @param listingPath - the route's override, when it declares one.
 * @returns the listing URL.
 */
export function listingUrl(baseURL, api, listingPath) {
  const base = String(baseURL).replace(/\/+$/, '');
  if (typeof listingPath === 'string' && listingPath.length > 0) {
    if (/^https?:\/\//i.test(listingPath)) return listingPath;
    return `${base}/${listingPath.replace(/^\/+/, '')}`;
  }
  if (api !== 'anthropic-messages') return `${base}/models`;
  return `${base.endsWith('/v1') ? base.slice(0, -3) : base}/v1/models?limit=1000`;
}

/**
 * Read one listing reply into `{ id, raw }` entries.
 *
 * The standard `data` array wins when both supported shapes are present. An
 * enriched `models` map uses each property key as the request-facing id — its
 * nested `id` is only a fallback, because a gateway may put a canonical
 * identity there instead of the alias it accepts on requests. Entries without
 * a usable id are skipped rather than failing the whole listing.
 *
 * @param body - parsed JSON body.
 * @returns the entries in endpoint order.
 * @throws {Error} when the reply is neither supported shape.
 */
export function parseListing(body) {
  const data = body?.data;
  let listed;
  if (Array.isArray(data)) {
    listed = data.map((raw) => ({ key: undefined, raw }));
  } else {
    const models = body?.models;
    if (models === null || typeof models !== 'object' || Array.isArray(models)) {
      throw new Error('listing has neither a "data" array nor a "models" object');
    }
    listed = Object.entries(models)
      .filter(([, raw]) => raw !== null && typeof raw === 'object' && !Array.isArray(raw))
      .map(([key, raw]) => ({ key, raw }));
  }

  const entries = [];
  for (const { key, raw } of listed) {
    const id = firstText(key, raw?.id);
    if (id === undefined) continue;
    entries.push({ id, raw });
  }
  return entries;
}

/** Read a reply body, refusing one that outgrows the ceiling. */
async function readBounded(response, url) {
  const declared = Number(response.headers.get('content-length') ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new Error(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`);
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw new Error(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`);
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

/** Build the auth headers one protocol expects. */
function authHeaders(api, apiKey) {
  const headers = { accept: 'application/json', 'user-agent': USER_AGENT };
  if (api === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION;
    if (apiKey) headers['x-api-key'] = apiKey;
  } else if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/**
 * The error for a reply that arrived and refused.
 *
 * The status is carried on the error because it decides whether a second
 * attempt could help at all — see {@link worthRetrying} — and a `Retry-After`
 * is surfaced because that is the endpoint asking for a specific pace, which
 * belongs in the report rather than in a silent backoff this plugin invents.
 *
 * @param url - the listing URL.
 * @param response - the refusing reply.
 * @returns the error to throw.
 */
function refused(url, response) {
  const retryAfter = response.headers.get('retry-after');
  const hint = response.status === 401 || response.status === 403 ? '; check the API key' : '';
  const pace = retryAfter === null || retryAfter.length === 0 ? '' : `; retry-after ${retryAfter}`;
  const error = new Error(`${url} answered ${response.status}${hint}${pace}`);
  error.httpStatus = response.status;
  if (retryAfter !== null && retryAfter.length > 0) error.retryAfter = retryAfter;
  return error;
}

/**
 * Whether one attempt is worth repeating right away.
 *
 * A reply that arrived is an answer: asking again cannot change it, and on 429
 * it is exactly what the endpoint asked this caller not to do. Only a
 * transport-level failure (DNS, refusal, timeout) earns one more try — and a
 * caller-driven abort never does, because the caller already said stop.
 *
 * @param error - the failure from one attempt.
 * @param signal - the caller's cancellation signal, when there is one.
 * @returns whether to try once more.
 */
export function worthRetrying(error, signal) {
  if (signal?.aborted === true) return false;
  return error?.httpStatus === undefined;
}

/**
 * Fetch and parse one route's live listing.
 * @param options - endpoint, protocol, optional listing-path override, optional key, timeout, caller signal.
 * @returns the parsed entries.
 * @throws {Error} on transport failure, a non-2xx reply, or an unreadable body.
 */
export async function fetchListing({ baseURL, api, apiKey, listingPath, timeoutMs, signal }) {
  const url = listingUrl(baseURL, api, listingPath);
  const timeout = AbortSignal.timeout(Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 20_000);
  const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);

  const response = await fetch(url, { method: 'GET', headers: authHeaders(api, apiKey), signal: combined });
  if (!response.ok) throw refused(url, response);
  const text = await readBounded(response, url);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${url} did not answer with JSON`);
  }
  return parseListing(parsed);
}

/**
 * Resolve one route's API key through the harness credentials seam.
 *
 * A route that names no credential resolves to `undefined` and the request goes
 * out unauthenticated: public listings (OpenRouter's, for one) load fine without
 * a key, and inventing one here would only turn a working probe into a failure.
 *
 * @param ctx - plugin context.
 * @param apiKeyEnv - credential reference recorded on the route, if any.
 * @returns the key, or `undefined`.
 */
export async function resolveApiKey(ctx, apiKeyEnv) {
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) return undefined;
  const credentials = ctx.get('credentials');
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined;
  try {
    const resolved = await credentials.resolve(apiKeyEnv);
    const value = resolved?.value;
    if (typeof value === 'string' && value.length > 0) return value;
  } catch {
    /* An unresolvable reference is not fatal: the listing may be public. */
  }
  const fromEnv = process.env[apiKeyEnv];
  return typeof fromEnv === 'string' && fromEnv.length > 0 ? fromEnv : undefined;
}
