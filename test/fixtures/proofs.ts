import { vi } from 'vitest';
import { encodeAbiParameters, toHex } from 'viem';
import { TEST_OWNER, TEST_ACCOUNT, createMockPublicClient } from './mocks.js';
import { L2_TO_L1_MESSAGE_PASSER, OUTPUT_ROOT_VERSION_V0 } from '../../src/crosschain/slots.js';
import type { L2UsdDeltaProof } from '../../src/crosschain/proof-builder.js';

/** Canonical fixture pair: 0x11… < 0x22… */
export const FIXTURE_PAIR = {
  account0: TEST_OWNER,
  account1: TEST_ACCOUNT,
} as const;

/** Known-answer slot for transferDeltaUSD[0x11…][0x22…] with base slot 5 */
export const SLOT_BASE5 = '0xf825e63208a6fe6bdf5e6738b6a0d95f8b34351bc772559bbdc14f4a1baf692e' as `0x${string}`;
/** Known-answer slot for transferDeltaUSD[0x11…][0x22…] with base slot 6 */
export const SLOT_BASE6 = '0x029a297e5f7d419f837429c2cd28c3e7acfbb718a07d794870f51a264e1cb5fe' as `0x${string}`;

/** OP Stack v0 output-root preimage fields at the mock anchor block */
export const MOCK_PREIMAGE = {
  version: OUTPUT_ROOT_VERSION_V0,
  stateRoot: `0x${'aa'.repeat(32)}` as `0x${string}`,
  messagePasserStorageRoot: `0x${'bb'.repeat(32)}` as `0x${string}`,
  latestBlockhash: `0x${'cc'.repeat(32)}` as `0x${string}`,
} as const;

