import { describe, it, expect } from 'vitest';
import { isUsableEndpoint } from '@azeth/common';

describe('isUsableEndpoint (F8 endpoint hygiene)', () => {
  it('accepts real public http(s) URLs', () => {
    expect(isUsableEndpoint('https://api.azeth.ai/api/v1/pricing')).toBe(true);
    expect(isUsableEndpoint('http://my-service.io/x')).toBe(true);
  });

  it('rejects blank / whitespace / nullish', () => {
    expect(isUsableEndpoint(undefined)).toBe(false);
    expect(isUsableEndpoint(null)).toBe(false);
    expect(isUsableEndpoint('')).toBe(false);
    expect(isUsableEndpoint(' ')).toBe(false);
  });

  it('rejects placeholder and ephemeral-tunnel hosts', () => {
    expect(isUsableEndpoint('https://api.example.com/v1/pricing')).toBe(false);
    expect(isUsableEndpoint('https://eb98-194-126-177-160.ngrok-free.app/x')).toBe(false);
    expect(isUsableEndpoint('https://foo.trycloudflare.com/x')).toBe(false);
    expect(isUsableEndpoint('http://localhost:3000/x')).toBe(false);
  });

  it('rejects non-http(s) and malformed', () => {
    expect(isUsableEndpoint('ftp://x.com')).toBe(false);
    expect(isUsableEndpoint('not a url')).toBe(false);
  });
});
