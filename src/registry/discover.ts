import type { PublicClient, Transport, Chain } from 'viem';
import {
  AzethError,
  AZETH_CONTRACTS,
  ERC8004_REGISTRY,
  type RegistryEntry,
  type DiscoveryParams,
  type EntityType,
  type SupportedChainName,
} from '@azeth/common';
import { AzethOracleAbi } from '@azeth/common/abis';
import { withRetry } from '../utils/retry.js';

/** Discover services from the Azeth server's trust registry index.
 *
 *  MEDIUM-8 (Audit): Results are fetched from the server's in-memory index, NOT verified
 *  on-chain. The server could return stale, incomplete, or manipulated entries. For security-
 *  critical decisions (e.g., routing payments or trusting a service endpoint), callers SHOULD
 *  verify the returned entries against the on-chain ERC-8004 Identity Registry before trusting
 *  them. Use the contract's `ownerOf(tokenId)` and metadata to confirm authenticity.
 */
export async function discoverServices(
  serverUrl: string,
  params: DiscoveryParams,
): Promise<RegistryEntry[]> {
  // H-7 fix: Default limit 20, max 100 to prevent unbounded API reads
  const limit = Math.min(params.limit ?? 20, 100);

  const queryParams = new URLSearchParams();
  if (params.capability) queryParams.set('capability', params.capability);
  if (params.entityType) queryParams.set('entityType', params.entityType);
  if (params.minReputation !== undefined) queryParams.set('minReputation', params.minReputation.toString());
  if (params.sortByReputation) queryParams.set('sortByReputation', 'true');
  queryParams.set('limit', limit.toString());
  if (params.offset !== undefined) queryParams.set('offset', params.offset.toString());

  let response: Response;
  try {
    response = await withRetry(() => fetch(`${serverUrl}/api/v1/registry/discover?${queryParams}`));
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to discover services',
      'SERVER_UNAVAILABLE',
      { originalError: err instanceof Error ? err.name : undefined },
    );
  }
  if (!response.ok) {
    throw new AzethError(
      `Discovery API error: ${response.status}`,
      response.status === 404 ? 'SERVICE_NOT_FOUND' : 'REGISTRY_ERROR',
      { status: response.status },
    );
  }

  const body = await response.json() as { data: RegistryEntry[] };
  return body.data ?? [];
}

/** Get a specific registry entry by token ID */
export async function getRegistryEntry(
  serverUrl: string,
  tokenId: bigint,
): Promise<RegistryEntry | null> {
  let response: Response;
  try {
    response = await withRetry(() => fetch(`${serverUrl}/api/v1/registry/${tokenId}`));
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to get registry entry',
      'SERVER_UNAVAILABLE',
      { originalError: err instanceof Error ? err.name : undefined },
    );
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new AzethError(
      `Registry API error: ${response.status}`,
      'REGISTRY_ERROR',
      { status: response.status, tokenId: tokenId.toString() },
    );
  }

  const body = await response.json() as { data: RegistryEntry };
  return body.data ?? null;
}

// ── On-chain fallback via AzethOracle ────────────────────────────────────────

/** Batch size for oracle discovery — entries per RPC call (oracle caps at 1000) */
const ORACLE_BATCH_SIZE = 1000;

/** Parsed metadata from a data:application/json, URI */
interface ParsedMetadata {
  name: string;
  description: string;
  entityType: EntityType;
  capabilities: string[];
  endpoint?: string;
}

/** Parse a data:application/json, URI into metadata fields */
function parseDataURI(uri: string): ParsedMetadata | null {
  try {
    if (!uri.startsWith('data:application/json,')) return null;
    const jsonStr = decodeURIComponent(uri.slice('data:application/json,'.length));
    const meta = JSON.parse(jsonStr) as Record<string, unknown>;

    const name = typeof meta.name === 'string' ? meta.name : '';
    const description = typeof meta.description === 'string' ? meta.description : '';
    const entityType = typeof meta.entityType === 'string' && ['agent', 'service', 'infrastructure'].includes(meta.entityType)
      ? (meta.entityType as EntityType)
      : 'agent';
    const capabilities = Array.isArray(meta.capabilities)
      ? meta.capabilities.filter((c): c is string => typeof c === 'string')
      : [];
    const endpoint = typeof meta.endpoint === 'string' ? meta.endpoint : undefined;

    return { name, description, entityType, capabilities, endpoint };
  } catch {
    return null;
  }
}

