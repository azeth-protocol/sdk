import { describe, it, expect, vi } from 'vitest';
import { resolveAddresses, requireAddress } from '../../src/utils/addresses.js';

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

describe('utils/addresses', () => {
  describe('resolveAddresses', () => {
    it('should return chain defaults when no overrides provided', () => {
      const addresses = resolveAddresses('baseSepolia');

      expect(addresses.factory).toBe('0x6666666666666666666666666666666666666666');
      expect(addresses.guardianModule).toBe('0x7777777777777777777777777777777777777777');
      expect(addresses.trustRegistryModule).toBe('0x8888888888888888888888888888888888888888');
      expect(addresses.paymentAgreementModule).toBe('0x9999999999999999999999999999999999999999');
      expect(addresses.reputationModule).toBe('0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    });

    it('should merge overrides with chain defaults', () => {
      const customFactory = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' as `0x${string}`;
      const addresses = resolveAddresses('baseSepolia', { factory: customFactory });

      expect(addresses.factory).toBe(customFactory);
      expect(addresses.guardianModule).toBe('0x7777777777777777777777777777777777777777');
    });

    it('should allow overriding all required addresses', () => {
      const overrides = {
        factory: '0x0000000000000000000000000000000000000001' as `0x${string}`,
        guardianModule: '0x0000000000000000000000000000000000000002' as `0x${string}`,
        trustRegistryModule: '0x0000000000000000000000000000000000000003' as `0x${string}`,
        paymentAgreementModule: '0x0000000000000000000000000000000000000004' as `0x${string}`,
        reputationModule: '0x0000000000000000000000000000000000000005' as `0x${string}`,
      };
      const addresses = resolveAddresses('base', overrides);

      expect(addresses.factory).toBe(overrides.factory);
      expect(addresses.guardianModule).toBe(overrides.guardianModule);
      expect(addresses.trustRegistryModule).toBe(overrides.trustRegistryModule);
      expect(addresses.paymentAgreementModule).toBe(overrides.paymentAgreementModule);
      expect(addresses.reputationModule).toBe(overrides.reputationModule);
    });

    it('should throw for undeployed chain with empty addresses', () => {
      expect(() => resolveAddresses('base')).toThrow('not yet deployed on base');
    });
  });

  describe('requireAddress', () => {
    it('should return the address when it is non-empty', () => {
      const addresses = resolveAddresses('baseSepolia');
      const factory = requireAddress(addresses, 'factory');

      expect(factory).toBe('0x6666666666666666666666666666666666666666');
    });

    it('should throw when address is empty', () => {
      // Build an addresses object directly to bypass resolveAddresses validation
      const addresses = {
        factory: '' as `0x${string}`,
        guardianModule: '' as `0x${string}`,
        trustRegistryModule: '' as `0x${string}`,
        paymentAgreementModule: '' as `0x${string}`,
        reputationModule: '' as `0x${string}`,
        priceOracle: '' as `0x${string}`,
        accountImplementation: '' as `0x${string}`,
      };

      expect(() => requireAddress(addresses, 'factory')).toThrow('factory address not configured');
    });

    it('should throw AzethError with NETWORK_ERROR code', () => {
      // Build an addresses object directly to bypass resolveAddresses validation
      const addresses = {
        factory: '' as `0x${string}`,
        guardianModule: '' as `0x${string}`,
        trustRegistryModule: '' as `0x${string}`,
        paymentAgreementModule: '' as `0x${string}`,
        reputationModule: '' as `0x${string}`,
        priceOracle: '' as `0x${string}`,
        accountImplementation: '' as `0x${string}`,
      };

      try {
        requireAddress(addresses, 'reputationModule');
        expect.unreachable('Should have thrown');
      } catch (err: any) {
        expect(err.code).toBe('NETWORK_ERROR');
        expect(err.details?.field).toBe('reputationModule');
      }
    });
  });
});
