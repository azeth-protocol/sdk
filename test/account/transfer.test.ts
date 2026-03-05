import { describe, it, expect, vi, beforeEach } from 'vitest';
import { transfer } from '../../src/account/transfer.js';
import {
  createMockSmartAccountClient,
  createMockPublicClient,
  TEST_SMART_ACCOUNT,
  TEST_RECIPIENT,
  TEST_TOKEN,
  TEST_TX_HASH,
  TEST_ADDRESSES,
} from '../fixtures/mocks.js';

vi.mock('@azeth/common/abis', () => ({
  AzethAccountAbi: [],
  GuardianModuleAbi: [],
}));

describe('account/transfer', () => {
  let smartAccountClient: ReturnType<typeof createMockSmartAccountClient>;

  beforeEach(() => {
    smartAccountClient = createMockSmartAccountClient();
    vi.clearAllMocks();
  });

  describe('ETH transfers via UserOp', () => {
    it('should send ETH via SmartAccountClient.sendTransaction()', async () => {
      const amount = 1000000000000000000n; // 1 ETH

      const result = await transfer(smartAccountClient, TEST_SMART_ACCOUNT, {
        to: TEST_RECIPIENT,
        amount,
      });

      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(result.from).toBe(TEST_SMART_ACCOUNT);
      expect(result.to).toBe(TEST_RECIPIENT);
      expect(result.amount).toBe(amount);
      expect(result.token).toBe('ETH');
      // Calls sendTransaction on the SmartAccountClient (UserOp-based)
      expect(smartAccountClient.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: TEST_RECIPIENT,
          value: amount,
          data: '0x',
        }),
      );
    });

    it('should propagate execute errors', async () => {
      smartAccountClient.sendTransaction.mockRejectedValue(new Error('Insufficient funds'));

      await expect(
        transfer(smartAccountClient, TEST_SMART_ACCOUNT, {
          to: TEST_RECIPIENT,
          amount: 999999999999999999999n,
        }),
      ).rejects.toThrow('Insufficient funds');
    });
  });

  describe('ERC-20 transfers via UserOp', () => {
    it('should send tokens via SmartAccountClient.sendTransaction()', async () => {
      const amount = 1000000n; // 1 USDC

      const result = await transfer(smartAccountClient, TEST_SMART_ACCOUNT, {
        to: TEST_RECIPIENT,
        token: TEST_TOKEN,
        amount,
      });

      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(result.from).toBe(TEST_SMART_ACCOUNT);
      expect(result.token).toBe(TEST_TOKEN);
      // Should call sendTransaction with the token address as `to` and encoded transfer data
      expect(smartAccountClient.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: TEST_TOKEN,
          value: 0n,
          data: expect.any(String),
        }),
      );
    });

    it('should propagate execute errors for token transfers', async () => {
      smartAccountClient.sendTransaction.mockRejectedValue(new Error('ERC20: transfer amount exceeds balance'));

      await expect(
        transfer(smartAccountClient, TEST_SMART_ACCOUNT, {
          to: TEST_RECIPIENT,
          token: TEST_TOKEN,
          amount: 999999999999n,
        }),
      ).rejects.toThrow('ERC20: transfer amount exceeds balance');
    });
  });

  describe('zero and negative amount validation', () => {
    it('should reject zero ETH transfer', async () => {
      await expect(
        transfer(smartAccountClient, TEST_SMART_ACCOUNT, {
          to: TEST_RECIPIENT,
          amount: 0n,
        }),
      ).rejects.toThrow('Transfer amount must be greater than zero');
    });

    it('should reject zero token transfer', async () => {
      await expect(
        transfer(smartAccountClient, TEST_SMART_ACCOUNT, {
          to: TEST_RECIPIENT,
          token: TEST_TOKEN,
          amount: 0n,
        }),
      ).rejects.toThrow('Transfer amount must be greater than zero');
    });

    it('should reject negative amounts', async () => {
      await expect(
        transfer(smartAccountClient, TEST_SMART_ACCOUNT, {
          to: TEST_RECIPIENT,
          amount: -1n,
        }),
      ).rejects.toThrow('Transfer amount must be greater than zero');
    });
  });

  describe('pre-flight guardrail check', () => {
    let publicClient: ReturnType<typeof createMockPublicClient>;

    /** Build a mock checkOperation response tuple */
    function mockCheckResult(reason: number, overrides: Partial<{
      usdValue: bigint; dailySpentUSD: bigint; maxTxAmountUSD: bigint;
      dailySpendLimitUSD: bigint; targetWhitelisted: boolean; oracleStale: boolean;
    }> = {}) {
      return [
        reason,
        {
          usdValue: overrides.usdValue ?? 1000_000000_000000_000000n,
          dailySpentUSD: overrides.dailySpentUSD ?? 0n,
          maxTxAmountUSD: overrides.maxTxAmountUSD ?? 2000_000000_000000_000000n,
          dailySpendLimitUSD: overrides.dailySpendLimitUSD ?? 10000_000000_000000_000000n,
          targetWhitelisted: overrides.targetWhitelisted ?? true,
          oracleStale: overrides.oracleStale ?? false,
        },
      ];
    }

    beforeEach(() => {
      publicClient = createMockPublicClient();
    });

    it('should pass pre-flight when reason is OK (0)', async () => {
      publicClient.readContract.mockResolvedValue(mockCheckResult(0));

      const result = await transfer(
        smartAccountClient, TEST_SMART_ACCOUNT,
        { to: TEST_RECIPIENT, amount: 1000000000000000000n },
        publicClient as never, TEST_ADDRESSES,
      );

      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({ functionName: 'checkOperation' }),
      );
    });

    it('should throw GUARDIAN_REJECTED when tx limit exceeded (reason 2)', async () => {
      publicClient.readContract.mockResolvedValue(mockCheckResult(2, {
        usdValue: 3000_000000_000000_000000n,
      }));

      await expect(
        transfer(
          smartAccountClient, TEST_SMART_ACCOUNT,
          { to: TEST_RECIPIENT, amount: 1500000000000000000n },
          publicClient as never, TEST_ADDRESSES,
        ),
      ).rejects.toThrow(/exceeds per-transaction limit/);
    });

    it('should throw GUARDIAN_REJECTED when daily limit exceeded (reason 3)', async () => {
      publicClient.readContract.mockResolvedValue(mockCheckResult(3, {
        usdValue: 2000_000000_000000_000000n,
        dailySpentUSD: 9000_000000_000000_000000n,
      }));

      await expect(
        transfer(
          smartAccountClient, TEST_SMART_ACCOUNT,
          { to: TEST_RECIPIENT, amount: 1000000000000000000n },
          publicClient as never, TEST_ADDRESSES,
        ),
      ).rejects.toThrow(/daily/i);
    });

    it('should throw GUARDIAN_REJECTED when target not whitelisted (reason 4)', async () => {
      publicClient.readContract.mockResolvedValue(mockCheckResult(4, {
        targetWhitelisted: false,
      }));

      await expect(
        transfer(
          smartAccountClient, TEST_SMART_ACCOUNT,
          { to: TEST_RECIPIENT, token: TEST_TOKEN, amount: 1000000n },
          publicClient as never, TEST_ADDRESSES,
        ),
      ).rejects.toThrow(/not.*whitelist/i);
    });

    it('should throw GUARDIAN_REJECTED when oracle is stale (reason 5)', async () => {
      publicClient.readContract.mockResolvedValue(mockCheckResult(5, {
        oracleStale: true,
      }));

      await expect(
        transfer(
          smartAccountClient, TEST_SMART_ACCOUNT,
          { to: TEST_RECIPIENT, amount: 1000000000000000000n },
          publicClient as never, TEST_ADDRESSES,
        ),
      ).rejects.toThrow(/oracle.*stale/i);
    });

    it('should skip pre-flight when publicClient is not provided', async () => {
      // Existing behavior: no pre-flight, just send
      const result = await transfer(
        smartAccountClient, TEST_SMART_ACCOUNT,
        { to: TEST_RECIPIENT, amount: 1000000000000000000n },
      );
      expect(result.txHash).toBe(TEST_TX_HASH);
    });

    it('should include error details in GUARDIAN_REJECTED error', async () => {
      publicClient.readContract.mockResolvedValue(mockCheckResult(2, {
        usdValue: 5000_000000_000000_000000n,
        maxTxAmountUSD: 2000_000000_000000_000000n,
      }));

      try {
        await transfer(
          smartAccountClient, TEST_SMART_ACCOUNT,
          { to: TEST_RECIPIENT, amount: 2500000000000000000n },
          publicClient as never, TEST_ADDRESSES,
        );
        expect.fail('Should have thrown');
      } catch (err: unknown) {
        const azethErr = err as { code: string; details: Record<string, unknown> };
        expect(azethErr.code).toBe('GUARDIAN_REJECTED');
        expect(azethErr.details).toHaveProperty('reason', 'EXCEEDS_TX_LIMIT');
        expect(azethErr.details).toHaveProperty('usdValue');
        expect(azethErr.details).toHaveProperty('maxTxAmountUSD');
      }
    });
  });
});
