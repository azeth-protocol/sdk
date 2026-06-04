/**
 * SSRF guard for untrusted outbound HTTP (x402 payment targets and registry-discovered
 * endpoints, both of which are attacker-publishable). This is the single, audited guard
 * implementation — used both by the SDK's own client methods (default-on) and by the MCP
 * server, so there is exactly ONE place this logic lives.
 *
 * It validates that a URL is HTTPS and does NOT resolve to an internal/private/reserved
 * address (defeating DNS-rebinding and alternative-encoding bypasses by resolving via the
 * same getaddrinfo path the connection uses), and returns a connection dispatcher pinned to
 * the validated public IP(s) so the socket cannot be re-resolved to a private target at
 * connect time. Throws (AzethError) to BLOCK a request.
 */
import { URL } from 'node:url';
import dns from 'node:dns/promises';
import { AzethError } from '@azeth/common';
import type { SecureFetchGuard } from './secure-fetch.js';

/** Check if an IPv4 address is in a private/reserved range */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p))) return false;
  const [a, b] = parts;
  return (
    a === 127 ||                           // loopback
    a === 10 ||                            // 10.0.0.0/8
    (a === 172 && b! >= 16 && b! <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) ||            // 192.168.0.0/16
    (a === 169 && b === 254) ||            // link-local
    a === 0                                // 0.0.0.0/8
  );
}

/** Check if an IPv6 address is in a private/reserved range */
export function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower.startsWith('fc') ||
    lower.startsWith('fd') ||
    lower.startsWith('fe80') ||
    lower.startsWith('::ffff:127.') ||
    lower.startsWith('::ffff:10.') ||
    lower.startsWith('::ffff:172.16.') || lower.startsWith('::ffff:172.17.') ||
    lower.startsWith('::ffff:172.18.') || lower.startsWith('::ffff:172.19.') ||
    lower.startsWith('::ffff:172.20.') || lower.startsWith('::ffff:172.21.') ||
    lower.startsWith('::ffff:172.22.') || lower.startsWith('::ffff:172.23.') ||
    lower.startsWith('::ffff:172.24.') || lower.startsWith('::ffff:172.25.') ||
    lower.startsWith('::ffff:172.26.') || lower.startsWith('::ffff:172.27.') ||
    lower.startsWith('::ffff:172.28.') || lower.startsWith('::ffff:172.29.') ||
    lower.startsWith('::ffff:172.30.') || lower.startsWith('::ffff:172.31.') ||
    lower.startsWith('::ffff:192.168.') ||
    lower.startsWith('::ffff:169.254.') ||
    lower.startsWith('::ffff:0.') ||
    lower === '::' ||
    lower === '::ffff:0.0.0.0'
  );
}

/**
 * Validated URL with pinned IP addresses to prevent DNS rebinding.
 * The resolved IPs are captured at validation time and should be used for the actual
 * connection to prevent TOCTOU DNS rebinding attacks.
 */
export interface ValidatedUrl {
  url: string;
  /** Pinned IPv4 addresses resolved at validation time */
  pinnedIPv4: string[];
}

/**
 * Validate that a URL is external (HTTPS, not pointing to internal/private addresses).
 * Resolves hostname via DNS to catch rebinding bypasses. Returns pinned IPs for the caller
 * to use when making the actual request.
 */