/** Result from discovery with fallback — includes source indicator */
export interface DiscoveryWithFallbackResult {
  entries: RegistryEntry[];
  /** 'server' if results came from the API, 'on-chain' if from direct contract reads */
  source: 'server' | 'on-chain';
  /** True when minReputation was requested but ignored in on-chain mode */
  minReputationIgnored?: boolean;
}

/** Options for discoverServicesWithFallback */
export interface DiscoveryFallbackOptions {
  /** Cache query results in-memory for 60s (default: false) */
  cacheResults?: boolean;
}

// ── SDK-side discovery cache ─────────────────────────────────────────────────

const SDK_CACHE_TTL_MS = 60_000;
const SDK_CACHE_MAX = 100;

interface SDKCacheEntry {
  result: DiscoveryWithFallbackResult;
  timestamp: number;
  lastAccessed: number;
}

const sdkDiscoveryCache = new Map<string, SDKCacheEntry>();

/** Serialize params into a stable cache key */
function makeCacheKey(serverUrl: string, params: DiscoveryParams, chainName: string): string {
  return JSON.stringify({
    u: serverUrl,
    p: {
      c: params.capability,
      e: params.entityType,
      n: params.name,
      mr: params.minReputation,
      sr: params.sortByReputation,
      l: params.limit,
      o: params.offset,
    },
    ch: chainName,
  });
}

/** Evict the least-recently-accessed entry from the SDK cache */
function evictLRU(): void {
  if (sdkDiscoveryCache.size < SDK_CACHE_MAX) return;
  let lruKey: string | undefined;
  let lruTime = Infinity;
  for (const [k, v] of sdkDiscoveryCache) {
    if (v.lastAccessed < lruTime) {
      lruTime = v.lastAccessed;
      lruKey = k;
    }
  }
  if (lruKey !== undefined) sdkDiscoveryCache.delete(lruKey);
}

/** Discover services with automatic on-chain fallback when the server is unavailable.
 *
 *  First tries the Azeth server API (fast, indexed, supports reputation sorting).
 *  If the server is unreachable (`SERVER_UNAVAILABLE`), retries once after 2s delay,
 *  then falls back to reading the ERC-8004 Identity Registry via the AzethOracle's
 *  `discoverRegistry()` view function.
 *
 *  On-chain fallback limitations:
 *  - Does NOT support minReputation or sortByReputation (requires the server's index)
 *  - Filters by capability and entityType are applied client-side
 *  - Reads up to 1000 entries per RPC call via the AzethOracle batch view function
 *  - Oracle uses early termination after 5 consecutive non-existent token IDs
 *
 *  @param options.cacheResults - Cache results in-memory for 60s (default: false)
 */
export async function discoverServicesWithFallback(
  serverUrl: string,
  params: DiscoveryParams,
  publicClient: PublicClient<Transport, Chain>,
  chainName: SupportedChainName,
  options?: DiscoveryFallbackOptions,
): Promise<DiscoveryWithFallbackResult> {
  // Check SDK-side cache if enabled
  if (options?.cacheResults) {
    const cacheKey = makeCacheKey(serverUrl, params, chainName);
    const cached = sdkDiscoveryCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < SDK_CACHE_TTL_MS) {
      cached.lastAccessed = Date.now();
      return cached.result;
    }
  }

  const result = await discoverServicesWithFallbackInner(serverUrl, params, publicClient, chainName);

  // Store in SDK cache if enabled
  if (options?.cacheResults) {
    const cacheKey = makeCacheKey(serverUrl, params, chainName);
    evictLRU();
    sdkDiscoveryCache.set(cacheKey, {
      result,
      timestamp: Date.now(),
      lastAccessed: Date.now(),
    });
  }

  return result;
}

