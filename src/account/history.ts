import {
  type PublicClient,
  type Chain,
  type Transport,
} from 'viem';
import { AzethError } from '@azeth/common';
import { ReputationModuleAbi } from '@azeth/common/abis';
import { withRetry } from '../utils/retry.js';

export interface HistoryParams {
  limit?: number;
  offset?: number;
  fromBlock?: bigint;
}

export interface TransactionRecord {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}` | null;
  value: bigint;
  /** Token contract address (null for native ETH, 0x0...0 for ETH recorded by ReputationModule) */
  token: `0x${string}` | null;
  blockNumber: bigint;
  timestamp: number;
}

/** Pad an address to a 32-byte hex topic for event log filtering */
function addressToTopic(addr: `0x${string}`): `0x${string}` {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}` as `0x${string}`;
}

/** Get transaction history for an account
 *  Tries server API first, then falls back to on-chain TransferRecorded events
 *  from the ReputationModule (last ~1000 blocks).
 */
export async function getHistory(
  publicClient: PublicClient<Transport, Chain>,
  account: `0x${string}`,
  serverUrl?: string,
  params?: HistoryParams,
  reputationModuleAddress?: `0x${string}`,
  tokenAddresses?: `0x${string}`[],
): Promise<TransactionRecord[]> {
  // If server URL is provided, try the indexed API (fall back gracefully if unreachable)
  if (serverUrl) {
    const queryParams = new URLSearchParams();
    queryParams.set('address', account);
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());

    try {
      const response = await withRetry(() => fetch(`${serverUrl}/api/v1/history?${queryParams}`));
      if (response.ok) {
        return await response.json() as TransactionRecord[];
      }
      // Non-OK response — fall through to on-chain fallback
    } catch {
      // Server unreachable — fall through to on-chain fallback
    }
  }

  // On-chain fallback: query TransferRecorded events from ReputationModule
  if (!reputationModuleAddress) return [];

  try {
    const currentBlock = await publicClient.getBlockNumber();
    const fromBlock = params?.fromBlock ?? (currentBlock > 50_000n ? currentBlock - 50_000n : 0n);
    const limit = params?.limit ?? 50;
    const accountTopic = addressToTopic(account);

    // Query outgoing (from=account) and incoming (to=account) in parallel
    const [outgoing, incoming] = await Promise.all([
      publicClient.getLogs({
        address: reputationModuleAddress,
        event: {
          type: 'event' as const,
          name: 'TransferRecorded',
          inputs: [
            { name: 'from', type: 'address', indexed: true },
            { name: 'to', type: 'address', indexed: true },
            { name: 'token', type: 'address', indexed: true },
            { name: 'amount', type: 'uint256', indexed: false },
          ],
        },
        args: { from: account },
        fromBlock,
        toBlock: currentBlock,
      }).catch(() => []),
      publicClient.getLogs({
        address: reputationModuleAddress,
        event: {
          type: 'event' as const,
          name: 'TransferRecorded',
          inputs: [
            { name: 'from', type: 'address', indexed: true },
            { name: 'to', type: 'address', indexed: true },
            { name: 'token', type: 'address', indexed: true },
            { name: 'amount', type: 'uint256', indexed: false },
          ],
        },
        args: { to: account },
        fromBlock,
        toBlock: currentBlock,
      }).catch(() => []),
    ]);

    // Query standard ERC-20 Transfer events for incoming deposits.
    // Deposits via direct ERC-20 transfer() bypass the ReputationModule Hook,
    // so no TransferRecorded events are emitted — we must query Transfer events directly.
    const validTokens = (tokenAddresses ?? []).filter(Boolean);
    const depositLogs = validTokens.length > 0
      ? (await Promise.all(
          validTokens.map(tokenAddr =>
            publicClient.getLogs({
              address: tokenAddr,
              event: {
                type: 'event' as const,
                name: 'Transfer',
                inputs: [
                  { name: 'from', type: 'address', indexed: true },
                  { name: 'to', type: 'address', indexed: true },
                  { name: 'value', type: 'uint256', indexed: false },
                ],
              },
              args: { to: account },
              fromBlock,
              toBlock: currentBlock,
            }).catch(() => []),
          ),
        )).flat()
      : [];

    // Merge, deduplicate by txHash, and sort by blockNumber descending
    const allLogs = [...outgoing, ...incoming, ...depositLogs];
    const seen = new Set<string>();
    const records: TransactionRecord[] = [];

    for (const log of allLogs) {
      const txHash = log.transactionHash;
      if (!txHash || seen.has(txHash)) continue;
      seen.add(txHash);

      const args = log.args as Record<string, unknown>;
      const from = (args.from as `0x${string}` | undefined);
      const to = (args.to as `0x${string}` | undefined);
      // TransferRecorded has 'token' and 'amount'; ERC-20 Transfer has 'value' and log.address is the token
      const token = (args.token as `0x${string}` | undefined) ?? (args.value !== undefined ? log.address : null);
      const amount = (args.amount as bigint | undefined) ?? (args.value as bigint | undefined);

      records.push({
        hash: txHash,
        from: from ?? account,
        to: to ?? null,
        value: amount ?? 0n,
        token: token ?? null,
        blockNumber: log.blockNumber ?? 0n,
        timestamp: 0,
      });
    }

    // Sort by blockNumber descending (most recent first) and apply limit
    records.sort((a, b) => Number(b.blockNumber - a.blockNumber));
    const sliced = records.slice(0, limit);

    // Batch-fetch block timestamps for unique block numbers
    const uniqueBlocks = [...new Set(sliced.map(r => r.blockNumber))];
    const blockTimestamps = new Map<bigint, number>();
    await Promise.all(
      uniqueBlocks.map(async (blockNumber) => {
        try {
          const block = await publicClient.getBlock({ blockNumber });
          blockTimestamps.set(blockNumber, Number(block.timestamp));
        } catch {
          // If block fetch fails, leave timestamp as 0
        }
      }),
    );

    for (const record of sliced) {
      record.timestamp = blockTimestamps.get(record.blockNumber) ?? 0;
    }

    return sliced;
  } catch {
    // On-chain fallback failed — return empty
    return [];
  }
}
