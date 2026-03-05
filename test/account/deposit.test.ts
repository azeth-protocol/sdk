import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deposit, validateDepositTarget } from '../../src/account/deposit.js';
import {
  createMockPublicClient,
  createMockWalletClient,
  TEST_OWNER,
  TEST_SMART_ACCOUNT,
  TEST_TOKEN,
  TEST_TX_HASH,
  TEST_ADDRESSES,
} from '../fixtures/mocks.js';

vi.mock('@azeth/common/abis', () => ({
  AzethFactoryAbi: [],
}));

describe('account/deposit', () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
    vi.clearAllMocks();
  });

  describe('validateDepositTarget', () => {
    it('should succeed for valid owned account', async () => {
      publicClient.readContract
        .mockResolvedValueOnce(true) // isAzethAccount
        .mockResolvedValueOnce(TEST_OWNER); // getOwnerOf

      await expect(
        validateDepositTarget(publicClient, TEST_ADDRESSES, TEST_OWNER, TEST_SMART_ACCOUNT),
      ).resolves.not.toThrow();
    });

    it('should reject non-Azeth account', async () => {
      publicClient.readContract
        .mockResolvedValueOnce(false); // isAzethAccount = false

      await expect(
        validateDepositTarget(publicClient, TEST_ADDRESSES, TEST_OWNER, TEST_SMART_ACCOUNT),
      ).rejects.toThrow('Target is not a valid Azeth smart account');
    });

    it('should reject account not owned by depositor', async () => {
      const otherOwner = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`;
      publicClient.readContract
        .mockResolvedValueOnce(true) // isAzethAccount
        .mockResolvedValueOnce(otherOwner); // getOwnerOf = different address

      await expect(
        validateDepositTarget(publicClient, TEST_ADDRESSES, TEST_OWNER, TEST_SMART_ACCOUNT),
      ).rejects.toThrow('Cannot deposit to a smart account you do not own');
    });

    it('should handle case-insensitive address comparison', async () => {
      const mixedCaseOwner = '0x1111111111111111111111111111111111111111' as `0x${string}`;
      const upperCaseOwner = '0x1111111111111111111111111111111111111111' as `0x${string}`;
      publicClient.readContract
        .mockResolvedValueOnce(true) // isAzethAccount
        .mockResolvedValueOnce(upperCaseOwner); // getOwnerOf

      await expect(
        validateDepositTarget(publicClient, TEST_ADDRESSES, mixedCaseOwner, TEST_SMART_ACCOUNT),
      ).resolves.not.toThrow();
    });
  });

  describe('deposit ETH', () => {
    it('should deposit ETH via sendTransaction', async () => {
      const amount = 100000000000000000n; // 0.1 ETH
      publicClient.readContract
        .mockResolvedValueOnce(true) // isAzethAccount
        .mockResolvedValueOnce(TEST_OWNER); // getOwnerOf

      const result = await deposit(publicClient, walletClient, TEST_ADDRESSES, TEST_OWNER, {
        to: TEST_SMART_ACCOUNT,
        amount,
      });

      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(result.from).toBe(TEST_OWNER);
      expect(result.to).toBe(TEST_SMART_ACCOUNT);
      expect(result.amount).toBe(amount);
      expect(result.token).toBe('ETH');
      expect(walletClient.sendTransaction).toHaveBeenCalledWith({
        to: TEST_SMART_ACCOUNT,
        value: amount,
      });
    });

    it('should wait for receipt', async () => {
      publicClient.readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(TEST_OWNER);

      await deposit(publicClient, walletClient, TEST_ADDRESSES, TEST_OWNER, {
        to: TEST_SMART_ACCOUNT,
        amount: 100n,
      });

      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TEST_TX_HASH, timeout: 120_000 });
    });
  });

  describe('deposit ERC-20', () => {
    it('should deposit tokens via writeContract', async () => {
      const amount = 1000000n; // 1 USDC
      publicClient.readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(TEST_OWNER);

      const result = await deposit(publicClient, walletClient, TEST_ADDRESSES, TEST_OWNER, {
        to: TEST_SMART_ACCOUNT,
        amount,
        token: TEST_TOKEN,
      });

      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(result.token).toBe(TEST_TOKEN);
      expect(walletClient.writeContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: TEST_TOKEN,
          functionName: 'transfer',
          args: [TEST_SMART_ACCOUNT, amount],
        }),
      );
    });
  });

  describe('validation', () => {
    it('should reject zero amount', async () => {
      await expect(
        deposit(publicClient, walletClient, TEST_ADDRESSES, TEST_OWNER, {
          to: TEST_SMART_ACCOUNT,
          amount: 0n,
        }),
      ).rejects.toThrow('Deposit amount must be positive');
    });

    it('should reject negative amount', async () => {
      await expect(
        deposit(publicClient, walletClient, TEST_ADDRESSES, TEST_OWNER, {
          to: TEST_SMART_ACCOUNT,
          amount: -1n,
        }),
      ).rejects.toThrow('Deposit amount must be positive');
    });

    it('should throw when transaction reverts', async () => {
      publicClient.readContract
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(TEST_OWNER);
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'reverted',
        logs: [],
      });

      await expect(
        deposit(publicClient, walletClient, TEST_ADDRESSES, TEST_OWNER, {
          to: TEST_SMART_ACCOUNT,
          amount: 100n,
        }),
      ).rejects.toThrow('Deposit transaction reverted');
    });
  });
});
