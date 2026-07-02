import { describe, it, expect } from 'vitest';
import { keccak256, encodeAbiParameters } from 'viem';
import { AzethError } from '@azeth/common';
import {
  buildL2UsdDeltaProof,
  getAnchorState,
  ANCHOR_STATE_REGISTRY_ABI,
} from '../../src/crosschain/proof-builder.js';
import { L2_TO_L1_MESSAGE_PASSER, OUTPUT_ROOT_VERSION_V0 } from '../../src/crosschain/slots.js';
import {
  FIXTURE_PAIR,
  SLOT_BASE5,
  SLOT_BASE6,
  MOCK_PREIMAGE,
  MOCK_STATE_ROOT_PROOF,
  MOCK_ANCHOR,
  MOCK_ACCOUNT_PROOF,
  MOCK_STORAGE_PROOF,
  MOCK_CHAIN_CONFIG,
  POSITIVE_SLOT_WORD,
  NEGATIVE_SLOT_WORD,
  ZERO_SLOT_WORD,
  mockL1Reader,
  mockL2Archive,
} from '../fixtures/proofs.js';

const READER = '0xB28fEA196dcc198D92ee05962Cf4204a111F5d7d' as `0x${string}`;
const PARAMS = { chainId: 84532n, accountA: FIXTURE_PAIR.account0, accountB: FIXTURE_PAIR.account1 };

async function expectAzethError(
  promise: Promise<unknown>,
  code: string,
  reason?: string,
): Promise<AzethError> {
  try {
    await promise;
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(AzethError);
    const azethErr = err as AzethError;
    expect(azethErr.code).toBe(code);
    if (reason !== undefined) {
      expect(azethErr.details?.['reason']).toBe(reason);
    }
    return azethErr;
  }
  throw new Error('unreachable');
}

