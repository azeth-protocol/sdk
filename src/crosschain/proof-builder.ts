import { keccak256, encodeAbiParameters } from 'viem';
import type { Chain, PublicClient, Transport } from 'viem';
import { AzethError } from '@azeth/common';
import { TrustL2ReaderAbi } from '@azeth/common/abis';
import { withRetry } from '../utils/retry.js';
import {
  L2_TO_L1_MESSAGE_PASSER,
  OUTPUT_ROOT_VERSION_V0,
  canonicalizePair,
  computeTransferDeltaUSDSlot,
  decodeInt256Word,
} from './slots.js';
import { getL2ChainConfig, type L2ChainConfigResult } from './read.js';

/** Minimal external OP AnchorStateRegistry ABI — exported for tests */
export const ANCHOR_STATE_REGISTRY_ABI = [
  {
    type: 'function',
    name: 'anchors',
    stateMutability: 'view',
    inputs: [{ name: 'gameType', type: 'uint32' }],
    outputs: [
      { name: 'root', type: 'bytes32' },
      { name: 'l2BlockNumber', type: 'uint256' },
    ],
  },
] as const;

/** Current rollup anchor: output root + the L2 block it commits to */
export interface AnchorState {
  root: `0x${string}`;
  l2BlockNumber: bigint;
}

/** OP Stack v0 output-root preimage (field order matters — it is what gets hashed) */
export interface OutputRootPreimage {
  version: `0x${string}`;
  stateRoot: `0x${string}`;
  messagePasserStorageRoot: `0x${string}`;
  latestBlockhash: `0x${string}`;
}

/** Complete proof bundle for `TrustL2Reader.proveL2UsdDelta` */
export interface L2UsdDeltaProof {
  // calldata args (verbatim for proveL2UsdDelta)
  chainId: bigint;
  account0: `0x${string}`;
  account1: `0x${string}`;
  /** exactly 128 bytes: abi.encode(version, stateRoot, msgPasserRoot, blockHash) */
  stateRootProof: `0x${string}`;
  /** eth_getProof(...).accountProof verbatim */
  accountProof: `0x${string}`[];
  /** eth_getProof(...).storageProof[0].proof verbatim */
  storageProof: `0x${string}`[];
  // metadata (not sent on-chain)
  anchor: AnchorState;
  outputRootPreimage: OutputRootPreimage;
  slot: `0x${string}`;
  baseSlot: bigint;
  /** eth_getStorageAt(module, slot, anchorBlock) */
  rawSlotValue: `0x${string}`;
  /** int256; positive = account0 net-paid account1 (18-dec USD WAD) */
  usdDelta: bigint;
}

export interface BuildL2UsdDeltaProofParams {
  /** L2 chain id, e.g. 84532n */
  chainId: bigint;
  /** any order — builder canonicalizes */
  accountA: `0x${string}`;
  accountB: `0x${string}`;
}

/** RPC failures that indicate the L2 endpoint cannot serve archive state at the anchor block */
const ARCHIVE_ERROR_RE = /getProof|proof window|unsupported|405|403|archive|distance to target/i;

/** Map an L2 RPC throw to a typed AzethError (archive-incapable endpoints get an actionable cause) */
function mapL2RpcError(err: unknown, anchorL2BlockNumber: bigint): AzethError {
  if (err instanceof AzethError) return err;
  const message = err instanceof Error ? err.message : String(err);
  if (ARCHIVE_ERROR_RE.test(message)) {
    return new AzethError(
      `L2 RPC cannot serve state at anchor block ${anchorL2BlockNumber} (archive node required): ${message}`,
      'NETWORK_ERROR',
      { cause: 'archive', anchorL2BlockNumber },
    );
  }
  return new AzethError(message, 'NETWORK_ERROR', { cause: 'rpc' });
}

/** Pre-flight for proof building: reader chain config + baseSlot
 *  (runtime `TRANSFER_DELTA_USD_BASE_SLOT()` — never hardcoded) + current anchor.
 *
 *  @throws CONTRACT_ERROR when the chain is unregistered or inactive,
 *          INVALID_INPUT for non-OP-Stack rollups,
 *          PROOF_INVALID (`reason: 'MISSING_ANCHOR'`) when no usable anchor exists.
 */
