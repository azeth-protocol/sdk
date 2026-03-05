import { encodeFunctionData } from 'viem';
import { GuardianModuleAbi } from '@azeth/common/abis';
import { AzethError, type AzethContractAddresses } from '@azeth/common';
import { requireAddress } from '../utils/addresses.js';
import type { AzethSmartAccountClient } from '../utils/userop.js';

/** Update the token whitelist on the GuardianModule via ERC-4337 UserOperation.
 *
 *  Tokens must be whitelisted for executor-module operations (e.g., PaymentAgreementModule)
 *  to succeed. Owner-signed transfers bypass the whitelist.
 *
 *  @param smartAccountClient - ERC-4337 smart account client for the caller
 *  @param addresses - Contract addresses containing guardianModule
 *  @param token - Token address to whitelist/delist (use address(0) for native ETH)
 *  @param allowed - true to whitelist, false to remove from whitelist
 *  @returns Transaction hash
 */
export async function setTokenWhitelist(
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  token: `0x${string}`,
  allowed: boolean,
): Promise<`0x${string}`> {
  const guardianAddress = requireAddress(addresses, 'guardianModule');

  try {
    const data = encodeFunctionData({
      abi: GuardianModuleAbi,
      functionName: 'setTokenWhitelist',
      args: [token, allowed],
    });
    return await smartAccountClient.sendTransaction({
      to: guardianAddress,
      value: 0n,
      data,
    });
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to update token whitelist',
      'CONTRACT_ERROR',
      { originalError: err instanceof Error ? err.name : undefined },
    );
  }
}

/** Update the protocol whitelist on the GuardianModule via ERC-4337 UserOperation.
 *
 *  Protocols (contract addresses) must be whitelisted for executor-module operations
 *  that interact with external contracts.
 *
 *  @param smartAccountClient - ERC-4337 smart account client for the caller
 *  @param addresses - Contract addresses containing guardianModule
 *  @param protocol - Protocol/contract address to whitelist/delist
 *  @param allowed - true to whitelist, false to remove from whitelist
 *  @returns Transaction hash
 */
export async function setProtocolWhitelist(
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  protocol: `0x${string}`,
  allowed: boolean,
): Promise<`0x${string}`> {
  const guardianAddress = requireAddress(addresses, 'guardianModule');

  try {
    const data = encodeFunctionData({
      abi: GuardianModuleAbi,
      functionName: 'setProtocolWhitelist',
      args: [protocol, allowed],
    });
    return await smartAccountClient.sendTransaction({
      to: guardianAddress,
      value: 0n,
      data,
    });
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to update protocol whitelist',
      'CONTRACT_ERROR',
      { originalError: err instanceof Error ? err.name : undefined },
    );
  }
}
