import { keccak256, encodeAbiParameters } from 'viem';
import { AzethError } from '@azeth/common';

/** OP Stack L2ToL1MessagePasser predeploy (source of messagePasserStorageRoot) */
export const L2_TO_L1_MESSAGE_PASSER: `0x${string}` = '0x4200000000000000000000000000000000000016';

/** v0 output-root version (bytes32 zero) */
export const OUTPUT_ROOT_VERSION_V0: `0x${string}` = `0x${'00'.repeat(32)}` as `0x${string}`;

/** A canonically ordered account pair (account0 < account1 numerically) */
export interface CanonicalPair {
  account0: `0x${string}`;
  account1: `0x${string}`;
  /** true when the inputs were supplied in (b, a) order and got swapped */
  flipped: boolean;
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Order (a, b) so account0 < account1 numerically.
 *
 *  @throws AzethError INVALID_INPUT if the addresses are equal or malformed.
 */
export function canonicalizePair(a: `0x${string}`, b: `0x${string}`): CanonicalPair {
  if (!ADDRESS_RE.test(a)) {
    throw new AzethError('Invalid address for accountA', 'INVALID_INPUT', { field: 'accountA' });
  }
  if (!ADDRESS_RE.test(b)) {
    throw new AzethError('Invalid address for accountB', 'INVALID_INPUT', { field: 'accountB' });
  }

  const aValue = BigInt(a.toLowerCase());
  const bValue = BigInt(b.toLowerCase());

  if (aValue === bValue) {
    throw new AzethError('account0 and account1 must differ', 'INVALID_INPUT', { accountA: a });
  }

  if (aValue < bValue) {
    return { account0: a, account1: b, flipped: false };
  }
  return { account0: b, account1: a, flipped: true };
}

/** Compute the storage slot of `ReputationModule.transferDeltaUSD[account0][account1]`.
 *
 *  Formula (mirrors L2ProofLib.computeTransferDeltaUSDSlot):
 *    innerSlot = keccak256(abi.encode(account0, baseSlot))
 *    slot      = keccak256(abi.encode(account1, innerSlot))
 *  — addresses left-padded to 32 bytes, keys in declared mapping order.
 *
 *  @param baseSlot - The mapping's base slot. Read it at runtime from
 *    `TrustL2Reader.TRANSFER_DELTA_USD_BASE_SLOT()` — never hardcode (the current
 *    deployment uses 6 while the deployed module's variable lives at slot 5; a
 *    reader redeploy will correct this and the SDK picks it up automatically).
 *  @throws AzethError INVALID_INPUT unless account0 < account1 (strict).
 */
export function computeTransferDeltaUSDSlot(
  account0: `0x${string}`,
  account1: `0x${string}`,
  baseSlot: bigint,
): `0x${string}` {
  if (!ADDRESS_RE.test(account0) || !ADDRESS_RE.test(account1)) {
    throw new AzethError('Invalid address for account pair', 'INVALID_INPUT', { account0, account1 });
  }
  if (BigInt(account0.toLowerCase()) >= BigInt(account1.toLowerCase())) {
    throw new AzethError(
      'account0 must be strictly less than account1 (canonical pair ordering)',
      'INVALID_INPUT',
    );
  }

  const innerSlot = keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [account0, baseSlot]),
  );
  return keccak256(
    encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [account1, innerSlot]),
  );
}

const TWO_POW_255 = 1n << 255n;
const TWO_POW_256 = 1n << 256n;

/** Decode a bytes32 storage word as int256 two's-complement
 *  (value > 2^255 - 1 → value - 2^256). */
export function decodeInt256Word(word: `0x${string}`): bigint {
  const value = BigInt(word);
  return value >= TWO_POW_255 ? value - TWO_POW_256 : value;
}