export async function getAnchorState(
  l1Client: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
  chainId: bigint,
): Promise<{ config: L2ChainConfigResult; baseSlot: bigint; anchor: AnchorState }> {
  // Step 2 — chain config + guards
  const config = await getL2ChainConfig(l1Client, readerAddress, chainId);
  if (config.chainId === 0n) {
    throw new AzethError(
      `L2 chain ${chainId} is not registered on TrustL2Reader`,
      'CONTRACT_ERROR',
      { chainId },
    );
  }
  if (!config.active) {
    throw new AzethError(
      `L2 chain ${chainId} is registered but not active on TrustL2Reader`,
      'CONTRACT_ERROR',
      { chainId },
    );
  }
  if (config.rollupType !== 1) {
    throw new AzethError(
      `Only OP Stack rollups (rollupType 1) are supported for proof building; chain ${chainId} has rollupType ${config.rollupType}`,
      'INVALID_INPUT',
      { chainId, rollupType: config.rollupType },
    );
  }

  // Step 3 — runtime base slot (G2: auto-corrects after a reader redeploy)
  const baseSlot = await withRetry(() => l1Client.readContract({
    address: readerAddress,
    abi: TrustL2ReaderAbi,
    functionName: 'TRANSFER_DELTA_USD_BASE_SLOT',
    args: [],
  })) as bigint;

  // Step 4 — current anchor from the OP AnchorStateRegistry
  const [root, l2BlockNumber] = await withRetry(() => l1Client.readContract({
    address: config.stateRootSource,
    abi: ANCHOR_STATE_REGISTRY_ABI,
    functionName: 'anchors',
    args: [config.gameType],
  })) as readonly [`0x${string}`, bigint];

  if (BigInt(root) === 0n || l2BlockNumber === 0n) {
    throw new AzethError(
      `No usable anchor state root for chain ${chainId} (gameType ${config.gameType}) on ${config.stateRootSource} — the rollup has not posted an anchor yet`,
      'PROOF_INVALID',
      { reason: 'MISSING_ANCHOR', chainId, gameType: config.gameType },
    );
  }

  return { config, baseSlot, anchor: { root, l2BlockNumber } };
}

/** Build a complete, format-exact proof bundle for
 *  `transferDeltaUSD[account0][account1]` at the current rollup anchor.
 *
 *  All L2 reads (block header, message-passer proof, account/storage proof) target
 *  exactly the anchor's `l2BlockNumber` (~7 days old) — never `latest` — so the
 *  `l2ArchiveClient` must be a true archive endpoint serving `eth_getProof` that far back.
 *
 *  NOTE (current deployment): the live reader's `TRANSFER_DELTA_USD_BASE_SLOT()` is 6
 *  while the deployed module's `transferDeltaUSD` lives at slot 5, so real-data proofs
 *  revert `InvalidProof` until the reader is redeployed. This builder reads the base
 *  slot at runtime and works unchanged after the redeploy.
 */