export async function validateExternalUrl(urlStr: string): Promise<ValidatedUrl> {
  const url = new URL(urlStr);

  if (url.protocol !== 'https:') {
    throw new AzethError('URL must use HTTPS', 'INVALID_INPUT');
  }

  const hostname = url.hostname.toLowerCase();

  // String-based blocklist for obvious patterns (fast path)
  const blockedPatterns = [
    'localhost', '127.0.0.1', '0.0.0.0', '::1',
    '169.254.', '10.', '172.16.', '172.17.', '172.18.', '172.19.',
    '172.20.', '172.21.', '172.22.', '172.23.', '172.24.', '172.25.',
    '172.26.', '172.27.', '172.28.', '172.29.', '172.30.', '172.31.',
    '192.168.', 'fc00:', 'fd00:', 'fe80:',
    '::ffff:127.', '::ffff:10.', '::ffff:172.16.', '::ffff:192.168.',
    '::ffff:169.254.',
  ];

  for (const pattern of blockedPatterns) {
    if (hostname === pattern || hostname.startsWith(pattern)) {
      throw new AzethError(
        'URL points to an internal or private network address. Only public HTTPS URLs are allowed.',
        'INVALID_INPUT',
      );
    }
  }

  // Resolve the hostname and reject any private/reserved address (DNS-rebinding /
  // alternative-encoding bypasses), checking BOTH A and AAAA records.
  //
  // Resolve via getaddrinfo (dns.lookup) — the SAME resolver the HTTP client and the
  // actual connection use — NOT dns.resolve4/6 (c-ares direct nameserver queries). c-ares
  // spuriously fails in restricted-DNS / sandboxed environments where getaddrinfo (and
  // therefore the request itself) succeeds, and it can resolve differently than the
  // connection (a TOCTOU gap). `{ all: true }` returns every A and AAAA record at once.
  let resolved: Array<{ address: string; family: number }>;
  try {
    resolved = await dns.lookup(hostname, { all: true });
  } catch (err) {
    // DNS resolution failure must REJECT — cannot verify URL safety (fail closed).
    // Differentiate "hostname doesn't exist" (input error) from "DNS unreachable" (network).
    const dnsErr = err as NodeJS.ErrnoException;
    if (dnsErr.code === 'ENOTFOUND' || dnsErr.code === 'ENODATA' || dnsErr.code === 'ENOENT') {
      throw new AzethError(
        'Hostname not found — verify the URL is correct',
        'INVALID_INPUT',
        { hostname: url.hostname },
      );
    }
    throw new AzethError(
      'DNS resolution failed — cannot verify URL safety',
      'NETWORK_ERROR',
      { hostname: url.hostname, cause: 'dns' },
    );
  }

  if (resolved.length === 0) {
    throw new AzethError(
      'Hostname not found — verify the URL is correct',
      'INVALID_INPUT',
      { hostname: url.hostname },
    );
  }

  // Reject if ANY resolved address is private/reserved; pin the public IPv4s.
  const pinnedIPv4: string[] = [];
  for (const { address, family } of resolved) {
    if (family === 6) {
      if (isPrivateIPv6(address)) {
        throw new AzethError(
          'URL resolves to a private or reserved IPv6 address. Only public HTTPS URLs are allowed.',
          'INVALID_INPUT',
        );
      }
    } else {
      if (isPrivateIPv4(address)) {
        throw new AzethError(
          'URL resolves to a private or reserved IP address. Only public HTTPS URLs are allowed.',
          'INVALID_INPUT',
        );
      }
      pinnedIPv4.push(address);
    }
  }

  return { url: urlStr, pinnedIPv4 };
}

/** Lazily load undici's `Agent` (an OPTIONAL dependency). undici is Node's built-in HTTP
 *  engine, but it must be installed as a package to construct a custom connection
 *  dispatcher. If unavailable, the connection pin is skipped — validate + redirect-refusal
 *  still apply (graceful degradation). */
let agentCtorPromise: Promise<(new (opts: unknown) => unknown) | undefined> | undefined;
function loadAgentCtor(): Promise<(new (opts: unknown) => unknown) | undefined> {
  if (!agentCtorPromise) {
    // `as string` keeps this a runtime-only dynamic import so the build does not require
    // undici's type declarations to be present.
    agentCtorPromise = import('undici' as string)
      .then((m: { Agent?: new (opts: unknown) => unknown }) => m.Agent)
      .catch(() => undefined);
  }
  return agentCtorPromise;
}

/** A net.LookupFunction-compatible resolver that pins DNS resolution to the given
 *  already-validated public IPv4 address(es), ignoring the hostname. This is what makes
 *  the connection immune to DNS rebinding: no matter what an attacker-controlled DNS
 *  record returns at connect time, the socket only ever connects to the pre-validated IPs.
 *  Supports both the single-address and `{ all }` callback forms. Exported for tests. */
export function createPinnedLookup(
  pinnedIPv4: string[],
): (
  hostname: string,
  opts: { all?: boolean } | undefined,
  cb: (err: Error | null, address: unknown, family?: number) => void,
) => void {
  return (_hostname, opts, cb): void => {
    if (opts?.all) cb(null, pinnedIPv4.map((address) => ({ address, family: 4 })));
    else cb(null, pinnedIPv4[0], 4);
  };
}

/** Build a connection dispatcher pinned to the already-validated public IPv4 address(es).
 *  Closes the DNS-rebinding TOCTOU: after validateExternalUrl confirms the host resolves to
 *  public IPs, the actual connection is pinned to those IPs and cannot be re-resolved to a
 *  private target. TLS SNI / certificate validation still uses the URL hostname. Returns
 *  undefined when there is nothing to pin (e.g. IPv6-only host) or undici is unavailable —
 *  the request then proceeds with validate-only protection. */
async function buildPinnedDispatcher(pinnedIPv4: string[]): Promise<unknown | undefined> {
  if (pinnedIPv4.length === 0) return undefined;
  const AgentCtor = await loadAgentCtor();
  if (!AgentCtor) return undefined;
  try {
    return new AgentCtor({ connect: { lookup: createPinnedLookup(pinnedIPv4) } });
  } catch {
    return undefined;
  }
}

/** Create the default SSRF guard for `secureFetch` over untrusted URLs (x402 targets,
 *  registry-discovered endpoints): validates the URL (HTTPS, non-private/reserved IP,
 *  DNS-resolvable) and returns a connection dispatcher pinned to the validated IPs. Throws
 *  (AzethError) to BLOCK the request. This is the secure-by-default guard the SDK's client
 *  methods inject unless the caller supplies their own guard or opts out. */
export function createDefaultSsrfGuard(): SecureFetchGuard {
  return async (urlStr: string) => {
    const validated = await validateExternalUrl(urlStr);
    return { dispatcher: await buildPinnedDispatcher(validated.pinnedIPv4) };
  };
}
