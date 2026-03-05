import {
  type PublicClient,
  type Chain,
  type Transport,
  encodeFunctionData,
} from 'viem';
import { ReputationModuleAbi, ERC8004ReputationRegistryAbi } from '@azeth/common/abis';
import {
  AzethError,
  AZETH_CONTRACTS,
  ERC8004_REPUTATION_REGISTRY,
  type SupportedChainName,
  type AzethContractAddresses,
  type OnChainOpinion,
  type OpinionEntry,
  type WeightedReputation,
  type ActiveOpinion,
} from '@azeth/common';
import { requireAddress } from '../utils/addresses.js';
import { wrapContractError } from '../utils/errors.js';
import type { AzethSmartAccountClient } from '../utils/userop.js';

/** Submit an opinion for an agent on the ERC-8004 Reputation Registry via the ReputationModule.
 *
 *  Routes the call through the smart account via ERC-4337 UserOperation so that
 *  msg.sender in the ReputationModule context is the smart account (not the EOA).
 *
 *  The contract requires a positive net USD payment from the caller to the target agent
 *  (aggregated on-chain via Chainlink). Value is int128 with configurable decimal precision.
 *  If an opinion already exists for this rater→agent pair, it is updated (old entry revoked, new one created).
 */
export async function submitOpinion(
  publicClient: PublicClient<Transport, Chain>,
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  _account: `0x${string}`,
  opinion: OnChainOpinion,
): Promise<`0x${string}`> {
  if (opinion.agentId <= 0n) {
    throw new AzethError('agentId must be a positive integer', 'INVALID_INPUT', { field: 'agentId' });
  }

  // Decimal-misuse detection: catch callers who pass e.g. value=85, decimals=18
  // (effective value = 8.5e-17 — almost certainly a mistake, not intentional).
  if (opinion.value !== 0n && opinion.valueDecimals > 0) {
    const absValue = opinion.value < 0n ? -opinion.value : opinion.value;
    const divisor = 10n ** BigInt(opinion.valueDecimals);
    // If |value| < divisor, effectiveValue < 1.0 — likely decimal misuse
    // (e.g., value=85, decimals=18 → effectiveValue = 0.0000000000000000085)
    if (absValue > 0n && absValue < divisor) {
      throw new AzethError(
        `Likely decimal misuse: value=${opinion.value} with valueDecimals=${opinion.valueDecimals} ` +
        `yields an effective value near zero. For a rating of ${opinion.value}, use valueDecimals=0. ` +
        `For WAD format, use value=${opinion.value}e18 with valueDecimals=18.`,
        'INVALID_INPUT',
        { field: 'value', value: opinion.value.toString(), valueDecimals: opinion.valueDecimals },
      );
    }
  }

  const moduleAddress = requireAddress(addresses, 'reputationModule');

  let txHash: `0x${string}`;
  try {
    // Route through smart account via UserOp so msg.sender = smart account address.
    // The SmartAccountClient builds a UserOperation that wraps this call in
    // AzethAccount.execute(mode, encodeSingle(module, 0, calldata)).
    const data = encodeFunctionData({
      abi: ReputationModuleAbi,
      functionName: 'submitOpinion',
      args: [
        opinion.agentId,
        opinion.value,
        opinion.valueDecimals,
        opinion.tag1,
        opinion.tag2,
        opinion.endpoint,
        opinion.opinionURI,
        opinion.opinionHash,
      ],
    });
    txHash = await smartAccountClient.sendTransaction({
      to: moduleAddress,
      value: 0n,
      data,
    });
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }

  return txHash;
}

/** Get payment-weighted reputation for an agent from the ReputationModule.
 *
 *  Calls ReputationModule.getWeightedReputation(agentId, raters[]).
 *  Only raters with positive net USD payment to the agent contribute
 *  to the weighted average.
 */
export async function getWeightedReputation(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  agentId: bigint,
  raters: `0x${string}`[],
): Promise<WeightedReputation> {
  const moduleAddress = requireAddress(addresses, 'reputationModule');

  try {
    const result = await publicClient.readContract({
      address: moduleAddress,
      abi: ReputationModuleAbi,
      functionName: 'getWeightedReputation',
      args: [agentId, raters],
    });

    const [weightedValue, totalWeight, opinionCount] = result as [bigint, bigint, bigint];
    return { weightedValue, totalWeight, opinionCount };
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }
}

