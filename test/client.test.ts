import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createMockResponse, TEST_SMART_ACCOUNT } from './fixtures/mocks.js';

// Mock XMTPClient at the module level (correct boundary for AzethKit tests).
// The actual @xmtp/agent-sdk is tested in xmtp.test.ts.
const mockXmtpSendMessage = vi.fn().mockResolvedValue('conv-123');
const mockXmtpOnMessage = vi.fn().mockReturnValue(() => {});
const mockXmtpDestroy = vi.fn().mockResolvedValue(undefined);
const mockXmtpIsReady = vi.fn().mockReturnValue(false);
const mockXmtpInitialize = vi.fn().mockImplementation(function (this: { _ready: boolean }) {
  this._ready = true;
  mockXmtpIsReady.mockReturnValue(true);
  return Promise.resolve();
});

vi.mock('../src/messaging/xmtp.js', () => ({
  XMTPClient: vi.fn().mockImplementation(() => ({
    initialize: mockXmtpInitialize,
    sendMessage: mockXmtpSendMessage,
    onMessage: mockXmtpOnMessage,
    canReach: vi.fn().mockResolvedValue(true),
    getConversations: vi.fn().mockResolvedValue([]),
    isReady: mockXmtpIsReady,
    destroy: mockXmtpDestroy,
    setRouter: vi.fn(),
  })),
}));

// Mock viem modules
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBalance: vi.fn().mockResolvedValue(1000000000000000000n),
      readContract: vi.fn().mockImplementation((params: { functionName: string }) => {
        // Return appropriate mock data based on the function being called
        if (params.functionName === 'getAccountsByOwner') {
          return Promise.resolve([TEST_SMART_ACCOUNT]);
        }
        if (params.functionName === 'isAzethAccount') {
          return Promise.resolve(true);
        }
        if (params.functionName === 'getOwnerOf') {
          return Promise.resolve('0x1111111111111111111111111111111111111111');
        }
        if (params.functionName === 'checkOperation') {
          // Return OK (reason=0) with mock details
          return Promise.resolve([0, {
            usdValue: 1000_000000_000000_000000n,
            dailySpentUSD: 0n,
            maxTxAmountUSD: 2000_000000_000000_000000n,
            dailySpendLimitUSD: 10000_000000_000000_000000n,
            targetWhitelisted: true,
            oracleStale: false,
          }]);
        }
        return Promise.resolve(0n);
      }),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success', logs: [] }),
      getBlockNumber: vi.fn().mockResolvedValue(1000n),
      getBlock: vi.fn().mockResolvedValue({ number: 1000n, timestamp: 1700000000n }),
      chain: { id: 84532 },
    })),
    createWalletClient: vi.fn(() => ({
      writeContract: vi.fn().mockResolvedValue('0xabc' as `0x${string}`),
      sendTransaction: vi.fn().mockResolvedValue('0xdef' as `0x${string}`),
      signMessage: vi.fn().mockResolvedValue('0xsig' as `0x${string}`),
      signTypedData: vi.fn().mockResolvedValue('0xtsig' as `0x${string}`),
      account: { address: '0x1111111111111111111111111111111111111111' as `0x${string}` },
      chain: { id: 84532 },
    })),
    http: vi.fn(),
    encodeFunctionData: vi.fn().mockReturnValue('0xmockencoded'),
    formatEther: vi.fn((v: bigint) => (Number(v) / 1e18).toString()),
    formatUnits: vi.fn((v: bigint, d: number) => (Number(v) / Math.pow(10, d)).toString()),
  };
});

vi.mock('viem/chains', () => ({
  base: { id: 8453, name: 'Base' },
  baseSepolia: { id: 84532, name: 'Base Sepolia' },
  sepolia: { id: 11155111, name: 'Sepolia' },
  mainnet: { id: 1, name: 'Ethereum' },
}));

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  })),
}));

// Mock the UserOp utility to avoid hitting real bundler/permissionless in unit tests.
// The SmartAccountClient is mocked with sendTransaction returning a dummy tx hash.
vi.mock('../src/utils/userop.js', () => ({
  createAzethSmartAccountClient: vi.fn().mockResolvedValue({
    sendTransaction: vi.fn().mockResolvedValue('0xabc' as `0x${string}`),
    writeContract: vi.fn().mockResolvedValue('0xabc' as `0x${string}`),
    account: { address: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' as `0x${string}` },
    chain: { id: 84532 },
  }),
}));

vi.mock(import('@azeth/common'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    SUPPORTED_CHAINS: {
      base: { id: 8453, name: 'Base', rpcDefault: 'https://mainnet.base.org' },
      baseSepolia: { id: 84532, name: 'Base Sepolia', rpcDefault: 'https://sepolia.base.org' },
    },
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
    TOKENS: {
      baseSepolia: { USDC: '' as `0x${string}`, WETH: '' as `0x${string}` },
      base: {
        USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
        WETH: '0x4200000000000000000000000000000000000006' as `0x${string}`,
      },
    },
    ERC8004_REPUTATION_REGISTRY: {
      baseSepolia: '0x8004B663056A597Dffe9eCcC1965A193B7388713' as `0x${string}`,
      base: '' as `0x${string}`,
    },
  };
});

