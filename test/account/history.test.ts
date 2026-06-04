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
    it('parses the { data, meta } envelope and restores bigint fields (F-5)', async () => {
      // The real server wraps records in { data, meta } and serializes the
      // bigint fields (value, blockNumber) as JSON strings.
      const serverBody = {
        data: [
          {
            hash: '0xabc' as `0x${string}`,
            from: TEST_ACCOUNT,
            to: '0x1234' as `0x${string}`,
            value: '100',
            token: null,
            type: 'transfer',
            timestamp: 1700000000,
            blockNumber: '50',
          },
        ],
        meta: { count: 1, nextCursor: undefined },
      };

      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(200, serverBody),
      );

      const result = await getHistory(publicClient, TEST_ACCOUNT, 'https://api.azeth.ai');

      expect(result.transactions).toEqual([
        {
          hash: '0xabc',
          from: TEST_ACCOUNT,
          to: '0x1234',
          value: 100n,
          token: null,
          blockNumber: 50n,
          timestamp: 1700000000,
          type: 'transfer',
        },
      ]);
      // The indexed server path is authoritative — not a degraded result.
      expect(result.indexedHistoryUnavailable).toBe(false);
      // bigint fields restored from JSON strings; the recurring-payment tag carried through.
      expect(result.transactions[0]?.value).toBe(100n);
      expect(result.transactions[0]?.blockNumber).toBe(50n);
      expect(result.transactions[0]?.type).toBe('transfer');
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://api.azeth.ai/api/v1/history'),
        // history now routes through secureFetch, which passes an (empty) init as the 2nd arg
        expect.anything(),
      );
    });

    it('should pass query parameters to the API', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(200, { data: [] }),
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

    it('falls back (and flags unavailable) when the server returns non-OK', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(500, { error: 'Internal error' }),
      );

      // No reputationModule address → no on-chain source → unavailable, not error.
      const result = await getHistory(publicClient, TEST_ACCOUNT, 'https://api.azeth.ai');
      expect(result.transactions).toEqual([]);
      expect(result.indexedHistoryUnavailable).toBe(true);
    });

    it('should not include limit/offset params when not provided', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(200, { data: [] }),
      );

      await getHistory(publicClient, TEST_ACCOUNT, 'https://api.azeth.ai');

      const calledUrl = (globalThis.fetch as any).mock.calls[0][0] as string;
      expect(calledUrl).toContain('address=' + TEST_ACCOUNT);
      expect(calledUrl).not.toContain('limit=');
      expect(calledUrl).not.toContain('offset=');
    });
  });

  describe('fallback (no serverUrl)', () => {
    it('flags unavailable (no transactions) when there is no indexer source', async () => {
      const result = await getHistory(publicClient, TEST_ACCOUNT);

      expect(result.transactions).toEqual([]);
      expect(result.indexedHistoryUnavailable).toBe(true);
      // No ReputationModule address → returns before any RPC call.
      expect(publicClient.getBlockNumber).not.toHaveBeenCalled();
      expect(publicClient.getBlock).not.toHaveBeenCalled();
    });

    it('flags unavailable regardless of params when there is no indexer source', async () => {
      const result = await getHistory(publicClient, TEST_ACCOUNT, undefined, {
        limit: 10,
        fromBlock: 500n,
      });

      expect(result.transactions).toEqual([]);
      expect(result.indexedHistoryUnavailable).toBe(true);
    });
  });

  describe('on-chain fallback (F-5)', () => {
    const REPUTATION_MODULE = '0xB8C98ace6bdB25f5AEb2031150A5944F3135ccC0' as `0x${string}`;
    const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`;

    it('chunks getLogs to stay within RPC block-range caps', async () => {
      const getLogs = vi.fn().mockResolvedValue([]);
      const pc = createMockPublicClient({
        getBlockNumber: vi.fn().mockResolvedValue(100_000n),
        getLogs,
      });

      const result = await getHistory(pc, TEST_ACCOUNT, undefined, undefined, REPUTATION_MODULE, [USDC]);

      // Full scan served ⇒ not a degraded result.
      expect(result.indexedHistoryUnavailable).toBe(false);
      expect(getLogs).toHaveBeenCalled();
      // No single query may exceed the ~10k block-range cap many RPCs enforce.
      for (const [params] of getLogs.mock.calls) {
        expect(params.toBlock - params.fromBlock).toBeLessThanOrEqual(10_000n);
      }
      // The 50k scan window is covered by multiple chunks, not one oversized call.
      expect(getLogs.mock.calls.length).toBeGreaterThan(1);
    });

    it('degrades to a recent-only window when the full scan is rejected', async () => {
      // The RPC rejects wide ranges (the real Base Sepolia symptom) but serves the
      // narrow recent window — so we should get recent records + the unavailable flag.
      const recentLog = {
        transactionHash: '0xrecent' as `0x${string}`,
        args: {
          from: TEST_ACCOUNT,
          to: '0x000000000000000000000000000000000000dEaD' as `0x${string}`,
          token: '0x0000000000000000000000000000000000000000' as `0x${string}`,
          amount: 7n,
        },
        blockNumber: 99_000n,
        address: REPUTATION_MODULE,
      };
      const getLogs = vi.fn().mockImplementation(({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
        toBlock - fromBlock > 2_000n
          ? Promise.reject(new Error('block range too large'))
          : Promise.resolve([recentLog]),
      );
      const pc = createMockPublicClient({
        getBlockNumber: vi.fn().mockResolvedValue(100_000n),
        getLogs,
      });

      const result = await getHistory(pc, TEST_ACCOUNT, undefined, undefined, REPUTATION_MODULE, [USDC]);

      expect(result.indexedHistoryUnavailable).toBe(true);
      expect(result.transactions.length).toBeGreaterThan(0);
      expect(result.transactions[0]?.hash).toBe('0xrecent');
    });

    it('returns empty with the flag (never throws) when even the recent window fails', async () => {
      const pc = createMockPublicClient({
        getBlockNumber: vi.fn().mockResolvedValue(100_000n),
        getLogs: vi.fn().mockRejectedValue(new Error('eth_getLogs disabled')),
      });

      const result = await getHistory(pc, TEST_ACCOUNT, undefined, undefined, REPUTATION_MODULE, [USDC]);
      expect(result.transactions).toEqual([]);
      expect(result.indexedHistoryUnavailable).toBe(true);
    });
  });
});
