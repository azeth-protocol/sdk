/** Smart service discovery + payment routing with fallback.
 *
 *  Combines discoverServices → fetch402 into one operation with automatic
 *  fallback to alternative services on failure. This is a pure routing layer —
 *  reputation feedback is handled by AzethKit, which has access to the
 *  SmartAccountClient required for on-chain opinion submission.
 */

import type { PublicClient, WalletClient, Chain, Transport, Account } from 'viem';
import {
  AzethError,
  chainIdToName,
  isUsableEndpoint,
  type RegistryEntry,
  type DiscoveryParams,
  type EntityType,
  type SupportedChainName,
} from '@azeth/common';
import { type Fetch402Options, type Fetch402Result, fetch402 } from './x402.js';
import { discoverServicesWithFallback } from '../registry/discover.js';
import { resolveIntent, parseCatalogBody, type ResolvedCatalogEntry, type CatalogOption } from './catalog-resolve.js';

/** Options for smartFetch402 */
export interface SmartFetch402Options extends Fetch402Options {
  /** Minimum reputation score to consider (0-100). Default: 0 */
  minReputation?: number;
  /** Maximum services to try before giving up. Default: 3 */
  maxRetries?: number;
  /** Whether to submit reputation feedback after the call. Default: true.
   *  Only effective when called via AzethKit (which owns the SmartAccountClient). */
  autoFeedback?: boolean;
  /** Entity type filter (e.g., 'service'). Default: undefined (any) */
  entityType?: EntityType;
  /** Preferred service tokenId — tried first if available in results */
  preferredService?: bigint;
  // Note: the SSRF guard is `secureGuard`, inherited from Fetch402Options. It is applied
  // here (early skip) AND inside fetch402 (validate + connection pin + redirect policy). (F9)
  /** Loose intent tokens for catalog navigation (e.g. ["bitcoin"]). When a discovered provider
   *  serves a catalog, these are matched deterministically against the catalog's param value
   *  enums to pick the concrete priced route — no model in the loop. (F6) */
  intent?: string[];
  /** Structured param overrides for catalog navigation (e.g. {coinId:"bitcoin"}); precise, and
   *  take precedence over `intent`. (F6) */
  params?: Record<string, string>;
}

/** Result from smartFetch402 including routing metadata */
export interface SmartFetch402Result extends Fetch402Result {
  /** The service that was successfully called */
  service: RegistryEntry;
  /** Number of services attempted before success */
  attemptsCount: number;
  /** Services that failed (for debugging) */
  failedServices?: Array<{ service: RegistryEntry; error: string }>;
  /** When catalog navigation resolved an intent to a concrete priced route, the receipt of what
   *  was bought (the entry, the bound params, the concrete URL). (F6) */
  resolved?: ResolvedCatalogEntry;
}

/** Compute reputation feedback value from response time.
 *
 *  Maps response latency to a 0-100 quality score:
 *  - < 200ms → 90 (excellent)
 *  - < 500ms → 70 (good)
 *  - < 2000ms → 50 (acceptable)
 *  - >= 2000ms → 30 (slow)
 */
export function computeFeedbackValue(responseTimeMs: number): number {
  if (responseTimeMs < 200) return 90;
  if (responseTimeMs < 500) return 70;
  if (responseTimeMs < 2000) return 50;
  return 30;
}

/** Penalty value for services that failed outright */
export const FAILURE_PENALTY_VALUE = -20;

/** Smart discovery and payment routing with fallback.
 *
 *  This is a pure routing function — it discovers services, tries them in
 *  reputation order, and falls back on failure. It does NOT submit reputation
 *  feedback (that requires a SmartAccountClient, which only AzethKit owns).
 *
 *  @param publicClient - viem public client for chain reads
 *  @param walletClient - viem wallet client for signing
 *  @param account - EOA address
 *  @param serverUrl - Azeth server URL for discovery
 *  @param capability - Service capability to discover (e.g., 'price-feed')
 *  @param options - Smart fetch options
 *  @returns SmartFetch402Result with the successful service and attempt metadata
 */