vi.mock('@azeth/common/abis', () => ({
  AzethFactoryAbi: [],
  AzethAccountAbi: [],
  GuardianModuleAbi: [],
  TrustRegistryModuleAbi: [],
  PaymentAgreementModuleAbi: [],
  ReputationModuleAbi: [],
  ERC8004ReputationRegistryAbi: [],
}));

// Dynamic import AFTER all mocks are registered to ensure mock propagation
const { AzethKit } = await import('../src/client.js');
type AzethKitConfig = import('../src/client.js').AzethKitConfig;

describe('AzethKit client', () => {
  const TEST_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as `0x${string}`;
  const originalFetch = globalThis.fetch;

  afterEach(async () => {
    globalThis.fetch = originalFetch;
  });

  const defaultConfig: AzethKitConfig = {
    privateKey: TEST_PRIVATE_KEY,
    chain: 'baseSepolia',
    budget: { enforce: false },
  };

  describe('create', () => {
    it('should create an AzethKit instance', async () => {
      const kit = await AzethKit.create(defaultConfig);

      expect(kit).toBeInstanceOf(AzethKit);
      expect(kit.address).toBe('0x1111111111111111111111111111111111111111');
      expect(kit.chainName).toBe('baseSepolia');
      expect(kit.publicClient).toBeDefined();
    });

    it('should resolve addresses from chain defaults', async () => {
      const kit = await AzethKit.create(defaultConfig);

      expect(kit.addresses).toBeDefined();
      expect(kit.addresses.factory).toBe('0x6666666666666666666666666666666666666666');
      expect(kit.addresses.reputationModule).toBe('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    });

    it('should accept contractAddresses overrides', async () => {
      const customFactory = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as `0x${string}`;
      const kit = await AzethKit.create({
        ...defaultConfig,
        contractAddresses: { factory: customFactory },
      });

      expect(kit.addresses.factory).toBe(customFactory);
      // Other addresses should come from chain defaults
      expect(kit.addresses.guardianModule).toBe('0x7777777777777777777777777777777777777777');
    });

    it('should use default server URL', async () => {
      const kit = await AzethKit.create(defaultConfig);

      expect(kit.serverUrl).toBe('https://api.azeth.ai');
    });

    it('should use custom server URL when provided', async () => {
      const kit = await AzethKit.create({
        ...defaultConfig,
        serverUrl: 'https://custom.azeth.ai',
      });

      expect(kit.serverUrl).toBe('https://custom.azeth.ai');
    });

    // TODO: Switch to chain: 'base' (no overrides) once mainnet contracts are deployed
    it('should accept base chain with contract overrides', async () => {
      const kit = await AzethKit.create({
        ...defaultConfig,
        chain: 'base',
        contractAddresses: {
          factory: '0x0000000000000000000000000000000000000001' as `0x${string}`,
          guardianModule: '0x0000000000000000000000000000000000000002' as `0x${string}`,
          trustRegistryModule: '0x0000000000000000000000000000000000000003' as `0x${string}`,
          paymentAgreementModule: '0x0000000000000000000000000000000000000004' as `0x${string}`,
          reputationModule: '0x0000000000000000000000000000000000000005' as `0x${string}`,
        },
      });

      expect(kit.chainName).toBe('base');
    });

    it('should throw when base chain has no deployed contracts and no overrides', async () => {
      await expect(
        AzethKit.create({ ...defaultConfig, chain: 'base' }),
      ).rejects.toThrow('not yet deployed on base');
    });
  });

  describe('method delegation', () => {
    let kit: AzethKit;

    beforeEach(async () => {
      kit = await AzethKit.create(defaultConfig);
    });

    afterEach(async () => {
      await kit.destroy();
    });

    it('should delegate transfer() to the transfer module', async () => {
      const result = await kit.transfer({
        to: '0x2222222222222222222222222222222222222222' as `0x${string}`,
        amount: 100n,
      });

      expect(result).toBeDefined();
      expect(result.txHash).toBeDefined();
    });

    it('should delegate getBalance() to the balance module', async () => {
      const result = await kit.getBalance();

      expect(result).toBeDefined();
      expect(typeof result.eth).toBe('bigint');
      expect(result.eoa).toBeDefined();
      expect(typeof result.eoa.eth).toBe('bigint');
    });

    it('should delegate getHistory() to the history module', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, []));

      const result = await kit.getHistory();

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should delegate discoverServices() to the discover module', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, []));

      const result = await kit.discoverServices({ capability: 'test' });

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should delegate fetch402() to the x402 module', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: 'ok' }));

      const result = await kit.fetch402('https://api.example.com/data');

      expect(result).toBeDefined();
      expect(result.paymentMade).toBe(false);
    });

    it('should delegate publishService() to the register module', async () => {
      const result = await kit.publishService({
        name: 'TestService',
        description: 'A test service',
        entityType: 'service',
        capabilities: ['test'],
      });

      expect(result).toBeDefined();
      expect(result.txHash).toBeDefined();
    });

    it('should delegate createPaymentAgreement() to the agreements module', async () => {
      const result = await kit.createPaymentAgreement({
        payee: '0x2222222222222222222222222222222222222222' as `0x${string}`,
        token: '0x4444444444444444444444444444444444444444' as `0x${string}`,
        amount: 1000000n,
        interval: 86400,
      });

      expect(result).toBeDefined();
      expect(result.txHash).toBeDefined();
    });

    it('should delegate sendMessage() through XMTPClient', async () => {
      const convId = await kit.sendMessage({
        to: '0x2222222222222222222222222222222222222222' as `0x${string}`,
        content: 'Hello!',
      });

      // The XMTP client should have been initialized and message sent
      expect(mockXmtpInitialize).toHaveBeenCalled();
      expect(mockXmtpSendMessage).toHaveBeenCalledWith({
        to: '0x2222222222222222222222222222222222222222',
        content: 'Hello!',
      });
      expect(convId).toBe('conv-123');
    });

    it('should delegate onMessage() through XMTPClient', () => {
      const handler = vi.fn().mockResolvedValue(undefined);
      const unsubscribe = kit.onMessage(handler);

      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    });
  });

  describe('smart account tracking', () => {
    it('should have null smartAccount before resolution', async () => {
      const kit = await AzethKit.create(defaultConfig);
      // smartAccount is null before any resolution (getSmartAccounts hasn't been called yet in the mock)
      // Actually with mocked readContract, resolveSmartAccount should work
      expect(kit.smartAccount).toBeNull();
      await kit.destroy();
    });

    it('should resolve smart account from factory', async () => {
      const kit = await AzethKit.create(defaultConfig);
      const account = await kit.resolveSmartAccount();

      expect(account).toBe(TEST_SMART_ACCOUNT);
      expect(kit.smartAccount).toBe(TEST_SMART_ACCOUNT);
      await kit.destroy();
    });

    it('should cache resolved smart accounts', async () => {
      const kit = await AzethKit.create(defaultConfig);
      const first = await kit.resolveSmartAccount();
      const second = await kit.resolveSmartAccount();

      expect(first).toBe(second);
      expect(first).toBe(TEST_SMART_ACCOUNT);
      await kit.destroy();
    });

    it('should return all smart accounts via getSmartAccounts', async () => {
      const kit = await AzethKit.create(defaultConfig);
      const accounts = await kit.getSmartAccounts();

      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toBe(TEST_SMART_ACCOUNT);
      await kit.destroy();
    });
  });

  describe('deposit', () => {
    let kit: AzethKit;

    beforeEach(async () => {
      kit = await AzethKit.create(defaultConfig);
    });

    afterEach(async () => {
      await kit.destroy();
    });

    it('should delegate deposit() to the deposit module', async () => {
      const result = await kit.deposit({
        to: TEST_SMART_ACCOUNT,
        amount: 100n,
      });

      expect(result).toBeDefined();
      expect(result.txHash).toBeDefined();
    });

    it('should reject deposit with zero amount', async () => {
      await expect(
        kit.deposit({ to: TEST_SMART_ACCOUNT, amount: 0n }),
      ).rejects.toThrow('Deposit amount must be positive');
    });

    it('should auto-resolve smart account for depositToSelf', async () => {
      const result = await kit.depositToSelf({ amount: 100n });

      expect(result).toBeDefined();
      expect(result.to).toBe(TEST_SMART_ACCOUNT);
    });
  });

  describe('getSignedFetch', () => {
    it('should return a function', async () => {
      const kit = await AzethKit.create(defaultConfig);
      const signedFetch = kit.getSignedFetch();

      expect(typeof signedFetch).toBe('function');
    });
  });

  describe('destroy', () => {
    it('should clean up messaging client', async () => {
      const kit = await AzethKit.create(defaultConfig);

      // Initialize messaging by calling onMessage
      const unsub = kit.onMessage(vi.fn().mockResolvedValue(undefined));
      unsub();

      // Should not throw
      await expect(kit.destroy()).resolves.not.toThrow();
    });

    it('should be safe to call destroy without messaging', async () => {
      const kit = await AzethKit.create(defaultConfig);

      await expect(kit.destroy()).resolves.not.toThrow();
    });

    it('should be safe to call destroy multiple times', async () => {
      const kit = await AzethKit.create(defaultConfig);

      await kit.destroy();
      await expect(kit.destroy()).resolves.not.toThrow();
    });
  });
});
