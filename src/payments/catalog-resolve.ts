/** Deterministic, LLM-free resolution of an agent's INTENT against a provider's service
 *  CATALOG — the core of intent-native smart_pay. (F6)
 *
 *  A provider can monetize many endpoints (price of BTC, ETH, XRP…) behind ONE catalog
 *  served at its registered endpoint. When an agent calls smart_pay with a capability plus an
 *  intent — loose tokens like ["bitcoin"], or structured params like {coinId:"bitcoin"} — this
 *  module picks the right catalog entry and substitutes the path params, in pure code, with no
 *  model in the loop. On a miss it returns the menu (options) so the agent retries in one
 *  free round-trip instead of hitting a dead end.
 *
 *  Full URL contract (per CatalogEntry): the concrete URL is `${baseUrl}${entry.path}`.
 */
import type { CatalogEntry } from '@azeth/common';

// ── Catalog detection / parsing ──────────────────────────────────────────────

/** Parse a fetched response body into a catalog, tolerating common envelopes:
 *  a bare array, `{ catalog: [...] }`, or `{ data: { catalog: [...] } }`.
 *  Returns null if the body is not JSON or has no catalog entries. */
export function parseCatalogBody(bodyText: string): CatalogEntry[] | null {
  let json: unknown;
  try {
    json = JSON.parse(bodyText);
  } catch {
    return null;
  }
  const arr = extractCatalogArray(json);
  if (!arr) return null;
  const entries = arr.filter(isCatalogEntry);
  return entries.length > 0 ? entries : null;
}

function extractCatalogArray(json: unknown): unknown[] | null {
  if (Array.isArray(json)) return json;
  if (typeof json !== 'object' || json === null) return null;
  const obj = json as Record<string, unknown>;
  if (Array.isArray(obj['catalog'])) return obj['catalog'];
  const data = obj['data'];
  if (data && typeof data === 'object' && Array.isArray((data as Record<string, unknown>)['catalog'])) {
    return (data as Record<string, unknown>)['catalog'] as unknown[];
  }
  return null;
}

function isCatalogEntry(x: unknown): x is CatalogEntry {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as Record<string, unknown>)['name'] === 'string' &&
    typeof (x as Record<string, unknown>)['path'] === 'string'
  );
}

// ── Intent resolution ────────────────────────────────────────────────────────

export interface ResolveIntentInput {
  entries: CatalogEntry[];
  /** Capabilities of the parent service; inherited by entries that declare none. */
  parentCapabilities: string[];
  capability: string;
  /** Loose intent tokens (e.g. ["bitcoin"]) matched against the catalog's param value enums. */
  intent?: string[];
  /** Structured param overrides (e.g. {coinId:"bitcoin"}) — precise, take precedence. */
  params?: Record<string, string>;
  /** The provider's base endpoint; full URL = `${baseUrl}${entry.path}`. */
  baseUrl: string;
}

/** A catalog entry surfaced back to the agent when the intent can't be resolved — the menu. */
export interface CatalogOption {
  name: string;
  path: string;
  description?: string;
  pricing?: string;
  /** param name → allowed values parsed from the catalog (what the agent should pick from). */
  params: Record<string, string[]>;
  capabilities: string[];
}

export interface ResolvedCatalogEntry {
  /** Concrete priced URL to fetch + pay. */
  url: string;
  entryName: string;
  boundParams: Record<string, string>;
  pricing?: string;
}

export interface ResolveIntentResult {
  resolved?: ResolvedCatalogEntry;
  reason?: 'no_capability_match' | 'intent_unmatched';
  /** The menu to retry against (the capability-matching paid entries). */
  options: CatalogOption[];
}

/** Resolve an intent against a catalog. Pure + deterministic — never invents a param value,
 *  never auto-pays an entry whose path slots aren't all bound from the caller's input. */
