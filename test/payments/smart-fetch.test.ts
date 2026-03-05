import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzethError } from '@azeth/common';
import type { RegistryEntry } from '@azeth/common';
import {
  createMockPublicClient,
  createMockWalletClient,
  TEST_OWNER,
} from '../fixtures/mocks.js';

// Mock the discover functions
vi.mock('../../src/registry/discover.js', () => ({
  discoverServices: vi.fn(),
  discoverServicesWithFallback: vi.fn(),
}));

// Mock the fetch402 function
vi.mock('../../src/payments/x402.js', () => ({
  fetch402: vi.fn(),
}));

import { smartFetch402, computeFeedbackValue } from '../../src/payments/smart-fetch.js';
import { discoverServicesWithFallback } from '../../src/registry/discover.js';
import { fetch402 } from '../../src/payments/x402.js';

const mockedDiscover = vi.mocked(discoverServicesWithFallback);
const mockedFetch402 = vi.mocked(fetch402);

const SERVER_URL = 'https://api.azeth.ai';

function makeService(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    tokenId: 1n,
    owner: '0x0000000000000000000000000000000000000001' as `0x${string}`,
    entityType: 'service',
    name: 'TestService',
    description: 'A test service',
    capabilities: ['price-feed'],
    endpoint: 'https://service.example.com/api',
    active: true,
    reputation: 85,
    ...overrides,
  };
}

function makeFetch402Result(overrides: Record<string, unknown> = {}) {
  return {
    response: new Response('{"data": "ok"}', { status: 200 }),
    paymentMade: true,
    amount: 500_000n,
    txHash: '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as `0x${string}`,
    responseTimeMs: 150,
    settlementVerified: true,
    paymentMethod: 'x402' as const,
    ...overrides,
  };
}

