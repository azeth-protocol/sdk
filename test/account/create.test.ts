import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createAccount, getAccountAddress } from '../../src/account/create.js';
import {
  createMockPublicClient,
  createMockWalletClient,
  TEST_OWNER,
  TEST_ACCOUNT,
  TEST_RECIPIENT,
  TEST_TX_HASH,
  TEST_SALT,
  TEST_ADDRESSES,
} from '../fixtures/mocks.js';

// Mock @azeth/common modules
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
  };
});

vi.mock('@azeth/common/abis', () => ({
  AzethFactoryAbi: [],
  AzethAccountAbi: [],
  GuardianModuleAbi: [],
  TrustRegistryModuleAbi: [],
  PaymentAgreementModuleAbi: [],
  ReputationModuleAbi: [],
}));

describe('account/create', () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
    vi.clearAllMocks();
  });

  /** Helper: mock readContract to route by functionName */
  function mockReadContract(
    pub: ReturnType<typeof createMockPublicClient>,
    overrides: Record<string, unknown> = {},
  ) {
    const defaults: Record<string, unknown> = {
      getAccountsByOwner: [],  // no existing accounts → salt index 0
      getAddress: TEST_ACCOUNT,
      ...overrides,
    };
    pub.readContract.mockImplementation((args: any) => {
      const fn = args?.functionName ?? '';
      if (fn in defaults) return Promise.resolve(defaults[fn]);
      return Promise.resolve(0n);
    });
  }

  describe('createAccount', () => {
    it('should deploy a smart account via the factory', async () => {
      mockReadContract(publicClient);
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [],
      });

      const result = await createAccount(publicClient, walletClient, TEST_ADDRESSES, {
        owner: TEST_OWNER,
        guardrails: {
          maxTxAmountUSD: 1000000n,
          dailySpendLimitUSD: 5000000n,
          guardianMaxTxAmountUSD: 10000000n,
          guardianDailySpendLimitUSD: 50000000n,
          guardian: TEST_OWNER,
          emergencyWithdrawTo: TEST_OWNER,
        },
      });

      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(result.account).toBe(TEST_ACCOUNT);
      expect(walletClient.writeContract).toHaveBeenCalledOnce();
      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TEST_TX_HASH, timeout: 120_000 });
    });

    it('should use provided salt', async () => {
      const customSalt = ('0x' + 'ff'.repeat(32)) as `0x${string}`;
      mockReadContract(publicClient);

      await createAccount(publicClient, walletClient, TEST_ADDRESSES, {
        owner: TEST_OWNER,
        salt: customSalt,
        guardrails: {
          maxTxAmountUSD: 1000000n,
          dailySpendLimitUSD: 5000000n,
          guardianMaxTxAmountUSD: 10000000n,
          guardianDailySpendLimitUSD: 50000000n,
          guardian: TEST_OWNER,
          emergencyWithdrawTo: TEST_OWNER,
        },
      });

      const writeArgs = walletClient.writeContract.mock.calls[0][0] as any;
      expect(writeArgs.args[1]).toBe(customSalt);
    });

    it('should use salt index 0 when no accounts exist', async () => {
      mockReadContract(publicClient, { getAccountsByOwner: [] });

      await createAccount(publicClient, walletClient, TEST_ADDRESSES, {
        owner: TEST_OWNER,
        guardrails: {
          maxTxAmountUSD: 1000000n,
          dailySpendLimitUSD: 5000000n,
          guardianMaxTxAmountUSD: 10000000n,
          guardianDailySpendLimitUSD: 50000000n,
          guardian: TEST_OWNER,
          emergencyWithdrawTo: TEST_OWNER,
        },
      });

      const writeArgs = walletClient.writeContract.mock.calls[0][0] as any;
      expect(writeArgs.args[1]).toBe(TEST_SALT); // index 0 = all zeros
    });

    it('should auto-increment salt when accounts already exist', async () => {
      // Simulate 2 existing accounts → next salt should be index 2
      mockReadContract(publicClient, {
        getAccountsByOwner: [TEST_ACCOUNT, TEST_RECIPIENT],
      });

      await createAccount(publicClient, walletClient, TEST_ADDRESSES, {
        owner: TEST_OWNER,
        guardrails: {
          maxTxAmountUSD: 1000000n,
          dailySpendLimitUSD: 5000000n,
          guardianMaxTxAmountUSD: 10000000n,
          guardianDailySpendLimitUSD: 50000000n,
          guardian: TEST_OWNER,
          emergencyWithdrawTo: TEST_OWNER,
        },
      });

      const writeArgs = walletClient.writeContract.mock.calls[0][0] as any;
      const salt = writeArgs.args[1] as string;
      // Salt should be padded hex of 2
      expect(salt).toBe('0x0000000000000000000000000000000000000000000000000000000000000002');
    });

    it('should throw when factory is not deployed (empty address)', async () => {
      const emptyAddresses = { ...TEST_ADDRESSES, factory: '' as `0x${string}` };

      await expect(
        createAccount(publicClient, walletClient, emptyAddresses, {
          owner: TEST_OWNER,
          guardrails: {
            maxTxAmountUSD: 1000000n,
            dailySpendLimitUSD: 5000000n,
            guardianMaxTxAmountUSD: 10000000n,
            guardianDailySpendLimitUSD: 50000000n,
            guardian: TEST_OWNER,
            emergencyWithdrawTo: TEST_OWNER,
            },
        }),
      ).rejects.toThrow('factory address not configured');
    });

    it('should throw when transaction is reverted', async () => {
      mockReadContract(publicClient);
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'reverted',
        logs: [],
      });

      await expect(
        createAccount(publicClient, walletClient, TEST_ADDRESSES, {
          owner: TEST_OWNER,
          guardrails: {
            maxTxAmountUSD: 1000000n,
            dailySpendLimitUSD: 5000000n,
            guardianMaxTxAmountUSD: 10000000n,
            guardianDailySpendLimitUSD: 50000000n,
            guardian: TEST_OWNER,
            emergencyWithdrawTo: TEST_OWNER,
            },
        }),
      ).rejects.toThrow('Transaction reverted');
    });

    it('should fallback to readContract when event parsing fails', async () => {
      const expectedAccount = '0xAAAABBBBCCCCDDDDEEEEFFFF0000111122223333' as `0x${string}`;
      mockReadContract(publicClient, { getAddress: expectedAccount });

      const result = await createAccount(publicClient, walletClient, TEST_ADDRESSES, {
        owner: TEST_OWNER,
        guardrails: {
          maxTxAmountUSD: 1000000n,
          dailySpendLimitUSD: 5000000n,
          guardianMaxTxAmountUSD: 10000000n,
          guardianDailySpendLimitUSD: 50000000n,
          guardian: TEST_OWNER,
          emergencyWithdrawTo: TEST_OWNER,
        },
      });

      expect(result.account).toBe(expectedAccount);
      expect(result.tokenId).toBe(0n);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'getAddress',
        }),
      );
    });
  });

  describe('getAccountAddress', () => {
    it('should compute deterministic address without deploying', async () => {
      publicClient.readContract.mockResolvedValue(TEST_ACCOUNT);

      const address = await getAccountAddress(publicClient, TEST_ADDRESSES, TEST_OWNER, TEST_SALT);

      expect(address).toBe(TEST_ACCOUNT);
      expect(walletClient.writeContract).not.toHaveBeenCalled();
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'getAddress',
          args: [TEST_OWNER, TEST_SALT],
        }),
      );
    });

    it('should use the correct factory address', async () => {
      publicClient.readContract.mockResolvedValue(TEST_ACCOUNT);

      await getAccountAddress(publicClient, TEST_ADDRESSES, TEST_OWNER, TEST_SALT);

      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: '0x6666666666666666666666666666666666666666',
        }),
      );
    });
  });
});