export function resolveIntent(input: ResolveIntentInput): ResolveIntentResult {
  const cap = normalize(input.capability);
  const intentTokens = (input.intent ?? []).map(normalize).filter(Boolean);
  const params = input.params ?? {};

  // 1. Capability-matching, paid entries (entries without their own capabilities inherit the parent's).
  const candidates = input.entries.filter((e) => {
    if (e.paid === false) return false;
    const caps = (e.capabilities && e.capabilities.length ? e.capabilities : input.parentCapabilities).map(normalize);
    return caps.includes(cap);
  });
  if (candidates.length === 0) {
    return { reason: 'no_capability_match', options: input.entries.filter((e) => e.paid !== false).map(toOption) };
  }

  // 2. Try to bind each candidate's path slots from params (precise) then intent tokens (consumed once each).
  const bound: Array<{ entry: CatalogEntry; values: Record<string, string>; usedTokens: number; descriptorHits: number }> = [];
  for (const entry of candidates) {
    const slots = pathParamSlots(entry.path);
    const values: Record<string, string> = {};
    const consumed = new Set<number>();
    let ok = true;
    let used = 0;
    for (const slot of slots) {
      if (params[slot] !== undefined) {
        values[slot] = params[slot]!;
        continue;
      }
      const allowed = parseAllowedValues(entry.params?.[slot]);
      let boundVal: string | undefined;
      // (a) enumerated match: an intent token that is a valid value (or alias) for this slot
      for (let ti = 0; ti < intentTokens.length; ti++) {
        if (consumed.has(ti)) continue;
        if (allowed.size > 0 && allowed.has(intentTokens[ti]!)) {
          boundVal = canonicalValue(entry.params?.[slot], intentTokens[ti]!) ?? intentTokens[ti]!;
          consumed.add(ti);
          break;
        }
      }
      // (b) free-form param (no enumerated values): bind the next unconsumed token
      if (boundVal === undefined && allowed.size === 0) {
        for (let ti = 0; ti < intentTokens.length; ti++) {
          if (!consumed.has(ti)) {
            boundVal = intentTokens[ti]!;
            consumed.add(ti);
            break;
          }
        }
      }
      if (boundVal === undefined) {
        ok = false;
        break;
      }
      values[slot] = boundVal;
      used++;
    }
    if (ok) {
      // Descriptor match: unconsumed intent tokens (e.g. "fresh") that appear in the entry's
      // name words or capabilities — lets intent select a variant without a path param.
      const remaining = intentTokens.filter((_, ti) => !consumed.has(ti));
      const descriptors = new Set<string>([
        ...normalize(entry.name).split(/\s+/).filter(Boolean),
        ...(entry.capabilities ?? []).map(normalize),
      ]);
      const descriptorHits = remaining.filter((t) => descriptors.has(t)).length;
      bound.push({ entry, values, usedTokens: used, descriptorHits });
    }
  }

  if (bound.length === 0) {
    return { reason: 'intent_unmatched', options: candidates.map(toOption) };
  }

  // 3. Pick best: most intent signal matched (bound params + descriptor hits, e.g. "fresh"),
  //    then explicit-capability over inherited, then cheapest listed price, then stable order.
  bound.sort(
    (a, b) =>
      b.usedTokens + b.descriptorHits - (a.usedTokens + a.descriptorHits) ||
      explicitCap(b.entry, cap) - explicitCap(a.entry, cap) ||
      priceOf(a.entry.pricing) - priceOf(b.entry.pricing),
  );
  const best = bound[0]!;
  const path = substitutePath(best.entry.path, best.values);
  return {
    resolved: {
      url: joinUrl(input.baseUrl, path),
      entryName: best.entry.name,
      boundParams: best.values,
      pricing: best.entry.pricing,
    },
    options: candidates.map(toOption),
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/** Extract `{name}` slots from a path template. */
function pathParamSlots(path: string): string[] {
  const out: string[] = [];
  const re = /\{([^}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path)) !== null) out.push(m[1]!.trim());
  return out;
}

/** Parse a catalog param value spec ("bitcoin, ethereum (eth), …") into a normalized
 *  allowed-value set, including parenthetical aliases. "…"/"..." sentinels are ignored. */
function parseAllowedValues(spec?: string): Set<string> {
  const set = new Set<string>();
  if (!spec) return set;
  for (const raw of spec.split(',')) {
    const part = raw.trim();
    if (!part || part === '...' || part === '…') continue;
    const m = part.match(/^([^(]+?)\s*(?:\(([^)]*)\))?$/);
    if (!m) {
      set.add(normalize(part));
      continue;
    }
    const value = normalize(m[1]!);
    if (value && value !== '...' && value !== '…') set.add(value);
    if (m[2]) for (const a of m[2].split(/[,\s]+/)) {
      const an = normalize(a);
      if (an) set.add(an);
    }
  }
  return set;
}

/** Map a matched token (possibly an alias) back to the canonical value to put in the path. */
function canonicalValue(spec: string | undefined, token: string): string | undefined {
  if (!spec) return undefined;
  for (const raw of spec.split(',')) {
    const m = raw.trim().match(/^([^(]+?)\s*(?:\(([^)]*)\))?$/);
    if (!m) continue;
    const value = normalize(m[1]!);
    if (value === token) return value;
    if (m[2]) for (const a of m[2].split(/[,\s]+/)) if (normalize(a) === token) return value;
  }
  return undefined;
}

function substitutePath(path: string, values: Record<string, string>): string {
  return path.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(values[String(name).trim()] ?? ''));
}

/** Full URL = `${baseUrl}${path}` (path is relative to the endpoint, per the CatalogEntry contract). */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const p = path.startsWith('/') ? path : `/${path}`;
  return base + p;
}

function explicitCap(entry: CatalogEntry, cap: string): number {
  return entry.capabilities?.map(normalize).includes(cap) ? 1 : 0;
}

/** Leading dollar amount from pricing text ("$0.01/request" → 0.01). Unknown → +Inf (sorts last). */
function priceOf(pricing?: string): number {
  if (!pricing) return Number.POSITIVE_INFINITY;
  const m = pricing.match(/\$\s*([0-9]+(?:\.[0-9]+)?)/);
  return m ? parseFloat(m[1]!) : Number.POSITIVE_INFINITY;
}

function toOption(entry: CatalogEntry): CatalogOption {
  const params: Record<string, string[]> = {};
  for (const slot of pathParamSlots(entry.path)) params[slot] = [...parseAllowedValues(entry.params?.[slot])];
  return {
    name: entry.name,
    path: entry.path,
    description: entry.description,
    pricing: entry.pricing,
    params,
    capabilities: entry.capabilities ?? [],
  };
}
