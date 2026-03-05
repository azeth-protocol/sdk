import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getHistory } from '../../src/account/history.js';
import { createMockPublicClient, createMockResponse, TEST_ACCOUNT } from '../fixtures/mocks.js';

describe('account/history', () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('server-based history (with serverUrl)', () => {
    it('should fetch history from the server API', async () => {
      const mockRecords = [
        {
          hash: '0xabc' as `0x${string}`,
          from: TEST_ACCOUNT,
          to: '0x1234' as `0x${string}`,
          value: 100n,
          blockNumber: 50n,
          timestamp: 1700000000,
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(200, mockRecords),
      );

      const result = await getHistory(publicClient, TEST_ACCOUNT, 'https://api.azeth.ai');

      expect(result).toEqual(mockRecords);
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.azeth.ai/api/v1/history'),
      );
    });

    it('should pass query parameters to the API', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(200, []),
      );

      await getHistory(publicClient, TEST_ACCOUNT, 'https://api.azeth.ai', {
        limit: 10,
        offset: 5,
      });

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(calledUrl).toContain('address=' + TEST_ACCOUNT);
      expect(calledUrl).toContain('limit=10');
      expect(calledUrl).toContain('offset=5');
    });

    it('should throw on non-OK server response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(500, { error: 'Internal error' }),
      );

      const result = await getHistory(publicClient, TEST_ACCOUNT, 'https://api.azeth.ai');
      expect(result).toEqual([]);
    });

    it('should not include limit/offset params when not provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(200, []),
      );

      await getHistory(publicClient, TEST_ACCOUNT, 'https://api.azeth.ai');

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(calledUrl).toContain('address=' + TEST_ACCOUNT);
      expect(calledUrl).not.toContain('limit=');
      expect(calledUrl).not.toContain('offset=');
    });
  });

  describe('fallback (no serverUrl)', () => {
    it('should return empty array without an indexer', async () => {
      const result = await getHistory(publicClient, TEST_ACCOUNT);

      expect(result).toEqual([]);
      expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
      expect(publicClient.getBlock).not.toHaveBeenCalled();
    });

    it('should return empty array regardless of params', async () => {
      const result = await getHistory(publicClient, TEST_ACCOUNT, undefined, {
        limit: 10,
        fromBlock: 500n,
      });

      expect(result).toEqual([]);
    });
  });
});
