/** SSRF-hardened fetch for UNTRUSTED URLs (x402 payment targets, registry-discovered
 *  endpoints). This is the single network chokepoint for the payment path.
 *
 *  Threat model: an attacker who controls a service endpoint (published in the open
 *  trust registry) or a malicious x402 server can try to (a) redirect the client to an
 *  internal/private target [redirect-SSRF], or (b) flip DNS between validation and the
 *  actual connection so a "public" host resolves to a private IP at connect time
 *  [DNS-rebinding TOCTOU].
 *
 *  Defenses (only active when a `guard` is supplied — i.e. at the MCP trust boundary):
 *   1. `redirect: 'manual'` — never auto-follow. Each hop is re-validated by the guard
 *      before connecting, so a 30x to a private target is rejected, not followed.
 *   2. Pinned dispatcher — the guard returns a connection dispatcher pinned to the
 *      already-validated public IP(s), so the actual connection cannot be re-resolved to
 *      a rebound private IP. TLS SNI/cert validation still uses the URL hostname.
 *   3. Credential-carrying requests (`guardedRedirect: 'error'`) refuse ALL redirects, so
 *      a signed payment authorization / SIWx identity header is never re-sent to a
 *      redirected host.
 *
 *  When NO guard is supplied (SDK used directly, or trusted first-party server calls),
 *  this is a transparent passthrough to `fetch()` — behaviour is unchanged.
 */
import { AzethError } from '@azeth/common';

/** Guard run before connecting to a URL (and again before every redirect hop).
 *  - Throws to BLOCK the request (e.g. non-HTTPS, private/reserved IP, DNS failure).
 *  - May return an optional connection `dispatcher` (undici `Agent`) pinned to the
 *    validated IP(s). The SDK passes it through to `fetch()` (a Node/undici extension);
 *    it is `unknown` here so the SDK stays portable and free of Node-only imports. */
export type SecureFetchGuard = (url: string) => Promise<{ dispatcher?: unknown }>;

/** Redirect handling for guarded requests. */
export type GuardedRedirectPolicy =
  /** Re-validate each Location and follow public ones (use for idempotent, credential-free reads). */
  | 'follow'
  /** Reject on ANY redirect (use for requests carrying payment proof / SIWx / credentials). */
  | 'error';

export interface SecureFetchOptions extends RequestInit {
  /** SSRF guard + optional connection pin. Omit for trusted/SDK-direct calls (passthrough). */
  guard?: SecureFetchGuard;
  /** Redirect policy when `guard` is set. Default: 'follow'. */
  guardedRedirect?: GuardedRedirectPolicy;
  /** Max redirects to follow when `guardedRedirect: 'follow'`. Default: 3. */
  maxRedirects?: number;
}

/** RequestInit extended with undici's `dispatcher` (present on Node's global fetch). */
type UndiciRequestInit = RequestInit & { dispatcher?: unknown };

const DEFAULT_MAX_REDIRECTS = 3;

/** SSRF-hardened fetch. See module docs. */
export async function secureFetch(url: string, opts: SecureFetchOptions = {}): Promise<Response> {
  const { guard, guardedRedirect = 'follow', maxRedirects = DEFAULT_MAX_REDIRECTS, ...init } = opts;

  // No guard → trusted / SDK-direct path: transparent passthrough (unchanged behaviour).
  if (!guard) {
    return fetch(url, init);
  }

  let currentUrl = url;
  let currentInit: RequestInit = init;

  for (let hop = 0; ; hop++) {
    // Validate (and obtain a pinned dispatcher for) THIS hop's host. Throws to block.
    const { dispatcher } = await guard(currentUrl);

    const fetchInit: UndiciRequestInit = { ...currentInit, redirect: 'manual' };
    if (dispatcher) fetchInit.dispatcher = dispatcher;

    const res = await fetch(currentUrl, fetchInit as RequestInit);

    const isRedirect = res.status >= 300 && res.status < 400 && res.headers.has('location');
    if (!isRedirect) return res;

    // A redirect was returned.
    if (guardedRedirect === 'error') {
      throw new AzethError(
        `Service attempted a redirect (HTTP ${res.status}) on a credential-carrying request; refusing to follow.`,
        'INVALID_INPUT',
        { from: currentUrl },
      );
    }
    if (hop >= maxRedirects) {
      throw new AzethError(`Too many redirects (> ${maxRedirects})`, 'INVALID_INPUT', { url });
    }

    const location = res.headers.get('location');
    if (!location) return res; // defensive: header vanished — treat as final
    let nextUrl: string;
    try {
      nextUrl = new URL(location, currentUrl).href;
    } catch {
      throw new AzethError('Service returned an invalid redirect Location', 'INVALID_INPUT', { location });
    }

    // Per the Fetch spec: 303, and 301/302 on a non-GET/HEAD request, become GET with no body.
    const method = (currentInit.method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method !== 'GET' && method !== 'HEAD')) {
      currentInit = { ...currentInit, method: 'GET', body: undefined };
    }

    currentUrl = nextUrl; // next iteration re-validates + re-pins this URL
  }
}