/** The exact 128-byte abi.encode(version, stateRoot, msgPasserRoot, blockHash) of MOCK_PREIMAGE */
export const MOCK_STATE_ROOT_PROOF = encodeAbiParameters(
  [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
  [MOCK_PREIMAGE.version, MOCK_PREIMAGE.stateRoot, MOCK_PREIMAGE.messagePasserStorageRoot, MOCK_PREIMAGE.latestBlockhash],
);

/** Anchor whose root is exactly keccak256(MOCK_STATE_ROOT_PROOF) — format-exact */
export const MOCK_ANCHOR = {
  root: '0x42407e3f5e221c8842bdc0a0ad91840a35b813864435fa556d24673995121da9' as `0x${string}`,
  l2BlockNumber: 42329663n,
} as const;

/** Synthetic RLP-shaped MPT account-proof nodes (≥2 nodes, root→leaf) */
export const MOCK_ACCOUNT_PROOF: `0x${string}`[] = [
  `0xf90211a0${'11'.repeat(32)}a0${'12'.repeat(32)}` as `0x${string}`,
  `0xf86d9d3a${'13'.repeat(28)}b84cf84a0186${'14'.repeat(20)}` as `0x${string}`,
];

/** Synthetic RLP-shaped MPT storage-proof nodes (≥2 nodes, root→leaf) */
export const MOCK_STORAGE_PROOF: `0x${string}`[] = [
  `0xf8b1a0${'21'.repeat(32)}a0${'22'.repeat(32)}` as `0x${string}`,
  `0xe9a02061${'23'.repeat(30)}87868594${'24'.repeat(4)}` as `0x${string}`,
];

/** Registered Base Sepolia config as returned by getChainConfig(84532) */
export const MOCK_CHAIN_CONFIG = {
  chainId: 84532n,
  stateRootSource: '0x2fF5cC82dBf333Ea30D8ee462178ab1707315355' as `0x${string}`,
  reputationModule: '0xB8C98ace6bdB25f5AEb2031150A5944F3135ccC0' as `0x${string}`,
  rollupType: 1,
  gameType: 0,
  active: true,
} as const;

/** 100e18 (positive int256) as a 32-byte storage word */
export const POSITIVE_SLOT_WORD = toHex(100n * 10n ** 18n, { size: 32 });
/** -5e18 (negative int256, two's complement) as a 32-byte storage word */
export const NEGATIVE_SLOT_WORD = toHex((1n << 256n) - 5n * 10n ** 18n, { size: 32 });
/** zero word */
export const ZERO_SLOT_WORD = toHex(0n, { size: 32 });

/** A complete, internally consistent proof bundle for prove/kit tests */
export const MOCK_PROOF: L2UsdDeltaProof = {
  chainId: 84532n,
  account0: FIXTURE_PAIR.account0,
  account1: FIXTURE_PAIR.account1,
  stateRootProof: MOCK_STATE_ROOT_PROOF,
  accountProof: MOCK_ACCOUNT_PROOF,
  storageProof: MOCK_STORAGE_PROOF,
  anchor: { ...MOCK_ANCHOR },
  outputRootPreimage: { ...MOCK_PREIMAGE },
  slot: SLOT_BASE6,
  baseSlot: 6n,
  rawSlotValue: POSITIVE_SLOT_WORD,
  usdDelta: 100n * 10n ** 18n,
};

/** readContract switch values that a happy-path L1 TrustL2Reader mock should return.
 *  Override any entry with a value or a `(params) => value` function (throw inside to simulate reverts). */
export type L1ReaderOverrides = Record<string, unknown | ((params: { functionName: string; address: `0x${string}`; args?: readonly unknown[] }) => unknown)>;

/** Mock L1 public client whose readContract switches on functionName (TrustL2Reader + AnchorStateRegistry) */
export function mockL1Reader(overrides: L1ReaderOverrides = {}) {
  const defaults: L1ReaderOverrides = {
    getChainConfig: { ...MOCK_CHAIN_CONFIG },
    TRANSFER_DELTA_USD_BASE_SLOT: 6n,
    anchors: [MOCK_ANCHOR.root, MOCK_ANCHOR.l2BlockNumber],
    getProvenDelta: { usdDelta: 0n, l2BlockNumber: 0n, provenAt: 0n },
    getProvenNetPaidUSD: 0n,
    getAggregateNetPaidUSD: 0n,
    getRegisteredChainIds: [84532n],
  };

  const readContract = vi.fn().mockImplementation(
    async (params: { functionName: string; address: `0x${string}`; args?: readonly unknown[] }) => {
      const entry = overrides[params.functionName] !== undefined
        ? overrides[params.functionName]
        : defaults[params.functionName];
      if (entry === undefined) {
        throw new Error(`mockL1Reader: unmocked functionName ${params.functionName}`);
      }
      return typeof entry === 'function'
        ? (entry as (p: typeof params) => unknown)(params)
        : entry;
    },
  );

  return createMockPublicClient({
    readContract,
    chain: { id: 11155111, name: 'Ethereum Sepolia' },
  });
}

export interface MockL2ArchiveOptions {
  /** Value the module-slot eth_getProof reports (defaults to BigInt(slotValue)) */
  storageProofValue?: bigint;
  /** Reject every getProof call with this error (archive-incapable RPC simulation) */
  getProofError?: Error;
}

/** Mock L2 archive client: getBlock/getProof/getStorageAt returning fixture-consistent data.
 *  getProof distinguishes the L2ToL1MessagePasser from the ReputationModule by address. */
export function mockL2Archive(slotValue: `0x${string}` = POSITIVE_SLOT_WORD, options: MockL2ArchiveOptions = {}) {
  const getBlock = vi.fn().mockResolvedValue({
    number: MOCK_ANCHOR.l2BlockNumber,
    stateRoot: MOCK_PREIMAGE.stateRoot,
    hash: MOCK_PREIMAGE.latestBlockhash,
    timestamp: 1700000000n,
  });

  const getProof = vi.fn().mockImplementation(
    async (params: { address: `0x${string}`; storageKeys: `0x${string}`[]; blockNumber?: bigint }) => {
      if (options.getProofError) throw options.getProofError;
      if (params.address.toLowerCase() === L2_TO_L1_MESSAGE_PASSER.toLowerCase()) {
        return {
          address: params.address,
          accountProof: [`0xf90211a0${'31'.repeat(32)}` as `0x${string}`],
          storageHash: MOCK_PREIMAGE.messagePasserStorageRoot,
          storageProof: [],
        };
      }
      return {
        address: params.address,
        accountProof: MOCK_ACCOUNT_PROOF,
        storageHash: `0x${'dd'.repeat(32)}` as `0x${string}`,
        storageProof: [
          {
            key: params.storageKeys[0],
            proof: MOCK_STORAGE_PROOF,
            value: options.storageProofValue ?? BigInt(slotValue),
          },
        ],
      };
    },
  );

  const getStorageAt = vi.fn().mockResolvedValue(slotValue);

  return createMockPublicClient({ getBlock, getProof, getStorageAt, chain: { id: 84532 } });
}