/** Get payment-weighted reputation for an agent across ALL raters.
 *
 *  WARNING: This calls the unbounded getWeightedReputationAll() on-chain function.
 *  Gas cost grows linearly with the number of raters. Use getWeightedReputation()
 *  with an explicit rater list for production workloads.
 */
export async function getWeightedReputationAll(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  agentId: bigint,
): Promise<WeightedReputation> {
  const moduleAddress = requireAddress(addresses, 'reputationModule');

  try {
    const result = await publicClient.readContract({
      address: moduleAddress,
      abi: ReputationModuleAbi,
      functionName: 'getWeightedReputationAll',
      args: [agentId],
    });

    const [weightedValue, totalWeight, opinionCount] = result as [bigint, bigint, bigint];
    return { weightedValue, totalWeight, opinionCount };
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }
}

/** Get the net payment delta between two accounts for a specific token.
 *
 *  Returns a signed int256: positive means `from` has paid `to` more than `to` has paid `from`.
 *  Negative means `to` has paid `from` more.
 */
export async function getNetPaid(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  from: `0x${string}`,
  to: `0x${string}`,
  token: `0x${string}`,
): Promise<bigint> {
  const moduleAddress = requireAddress(addresses, 'reputationModule');

  try {
    const result = await publicClient.readContract({
      address: moduleAddress,
      abi: ReputationModuleAbi,
      functionName: 'getNetPaid',
      args: [from, to, token],
    });

    return result as bigint;
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }
}

/** Get the total net payment from `from` to `to` across all supported tokens, in 18-decimal USD.
 *
 *  Aggregates positive net deltas across all tokens tracked by the oracle (ETH, USDC, etc.)
 *  and converts to a single USD value. Always returns >= 0 (only sums directions where
 *  `from` has paid `to` more).
 *
 *  This is the same value the contract uses to gate opinion submissions ($1 minimum).
 */
export async function getTotalNetPaidUSD(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  from: `0x${string}`,
  to: `0x${string}`,
): Promise<bigint> {
  const moduleAddress = requireAddress(addresses, 'reputationModule');

  try {
    const result = await publicClient.readContract({
      address: moduleAddress,
      abi: ReputationModuleAbi,
      functionName: 'getTotalNetPaidUSD',
      args: [from, to],
    });

    return result as bigint;
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }
}

/** Get active opinion state for a rater→agent relationship.
 *
 *  Returns the current opinion index and whether an active opinion exists.
 */
export async function getActiveOpinion(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  agentId: bigint,
): Promise<ActiveOpinion> {
  const moduleAddress = requireAddress(addresses, 'reputationModule');

  try {
    const result = await publicClient.readContract({
      address: moduleAddress,
      abi: ReputationModuleAbi,
      functionName: 'getActiveOpinion',
      args: [account, agentId],
    });

    const { opinionIndex, exists } = result as { opinionIndex: bigint; exists: boolean };
    return { opinionIndex, exists };
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }
}

/** Read a single opinion entry from the ERC-8004 Reputation Registry. */
export async function readOpinion(
  publicClient: PublicClient<Transport, Chain>,
  chainName: SupportedChainName,
  agentId: bigint,
  clientAddress: `0x${string}`,
  opinionIndex: bigint,
): Promise<OpinionEntry> {
  const registryAddress = ERC8004_REPUTATION_REGISTRY[chainName] as `0x${string}`;
  if (!registryAddress) {
    throw new AzethError(
      `No reputation registry configured for ${chainName}`,
      'REGISTRY_ERROR',
    );
  }

  try {
    const result = await publicClient.readContract({
      address: registryAddress,
      abi: ERC8004ReputationRegistryAbi,
      functionName: 'readFeedback',
      args: [agentId, clientAddress, opinionIndex],
    });

    const [value, valueDecimals, tag1, tag2, isRevoked] = result as [bigint, number, string, string, boolean];
    return { value, valueDecimals, tag1, tag2, isRevoked };
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }
}

/** Get the Azeth ReputationModule address for a chain */
export function getReputationModuleAddress(chainName: SupportedChainName): `0x${string}` {
  const addr = AZETH_CONTRACTS[chainName].reputationModule;
  if (!addr || addr === ('' as `0x${string}`)) {
    throw new AzethError(
      `ReputationModule not deployed on ${chainName}`,
      'NETWORK_ERROR',
      { chain: chainName },
    );
  }
  return addr;
}
