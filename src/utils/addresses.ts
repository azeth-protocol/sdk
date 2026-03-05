import {
  AZETH_CONTRACTS,
  AzethError,
  type SupportedChainName,
  type AzethContractAddresses,
} from '@azeth/common';

/** Validate an address override is well-formed if provided */
function validateOverride(address: `0x${string}` | undefined, field: string): void {
  if (address !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new AzethError(`Invalid override for ${field}: must be a valid Ethereum address`, 'INVALID_INPUT', { field });
  }
}

/** Resolve contract addresses for a chain, with optional overrides */
export function resolveAddresses(
  chainName: SupportedChainName,
  overrides?: Partial<AzethContractAddresses>,
): AzethContractAddresses {
  if (overrides) {
    validateOverride(overrides.factory, 'factory');
    validateOverride(overrides.guardianModule, 'guardianModule');
    validateOverride(overrides.trustRegistryModule, 'trustRegistryModule');
    validateOverride(overrides.paymentAgreementModule, 'paymentAgreementModule');
    validateOverride(overrides.reputationModule, 'reputationModule');
    validateOverride(overrides.priceOracle, 'priceOracle');
    validateOverride(overrides.accountImplementation, 'accountImplementation');
  }

  const defaults = AZETH_CONTRACTS[chainName];
  const resolved: AzethContractAddresses = {
    factory: overrides?.factory ?? defaults.factory,
    guardianModule: overrides?.guardianModule ?? defaults.guardianModule,
    trustRegistryModule: overrides?.trustRegistryModule ?? defaults.trustRegistryModule,
    paymentAgreementModule: overrides?.paymentAgreementModule ?? defaults.paymentAgreementModule,
    reputationModule: overrides?.reputationModule ?? defaults.reputationModule,
    priceOracle: overrides?.priceOracle ?? defaults.priceOracle,
    accountImplementation: overrides?.accountImplementation ?? defaults.accountImplementation,
  };

  // HIGH-8 fix: Validate that no required address is empty. Empty addresses (like Base
  // mainnet before deployment) would pass to viem and cause confusing errors or send
  // transactions to the zero address.
  // priceOracle and accountImplementation are optional (only needed for createAccount).
  const REQUIRED_FIELDS: (keyof AzethContractAddresses)[] = [
    'factory', 'guardianModule', 'trustRegistryModule', 'paymentAgreementModule', 'reputationModule',
  ];
  for (const key of REQUIRED_FIELDS) {
    const value = resolved[key];
    if (!value || (value as string) === '' || value === ('0x' as `0x${string}`)) {
      throw new AzethError(
        `Contract ${key} not yet deployed on ${chainName}. Run deployment first or provide an override.`,
        'INVALID_INPUT',
        { field: key, chain: chainName },
      );
    }
  }

  return resolved;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Validate that a required contract address is present, non-empty, and not the zero address */
export function requireAddress(
  addresses: AzethContractAddresses,
  field: keyof AzethContractAddresses,
): `0x${string}` {
  const addr = addresses[field];
  if (!addr || addr === ('' as `0x${string}`) || addr === ZERO_ADDRESS) {
    throw new AzethError(
      `${field} address not configured`,
      'NETWORK_ERROR',
      { field },
    );
  }
  return addr;
}
