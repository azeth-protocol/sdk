import {
  type PublicClient,
  type Chain,
  type Transport,
} from 'viem';
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

/** Result of a history query.
 *
 *  `indexedHistoryUnavailable` is true when the full history could not be served —
 *  either the indexed backbone is not reachable AND the configured RPC cannot serve
 *  the full on-chain fallback scan (so `transactions` is a best-effort recent-only
 *  window, possibly empty). Consumers should surface this so a degraded result is
 *  not mistaken for "no activity". Full, complete history requires the indexer. */
export interface HistoryResult {
  transactions: TransactionRecord[];
  indexedHistoryUnavailable: boolean;
}

/** Shape of a single record returned by the server's GET /api/v1/history.
 *  The server wraps records in `{ data, meta }` and serializes the bigint
 *  fields (value, blockNumber) as JSON-safe strings. */
interface ServerHistoryRecord {
  hash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}` | null;
  value: string;
  token: `0x${string}` | null;
  blockNumber: string;
  timestamp: number;
}

/** TransferRecorded event emitted by the ReputationModule hook. */
const TRANSFER_RECORDED_EVENT = {
  type: 'event',
  name: 'TransferRecorded',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'token', type: 'address', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
  ],
} as const;

/** Standard ERC-20 Transfer event (for deposits that bypass the hook). */
const ERC20_TRANSFER_EVENT = {
  type: 'event',
  name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'value', type: 'uint256', indexed: false },
  ],
} as const;

/** Max block span per getLogs call. Public RPC providers commonly reject ranges
 *  wider than ~10k blocks, so the scan window is split into chunks. */
const MAX_LOG_BLOCK_RANGE = 10_000n;

/** Block span for the best-effort full on-chain fallback scan. */
const FULL_SCAN_BLOCK_RANGE = 50_000n;

/** Narrow, recent-only window the SDK retries when the full scan is rejected by
 *  the RPC — enough to surface very recent activity without a wide getLogs call. */
const RECENT_FALLBACK_BLOCK_RANGE = 2_000n;

/** Run a getLogs query across [fromBlock, toBlock] in MAX_LOG_BLOCK_RANGE chunks,
 *  concatenating the results. Errors propagate so the caller can decide whether to
 *  degrade to a smaller window. */
async function getLogsInChunks<TLog>(
  fromBlock: bigint,
  toBlock: bigint,
  query: (range: { fromBlock: bigint; toBlock: bigint }) => Promise<TLog[]>,
): Promise<TLog[]> {
  const out: TLog[] = [];
  for (let start = fromBlock; start <= toBlock; start += MAX_LOG_BLOCK_RANGE + 1n) {
    const end = start + MAX_LOG_BLOCK_RANGE < toBlock ? start + MAX_LOG_BLOCK_RANGE : toBlock;
    out.push(...(await query({ fromBlock: start, toBlock: end })));
    if (end >= toBlock) break;
  }
  return out;
}

/** Scan ReputationModule TransferRecorded + inbound ERC-20 Transfer logs for
 *  `account` across [fromBlock, toBlock] (chunked), returning the most recent
 *  `limit` records sorted newest-first with block timestamps. Errors propagate so
 *  the caller can decide whether to degrade to a smaller window. */
async function scanOnChainTransfers(
  publicClient: PublicClient<Transport, Chain>,
  account: `0x${string}`,
  reputationModuleAddress: `0x${string}`,
  tokenAddresses: `0x${string}`[] | undefined,
  fromBlock: bigint,
  toBlock: bigint,
  limit: number,
): Promise<TransactionRecord[]> {
  // Outgoing (from=account) and incoming (to=account) TransferRecorded events.
  const [outgoing, incoming] = await Promise.all([
    getLogsInChunks(fromBlock, toBlock, (range) => publicClient.getLogs({
      address: reputationModuleAddress,
      event: TRANSFER_RECORDED_EVENT,
      args: { from: account },
      ...range,
    })),
    getLogsInChunks(fromBlock, toBlock, (range) => publicClient.getLogs({
      address: reputationModuleAddress,
      event: TRANSFER_RECORDED_EVENT,
      args: { to: account },
      ...range,
    })),
  ]);

  // ERC-20 deposits via direct transfer() bypass the ReputationModule hook, so
  // no TransferRecorded event is emitted — query Transfer events directly.
  const validTokens = (tokenAddresses ?? []).filter(Boolean);
  const depositLogs = validTokens.length > 0
    ? (await Promise.all(
        validTokens.map((tokenAddr) =>
          getLogsInChunks(fromBlock, toBlock, (range) => publicClient.getLogs({
            address: tokenAddr,
            event: ERC20_TRANSFER_EVENT,
            args: { to: account },
            ...range,
          })),
        ),
      )).flat()
    : [];

  // Merge and deduplicate by txHash.
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

  // Newest-first, apply limit, then batch-fetch block timestamps.
  records.sort((a, b) => Number(b.blockNumber - a.blockNumber));
  const sliced = records.slice(0, limit);

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
}

/** Get transaction history for an account.
 *
 *  Tries the indexed server API first; otherwise falls back to scanning on-chain
 *  ReputationModule TransferRecorded + ERC-20 Transfer logs. When the configured
 *  RPC cannot serve the full fallback scan, the result DEGRADES to a recent-only
 *  window (or empty) and sets `indexedHistoryUnavailable: true` instead of
 *  throwing — full, complete history requires the indexed backbone (F-5).
 */
export async function getHistory(
  publicClient: PublicClient<Transport, Chain>,
  account: `0x${string}`,
  serverUrl?: string,
  params?: HistoryParams,
  reputationModuleAddress?: `0x${string}`,
  tokenAddresses?: `0x${string}`[],
): Promise<HistoryResult> {
  // Indexed server API (authoritative when reachable).
  if (serverUrl) {
    const queryParams = new URLSearchParams();
    queryParams.set('address', account);
    if (params?.limit) queryParams.set('limit', params.limit.toString());
    if (params?.offset) queryParams.set('offset', params.offset.toString());

    try {
      const response = await withRetry(() => fetch(`${serverUrl}/api/v1/history?${queryParams}`));
      if (response.ok) {
        // The server returns { data, meta } and serializes bigint fields as strings.
        const body = await response.json() as { data?: ServerHistoryRecord[] };
        return {
          transactions: (body.data ?? []).map((r) => ({
            hash: r.hash,
            from: r.from,
            to: r.to,
            value: BigInt(r.value),
            token: r.token,
            blockNumber: BigInt(r.blockNumber),
            timestamp: r.timestamp,
          })),
          indexedHistoryUnavailable: false,
        };
      }
      // Non-OK (e.g. auth-gated) — fall through to the on-chain fallback.
    } catch {
      // Server unreachable — fall through to the on-chain fallback.
    }
  }

  // On-chain fallback. Without a ReputationModule address there is no source.
  if (!reputationModuleAddress) {
    return { transactions: [], indexedHistoryUnavailable: true };
  }

  let currentBlock: bigint;
  try {
    currentBlock = await publicClient.getBlockNumber();
  } catch {
    return { transactions: [], indexedHistoryUnavailable: true };
  }

  const limit = params?.limit ?? 50;
  const fullFromBlock = params?.fromBlock ?? (currentBlock > FULL_SCAN_BLOCK_RANGE ? currentBlock - FULL_SCAN_BLOCK_RANGE : 0n);

  try {
    // Best case: the RPC serves the full scan window.
    const transactions = await scanOnChainTransfers(
      publicClient, account, reputationModuleAddress, tokenAddresses, fullFromBlock, currentBlock, limit,
    );
    return { transactions, indexedHistoryUnavailable: false };
  } catch {
    // The configured RPC can't serve the full window (wide getLogs rejected).
    // Degrade to a recent-only slice it CAN serve and flag that full/indexed
    // history is unavailable — never throw. This is the F-5 interim until the
    // indexed backbone lands; full history is not reconstructable from this RPC.
    try {
      const recentFromBlock = currentBlock > RECENT_FALLBACK_BLOCK_RANGE ? currentBlock - RECENT_FALLBACK_BLOCK_RANGE : 0n;
      const transactions = await scanOnChainTransfers(
        publicClient, account, reputationModuleAddress, tokenAddresses, recentFromBlock, currentBlock, limit,
      );
      return { transactions, indexedHistoryUnavailable: true };
    } catch {
      return { transactions: [], indexedHistoryUnavailable: true };
    }
  }
}
