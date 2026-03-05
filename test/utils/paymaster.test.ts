import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkPolicy, type PaymasterPolicy } from '../../src/utils/paymaster.js';
import type { GetPaymasterDataParameters } from 'viem/account-abstraction';

/** Helper to build minimal GetPaymasterDataParameters-like objects for testing */
function mockParams(overrides: Record<string, unknown> = {}): GetPaymasterDataParameters {
  return {
    sender: '0x1111111111111111111111111111111111111111',
    callData: '0x',
    nonce: 0n,
    callGasLimit: 100000n,
    verificationGasLimit: 100000n,
    preVerificationGas: 50000n,
    maxFeePerGas: 1000000000n, // 1 gwei
    maxPriorityFeePerGas: 100000000n,
    chainId: 84532,
    entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
    entryPointVersion: '0.7',
    ...overrides,
  } as unknown as GetPaymasterDataParameters;
}

describe('checkPolicy', () => {
  describe('no policy', () => {
    it('returns undefined when policy is undefined (allow all)', () => {
      const result = checkPolicy(undefined, mockParams());
      expect(result).toBeUndefined();
    });

    it('returns undefined when policy is empty object (allow all)', () => {
      const result = checkPolicy({}, mockParams());
      expect(result).toBeUndefined();
    });
  });

  describe('allowedAccounts', () => {
    it('allows account that is in the allowlist', () => {
      const policy: PaymasterPolicy = {
        allowedAccounts: ['0x1111111111111111111111111111111111111111'],
      };
      const result = checkPolicy(policy, mockParams());
      expect(result).toBeUndefined();
    });

    it('allows account with case-insensitive matching', () => {
      const policy: PaymasterPolicy = {
        allowedAccounts: ['0x1111111111111111111111111111111111111111'],
      };
      const params = mockParams({ sender: '0x1111111111111111111111111111111111111111' });
      const result = checkPolicy(policy, params);
      expect(result).toBeUndefined();
    });

    it('denies account not in allowlist', () => {
      const policy: PaymasterPolicy = {
        allowedAccounts: ['0x2222222222222222222222222222222222222222'],
      };
      const result = checkPolicy(policy, mockParams());
      expect(result).toContain('not in paymaster allowedAccounts');
    });

    it('allows all when allowedAccounts is empty array', () => {
      const policy: PaymasterPolicy = {
        allowedAccounts: [],
      };
      const result = checkPolicy(policy, mockParams());
      expect(result).toBeUndefined();
    });
  });

  describe('maxSponsoredPerDay', () => {
    it('allows first request when limit is 1', () => {
      const policy: PaymasterPolicy = {
        maxSponsoredPerDay: 1,
      };
      // Use unique sender to avoid interference from other tests
      const uniqueSender = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
      const result = checkPolicy(policy, mockParams({ sender: uniqueSender }));
      expect(result).toBeUndefined();
    });

    it('denies after limit is reached', () => {
      const policy: PaymasterPolicy = {
        maxSponsoredPerDay: 1,
      };
      const uniqueSender = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
      // First call succeeds
      checkPolicy(policy, mockParams({ sender: uniqueSender }));
      // Second call should be denied
      const result = checkPolicy(policy, mockParams({ sender: uniqueSender }));
      expect(result).toContain('exceeded daily sponsorship limit');
    });

    it('allows unlimited when maxSponsoredPerDay is 0', () => {
      const policy: PaymasterPolicy = {
        maxSponsoredPerDay: 0,
      };
      const uniqueSender = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
      for (let i = 0; i < 100; i++) {
        const result = checkPolicy(policy, mockParams({ sender: uniqueSender }));
        expect(result).toBeUndefined();
      }
    });
  });

  describe('maxGasCostWei', () => {
    it('allows when gas cost is under limit', () => {
      const policy: PaymasterPolicy = {
        // 1 ETH limit
        maxGasCostWei: 1000000000000000000n,
      };
      // Gas cost: 1 gwei * 250000 = 250000 gwei = 0.00025 ETH — well under limit
      const result = checkPolicy(policy, mockParams());
      expect(result).toBeUndefined();
    });

    it('denies when gas cost exceeds limit', () => {
      const policy: PaymasterPolicy = {
        maxGasCostWei: 100n, // Very low limit (100 wei)
      };
      // Gas cost: 1 gwei * 250000 = 250B wei — far exceeds 100 wei
      const result = checkPolicy(policy, mockParams());
      expect(result).toContain('exceeds maxGasCostWei');
    });

    it('allows when maxFeePerGas is missing (cost estimate is 0)', () => {
      const policy: PaymasterPolicy = {
        maxGasCostWei: 100n,
      };
      const result = checkPolicy(policy, mockParams({ maxFeePerGas: undefined }));
      expect(result).toBeUndefined();
    });
  });

  describe('combined policies', () => {
    it('checks all conditions — denies on first failure (allowedAccounts)', () => {
      const policy: PaymasterPolicy = {
        allowedAccounts: ['0x2222222222222222222222222222222222222222'],
        maxSponsoredPerDay: 100,
        maxGasCostWei: 1000000000000000000n,
      };
      const result = checkPolicy(policy, mockParams());
      expect(result).toContain('not in paymaster allowedAccounts');
    });

    it('passes all checks when everything is valid', () => {
      const policy: PaymasterPolicy = {
        allowedAccounts: ['0x1111111111111111111111111111111111111111'],
        maxSponsoredPerDay: 100,
        maxGasCostWei: 1000000000000000000n,
      };
      const result = checkPolicy(policy, mockParams());
      expect(result).toBeUndefined();
    });
  });
});
