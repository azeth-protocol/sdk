import { describe, it, expect, vi, afterEach } from 'vitest';
import { discoverServices, getRegistryEntry, discoverServicesWithFallback } from '../../src/registry/discover.js';
import { createMockResponse, createMockPublicClient } from '../fixtures/mocks.js';
import type { RegistryEntry } from '@azeth/common';

// Mock withRetry to execute immediately without retries or delays.
// This prevents tests from timing out due to exponential backoff on TypeError('fetch failed').
vi.mock('../../src/utils/retry.js', () => ({
  withRetry: (fn: () => Promise<unknown>) => fn(),
}));

describe('registry/discover', () => {
  const originalFetch = globalThis.fetch;
  const serverUrl = 'https://api.azeth.ai';

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('discoverServices', () => {
    it('should fetch services from the discovery API', async () => {
      const mockEntries: RegistryEntry[] = [
        {
          tokenId: 1n,
          owner: '0x1111111111111111111111111111111111111111' as `0x${string}`,
          entityType: 'service',
          name: 'DataService',
          description: 'Provides data',
          capabilities: ['data-analysis'],
          endpoint: 'https://data.example.com',
          active: true,
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: mockEntries }));

      const result = await discoverServices(serverUrl, { capability: 'data-analysis' });

      expect(result).toEqual(mockEntries);
    });

    it('should pass all query parameters', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: [] }));

      await discoverServices(serverUrl, {
        capability: 'prediction',
        entityType: 'agent',
        minReputation: 80,
        limit: 10,
        offset: 5,
      });

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(calledUrl).toContain('capability=prediction');
      expect(calledUrl).toContain('entityType=agent');
      expect(calledUrl).toContain('minReputation=80');
      expect(calledUrl).toContain('limit=10');
      expect(calledUrl).toContain('offset=5');
    });

    it('should omit undefined parameters', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: [] }));

      await discoverServices(serverUrl, {});

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(calledUrl).toContain('/api/v1/registry/discover?');
      expect(calledUrl).not.toContain('capability=');
      expect(calledUrl).not.toContain('entityType=');
    });

    it('should throw on non-OK response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(503, { error: 'Service unavailable' }));

      await expect(discoverServices(serverUrl, { capability: 'test' })).rejects.toThrow(
        'Discovery API error: 503',
      );
    });

    it('should return empty array when no services match', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: [] }));

      const result = await discoverServices(serverUrl, { capability: 'nonexistent' });

      expect(result).toEqual([]);
    });

    it('should handle minReputation of 0', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: [] }));

      await discoverServices(serverUrl, { minReputation: 0 });

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(calledUrl).toContain('minReputation=0');
    });

    it('should throw SERVER_UNAVAILABLE when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      await expect(discoverServices(serverUrl, {})).rejects.toMatchObject({
        code: 'SERVER_UNAVAILABLE',
      });
    });
  });

  describe('getRegistryEntry', () => {
    it('should fetch a specific registry entry by tokenId', async () => {
      const mockEntry: RegistryEntry = {
        tokenId: 42n,
        owner: '0x1111111111111111111111111111111111111111' as `0x${string}`,
        entityType: 'agent',
        name: 'TestAgent',
        description: 'A test agent',
        capabilities: ['analysis'],
        endpoint: 'https://agent.example.com',
        active: true,
      };

      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: mockEntry }));

      const result = await getRegistryEntry(serverUrl, 42n);

      expect(result).toEqual(mockEntry);
      const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(calledUrl).toBe(`${serverUrl}/api/v1/registry/42`);
    });

    it('should return null for 404 responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(404, null));

      const result = await getRegistryEntry(serverUrl, 999n);

      expect(result).toBeNull();
    });

    it('should throw on other error responses', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(500, { error: 'Internal error' }));

      await expect(getRegistryEntry(serverUrl, 1n)).rejects.toThrow('Registry API error: 500');
    });

    it('should throw SERVER_UNAVAILABLE when fetch fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));

      await expect(getRegistryEntry(serverUrl, 1n)).rejects.toMatchObject({
        code: 'SERVER_UNAVAILABLE',
      });
    });
  });

  describe('discoverServicesWithFallback', () => {
    it('should return server results when server is available', async () => {
      const mockEntries: RegistryEntry[] = [
        {
          tokenId: 1n,
          owner: '0x1111111111111111111111111111111111111111' as `0x${string}`,
          entityType: 'service',
          name: 'ServerService',
          description: 'From server',
          capabilities: ['data'],
          active: true,
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: mockEntries }));
      const publicClient = createMockPublicClient();

      const result = await discoverServicesWithFallback(
        serverUrl, { capability: 'data' }, publicClient, 'baseSepolia',
      );

      expect(result.source).toBe('server');
      expect(result.entries).toEqual(mockEntries);
    });

    /** Helper: build a RegistrySnapshot tuple for oracle mock responses */
    function makeSnapshot(
      tokenId: bigint,
      owner: `0x${string}`,
      uri: string,
    ): { tokenId: bigint; owner: `0x${string}`; uri: string; exists: boolean } {
      return { tokenId, owner, uri, exists: true };
    }

    /** Helper: mock the oracle's discoverRegistry response on a publicClient.
     *  Returns the given snapshots and scannedCount when readContract is called
     *  with functionName 'discoverRegistry'. */
    function mockOracleDiscovery(
      publicClient: ReturnType<typeof createMockPublicClient>,
      snapshots: { tokenId: bigint; owner: `0x${string}`; uri: string; exists: boolean }[],
      scannedCount: bigint,
    ) {
      publicClient.readContract.mockImplementation((args: any) => {
        if (args?.functionName === 'discoverRegistry') {
          return Promise.resolve([snapshots, scannedCount]);
        }
        return Promise.resolve(0n);
      });
    }

    it('should fall back to on-chain when server is unavailable', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const publicClient = createMockPublicClient();

      const agentURI = 'data:application/json,' + encodeURIComponent(JSON.stringify({
        name: 'OnChainAgent',
        description: 'Discovered on-chain',
        entityType: 'agent',
        capabilities: ['analysis', 'data'],
        endpoint: 'https://onchain.example.com',
      }));

      mockOracleDiscovery(publicClient, [
        makeSnapshot(0n, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', agentURI),
        makeSnapshot(1n, '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', agentURI),
      ], 7n); // scannedCount < 1000 = early termination

      const result = await discoverServicesWithFallback(
        serverUrl, {}, publicClient, 'baseSepolia',
      );

      expect(result.source).toBe('on-chain');
      expect(result.entries.length).toBe(2);
      expect(result.entries[0]!.name).toBe('OnChainAgent');
      expect(result.entries[0]!.entityType).toBe('agent');
      expect(result.entries[0]!.capabilities).toContain('analysis');
      expect(result.entries[0]!.active).toBe(true);
    });

    it('should filter by capability on-chain', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const publicClient = createMockPublicClient();

      const makeURI = (name: string, caps: string[]) =>
        'data:application/json,' + encodeURIComponent(JSON.stringify({
          name, description: '', entityType: 'service', capabilities: caps,
        }));

      mockOracleDiscovery(publicClient, [
        makeSnapshot(0n, '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', makeURI('DataService', ['data'])),
        makeSnapshot(1n, '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB', makeURI('SwapService', ['swap'])),
      ], 7n);

      const result = await discoverServicesWithFallback(
        serverUrl, { capability: 'swap' }, publicClient, 'baseSepolia',
      );

      expect(result.source).toBe('on-chain');
      expect(result.entries.length).toBe(1);
      expect(result.entries[0]!.name).toBe('SwapService');
    });

    it('should filter by entityType on-chain', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const publicClient = createMockPublicClient();

      const makeURI = (name: string, entityType: string) =>
        'data:application/json,' + encodeURIComponent(JSON.stringify({
          name, description: '', entityType, capabilities: ['test'],
        }));

      mockOracleDiscovery(publicClient, [
        makeSnapshot(0n, '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', makeURI('Agent', 'agent')),
        makeSnapshot(1n, '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', makeURI('Infra', 'infrastructure')),
      ], 7n);

      const result = await discoverServicesWithFallback(
        serverUrl, { entityType: 'infrastructure' }, publicClient, 'baseSepolia',
      );

      expect(result.source).toBe('on-chain');
      expect(result.entries.length).toBe(1);
      expect(result.entries[0]!.name).toBe('Infra');
    });

    it('should return empty on-chain when no tokens exist', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const publicClient = createMockPublicClient();

      mockOracleDiscovery(publicClient, [], 5n); // Empty registry, scanned 5 then terminated

      const result = await discoverServicesWithFallback(
        serverUrl, {}, publicClient, 'baseSepolia',
      );

      expect(result.source).toBe('on-chain');
      expect(result.entries).toEqual([]);
    });

    it('should fall back to on-chain for REGISTRY_ERROR (e.g., 503)', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(503, { error: 'bad' }));
      const publicClient = createMockPublicClient();

      const agentURI = 'data:application/json,' + encodeURIComponent(JSON.stringify({
        name: 'FallbackAgent', description: 'From on-chain', entityType: 'agent', capabilities: ['test'],
      }));
      mockOracleDiscovery(publicClient, [
        makeSnapshot(0n, '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE', agentURI),
      ], 5n);

      // 503 triggers REGISTRY_ERROR which now falls back to on-chain
      const result = await discoverServicesWithFallback(serverUrl, {}, publicClient, 'baseSepolia');
      expect(result.source).toBe('on-chain');
      expect(result.entries.length).toBe(1);
      expect(result.entries[0]!.name).toBe('FallbackAgent');
    });

    it('should respect limit on-chain', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const publicClient = createMockPublicClient();

      const makeURI = (id: number) =>
        'data:application/json,' + encodeURIComponent(JSON.stringify({
          name: `Agent-${id}`, description: '', entityType: 'agent', capabilities: ['test'],
        }));

      // Oracle returns 20 entries
      const snapshots = Array.from({ length: 20 }, (_, i) =>
        makeSnapshot(BigInt(i), '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD', makeURI(i)),
      );
      mockOracleDiscovery(publicClient, snapshots, 25n);

      const result = await discoverServicesWithFallback(
        serverUrl, { limit: 3 }, publicClient, 'baseSepolia',
      );

      expect(result.source).toBe('on-chain');
      expect(result.entries.length).toBe(3);
    });

    it('should throw NETWORK_ERROR when oracle call fails', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('fetch failed'));
      const publicClient = createMockPublicClient();

      publicClient.readContract.mockRejectedValue(new Error('RPC error'));

      await expect(
        discoverServicesWithFallback(serverUrl, {}, publicClient, 'baseSepolia'),
      ).rejects.toMatchObject({
        code: 'NETWORK_ERROR',
      });
    });
  });
});
