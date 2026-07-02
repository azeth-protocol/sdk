import type { Account, Chain, PublicClient, Transport, WalletClient } from 'viem';
import { AzethError } from '@azeth/common';
import { TrustL2ReaderAbi } from '@azeth/common/abis';
import { withRetry } from '../utils/retry.js';
import { wrapContractError } from '../utils/errors.js';
import type { L2UsdDeltaProof } from './proof-builder.js';
import { getProvenDelta, type ProvenDeltaResult } from './read.js';

export interface ProveL2UsdDeltaOptions {
  /** default false — simulate only */
  broadcast?: boolean;
  /** REQUIRED when broadcast: true (funded L1 EOA) */
  l1WalletClient?: WalletClient<Transport, Chain, Account>;
  /** default true — pre-check cache, short-circuit */
  skipIfAlreadyProven?: boolean;
  /** default true (120_000ms timeout). A wait timeout/RPC failure after a
   *  successful broadcast does NOT throw — the result carries the txHash with
   *  `receiptStatus: 'pending'`. */
  waitForReceipt?: boolean;
}

export type ProveStatus = 'simulated' | 'broadcast' | 'already-proven';

export interface ProveL2UsdDeltaResult {
  status: ProveStatus;
  account0: `0x${string}`;
  account1: `0x${string}`;
  chainId: bigint;
  /** value proven/cached (canonical direction) */
  usdDelta: bigint;
  anchorL2BlockNumber: bigint;
  /** set when broadcast path estimates */
  gasEstimate?: bigint;
  /** status === 'broadcast' only */
  txHash?: `0x${string}`;
  /** status === 'broadcast' only.
   *  'confirmed' — the receipt landed with status success.
   *  'pending'   — the tx WAS broadcast but the receipt is not confirmed yet:
   *  either `waitForReceipt: false`, or the 120s wait timed out / the RPC failed.
   *  Track `txHash` on the L1 explorer; do NOT re-build and re-submit the proof
   *  (a landed tx makes the second submission revert ProofOutdated). */
  receiptStatus?: 'confirmed' | 'pending';
  /** status === 'already-proven' only */
  cached?: ProvenDeltaResult;
}

/** TrustL2Reader revert selectors that map to PROOF_INVALID (proof-content failures) */
const PROOF_INVALID_SELECTORS: Record<string, string> = {
  '0x09bde339': 'InvalidProof',
  '0x464db2f8': 'InvalidBlockHeader',
  '0x285c2eea': 'InvalidPairOrdering',
};

/** TrustL2Reader revert selectors that map to CONTRACT_ERROR (configuration failures) */
const CONTRACT_ERROR_SELECTORS: Record<string, string> = {
  '0xf25ca59c': 'ChainNotRegistered',
  '0x77267b7d': 'ChainNotActive',
  '0x0b78bd4c': 'UnsupportedRollupType',
  '0xe6c4247b': 'InvalidAddress',
};

/** ProofOutdated() — pair already proven at this or a newer anchor (G5) */
const PROOF_OUTDATED_SELECTOR = '0x0aaac1a5';

/** Collect message + revert-data text from a (possibly nested) viem error chain */
function collectErrorText(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    const e = current as Error & { data?: unknown; cause?: unknown };
    parts.push(e.message);
    if (typeof e.data === 'string') parts.push(e.data);
    else if (e.data && typeof e.data === 'object' && typeof (e.data as { data?: unknown }).data === 'string') {
      parts.push((e.data as { data: string }).data);
    }
    current = e.cause;
  }
  return parts.join(' ').toLowerCase();
}

/** Map a proveL2UsdDelta revert to a typed AzethError by 4-byte selector (§4 rows 7–8, 16–18).
 *  Scans for KNOWN selectors only (no naive first-hex extraction — addresses would false-match). */
function mapProofRevert(err: unknown, proof: L2UsdDeltaProof, cached?: ProvenDeltaResult): AzethError {
  if (err instanceof AzethError) return err;
  const text = collectErrorText(err);

  if (text.includes(PROOF_OUTDATED_SELECTOR) || text.includes('proofoutdated')) {
    return new AzethError(
      `Pair already proven at L2 block ${cached?.l2BlockNumber ?? 'unknown'} ≥ current anchor ${proof.anchor.l2BlockNumber} (ProofOutdated) — re-prove after the anchor advances`,
      'PROOF_INVALID',
      {
        reason: 'ALREADY_PROVEN',
        cachedL2BlockNumber: cached?.l2BlockNumber,
        anchorL2BlockNumber: proof.anchor.l2BlockNumber,
      },
    );
  }

  for (const [selector, name] of Object.entries(PROOF_INVALID_SELECTORS)) {
    if (text.includes(selector) || text.includes(name.toLowerCase())) {
      return new AzethError(
        `TrustL2Reader rejected the proof (${name}) — regenerate against the current anchor`,
        'PROOF_INVALID',
        { selector },
      );
    }
  }

  for (const [selector, name] of Object.entries(CONTRACT_ERROR_SELECTORS)) {
    if (text.includes(selector) || text.includes(name.toLowerCase())) {
      if (name === 'ChainNotRegistered') {
        return new AzethError(
          `L2 chain ${proof.chainId} is not registered on TrustL2Reader`,
          'CONTRACT_ERROR',
          { chainId: proof.chainId, selector },
        );
      }
      if (name === 'ChainNotActive') {
        return new AzethError(
          `L2 chain ${proof.chainId} is registered but not active on TrustL2Reader`,
          'CONTRACT_ERROR',
          { chainId: proof.chainId, selector },
        );
      }
      return new AzethError(
        `TrustL2Reader reverted: ${name}`,
        'CONTRACT_ERROR',
        { selector },
      );
    }
  }

  return wrapContractError(err, 'CONTRACT_ERROR');
}

