import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getBalance, getAllBalances } from '../../src/account/balance.js';
import { createMockPublicClient, TEST_SMART_ACCOUNT, TEST_OWNER, TEST_FACTORY } from '../fixtures/mocks.js';

vi.mock('@azeth/common', () => ({
  TOKENS: {
    baseSepolia: {
      USDC: '' as `0x${string}`,
      WETH: '' as `0x${string}`,
    },
    base: {
      USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
      WETH: '0x4200000000000000000000000000000000000006' as `0x${string}`,
    },
  },
  AzethError: class AzethError extends Error {
    code: string;
    details?: Record<string, unknown>;
    constructor(message: string, code: string, details?: Record<string, unknown>) {
      super(message);
      this.code = code;
      this.details = details;
    }
  },
  formatTokenAmount: (amount: bigint, decimals: number, maxFractionDigits?: number) => {
    const divisor = 10n ** BigInt(decimals);
    const whole = amount / divisor;
    const fraction = amount % divisor;
    if (fraction === 0n) return whole.toString();
    const fractionStr = fraction.toString().padStart(decimals, '0');
    const trimmed = maxFractionDigits !== undefined
      ? fractionStr.slice(0, maxFractionDigits)
      : fractionStr.replace(/0+$/, '');
    return `${whole}.${trimmed}`;
  },
  formatAddress: (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`,
}));

vi.mock('@azeth/common/abis', () => ({
  AzethFactoryAbi: [] as const,
}));

describe('account/balance', () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    vi.clearAllMocks();
  });

  describe('getBalance', () => {
    it('should return smart account ETH balance as primary', async () => {
      const ethBalance = 2500000000000000000n; // 2.5 ETH
      publicClient.getBalance.mockResolvedValue(ethBalance);

      const result = await getBalance(publicClient, 'baseSepolia', TEST_SMART_ACCOUNT, TEST_OWNER);

      expect(result.eth).toBe(ethBalance);
      expect(result.ethFormatted).toBe('2.5');
      // First call should be for smart account
      expect(publicClient.getBalance).toHaveBeenCalledWith({ address: TEST_SMART_ACCOUNT });
    });

    it('should return EOA ETH balance for gas management', async () => {
      const saBalance = 2500000000000000000n;
      const eoaBalance = 50000000000000000n; // 0.05 ETH
      publicClient.getBalance
        .mockResolvedValueOnce(saBalance)  // smart account
        .mockResolvedValueOnce(eoaBalance); // EOA

      const result = await getBalance(publicClient, 'baseSepolia', TEST_SMART_ACCOUNT, TEST_OWNER);

      expect(result.eth).toBe(saBalance);
      expect(result.eoa.eth).toBe(eoaBalance);
      expect(result.eoa.ethFormatted).toBe('0.05');
    });

    it('should return zero ETH balance', async () => {
      publicClient.getBalance.mockResolvedValue(0n);

      const result = await getBalance(publicClient, 'baseSepolia', TEST_SMART_ACCOUNT, TEST_OWNER);

      expect(result.eth).toBe(0n);
      expect(result.ethFormatted).toBe('0');
    });

    it('should return USDC balance when chain has USDC address', async () => {
      const usdcBalance = 1000000n; // 1 USDC (6 decimals)
      publicClient.getBalance.mockResolvedValue(0n);
      publicClient.readContract.mockResolvedValue(usdcBalance);

      const result = await getBalance(publicClient, 'base', TEST_SMART_ACCOUNT, TEST_OWNER);

      expect(result.usdc).toBe(usdcBalance);
      expect(result.usdcFormatted).toBe('1');
      expect(result.tokens['USDC']).toEqual({
        balance: usdcBalance,
        formatted: '1',
      });
    });

    it('should return WETH balance when chain has WETH address', async () => {
      const wethBalance = 500000000000000000n; // 0.5 WETH
      publicClient.getBalance.mockResolvedValue(0n);
      // First call = USDC, second call = WETH
      publicClient.readContract
        .mockResolvedValueOnce(0n)
        .mockResolvedValueOnce(wethBalance);

      const result = await getBalance(publicClient, 'base', TEST_SMART_ACCOUNT, TEST_OWNER);

      expect(result.tokens['WETH']).toEqual({
        balance: wethBalance,
        formatted: '0.5',
      });
    });

    it('should skip token balance when chain has empty token address', async () => {
      publicClient.getBalance.mockResolvedValue(1000000000000000000n);

      const result = await getBalance(publicClient, 'baseSepolia', TEST_SMART_ACCOUNT, TEST_OWNER);

      // baseSepolia has empty USDC and WETH addresses
      expect(result.usdc).toBe(0n);
      expect(result.tokens['USDC']).toBeUndefined();
      expect(result.tokens['WETH']).toBeUndefined();
      // readContract should not be called for empty token addresses
      expect(publicClient.readContract).not.toHaveBeenCalled();
    });

    it('should handle token contract read errors gracefully', async () => {
      publicClient.getBalance.mockResolvedValue(1000000000000000000n);
      publicClient.readContract.mockRejectedValue(new Error('Contract not found'));

      const result = await getBalance(publicClient, 'base', TEST_SMART_ACCOUNT, TEST_OWNER);

      // Should still return ETH balance even if token reads fail
      expect(result.eth).toBe(1000000000000000000n);
      expect(result.usdc).toBe(0n);
    });

    it('should format large USDC balances correctly', async () => {
      const largeUsdc = 1000000000000n; // 1,000,000 USDC
      publicClient.getBalance.mockResolvedValue(0n);
      publicClient.readContract.mockResolvedValue(largeUsdc);

      const result = await getBalance(publicClient, 'base', TEST_SMART_ACCOUNT, TEST_OWNER);

      expect(result.usdc).toBe(largeUsdc);
      expect(result.usdcFormatted).toBe('1000000');
    });

    it('should handle EOA balance fetch failure gracefully', async () => {
      publicClient.getBalance
        .mockResolvedValueOnce(1000n) // smart account succeeds
        .mockRejectedValueOnce(new Error('RPC error')); // EOA fails

      const result = await getBalance(publicClient, 'baseSepolia', TEST_SMART_ACCOUNT, TEST_OWNER);

      expect(result.eth).toBe(1000n);
      expect(result.eoa.eth).toBe(0n); // Falls back to 0
    });
  });

  describe('getAllBalances', () => {
    it('should use primary oracle path when getOwnerBalancesAndUSD succeeds', async () => {
      const rawResult = [
        [
          {
            account: TEST_OWNER,
            balances: [
              { token: '0x0000000000000000000000000000000000000000' as `0x${string}`, balance: 1000000000000000000n, usdValue: 2600000000000000000000n },
            ],
            totalUSD: 2600000000000000000000n,
          },
          {
            account: TEST_SMART_ACCOUNT,
            balances: [
              { token: '0x0000000000000000000000000000000000000000' as `0x${string}`, balance: 500000000000000000n, usdValue: 1300000000000000000000n },
            ],
            totalUSD: 1300000000000000000000n,
          },
        ],
        3900000000000000000000n,
      ] as const;

      publicClient.readContract.mockResolvedValueOnce(rawResult);

      const result = await getAllBalances(publicClient, 'baseSepolia', TEST_FACTORY, TEST_OWNER);

      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0].label).toBe('EOA');
      expect(result.accounts[1].label).toBe('Smart Account #1');
      expect(result.grandTotalUSD).toBe(3900000000000000000000n);
      // readContract should be called once (for getOwnerBalancesAndUSD)
      expect(publicClient.readContract).toHaveBeenCalledTimes(1);
    });

    it('should fall back to individual queries when oracle reverts', async () => {
      // First call: getOwnerBalancesAndUSD reverts
      publicClient.readContract
        .mockRejectedValueOnce(new Error('execution reverted'))
        // Second call: getAccountsByOwner returns smart accounts
        .mockResolvedValueOnce([TEST_SMART_ACCOUNT])
        // Third call: USDC balanceOf for EOA (base chain has USDC)
        .mockResolvedValueOnce(5000000n) // 5 USDC
        // Fourth call: WETH balanceOf for EOA
        .mockResolvedValueOnce(0n)
        // Fifth call: USDC balanceOf for smart account
        .mockResolvedValueOnce(10000000n) // 10 USDC
        // Sixth call: WETH balanceOf for smart account
        .mockResolvedValueOnce(250000000000000000n); // 0.25 WETH

      // ETH balances: EOA then smart account
      publicClient.getBalance
        .mockResolvedValueOnce(1000000000000000000n) // EOA: 1 ETH
        .mockResolvedValueOnce(500000000000000000n); // SA: 0.5 ETH

      const result = await getAllBalances(publicClient, 'base', TEST_FACTORY, TEST_OWNER);

      // Should have 2 accounts (EOA + 1 smart account)
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0].label).toBe('EOA');
      expect(result.accounts[0].account).toBe(TEST_OWNER);
      expect(result.accounts[1].label).toBe('Smart Account #1');
      expect(result.accounts[1].account).toBe(TEST_SMART_ACCOUNT);

      // USD values should be zero (oracle unavailable)
      expect(result.grandTotalUSD).toBe(0n);
      expect(result.grandTotalUSDFormatted).toContain('oracle unavailable');

      // ETH balances should be present
      const eoaEth = result.accounts[0].balances.find(b => b.symbol === 'ETH');
      expect(eoaEth?.balance).toBe(1000000000000000000n);

      const saEth = result.accounts[1].balances.find(b => b.symbol === 'ETH');
      expect(saEth?.balance).toBe(500000000000000000n);

      // USDC balances should be present
      const eoaUsdc = result.accounts[0].balances.find(b => b.symbol === 'USDC');
      expect(eoaUsdc?.balance).toBe(5000000n);

      const saUsdc = result.accounts[1].balances.find(b => b.symbol === 'USDC');
      expect(saUsdc?.balance).toBe(10000000n);

      // WETH balances should be present
      const saWeth = result.accounts[1].balances.find(b => b.symbol === 'WETH');
      expect(saWeth?.balance).toBe(250000000000000000n);

      // All USD values should be zero
      for (const account of result.accounts) {
        expect(account.totalUSD).toBe(0n);
        expect(account.totalUSDFormatted).toContain('oracle unavailable');
        for (const balance of account.balances) {
          expect(balance.usdValue).toBe(0n);
          expect(balance.usdFormatted).toContain('oracle unavailable');
        }
      }
    });

    it('should return just EOA when both oracle and getAccountsByOwner fail', async () => {
      // First call: getOwnerBalancesAndUSD reverts
      publicClient.readContract
        .mockRejectedValueOnce(new Error('execution reverted'))
        // Second call: getAccountsByOwner also fails
        .mockRejectedValueOnce(new Error('contract error'));

      // ETH balance for EOA only
      publicClient.getBalance.mockResolvedValueOnce(2000000000000000000n); // 2 ETH

      const result = await getAllBalances(publicClient, 'baseSepolia', TEST_FACTORY, TEST_OWNER);

      // Should have only 1 account (EOA only, baseSepolia has no USDC/WETH)
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0].label).toBe('EOA');
      expect(result.accounts[0].account).toBe(TEST_OWNER);

      // ETH balance should be present
      const eoaEth = result.accounts[0].balances.find(b => b.symbol === 'ETH');
      expect(eoaEth?.balance).toBe(2000000000000000000n);

      // USD should be zero
      expect(result.grandTotalUSD).toBe(0n);
    });

    it('should handle individual balance fetch failures in fallback gracefully', async () => {
      // getOwnerBalancesAndUSD reverts
      publicClient.readContract
        .mockRejectedValueOnce(new Error('execution reverted'))
        // getAccountsByOwner succeeds
        .mockResolvedValueOnce([TEST_SMART_ACCOUNT])
        // All subsequent balanceOf calls fail
        .mockRejectedValue(new Error('RPC error'));

      // All getBalance calls fail too
      publicClient.getBalance.mockRejectedValue(new Error('RPC error'));

      const result = await getAllBalances(publicClient, 'base', TEST_FACTORY, TEST_OWNER);

      // Should still return structure with zero balances
      expect(result.accounts).toHaveLength(2);
      expect(result.accounts[0].balances).toBeDefined();
      expect(result.accounts[0].balances.length).toBeGreaterThan(0);

      // All balances should be zero
      for (const account of result.accounts) {
        for (const balance of account.balances) {
          expect(balance.balance).toBe(0n);
        }
      }
    });

    it('should include correct token symbols in fallback for base chain', async () => {
      // getOwnerBalancesAndUSD reverts
      publicClient.readContract
        .mockRejectedValueOnce(new Error('execution reverted'))
        // getAccountsByOwner returns no smart accounts
        .mockResolvedValueOnce([])
        // USDC balanceOf for EOA
        .mockResolvedValueOnce(100000000n)
        // WETH balanceOf for EOA
        .mockResolvedValueOnce(0n);

      publicClient.getBalance.mockResolvedValueOnce(0n);

      const result = await getAllBalances(publicClient, 'base', TEST_FACTORY, TEST_OWNER);

      // Should have 1 account (EOA only, no smart accounts)
      expect(result.accounts).toHaveLength(1);

      const symbols = result.accounts[0].balances.map(b => b.symbol);
      expect(symbols).toContain('ETH');
      expect(symbols).toContain('USDC');
      expect(symbols).toContain('WETH');
    });
  });
});
