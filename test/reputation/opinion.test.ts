import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  submitOpinion,
  getWeightedReputation,
  getWeightedReputationAll,
  getNetPaid,
  getTotalNetPaidUSD,
  getActiveOpinion,
  readOpinion,
} from '../../src/reputation/opinion.js';
import {
  createMockPublicClient,
  createMockSmartAccountClient,
  TEST_ACCOUNT,
  TEST_TX_HASH,
  TEST_ADDRESSES,
} from '../fixtures/mocks.js';

vi.mock('@azeth/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@azeth/common')>();
  return {
    ...actual,
    AZETH_CONTRACTS: {
      baseSepolia: {
        factory: '0x6666666666666666666666666666666666666666' as `0x${string}`,
        guardianModule: '0x7777777777777777777777777777777777777777' as `0x${string}`,
        trustRegistryModule: '0x8888888888888888888888888888888888888888' as `0x${string}`,
        paymentAgreementModule: '0x9999999999999999999999999999999999999999' as `0x${string}`,
        reputationModule: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`,
        priceOracle: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`,
        accountImplementation: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as `0x${string}`,
      },
      base: {
        factory: '' as `0x${string}`,
        guardianModule: '' as `0x${string}`,
        trustRegistryModule: '' as `0x${string}`,
        paymentAgreementModule: '' as `0x${string}`,
        reputationModule: '' as `0x${string}`,
        priceOracle: '' as `0x${string}`,
        accountImplementation: '' as `0x${string}`,
      },
    },
    ERC8004_REPUTATION_REGISTRY: {
      baseSepolia: '0x8004B663056A597Dffe9eCcC1965A193B7388713' as `0x${string}`,
      base: '' as `0x${string}`,
    },
  };
});

vi.mock('@azeth/common/abis', () => ({
  ReputationModuleAbi: [],
  ERC8004ReputationRegistryAbi: [],
  AzethAccountAbi: [],
  AzethFactoryAbi: [],
  GuardianModuleAbi: [],
  TrustRegistryModuleAbi: [],
  PaymentAgreementModuleAbi: [],
}));

// Mock encodeFunctionData since we use empty ABIs in tests.
// The real ABIs are generated from Foundry artifacts; in unit tests we verify
// the call routing (sendTransaction called with correct `to` address) not the calldata encoding.
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    encodeFunctionData: vi.fn().mockReturnValue('0xmockencoded'),
  };
});