/** Internal implementation — performs server attempt with retry then on-chain fallback */
async function discoverServicesWithFallbackInner(
  serverUrl: string,
  params: DiscoveryParams,
  publicClient: PublicClient<Transport, Chain>,
  chainName: SupportedChainName,
): Promise<DiscoveryWithFallbackResult> {
  // Try the server first
  try {
    const entries = await discoverServices(serverUrl, params);
    // Fall back to on-chain when server returns empty results — the server index may be
    // stale or incomplete, but the on-chain registry is the source of truth.
    if (entries.length > 0) {
      return { entries, source: 'server' };
    }
  } catch (err: unknown) {
    // Fall back to on-chain for server connectivity issues AND 404/registry errors
    const fallbackCodes = new Set(['SERVER_UNAVAILABLE', 'SERVICE_NOT_FOUND', 'REGISTRY_ERROR']);
    if (!(err instanceof AzethError) || !fallbackCodes.has(err.code)) {
      throw err;
    }
    // Retry once with 2s delay before falling back to on-chain
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const entries = await discoverServices(serverUrl, params);
      if (entries.length > 0) {
        return { entries, source: 'server' };
      }
    } catch (retryErr: unknown) {
      if (!(retryErr instanceof AzethError) || !fallbackCodes.has(retryErr.code)) {
        throw retryErr;
      }
      // Fall through to on-chain
    }
  }

  // On-chain fallback via AzethOracle.discoverRegistry()
  const registryAddress = ERC8004_REGISTRY[chainName];
  if (!registryAddress) {
    throw new AzethError(
      `No ERC-8004 Identity Registry configured for ${chainName}`,
      'REGISTRY_ERROR',
    );
  }

  const oracleAddress = AZETH_CONTRACTS[chainName]?.priceOracle;
  if (!oracleAddress) {
    throw new AzethError(
      `No AzethOracle configured for ${chainName}`,
      'REGISTRY_ERROR',
    );
  }

  const limit = Math.min(params.limit ?? 20, 100);
  const offset = params.offset ?? 0;
  const collectTarget = offset + limit; // collect enough to slice for offset
  const entries: RegistryEntry[] = [];
  let startId = 0;
  let reachedEnd = false;

  while (!reachedEnd && entries.length < collectTarget) {
    let snapshots: readonly { tokenId: bigint; owner: `0x${string}`; uri: string; exists: boolean }[];
    let scannedCount: bigint;

    try {
      [snapshots, scannedCount] = await publicClient.readContract({
        address: oracleAddress,
        abi: AzethOracleAbi,
        functionName: 'discoverRegistry',
        args: [registryAddress, BigInt(startId), BigInt(ORACLE_BATCH_SIZE)],
      });
    } catch {
      throw new AzethError(
        'Failed to query AzethOracle discoverRegistry',
        'NETWORK_ERROR',
      );
    }

    for (const snap of snapshots) {
      if (entries.length >= collectTarget) break;
      if (!snap.exists) continue;

      const meta = parseDataURI(snap.uri);
      if (!meta) continue;

      // Apply filters client-side
      if (params.capability && !meta.capabilities.some(
        (c) => c.toLowerCase() === params.capability!.toLowerCase(),
      )) {
        continue;
      }
      if (params.entityType && meta.entityType !== params.entityType) {
        continue;
      }
      if (params.name && meta.name.trim().toLowerCase() !== params.name.trim().toLowerCase()) {
        continue;
      }

      entries.push({
        tokenId: snap.tokenId,
        owner: snap.owner,
        entityType: meta.entityType,
        name: meta.name,
        description: meta.description,
        capabilities: meta.capabilities,
        endpoint: meta.endpoint,
        active: true,
      });
    }

    // If scannedCount < ORACLE_BATCH_SIZE, oracle hit early termination (end of registry)
    if (scannedCount < BigInt(ORACLE_BATCH_SIZE)) {
      reachedEnd = true;
    } else {
      startId += ORACLE_BATCH_SIZE;
    }
  }

  // Sort: entries with endpoints first, then newest tokenId (most likely to be live)
  entries.sort((a, b) => {
    const aHas = a.endpoint ? 1 : 0;
    const bHas = b.endpoint ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
    return Number(b.tokenId - a.tokenId);
  });

  return {
    entries: entries.slice(offset, offset + limit),
    source: 'on-chain',
    // minReputation is not supported in on-chain mode (requires server index)
    ...(params.minReputation !== undefined ? { minReputationIgnored: true } : {}),
  };
}