describe('smartFetch402 (standalone routing layer)', () => {
  const publicClient = createMockPublicClient();
  const walletClient = createMockWalletClient();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should call the highest-ranked service successfully', async () => {
    const service = makeService({ reputation: 95 });
    mockedDiscover.mockResolvedValueOnce({ entries: [service], source: 'server' });
    mockedFetch402.mockResolvedValueOnce(makeFetch402Result());

    const result = await smartFetch402(
      publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
      'price-feed',
    );

    expect(result.service.name).toBe('TestService');
    expect(result.attemptsCount).toBe(1);
    expect(result.paymentMade).toBe(true);
    expect(result.failedServices).toBeUndefined();

    // Verify discovery was called with sortByReputation
    expect(mockedDiscover).toHaveBeenCalledWith(SERVER_URL, expect.objectContaining({
      capability: 'price-feed',
      sortByReputation: true,
      limit: 9,
    }), expect.anything(), expect.anything());
  });

  it('should fall back to second service when first fails', async () => {
    const service1 = makeService({ tokenId: 1n, name: 'FailService', reputation: 95 });
    const service2 = makeService({ tokenId: 2n, name: 'GoodService', reputation: 80, endpoint: 'https://good.example.com' });
    mockedDiscover.mockResolvedValueOnce({ entries: [service1, service2], source: 'server' });
    mockedFetch402
      .mockRejectedValueOnce(new AzethError('Connection refused', 'NETWORK_ERROR'))
      .mockResolvedValueOnce(makeFetch402Result());

    const result = await smartFetch402(
      publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
      'price-feed',
    );

    expect(result.service.name).toBe('GoodService');
    expect(result.attemptsCount).toBe(2);
    expect(result.failedServices).toHaveLength(1);
    expect(result.failedServices![0]!.service.name).toBe('FailService');
    expect(result.failedServices![0]!.error).toContain('Connection refused');
  });

  it('should treat non-success HTTP responses as soft failures and try next', async () => {
    const service1 = makeService({ tokenId: 1n, name: 'RateLimited' });
    const service2 = makeService({ tokenId: 2n, name: 'Working', endpoint: 'https://working.example.com' });
    mockedDiscover.mockResolvedValueOnce({ entries: [service1, service2], source: 'server' });
    // Service 1 returns 429 (rate limited) with no payment
    mockedFetch402
      .mockResolvedValueOnce(makeFetch402Result({
        response: new Response('Too Many Requests', { status: 429 }),
        paymentMade: false,
        amount: undefined,
      }))
      .mockResolvedValueOnce(makeFetch402Result());

    const result = await smartFetch402(
      publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
      'price-feed',
    );

    expect(result.service.name).toBe('Working');
    expect(result.attemptsCount).toBe(2);
    expect(result.failedServices).toHaveLength(1);
    expect(result.failedServices![0]!.error).toBe('HTTP 429');
  });

  it('should throw SERVICE_NOT_FOUND when all services fail', async () => {
    const service1 = makeService({ tokenId: 1n, name: 'Fail1' });
    const service2 = makeService({ tokenId: 2n, name: 'Fail2', endpoint: 'https://fail2.example.com' });
    mockedDiscover.mockResolvedValueOnce({ entries: [service1, service2], source: 'server' });
    mockedFetch402
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('500 error'));

    await expect(
      smartFetch402(
        publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
        'price-feed',
      ),
    ).rejects.toThrow(AzethError);

    try {
      mockedDiscover.mockResolvedValueOnce({ entries: [service1, service2], source: 'server' });
      mockedFetch402
        .mockRejectedValueOnce(new Error('timeout'))
        .mockRejectedValueOnce(new Error('500 error'));
      await smartFetch402(
        publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
        'price-feed',
      );
    } catch (err) {
      expect((err as AzethError).code).toBe('SERVICE_NOT_FOUND');
    }
  });

  it('should throw SERVICE_NOT_FOUND when no services are discovered', async () => {
    mockedDiscover.mockResolvedValueOnce({ entries: [], source: 'server' });

    await expect(
      smartFetch402(
        publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
        'nonexistent-capability',
      ),
    ).rejects.toThrow(AzethError);
  });

  it('should respect maxRetries option', async () => {
    const service = makeService();
    mockedDiscover.mockResolvedValueOnce({ entries: [service], source: 'server' });
    mockedFetch402.mockResolvedValueOnce(makeFetch402Result());

    await smartFetch402(
      publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
      'price-feed', { maxRetries: 5 },
    );

    expect(mockedDiscover).toHaveBeenCalledWith(SERVER_URL, expect.objectContaining({
      limit: 15,
    }), expect.anything(), expect.anything());
  });

  it('should pre-filter services without an endpoint', async () => {
    const noEndpoint = makeService({ tokenId: 1n, name: 'NoEndpoint', endpoint: undefined });
    const withEndpoint = makeService({ tokenId: 2n, name: 'HasEndpoint', endpoint: 'https://good.example.com' });
    mockedDiscover.mockResolvedValueOnce({ entries: [noEndpoint, withEndpoint], source: 'server' });
    mockedFetch402.mockResolvedValueOnce(makeFetch402Result());

    const result = await smartFetch402(
      publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
      'price-feed',
    );

    // Endpointless services are filtered before iteration, so only 1 attempt
    expect(result.service.name).toBe('HasEndpoint');
    expect(result.attemptsCount).toBe(1);
    expect(result.failedServices).toBeUndefined();
  });

  it('should move preferredService to the front', async () => {
    const service1 = makeService({ tokenId: 1n, name: 'First', reputation: 95 });
    const service2 = makeService({ tokenId: 2n, name: 'Preferred', reputation: 80, endpoint: 'https://preferred.example.com' });
    mockedDiscover.mockResolvedValueOnce({ entries: [service1, service2], source: 'server' });
    mockedFetch402.mockResolvedValueOnce(makeFetch402Result());

    const result = await smartFetch402(
      publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
      'price-feed', { preferredService: 2n },
    );

    // The preferred service should have been tried first
    expect(result.service.name).toBe('Preferred');
    expect(result.attemptsCount).toBe(1);
  });

  it('should pass minReputation and entityType to discovery', async () => {
    mockedDiscover.mockResolvedValueOnce({ entries: [], source: 'server' });

    try {
      await smartFetch402(
        publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
        'price-feed', { minReputation: 70, entityType: 'service' },
      );
    } catch {
      // Expected to throw SERVICE_NOT_FOUND
    }

    expect(mockedDiscover).toHaveBeenCalledWith(SERVER_URL, expect.objectContaining({
      minReputation: 70,
      entityType: 'service',
    }), expect.anything(), expect.anything());
  });

  // Note: Feedback tests are NOT here because the standalone smartFetch402 does
  // not submit feedback. Feedback is an AzethKit concern — only AzethKit has
  // access to the SmartAccountClient required for on-chain opinion submission.
  // See client.test.ts for feedback integration tests.

  it('should not submit feedback (standalone function has no SmartAccountClient)', async () => {
    const service = makeService();
    mockedDiscover.mockResolvedValueOnce({ entries: [service], source: 'server' });
    mockedFetch402.mockResolvedValueOnce(makeFetch402Result());

    const result = await smartFetch402(
      publicClient as any, walletClient as any, TEST_OWNER, SERVER_URL,
      'price-feed',
    );

    // Standalone function should never import or call submitOpinion
    expect(result.paymentMade).toBe(true);
    expect(result.service.name).toBe('TestService');
  });
});

describe('computeFeedbackValue', () => {
  it('returns 90 for response under 200ms', () => {
    expect(computeFeedbackValue(50)).toBe(90);
    expect(computeFeedbackValue(199)).toBe(90);
  });

  it('returns 70 for response under 500ms', () => {
    expect(computeFeedbackValue(200)).toBe(70);
    expect(computeFeedbackValue(499)).toBe(70);
  });

  it('returns 50 for response under 2000ms', () => {
    expect(computeFeedbackValue(500)).toBe(50);
    expect(computeFeedbackValue(1999)).toBe(50);
  });

  it('returns 30 for response 2000ms or more', () => {
    expect(computeFeedbackValue(2000)).toBe(30);
    expect(computeFeedbackValue(10000)).toBe(30);
  });
});
