import { describe, it, expect } from 'vitest';
import { toHex } from 'viem';
import { AzethError } from '@azeth/common';
import {
  canonicalizePair,
  computeTransferDeltaUSDSlot,
  decodeInt256Word,
  L2_TO_L1_MESSAGE_PASSER,
  OUTPUT_ROOT_VERSION_V0,
} from '../../src/crosschain/slots.js';
import { FIXTURE_PAIR, SLOT_BASE5, SLOT_BASE6 } from '../fixtures/proofs.js';

const A = FIXTURE_PAIR.account0; // 0x11…
const B = FIXTURE_PAIR.account1; // 0x22…

describe('crosschain/slots', () => {
  describe('constants', () => {
    it('exports the OP Stack predeploy and v0 version', () => {
      expect(L2_TO_L1_MESSAGE_PASSER).toBe('0x4200000000000000000000000000000000000016');
      expect(OUTPUT_ROOT_VERSION_V0).toBe(`0x${'00'.repeat(32)}`);
    });
  });

  describe('canonicalizePair', () => {
    it('orders addresses ascending numerically and flags flipped inputs', () => {
      const forward = canonicalizePair(A, B);
      expect(forward).toEqual({ account0: A, account1: B, flipped: false });

      const reversed = canonicalizePair(B, A);
      expect(reversed).toEqual({ account0: A, account1: B, flipped: true });
    });

    it('throws INVALID_INPUT for equal addresses (case-insensitive)', () => {
      try {
        canonicalizePair(A, A.toUpperCase().replace('0X', '0x') as `0x${string}`);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AzethError);
        expect((err as AzethError).code).toBe('INVALID_INPUT');
        expect((err as AzethError).message).toContain('must differ');
      }
    });

    it('throws INVALID_INPUT for malformed addresses', () => {
      expect(() => canonicalizePair('0x1234' as `0x${string}`, B)).toThrow(AzethError);
      try {
        canonicalizePair(A, 'not-an-address' as `0x${string}`);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as AzethError).code).toBe('INVALID_INPUT');
      }
    });
  });

  describe('computeTransferDeltaUSDSlot', () => {
    it('matches the known-answer slot for base slot 5', () => {
      expect(computeTransferDeltaUSDSlot(A, B, 5n)).toBe(SLOT_BASE5);
    });

    it('matches the known-answer slot for base slot 6', () => {
      expect(computeTransferDeltaUSDSlot(A, B, 6n)).toBe(SLOT_BASE6);
    });

    it('throws INVALID_INPUT unless account0 < account1 (strict)', () => {
      try {
        computeTransferDeltaUSDSlot(B, A, 6n);
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as AzethError).code).toBe('INVALID_INPUT');
        expect((err as AzethError).message).toContain('strictly less');
      }
      // equal addresses also rejected
      expect(() => computeTransferDeltaUSDSlot(A, A, 6n)).toThrow('strictly less');
    });
  });

  describe('decodeInt256Word', () => {
    it('decodes positive, negative (two\'s complement), zero, and min-int256 words', () => {
      // positive 100e18
      expect(decodeInt256Word(toHex(100n * 10n ** 18n, { size: 32 }))).toBe(100n * 10n ** 18n);

      // negative -5e18 round-trips through two's complement
      const negWord = toHex((1n << 256n) - 5n * 10n ** 18n, { size: 32 });
      expect(decodeInt256Word(negWord)).toBe(-5n * 10n ** 18n);

      // zero word
      expect(decodeInt256Word(toHex(0n, { size: 32 }))).toBe(0n);

      // 0x80…00 → -2^255 (int256 minimum)
      expect(decodeInt256Word(`0x80${'00'.repeat(31)}`)).toBe(-(1n << 255n));
    });
  });
});
