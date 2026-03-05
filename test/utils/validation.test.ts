import { describe, it, expect } from 'vitest';
import { validateAddress, validateUrl, validatePositiveAmount } from '../../src/utils/validation.js';
import { AzethError } from '@azeth/common';

describe('validateAddress', () => {
  it('accepts a valid checksummed Ethereum address', () => {
    expect(() => validateAddress('0xABCDEF1234567890abcdef1234567890ABCDEF12', 'recipient')).not.toThrow();
  });

  it('accepts a valid lowercase Ethereum address', () => {
    expect(() => validateAddress('0x1234567890abcdef1234567890abcdef12345678', 'to')).not.toThrow();
  });

  it('rejects address without 0x prefix', () => {
    expect(() => validateAddress('1234567890abcdef1234567890abcdef12345678', 'addr'))
      .toThrow(AzethError);
  });

  it('rejects address that is too short', () => {
    expect(() => validateAddress('0x1234', 'addr'))
      .toThrow(AzethError);
  });

  it('rejects address that is too long', () => {
    expect(() => validateAddress('0x1234567890abcdef1234567890abcdef1234567890', 'addr'))
      .toThrow(AzethError);
  });

  it('rejects address with non-hex characters', () => {
    expect(() => validateAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG', 'addr'))
      .toThrow(AzethError);
  });

  it('includes field name and value in error details', () => {
    try {
      validateAddress('invalid', 'myField');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzethError);
      const azethErr = err as AzethError;
      expect(azethErr.code).toBe('INVALID_INPUT');
      expect(azethErr.details?.field).toBe('myField');
      // Address value is intentionally not included in error details (M-2 security fix)
    }
  });

  it('rejects empty string', () => {
    expect(() => validateAddress('', 'addr')).toThrow(AzethError);
  });
});

describe('validateUrl', () => {
  it('accepts https URL', () => {
    expect(() => validateUrl('https://api.example.com/v1', 'endpoint')).not.toThrow();
  });

  it('accepts http URL', () => {
    expect(() => validateUrl('http://localhost:3000', 'endpoint')).not.toThrow();
  });

  it('rejects URL without protocol', () => {
    expect(() => validateUrl('api.example.com', 'endpoint')).toThrow(AzethError);
  });

  it('rejects ftp URLs', () => {
    expect(() => validateUrl('ftp://example.com', 'endpoint')).toThrow(AzethError);
  });

  it('includes field name in error details', () => {
    try {
      validateUrl('invalid-url', 'serviceEndpoint');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzethError);
      const azethErr = err as AzethError;
      expect(azethErr.code).toBe('INVALID_INPUT');
      expect(azethErr.details?.field).toBe('serviceEndpoint');
    }
  });
});

describe('validatePositiveAmount', () => {
  it('accepts positive bigint', () => {
    expect(() => validatePositiveAmount(1n, 'amount')).not.toThrow();
  });

  it('accepts large positive bigint', () => {
    expect(() => validatePositiveAmount(1000000000000000000n, 'amount')).not.toThrow();
  });

  it('rejects zero', () => {
    expect(() => validatePositiveAmount(0n, 'amount')).toThrow(AzethError);
  });

  it('rejects negative bigint', () => {
    expect(() => validatePositiveAmount(-1n, 'amount')).toThrow(AzethError);
  });

  it('includes field name and value in error details', () => {
    try {
      validatePositiveAmount(0n, 'txAmount');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzethError);
      const azethErr = err as AzethError;
      expect(azethErr.code).toBe('INVALID_INPUT');
      expect(azethErr.details?.field).toBe('txAmount');
      expect(azethErr.details?.value).toBe('0');
    }
  });
});