const REPUTATION_MODULE = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`;

describe('reputation/opinion', () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let smartAccountClient: ReturnType<typeof createMockSmartAccountClient>;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    smartAccountClient = createMockSmartAccountClient();
    vi.clearAllMocks();
  });

  describe('submitOpinion', () => {
    it('should submit opinion via SmartAccountClient.sendTransaction()', async () => {
      const txHash = await submitOpinion(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
        agentId: 42n,
        value: 85n,
        valueDecimals: 0,
        tag1: 'quality',
        tag2: 'x402',
        endpoint: 'https://service.example.com',
        opinionURI: '',
        opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      });

      expect(txHash).toBe(TEST_TX_HASH);
      // Should route through smart account via sendTransaction (UserOp)
      expect(smartAccountClient.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: REPUTATION_MODULE,
          value: 0n,
          data: expect.any(String),
        }),
      );
    });

    it('should throw when reputationModule is not deployed', async () => {
      const emptyAddresses = { ...TEST_ADDRESSES, reputationModule: '' as `0x${string}` };

      await expect(
        submitOpinion(publicClient, smartAccountClient, emptyAddresses, TEST_ACCOUNT, {
          agentId: 1n,
          value: 50n,
          valueDecimals: 0,
          tag1: '',
          tag2: '',
          endpoint: '',
          opinionURI: '',
          opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        }),
      ).rejects.toThrow('reputationModule address not configured');
    });

    it('should propagate contract errors', async () => {
      smartAccountClient.sendTransaction.mockRejectedValue(new Error('InvalidValue'));

      await expect(
        submitOpinion(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
          agentId: 1n,
          value: 50n,
          valueDecimals: 0,
          tag1: '',
          tag2: '',
          endpoint: '',
          opinionURI: '',
          opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
        }),
      ).rejects.toThrow('InvalidValue');
    });
  });

  describe('getWeightedReputation', () => {
    it('should read weighted reputation from the ReputationModule', async () => {
      publicClient.readContract.mockResolvedValue([85n, 1000000n, 5n]);

      const result = await getWeightedReputation(
        publicClient, TEST_ADDRESSES, 42n,
        ['0x1111111111111111111111111111111111111111' as `0x${string}`],
      );

      expect(result.weightedValue).toBe(85n);
      expect(result.totalWeight).toBe(1000000n);
      expect(result.opinionCount).toBe(5n);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: REPUTATION_MODULE,
          functionName: 'getWeightedReputation',
          args: [42n, ['0x1111111111111111111111111111111111111111']],
        }),
      );
    });

    it('should throw when reputationModule is not deployed', async () => {
      const emptyAddresses = { ...TEST_ADDRESSES, reputationModule: '' as `0x${string}` };

      await expect(
        getWeightedReputation(publicClient, emptyAddresses, 42n, []),
      ).rejects.toThrow('reputationModule address not configured');
    });
  });

  describe('getWeightedReputationAll', () => {
    it('should read reputation across all raters', async () => {
      publicClient.readContract.mockResolvedValue([90n, 5000000n, 10n]);

      const result = await getWeightedReputationAll(
        publicClient, TEST_ADDRESSES, 42n,
      );

      expect(result.weightedValue).toBe(90n);
      expect(result.totalWeight).toBe(5000000n);
      expect(result.opinionCount).toBe(10n);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: REPUTATION_MODULE,
          functionName: 'getWeightedReputationAll',
          args: [42n],
        }),
      );
    });
  });

  describe('getNetPaid', () => {
    it('should return the net payment delta between two accounts', async () => {
      publicClient.readContract.mockResolvedValue(500000n);

      const result = await getNetPaid(
        publicClient, TEST_ADDRESSES,
        '0x1111111111111111111111111111111111111111' as `0x${string}`,
        '0x2222222222222222222222222222222222222222' as `0x${string}`,
        '0x0000000000000000000000000000000000000000' as `0x${string}`,
      );

      expect(result).toBe(500000n);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: REPUTATION_MODULE,
          functionName: 'getNetPaid',
          args: [
            '0x1111111111111111111111111111111111111111',
            '0x2222222222222222222222222222222222222222',
            '0x0000000000000000000000000000000000000000',
          ],
        }),
      );
    });

    it('should throw when reputationModule is not deployed', async () => {
      const emptyAddresses = { ...TEST_ADDRESSES, reputationModule: '' as `0x${string}` };

      await expect(
        getNetPaid(
          publicClient, emptyAddresses,
          '0x1111111111111111111111111111111111111111' as `0x${string}`,
          '0x2222222222222222222222222222222222222222' as `0x${string}`,
          '0x0000000000000000000000000000000000000000' as `0x${string}`,
        ),
      ).rejects.toThrow('reputationModule address not configured');
    });
  });

  describe('getTotalNetPaidUSD', () => {
    it('should return aggregated USD total across all tokens', async () => {
      publicClient.readContract.mockResolvedValue(1500000000000000000n); // 1.5 USD in 18-decimal

      const result = await getTotalNetPaidUSD(
        publicClient, TEST_ADDRESSES,
        '0x1111111111111111111111111111111111111111' as `0x${string}`,
        '0x2222222222222222222222222222222222222222' as `0x${string}`,
      );

      expect(result).toBe(1500000000000000000n);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: REPUTATION_MODULE,
          functionName: 'getTotalNetPaidUSD',
          args: [
            '0x1111111111111111111111111111111111111111',
            '0x2222222222222222222222222222222222222222',
          ],
        }),
      );
    });

    it('should return 0 when no payments exist', async () => {
      publicClient.readContract.mockResolvedValue(0n);

      const result = await getTotalNetPaidUSD(
        publicClient, TEST_ADDRESSES,
        '0x1111111111111111111111111111111111111111' as `0x${string}`,
        '0x2222222222222222222222222222222222222222' as `0x${string}`,
      );

      expect(result).toBe(0n);
    });

    it('should throw when reputationModule is not deployed', async () => {
      const emptyAddresses = { ...TEST_ADDRESSES, reputationModule: '' as `0x${string}` };

      await expect(
        getTotalNetPaidUSD(
          publicClient, emptyAddresses,
          '0x1111111111111111111111111111111111111111' as `0x${string}`,
          '0x2222222222222222222222222222222222222222' as `0x${string}`,
        ),
      ).rejects.toThrow('reputationModule address not configured');
    });
  });

  describe('getActiveOpinion', () => {
    it('should return active opinion state for a rater->agent pair', async () => {
      publicClient.readContract.mockResolvedValue({ opinionIndex: 3n, exists: true });

      const result = await getActiveOpinion(
        publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 42n,
      );

      expect(result.opinionIndex).toBe(3n);
      expect(result.exists).toBe(true);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: REPUTATION_MODULE,
          functionName: 'getActiveOpinion',
          args: [TEST_ACCOUNT, 42n],
        }),
      );
    });

    it('should return exists=false when no opinion exists', async () => {
      publicClient.readContract.mockResolvedValue({ opinionIndex: 0n, exists: false });

      const result = await getActiveOpinion(
        publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 42n,
      );

      expect(result.opinionIndex).toBe(0n);
      expect(result.exists).toBe(false);
    });
  });

  describe('readOpinion', () => {
    it('should read an opinion entry from the registry', async () => {
      publicClient.readContract.mockResolvedValue([100n, 0, 'quality', 'x402', false]);

      const result = await readOpinion(publicClient, 'baseSepolia', 42n, TEST_ACCOUNT, 0n);

      expect(result.value).toBe(100n);
      expect(result.valueDecimals).toBe(0);
      expect(result.tag1).toBe('quality');
      expect(result.tag2).toBe('x402');
      expect(result.isRevoked).toBe(false);
    });

    it('should handle revoked opinion', async () => {
      publicClient.readContract.mockResolvedValue([100n, 0, 'quality', '', true]);

      const result = await readOpinion(publicClient, 'baseSepolia', 42n, TEST_ACCOUNT, 0n);

      expect(result.isRevoked).toBe(true);
    });
  });
});