describe('crosschain/proof-builder', () => {
  it('builds a 128-byte abi-encoded stateRootProof whose keccak equals the anchor root', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive();

    const proof = await buildL2UsdDeltaProof(l1, l2, READER, PARAMS);

    const expected = encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }],
      [OUTPUT_ROOT_VERSION_V0, MOCK_PREIMAGE.stateRoot, MOCK_PREIMAGE.messagePasserStorageRoot, MOCK_PREIMAGE.latestBlockhash],
    );
    expect(proof.stateRootProof).toBe(expected);
    expect(proof.stateRootProof).toBe(MOCK_STATE_ROOT_PROOF);
    expect((proof.stateRootProof.length - 2) / 2).toBe(128);
    expect(keccak256(proof.stateRootProof)).toBe(MOCK_ANCHOR.root);
    expect(proof.outputRootPreimage).toEqual({ ...MOCK_PREIMAGE });
    expect(proof.anchor).toEqual({ ...MOCK_ANCHOR });
  });

  it('reads TRANSFER_DELTA_USD_BASE_SLOT from the reader and derives the slot from it', async () => {
    const l1 = mockL1Reader({ TRANSFER_DELTA_USD_BASE_SLOT: 5n });
    const l2 = mockL2Archive();

    const proof = await buildL2UsdDeltaProof(l1, l2, READER, PARAMS);

    expect(proof.baseSlot).toBe(5n);
    expect(proof.slot).toBe(SLOT_BASE5);
    expect(l2.getStorageAt).toHaveBeenCalledWith(expect.objectContaining({ slot: SLOT_BASE5 }));
    expect(l2.getProof).toHaveBeenCalledWith(expect.objectContaining({ storageKeys: [SLOT_BASE5] }));
  });

  it('calls anchors on config.stateRootSource with the config gameType and pins every L2 read to the anchor block', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive();

    await buildL2UsdDeltaProof(l1, l2, READER, PARAMS);

    const anchorsCall = l1.readContract.mock.calls.find(
      (c: [{ functionName: string }]) => c[0].functionName === 'anchors',
    );
    expect(anchorsCall).toBeDefined();
    expect(anchorsCall![0]).toMatchObject({
      address: MOCK_CHAIN_CONFIG.stateRootSource,
      abi: ANCHOR_STATE_REGISTRY_ABI,
      args: [0],
    });

    expect(l2.getBlock).toHaveBeenCalledWith({ blockNumber: MOCK_ANCHOR.l2BlockNumber });
    for (const call of l2.getProof.mock.calls) {
      expect(call[0].blockNumber).toBe(MOCK_ANCHOR.l2BlockNumber);
    }
    expect(l2.getStorageAt).toHaveBeenCalledWith(
      expect.objectContaining({ blockNumber: MOCK_ANCHOR.l2BlockNumber }),
    );
  });

  it('fetches the message-passer storage root via getProof for 0x42…0016 with empty storageKeys', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive();

    await buildL2UsdDeltaProof(l1, l2, READER, PARAMS);

    expect(l2.getProof).toHaveBeenCalledWith(expect.objectContaining({
      address: L2_TO_L1_MESSAGE_PASSER,
      storageKeys: [],
      blockNumber: MOCK_ANCHOR.l2BlockNumber,
    }));
  });

  it('passes accountProof and storageProof through verbatim (no re-wrap)', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive();

    const proof = await buildL2UsdDeltaProof(l1, l2, READER, PARAMS);

    // strict identity — the builder must NOT copy/re-wrap the node arrays
    expect(proof.accountProof).toBe(MOCK_ACCOUNT_PROOF);
    expect(proof.storageProof).toBe(MOCK_STORAGE_PROOF);
  });

  it('decodes negative slot values as two\'s-complement int256 and still builds', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive(NEGATIVE_SLOT_WORD);

    const proof = await buildL2UsdDeltaProof(l1, l2, READER, PARAMS);

    expect(proof.usdDelta).toBe(-5n * 10n ** 18n);
    expect(proof.rawSlotValue).toBe(NEGATIVE_SLOT_WORD);

    // positive control
    const positive = await buildL2UsdDeltaProof(mockL1Reader(), mockL2Archive(POSITIVE_SLOT_WORD), READER, PARAMS);
    expect(positive.usdDelta).toBe(100n * 10n ** 18n);
  });

  it('canonicalizes (B, A) inputs so account0 < account1', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive();

    const proof = await buildL2UsdDeltaProof(l1, l2, READER, {
      chainId: 84532n,
      accountA: FIXTURE_PAIR.account1, // reversed on purpose
      accountB: FIXTURE_PAIR.account0,
    });

    expect(proof.account0).toBe(FIXTURE_PAIR.account0);
    expect(proof.account1).toBe(FIXTURE_PAIR.account1);
    expect(proof.slot).toBe(SLOT_BASE6);
  });

  it('throws PROOF_INVALID ZERO_DELTA for zero slot values WITHOUT calling getProof for the module slot (G3)', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive(ZERO_SLOT_WORD);

    await expectAzethError(buildL2UsdDeltaProof(l1, l2, READER, PARAMS), 'PROOF_INVALID', 'ZERO_DELTA');

    // only the message-passer getProof happened — never the reputation-module one
    const moduleProofCalls = l2.getProof.mock.calls.filter(
      (c: [{ address: string }]) => c[0].address.toLowerCase() === MOCK_CHAIN_CONFIG.reputationModule.toLowerCase(),
    );
    expect(moduleProofCalls).toHaveLength(0);
  });

  it('throws PROOF_INVALID MISSING_ANCHOR when the anchor root is zero', async () => {
    const l1 = mockL1Reader({ anchors: [`0x${'00'.repeat(32)}`, 0n] });
    const l2 = mockL2Archive();

    const err = await expectAzethError(buildL2UsdDeltaProof(l1, l2, READER, PARAMS), 'PROOF_INVALID', 'MISSING_ANCHOR');
    expect(err.message).toContain('No usable anchor state root');
  });

  it('throws PROOF_INVALID ANCHOR_MISMATCH when the preimage does not hash to the anchor root', async () => {
    const l1 = mockL1Reader({ anchors: [`0x${'ff'.repeat(32)}`, MOCK_ANCHOR.l2BlockNumber] });
    const l2 = mockL2Archive();

    const err = await expectAzethError(buildL2UsdDeltaProof(l1, l2, READER, PARAMS), 'PROOF_INVALID', 'ANCHOR_MISMATCH');
    expect(err.message).toContain('Output-root preimage mismatch');
    expect(err.details?.['anchorRoot']).toBe(`0x${'ff'.repeat(32)}`);
  });

  it('throws CONTRACT_ERROR when getChainConfig reports chainId 0 (unregistered)', async () => {
    const l1 = mockL1Reader({ getChainConfig: { ...MOCK_CHAIN_CONFIG, chainId: 0n } });
    const l2 = mockL2Archive();

    const err = await expectAzethError(buildL2UsdDeltaProof(l1, l2, READER, PARAMS), 'CONTRACT_ERROR');
    expect(err.message).toContain('not registered');
  });

  it('throws CONTRACT_ERROR when the chain is registered but inactive', async () => {
    const l1 = mockL1Reader({ getChainConfig: { ...MOCK_CHAIN_CONFIG, active: false } });
    const l2 = mockL2Archive();

    const err = await expectAzethError(buildL2UsdDeltaProof(l1, l2, READER, PARAMS), 'CONTRACT_ERROR');
    expect(err.message).toContain('not active');
  });

  it('throws INVALID_INPUT for non-OP-Stack rollup types', async () => {
    const l1 = mockL1Reader({ getChainConfig: { ...MOCK_CHAIN_CONFIG, rollupType: 2 } });
    const l2 = mockL2Archive();

    const err = await expectAzethError(buildL2UsdDeltaProof(l1, l2, READER, PARAMS), 'INVALID_INPUT');
    expect(err.message).toContain('rollupType 2');
  });

  it('maps proof-window RPC rejections to NETWORK_ERROR with cause archive (G7)', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive(POSITIVE_SLOT_WORD, {
      getProofError: new Error('distance to target block exceeds maximum proof window'),
    });

    const err = await expectAzethError(buildL2UsdDeltaProof(l1, l2, READER, PARAMS), 'NETWORK_ERROR');
    expect(err.details?.['cause']).toBe('archive');
    expect(err.details?.['anchorL2BlockNumber']).toBe(MOCK_ANCHOR.l2BlockNumber);
    expect(err.message).toContain('archive node required');
  });

  it('throws PROOF_INVALID RPC_INCONSISTENT when getProof storage value disagrees with getStorageAt', async () => {
    const l1 = mockL1Reader();
    const l2 = mockL2Archive(POSITIVE_SLOT_WORD, { storageProofValue: 1n });

    await expectAzethError(buildL2UsdDeltaProof(l1, l2, READER, PARAMS), 'PROOF_INVALID', 'RPC_INCONSISTENT');
  });

  describe('getAnchorState', () => {
    it('returns config, runtime baseSlot, and the current anchor', async () => {
      const l1 = mockL1Reader();

      const { config, baseSlot, anchor } = await getAnchorState(l1, READER, 84532n);

      expect(config.chainId).toBe(84532n);
      expect(config.stateRootSource).toBe(MOCK_CHAIN_CONFIG.stateRootSource);
      expect(baseSlot).toBe(6n);
      expect(anchor).toEqual({ ...MOCK_ANCHOR });
    });
  });
});
