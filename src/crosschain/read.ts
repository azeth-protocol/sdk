import type { Chain, PublicClient, Transport } from 'viem';
import { SUPPORTED_CHAINS } from '@azeth/common';
import { TrustL2ReaderAbi } from '@azeth/common/abis';
import { withRetry } from '../utils/retry.js';
import { wrapContractError } from '../utils/errors.js';
import { canonicalizePair } from './slots.js';

/** Decoded `ITrustL2Reader.L2ChainConfig` */
export interface L2ChainConfigResult {
  chainId: bigint;
  stateRootSource: `0x${string}`;
  reputationModule: `0x${string}`;
  rollupType: number;
  gameType: number;
  active: boolean;
}

/** Decoded `ITrustL2Reader.ProvenDelta` with the canonical pair attached */
export interface ProvenDeltaResult {
  account0: `0x${string}`;
  account1: `0x${string}`;
  chainId: bigint;
  /** int256, positive = account0 net-paid account1 (18-dec USD WAD) */
  usdDelta: bigint;
  l2BlockNumber: bigint;
  provenAt: bigint;
  /** provenAt > 0n */
  proven: boolean;
}

/** One per-chain row of an L1-proven cross-chain reputation breakdown */
export interface ChainNetPaidBreakdown {
  chainId: bigint;
  /** SUPPORTED_CHAINS match by id, else `chain ${id}` */
  chainName: string;
  /** Clamped ≥ 0 (contract semantics — negative directions read as 0) */
  netPaidUSD: bigint;
  proven: boolean;
  l2BlockNumber: bigint;
  provenAt: bigint;
}

/** Composite result for cross-chain reputation reads */
export interface CrossChainReputationResult {
  from: `0x${string}`;
  to: `0x${string}`;
  /** Sum of per-chain clamped values (== getAggregateNetPaidUSD) */
  totalNetPaidUSD: bigint;
  chains: ChainNetPaidBreakdown[];
  registeredChainIds: bigint[];
}

/** Resolve a human-readable chain name from SUPPORTED_CHAINS by numeric id */
function chainNameForId(chainId: bigint): string {
  for (const config of Object.values(SUPPORTED_CHAINS)) {
    if (BigInt(config.id) === chainId) return config.name;
  }
  return `chain ${chainId}`;
}

/** Get the L1-proven net USD `from` has paid `to` on a single L2 chain.
 *
 *  Direction-aware: call with NATURAL payer/payee order — the contract
 *  re-canonicalizes internally and clamps negative directions to 0.
 */
export async function getProvenNetPaidUSD(
  l1Client: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  chainId: bigint,
): Promise<bigint> {
  try {
    const result = await withRetry(() => l1Client.readContract({
      address: readerAddress,
      abi: TrustL2ReaderAbi,
      functionName: 'getProvenNetPaidUSD',
      args: [from, to, chainId],
    }));
    return result as bigint;
  } catch (err: unknown) {
    throw wrapContractError(err, 'CONTRACT_ERROR');
  }
}

/** Get the L1-proven net USD `from` has paid `to` aggregated across L2 chains.
 *
 *  @param chainIds - Chains to aggregate. Default: `getRegisteredChainIds()`.
 */
export async function getAggregateNetPaidUSD(
  l1Client: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  chainIds?: bigint[],
): Promise<bigint> {
  const ids = chainIds ?? await getRegisteredChainIds(l1Client, readerAddress);
  try {
    const result = await withRetry(() => l1Client.readContract({
      address: readerAddress,
      abi: TrustL2ReaderAbi,
      functionName: 'getAggregateNetPaidUSD',
      args: [from, to, ids],
    }));
    return result as bigint;
  } catch (err: unknown) {
    throw wrapContractError(err, 'CONTRACT_ERROR');
  }
}

/** Get the cached proven delta for a pair on one L2 chain.
 *
 *  Accepts any order; canonicalizes internally before the readContract call.
 *  `proven: false` (provenAt === 0) means no proof has been submitted yet.
 */
export async function getProvenDelta(
  l1Client: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
  accountA: `0x${string}`,
  accountB: `0x${string}`,
  chainId: bigint,
): Promise<ProvenDeltaResult> {
  const { account0, account1 } = canonicalizePair(accountA, accountB);
  try {
    const result = await withRetry(() => l1Client.readContract({
      address: readerAddress,
      abi: TrustL2ReaderAbi,
      functionName: 'getProvenDelta',
      args: [account0, account1, chainId],
    })) as { usdDelta: bigint; l2BlockNumber: bigint; provenAt: bigint };

    return {
      account0,
      account1,
      chainId,
      usdDelta: result.usdDelta,
      l2BlockNumber: result.l2BlockNumber,
      provenAt: result.provenAt,
      proven: result.provenAt > 0n,
    };
  } catch (err: unknown) {
    throw wrapContractError(err, 'CONTRACT_ERROR');
  }
}

/** Get all L2 chain ids registered on the TrustL2Reader */
export async function getRegisteredChainIds(
  l1Client: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
): Promise<bigint[]> {
  try {
    const result = await withRetry(() => l1Client.readContract({
      address: readerAddress,
      abi: TrustL2ReaderAbi,
      functionName: 'getRegisteredChainIds',
      args: [],
    }));
    return [...(result as readonly bigint[])];
  } catch (err: unknown) {
    throw wrapContractError(err, 'CONTRACT_ERROR');
  }
}

/** Get the registered L2 chain configuration from the TrustL2Reader */
export async function getL2ChainConfig(
  l1Client: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
  chainId: bigint,
): Promise<L2ChainConfigResult> {
  try {
    const result = await withRetry(() => l1Client.readContract({
      address: readerAddress,
      abi: TrustL2ReaderAbi,
      functionName: 'getChainConfig',
      args: [chainId],
    })) as {
      chainId: bigint;
      stateRootSource: `0x${string}`;
      reputationModule: `0x${string}`;
      rollupType: number;
      gameType: number;
      active: boolean;
    };

    return {
      chainId: result.chainId,
      stateRootSource: result.stateRootSource,
      reputationModule: result.reputationModule,
      rollupType: Number(result.rollupType),
      gameType: Number(result.gameType),
      active: result.active,
    };
  } catch (err: unknown) {
    throw wrapContractError(err, 'CONTRACT_ERROR');
  }
}

/** Composite cross-chain reputation read for `from` → `to`:
 *  registered chains → per-chain getProvenNetPaidUSD + getProvenDelta metadata;
 *  total = local sum of the per-chain clamped values (== getAggregateNetPaidUSD). */
export async function getCrossChainReputation(
  l1Client: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
): Promise<CrossChainReputationResult> {
  const registeredChainIds = await getRegisteredChainIds(l1Client, readerAddress);

  const chains: ChainNetPaidBreakdown[] = [];
  let totalNetPaidUSD = 0n;

  for (const chainId of registeredChainIds) {
    const [netPaidUSD, delta] = await Promise.all([
      getProvenNetPaidUSD(l1Client, readerAddress, from, to, chainId),
      getProvenDelta(l1Client, readerAddress, from, to, chainId),
    ]);

    totalNetPaidUSD += netPaidUSD;
    chains.push({
      chainId,
      chainName: chainNameForId(chainId),
      netPaidUSD,
      proven: delta.proven,
      l2BlockNumber: delta.l2BlockNumber,
      provenAt: delta.provenAt,
    });
  }

  return { from, to, totalNetPaidUSD, chains, registeredChainIds };
}