/** Simulate (eth_call) `proveL2UsdDelta`; broadcast ONLY when `options.broadcast === true`
 *  AND a funded L1 wallet client is supplied.
 *
 *  The broadcast path is a plain, permissionless L1 EOA transaction — no UserOp,
 *  bundler, paymaster, or guardian involvement; only L1 gas leaves the EOA.
 */
export async function proveL2UsdDelta(
  l1Client: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
  proof: L2UsdDeltaProof,
  options?: ProveL2UsdDeltaOptions,
): Promise<ProveL2UsdDeltaResult> {
  // Step 1 — replay pre-check (G5: never burn gas on a guaranteed ProofOutdated)
  const cached = await getProvenDelta(
    l1Client, readerAddress, proof.account0, proof.account1, proof.chainId,
  );
  if (cached.provenAt > 0n && proof.anchor.l2BlockNumber <= cached.l2BlockNumber) {
    if (options?.skipIfAlreadyProven === false) {
      throw new AzethError(
        `Pair already proven at L2 block ${cached.l2BlockNumber} ≥ current anchor ${proof.anchor.l2BlockNumber} (ProofOutdated) — re-prove after the anchor advances`,
        'PROOF_INVALID',
        {
          reason: 'ALREADY_PROVEN',
          cachedL2BlockNumber: cached.l2BlockNumber,
          anchorL2BlockNumber: proof.anchor.l2BlockNumber,
        },
      );
    }
    return {
      status: 'already-proven',
      account0: proof.account0,
      account1: proof.account1,
      chainId: proof.chainId,
      usdDelta: cached.usdDelta,
      anchorL2BlockNumber: cached.l2BlockNumber,
      cached,
    };
  }

  const args = [
    proof.chainId,
    proof.account0,
    proof.account1,
    proof.stateRootProof,
    proof.accountProof,
    proof.storageProof,
  ] as const;

  // Step 2 — simulate always (catches reverts before any gas is spent)
  let request: unknown;
  try {
    const sim = await withRetry(() => l1Client.simulateContract({
      address: readerAddress,
      abi: TrustL2ReaderAbi,
      functionName: 'proveL2UsdDelta',
      args,
      account: options?.l1WalletClient?.account,
    }));
    request = sim.request;
  } catch (err: unknown) {
    throw mapProofRevert(err, proof, cached);
  }

  // Step 3 — default path: simulation only
  if (!options?.broadcast) {
    return {
      status: 'simulated',
      account0: proof.account0,
      account1: proof.account1,
      chainId: proof.chainId,
      usdDelta: proof.usdDelta,
      anchorL2BlockNumber: proof.anchor.l2BlockNumber,
    };
  }

  // Step 4 — broadcast: require a funded L1 wallet and pre-check gas affordability
  const wallet = options.l1WalletClient;
  if (!wallet?.account) {
    throw new AzethError(
      'broadcast: true requires an l1WalletClient backed by a funded L1 account',
      'INVALID_INPUT',
    );
  }

  const gasEstimate = await withRetry(() => l1Client.estimateContractGas({
    address: readerAddress,
    abi: TrustL2ReaderAbi,
    functionName: 'proveL2UsdDelta',
    args,
    account: wallet.account,
  }));
  const gasPrice = await withRetry(() => l1Client.getGasPrice());
  const balance = await withRetry(() => l1Client.getBalance({ address: wallet.account.address }));
  const required = gasEstimate * gasPrice;
  if (balance < required) {
    const l1ChainName = l1Client.chain?.name ?? 'the L1 chain';
    throw new AzethError(
      `L1 wallet ${wallet.account.address} has insufficient ETH on ${l1ChainName} for proof submission: balance ${balance} wei, required ~${required} wei. Fund it with ${l1ChainName} ETH or run with broadcast=false`,
      'INSUFFICIENT_BALANCE',
      { balance, required, chain: l1ChainName },
    );
  }

  // Step 5 — submit the plain L1 transaction and (optionally) wait for the receipt
  let txHash: `0x${string}`;
  try {
    txHash = await wallet.writeContract(
      request as Parameters<WalletClient<Transport, Chain, Account>['writeContract']>[0],
    );
  } catch (err: unknown) {
    throw mapProofRevert(err, proof, cached);
  }

  // The tx is now on the network — from here on, NEVER lose txHash. A receipt
  // timeout or RPC failure after a successful broadcast is NOT a submission
  // failure: return status 'broadcast' with receiptStatus 'pending' instead of
  // leaking an untyped viem error that drops the hash (at the MCP boundary the
  // in-message hash gets redacted) and pushes callers into re-building +
  // re-submitting a proof that will then revert ProofOutdated.
  let receiptStatus: 'confirmed' | 'pending' = 'pending';
  if (options.waitForReceipt !== false) {
    let receiptOutcome: 'success' | 'reverted' | 'unknown';
    try {
      const receipt = await l1Client.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      receiptOutcome = receipt.status === 'reverted' ? 'reverted' : 'success';
    } catch {
      // WaitForTransactionReceiptTimeoutError or transient RPC failure — the
      // tx may still confirm; the caller tracks txHash.
      receiptOutcome = 'unknown';
    }
    if (receiptOutcome === 'reverted') {
      throw new AzethError('Transaction reverted', 'CONTRACT_ERROR', { txHash });
    }
    if (receiptOutcome === 'success') receiptStatus = 'confirmed';
  }

  return {
    status: 'broadcast',
    account0: proof.account0,
    account1: proof.account1,
    chainId: proof.chainId,
    usdDelta: proof.usdDelta,
    anchorL2BlockNumber: proof.anchor.l2BlockNumber,
    gasEstimate,
    txHash,
    receiptStatus,
  };
}
