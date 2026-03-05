import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { registerOnRegistry, updateMetadata, buildAgentURI } from '../../src/registry/register.js';
import {
  createMockPublicClient,
  createMockSmartAccountClient,
  TEST_ACCOUNT,
  TEST_TX_HASH,
  TEST_MODULE,
  TEST_ADDRESSES,
} from '../fixtures/mocks.js';

/** M-4: Compute the correct event topic for test matching */
const REGISTERED_EVENT_TOPIC = keccak256(toBytes('Registered(address,uint256,string)'));

vi.mock('@azeth/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@azeth/common')>();
  return {
    ...actual,
    AZETH_CONTRACTS: {
      baseSepolia: {
        factory: '0x6666666666666666666666666666666666666666' as `0x${string}`,
        guardianModule: '0x7777777777777777777777777777777777777777' as `0x${string}`,
        trustRegistryModule: '0x5555555555555555555555555555555555555555' as `0x${string}`,
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
  };
});

vi.mock('@azeth/common/abis', () => ({
  AzethAccountAbi: [],
  AzethFactoryAbi: [],
  GuardianModuleAbi: [],
  TrustRegistryModuleAbi: [],
  PaymentAgreementModuleAbi: [],
  ReputationModuleAbi: [],
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

describe('registry/register', () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let smartAccountClient: ReturnType<typeof createMockSmartAccountClient>;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    smartAccountClient = createMockSmartAccountClient();
    vi.clearAllMocks();
  });

  describe('registerOnRegistry', () => {
    it('should register on the trust registry and return tokenId', async () => {
      const tokenIdHex = '0x0000000000000000000000000000000000000000000000000000000000000042';
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          {
            address: TEST_MODULE,
            topics: [
              REGISTERED_EVENT_TOPIC,
              '0x' + TEST_ACCOUNT.slice(2).padStart(64, '0'),
              tokenIdHex,
            ],
            data: '0x',
          },
        ],
      });

      const result = await registerOnRegistry(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
        name: 'TestAgent',
        description: 'A test agent',
        entityType: 'agent',
        capabilities: ['data-analysis', 'prediction'],
        endpoint: 'https://agent.example.com',
      });

      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(result.tokenId).toBe(66n); // 0x42 = 66
      // Should route through smart account via sendTransaction (UserOp)
      expect(smartAccountClient.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: TEST_MODULE,
          value: 0n,
          data: expect.any(String),
        }),
      );
    });

    it('should build correct agentURI with metadata', () => {
      const agentURI = buildAgentURI({
        name: 'MyService',
        description: 'Service description',
        entityType: 'service',
        capabilities: ['api-gateway'],
        endpoint: 'https://service.example.com',
      });

      expect(agentURI).toContain('data:application/json,');
      const decoded = JSON.parse(decodeURIComponent(agentURI.replace('data:application/json,', '')));
      expect(decoded.name).toBe('MyService');
      expect(decoded.entityType).toBe('service');
      expect(decoded.capabilities).toEqual(['api-gateway']);
      expect(decoded.endpoint).toBe('https://service.example.com');
      expect(decoded.version).toBe('0.1.0');
    });

    it('should handle registration without endpoint', () => {
      const agentURI = buildAgentURI({
        name: 'Agent',
        description: 'No endpoint agent',
        entityType: 'agent',
        capabilities: [],
      });

      const decoded = JSON.parse(decodeURIComponent(agentURI.replace('data:application/json,', '')));
      expect(decoded.endpoint).toBe('');
    });

    it('should return tokenId 0 when no matching log found', async () => {
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [],
      });

      const result = await registerOnRegistry(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
        name: 'Agent',
        description: 'Test',
        entityType: 'agent',
        capabilities: [],
      });

      expect(result.tokenId).toBe(0n);
    });

    it('should propagate contract errors', async () => {
      smartAccountClient.sendTransaction.mockRejectedValue(new Error('AlreadyRegistered'));

      await expect(
        registerOnRegistry(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
          name: 'Agent',
          description: 'Test',
          entityType: 'agent',
          capabilities: [],
        }),
      ).rejects.toThrow('AlreadyRegistered');
    });
  });

  describe('updateMetadata', () => {
    it('should route through smart account sendTransaction', async () => {
      const txHash = await updateMetadata(
        publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT,
        'description', 'Updated description',
      );

      expect(txHash).toBe(TEST_TX_HASH);
      // Should route through smart account via sendTransaction (UserOp)
      expect(smartAccountClient.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: TEST_MODULE,
          value: 0n,
          data: expect.any(String),
        }),
      );
    });

    it('should wait for transaction receipt', async () => {
      await updateMetadata(
        publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT,
        'key', 'value',
      );

      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TEST_TX_HASH, timeout: 120_000 });
    });
  });
});
