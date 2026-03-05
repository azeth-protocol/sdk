import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { signRequest, buildAuthHeader, createSignedFetch } from '../../src/auth/erc8128.js';
import { createMockWalletClient, TEST_OWNER, createMockResponse } from '../fixtures/mocks.js';

/** Valid 65-byte mock signature (64 bytes r+s + v=27) for H-3 validation */
const MOCK_SIG = ('0x' + 'aa'.repeat(64) + '1b') as `0x${string}`;

describe('auth/erc8128', () => {
  let walletClient: ReturnType<typeof createMockWalletClient>;

  beforeEach(() => {
    walletClient = createMockWalletClient();
    vi.clearAllMocks();
  });

  describe('signRequest', () => {
    it('should sign a GET request and return SignedRequest', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);

      const result = await signRequest(
        walletClient,
        TEST_OWNER,
        'GET',
        'https://api.example.com/data',
      );

      expect(result.signature).toBe(MOCK_SIG);
      expect(result.keyid).toBe(TEST_OWNER);
      expect(result.nonce).toBeTruthy();
      expect(result.nonce.length).toBe(64); // H-8: 32 bytes = 64 hex chars
      expect(result.created).toBeGreaterThan(0);
      expect(walletClient.signMessage).toHaveBeenCalledOnce();
    });

    it('should include body digest for POST requests', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);

      const result = await signRequest(
        walletClient,
        TEST_OWNER,
        'POST',
        'https://api.example.com/action',
        '{"key":"value"}',
      );

      expect(result.signature).toBe(MOCK_SIG);

      // Verify the signMessage was called with content-digest in the message
      const signCall = walletClient.signMessage.mock.calls[0][0] as any;
      expect(signCall.message).toContain('"content-digest"');
      expect(signCall.message).toContain('"@method": POST');
    });

    it('should include method, path, and authority in signature base', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);

      await signRequest(walletClient, TEST_OWNER, 'GET', 'https://api.example.com/data?q=test');

      const signCall = walletClient.signMessage.mock.calls[0][0] as any;
      expect(signCall.message).toContain('"@method": GET');
      expect(signCall.message).toContain('"@path": /data');
      expect(signCall.message).toContain('"@authority": api.example.com');
    });

    it('should generate unique nonces per call', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);

      const result1 = await signRequest(walletClient, TEST_OWNER, 'GET', 'https://api.example.com/a');
      const result2 = await signRequest(walletClient, TEST_OWNER, 'GET', 'https://api.example.com/b');

      expect(result1.nonce).not.toBe(result2.nonce);
    });

    it('should use uppercase method', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);

      await signRequest(walletClient, TEST_OWNER, 'get', 'https://api.example.com/data');

      const signCall = walletClient.signMessage.mock.calls[0][0] as any;
      expect(signCall.message).toContain('"@method": GET');
    });
  });

  describe('buildAuthHeader', () => {
    it('should build a properly formatted ERC8128 auth header', () => {
      const header = buildAuthHeader({
        signature: MOCK_SIG,
        nonce: 'testnonce123',
        created: 1700000000,
        keyid: TEST_OWNER,
      });

      expect(header).toContain('ERC8128');
      expect(header).toContain('sig=:');
      expect(header).toContain(`keyid="${TEST_OWNER}"`);
      expect(header).toContain('nonce="testnonce123"');
      expect(header).toContain('created=1700000000');
    });

    it('should base64 encode the raw signature bytes', () => {
      const header = buildAuthHeader({
        signature: MOCK_SIG,
        nonce: 'n',
        created: 0,
        keyid: '0x0000000000000000000000000000000000000000' as `0x${string}`,
      });

      // The signature is base64 encoded between colons
      const match = header.match(/sig=:([^:]+):/);
      expect(match).toBeTruthy();
      // Verify it decodes to the raw 65 bytes of the hex signature
      const decoded = Buffer.from(match![1], 'base64');
      expect(decoded.length).toBe(65);
      expect(decoded).toEqual(Buffer.from(MOCK_SIG.slice(2), 'hex'));
    });
  });

  describe('createSignedFetch', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('should return a fetch function that adds auth headers', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: 'ok' }));

      const signedFetch = createSignedFetch(walletClient, TEST_OWNER);
      await signedFetch('https://api.example.com/resource');

      expect(globalThis.fetch).toHaveBeenCalledOnce();
      const callArgs = (globalThis.fetch as any).mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers.get('Authorization')).toContain('ERC8128');
    });

    it('should pass through request body and method', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, {}));

      const signedFetch = createSignedFetch(walletClient, TEST_OWNER);
      await signedFetch('https://api.example.com/action', {
        method: 'POST',
        body: '{"key":"value"}',
      });

      // The underlying signMessage should have been called with POST method
      const signCall = walletClient.signMessage.mock.calls[0][0] as any;
      expect(signCall.message).toContain('"@method": POST');
    });

    it('should preserve existing headers', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, {}));

      const signedFetch = createSignedFetch(walletClient, TEST_OWNER);
      await signedFetch('https://api.example.com/resource', {
        headers: { 'Content-Type': 'application/json' },
      });

      const callArgs = (globalThis.fetch as any).mock.calls[0];
      const headers = callArgs[1].headers;
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('Authorization')).toContain('ERC8128');
    });

    it('should handle URL object input', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, {}));

      const signedFetch = createSignedFetch(walletClient, TEST_OWNER);
      await signedFetch(new URL('https://api.example.com/resource'));

      expect(globalThis.fetch).toHaveBeenCalledOnce();
    });

    it('should default to GET method when none specified', async () => {
      walletClient.signMessage.mockResolvedValue(MOCK_SIG);
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, {}));

      const signedFetch = createSignedFetch(walletClient, TEST_OWNER);
      await signedFetch('https://api.example.com/resource');

      const signCall = walletClient.signMessage.mock.calls[0][0] as any;
      expect(signCall.message).toContain('"@method": GET');
    });
  });
});
