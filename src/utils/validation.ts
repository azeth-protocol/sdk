import { AzethError } from '@azeth/common';

/** Validate that a string is a valid Ethereum address (0x + 40 hex chars).
 *  L-12 fix (Audit #8): Also rejects the zero address to prevent accidental fund burns. */
export function validateAddress(address: string, fieldName: string): void {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) {
    throw new AzethError(
      'Invalid Ethereum address format',
      'INVALID_INPUT',
      { field: fieldName },
    );
  }
  if (address === '0x0000000000000000000000000000000000000000') {
    throw new AzethError(
      'Cannot use the zero address',
      'INVALID_INPUT',
      { field: fieldName },
    );
  }
}

/** Validate that a URL is well-formed HTTP(S). Optionally require HTTPS. */
export function validateUrl(url: string, fieldName: string, requireHttps = false): void {
  try {
    const parsed = new URL(url);
    if (requireHttps && parsed.protocol !== 'https:') {
      throw new AzethError('URL must use HTTPS', 'INVALID_INPUT', { field: fieldName });
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new AzethError('URL must use HTTP or HTTPS', 'INVALID_INPUT', { field: fieldName });
    }
  } catch (e) {
    if (e instanceof AzethError) throw e;
    throw new AzethError('Invalid URL format', 'INVALID_INPUT', { field: fieldName });
  }
}

/** Validate that a bigint amount is positive */
export function validatePositiveAmount(amount: bigint, fieldName: string): void {
  if (amount <= 0n) {
    throw new AzethError(
      `Invalid ${fieldName}: must be greater than 0`,
      'INVALID_INPUT',
      { field: fieldName, value: amount.toString() },
    );
  }
}
