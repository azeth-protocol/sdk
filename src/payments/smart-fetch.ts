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
  type RegistryEntry,
  type DiscoveryParams,
  type EntityType,
  type SupportedChainName,
} from '@azeth/common';
import { type Fetch402Options, type Fetch402Result, fetch402 } from './x402.js';
import { discoverServicesWithFallback } from '../registry/discover.js';

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
}

/** Result from smartFetch402 including routing metadata */
export interface SmartFetch402Result extends Fetch402Result {
  /** The service that was successfully called */
  service: RegistryEntry;
  /** Number of services attempted before success */
  attemptsCount: number;
  /** Services that failed (for debugging) */
  failedServices?: Array<{ service: RegistryEntry; error: string }>;
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
    .filter(s => !!s.endpoint)
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

  const failedServices: Array<{ service: RegistryEntry; error: string }> = [];

  for (let i = 0; i < services.length; i++) {
    const service = services[i]!;

    // Skip services without an endpoint
    if (!service.endpoint) {
      failedServices.push({ service, error: 'No endpoint URL' });
      continue;
    }

    try {
      const result = await fetch402(publicClient, walletClient, account, service.endpoint, {
        ...options,
        smartAccount: options?.smartAccount,
      });

      // Treat non-success HTTP responses (429 rate-limited, 5xx server error) as
      // soft failures when no payment was made — try the next service instead of
      // returning a broken response to the caller.
      const status = result.response.status;
      if (!result.paymentMade && status >= 400) {
        failedServices.push({ service, error: `HTTP ${status}` });
        continue;
      }

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

  // All services failed
  throw new AzethError(
    `All ${services.length} services for capability "${capability}" failed`,
    'SERVICE_NOT_FOUND',
    {
      capability,
      attemptsCount: services.length,
      failures: failedServices.map(f => ({ name: f.service.name, error: f.error })),
    },
  );
}