export async function buildL2UsdDeltaProof(
  l1Client: PublicClient<Transport, Chain>,
  l2ArchiveClient: PublicClient<Transport, Chain>,
  readerAddress: `0x${string}`,
  params: BuildL2UsdDeltaProofParams,
): Promise<L2UsdDeltaProof> {
  // Step 1 — canonical ordering
  const { account0, account1 } = canonicalizePair(params.accountA, params.accountB);

  // Steps 2–4 — pre-flight: config + baseSlot + anchor
  const { config, baseSlot, anchor } = await getAnchorState(l1Client, readerAddress, params.chainId);

  // Steps 5–6 — L2 header + message-passer storage root at the anchor block
  let stateRoot: `0x${string}`;
  let blockHash: `0x${string}`;
  let messagePasserStorageRoot: `0x${string}`;
  try {
    const block = await withRetry(() => l2ArchiveClient.getBlock({ blockNumber: anchor.l2BlockNumber }));
    if (!block.hash || !block.stateRoot) {
      throw new AzethError(
        `L2 block ${anchor.l2BlockNumber} has no hash/stateRoot (pending or malformed RPC response)`,
        'NETWORK_ERROR',
        { cause: 'rpc' },
      );
    }
    stateRoot = block.stateRoot;
    blockHash = block.hash;

    const mp = await withRetry(() => l2ArchiveClient.getProof({
      address: L2_TO_L1_MESSAGE_PASSER,
      storageKeys: [],
      blockNumber: anchor.l2BlockNumber,
    }));
    messagePasserStorageRoot = mp.storageHash;
  } catch (err: unknown) {
    throw mapL2RpcError(err, anchor.l2BlockNumber);
  }

  // Step 7 — 128-byte abi.encode(version, stateRoot, msgPasserRoot, blockHash). NOT RLP (G8).
  const stateRootProof = encodeAbiParameters(
    [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
    [OUTPUT_ROOT_VERSION_V0, stateRoot, messagePasserStorageRoot, blockHash],
  );
  if ((stateRootProof.length - 2) / 2 !== 128) {
    throw new AzethError(
      'stateRootProof must be exactly 128 bytes',
      'PROOF_INVALID',
      { reason: 'ENCODING', length: (stateRootProof.length - 2) / 2 },
    );
  }

  // Step 8 — fail-fast preimage check against the L1 anchor root
  const computed = keccak256(stateRootProof);
  if (computed.toLowerCase() !== anchor.root.toLowerCase()) {
    throw new AzethError(
      `Output-root preimage mismatch: computed ${computed}, anchor ${anchor.root} — L2 RPC inconsistent with L1 anchor`,
      'PROOF_INVALID',
      { reason: 'ANCHOR_MISMATCH', computed, anchorRoot: anchor.root, l2BlockNumber: anchor.l2BlockNumber },
    );
  }

  // Step 9 — storage slot for the canonical pair
  const slot = computeTransferDeltaUSDSlot(account0, account1, baseSlot);

  // Step 10 — pre-read the slot value; zero deltas cannot be proven (G3: exclusion
  // proofs revert on-chain, so we never even call eth_getProof for them).
  let rawSlotValue: `0x${string}` | undefined;
  try {
    rawSlotValue = await withRetry(() => l2ArchiveClient.getStorageAt({
      address: config.reputationModule,
      slot,
      blockNumber: anchor.l2BlockNumber,
    }));
  } catch (err: unknown) {
    throw mapL2RpcError(err, anchor.l2BlockNumber);
  }
  if (rawSlotValue === undefined || BigInt(rawSlotValue) === 0n) {
    throw new AzethError(
      `transferDeltaUSD[${account0}][${account1}] is zero at anchor block ${anchor.l2BlockNumber} on chain ${params.chainId} — zero values cannot be proven (exclusion proofs revert on-chain)`,
      'PROOF_INVALID',
      { reason: 'ZERO_DELTA', slot, anchorL2BlockNumber: anchor.l2BlockNumber },
    );
  }

  // Step 11 — MPT proofs, passed verbatim (G8: never re-wrap or concatenate; the
  // contract keccak-hashes the pre-hash keys itself).
  let accountProof: `0x${string}`[];
  let storageProof: `0x${string}`[];
  try {
    const proofResp = await withRetry(() => l2ArchiveClient.getProof({
      address: config.reputationModule,
      storageKeys: [slot],
      blockNumber: anchor.l2BlockNumber,
    }));
    const slotProof = proofResp.storageProof[0];
    if (!slotProof || BigInt(slotProof.value) !== BigInt(rawSlotValue)) {
      throw new AzethError(
        'Inconsistent eth_getProof response from L2 RPC (storage value mismatch)',
        'PROOF_INVALID',
        { reason: 'RPC_INCONSISTENT', slot },
      );
    }
    accountProof = proofResp.accountProof as `0x${string}`[];
    storageProof = slotProof.proof as `0x${string}`[];
  } catch (err: unknown) {
    throw mapL2RpcError(err, anchor.l2BlockNumber);
  }

  // Step 12 — decode int256 two's-complement
  const usdDelta = decodeInt256Word(rawSlotValue);

  return {
    chainId: params.chainId,
    account0,
    account1,
    stateRootProof,
    accountProof,
    storageProof,
    anchor,
    outputRootPreimage: {
      version: OUTPUT_ROOT_VERSION_V0,
      stateRoot,
      messagePasserStorageRoot,
      latestBlockhash: blockHash,
    },
    slot,
    baseSlot,
    rawSlotValue,
    usdDelta,
  };
}