export async function smartFetch402(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  account: `0x${string}`,
  serverUrl: string,
  capability: string,
  options?: SmartFetch402Options,
  /** Chain name for on-chain fallback discovery */
  chainName?: SupportedChainName,
): Promise<SmartFetch402Result> {
  const maxRetries = options?.maxRetries ?? 3;

  // Discover services sorted by reputation (best first).
  // Uses discoverServicesWithFallback: tries the server API first, then
  // falls back to on-chain ERC-8004 reads if the server is unavailable.
  const discoveryParams: DiscoveryParams = {
    capability,
    sortByReputation: true,
    minReputation: options?.minReputation,
    entityType: options?.entityType,
    limit: maxRetries * 3,
  };

  const resolvedChain = chainName ?? chainIdToName(publicClient.chain?.id ?? 0) ?? 'baseSepolia' as SupportedChainName;
  const discoveryResult = await discoverServicesWithFallback(serverUrl, discoveryParams, publicClient, resolvedChain);
  const services = discoveryResult.entries
    // Reject empty AND whitespace-only endpoints — registry entries with " "
    // are truthy but produce `fetch(" ")` → "Invalid URL", aborting the fallback (S-3).
    .filter(s => isUsableEndpoint(s.endpoint))
    .slice(0, maxRetries);

  if (services.length === 0) {
    throw new AzethError(
      `No services found for capability "${capability}"`,
      'SERVICE_NOT_FOUND',
      { capability, minReputation: options?.minReputation },
    );
  }

  // If preferredService is specified, move it to the front of the list
  if (options?.preferredService !== undefined) {
    const prefIdx = services.findIndex(s => s.tokenId === options.preferredService);
    if (prefIdx > 0) {
      const [preferred] = services.splice(prefIdx, 1);
      services.unshift(preferred!);
    }
  }

  const hasIntent = !!(options?.intent?.length || (options?.params && Object.keys(options.params).length > 0));
  const failedServices: Array<{ service: RegistryEntry; error: string }> = [];
  const catalogOptions: Array<{ service: { name: string; tokenId: string; endpoint?: string }; reason?: string; options: CatalogOption[] }> = [];

  for (let i = 0; i < services.length; i++) {
    const service = services[i]!;

    // Skip services without a usable endpoint (empty or whitespace-only)
    if (!isUsableEndpoint(service.endpoint)) {
      failedServices.push({ service, error: 'No usable endpoint (blank, placeholder, or ephemeral tunnel)' });
      continue;
    }

    try {
      // SSRF guard: the discovered endpoint is published by an arbitrary third party, so
      // validate it (HTTPS + non-private/reserved IP) before the fetch. The same guard is
      // re-applied (and pins the connection) inside fetch402; this early call lets us skip
      // a bad service without entering the payment flow. On rejection the throw is caught
      // below and we move to the next service. (F9)
      if (options?.secureGuard) {
        await options.secureGuard(service.endpoint);
      }
      const result = await fetch402(publicClient, walletClient, account, service.endpoint, {
        ...options,
        smartAccount: options?.smartAccount,
      });
      const status = result.response.status;

      // Soft-fail non-2xx that didn't pay → try the next provider.
      if (!result.paymentMade && status >= 400) {
        failedServices.push({ service, error: `HTTP ${status}` });
        continue;
      }

      // Catalog navigation (F6): when the caller gave an intent and this is a free 200 that
      // looks like a service catalog (a menu, not the data), deterministically resolve the
      // intent to the concrete priced route and pay THAT — instead of returning the menu.
      if (hasIntent && !result.paymentMade && status === 200) {
        let bodyText = '';
        try { bodyText = await result.response.text(); } catch { /* unreadable → treat as non-catalog */ }
        const catalog = parseCatalogBody(bodyText) ?? (service.catalog && service.catalog.length ? service.catalog : null);

        if (catalog) {
          const r = resolveIntent({
            entries: catalog,
            parentCapabilities: service.capabilities,
            capability,
            intent: options?.intent,
            params: options?.params,
            baseUrl: service.endpoint,
          });
          if (r.resolved) {
            if (options?.secureGuard) await options.secureGuard(r.resolved.url);
            const paid = await fetch402(publicClient, walletClient, account, r.resolved.url, {
              ...options,
              smartAccount: options?.smartAccount,
            });
            if (!paid.paymentMade && paid.response.status >= 400) {
              failedServices.push({ service, error: `catalog route HTTP ${paid.response.status}` });
              continue;
            }
            return {
              ...paid,
              service,
              attemptsCount: i + 1,
              failedServices: failedServices.length > 0 ? failedServices : undefined,
              resolved: r.resolved,
            };
          }
          // Intent didn't resolve against this provider's catalog — record its menu, try the next.
          catalogOptions.push({
            service: { name: service.name, tokenId: service.tokenId.toString(), endpoint: service.endpoint },
            reason: r.reason,
            options: r.options,
          });
          failedServices.push({ service, error: `intent unresolved (${r.reason ?? 'no_match'})` });
          continue;
        }

        // Not a catalog → it's a free data endpoint; return it (reconstruct the consumed body).
        const ct = result.response.headers.get('content-type');
        return {
          ...result,
          response: new Response(bodyText, { status, headers: ct ? { 'content-type': ct } : undefined }),
          service,
          attemptsCount: i + 1,
          failedServices: failedServices.length > 0 ? failedServices : undefined,
        };
      }

      // No intent, or a payment was made → existing behaviour.
      return {
        ...result,
        service,
        attemptsCount: i + 1,
        failedServices: failedServices.length > 0 ? failedServices : undefined,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      failedServices.push({ service, error: errorMsg });
      // Continue to next service
    }
  }

  // All services failed — or, when an intent was given, it couldn't be resolved against any
  // provider's catalog. In the latter case we attach the menu (`options`) so the agent can
  // refine its intent/params and retry in ONE free round-trip instead of hitting a dead end. (F6)
  throw new AzethError(
    catalogOptions.length > 0
      ? `Could not resolve your intent for capability "${capability}". See "options" for the available catalog entries and their valid params, then retry with matching intent/params.`
      : `All ${services.length} services for capability "${capability}" failed`,
    'SERVICE_NOT_FOUND',
    {
      capability,
      intent: options?.intent,
      params: options?.params,
      attemptsCount: services.length,
      failures: failedServices.map(f => ({ name: f.service.name, error: f.error })),
      ...(catalogOptions.length > 0 ? { options: catalogOptions } : {}),
    },
  );
}
