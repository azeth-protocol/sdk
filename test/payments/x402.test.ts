import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fetch402 } from '../../src/payments/x402.js';
import {
  createMockPublicClient,
  createMockWalletClient,
  createMockResponse,
  TEST_ACCOUNT,
  TEST_SMART_ACCOUNT,
} from '../fixtures/mocks.js';
import type { X402PaymentRequirement } from '@azeth/common';

// Mock the @x402/extensions SIWx functions — use vi.hoisted() because vi.mock is hoisted
const { mockCreateSIWxPayload, mockEncodeSIWxHeader } = vi.hoisted(() => ({
  mockCreateSIWxPayload: vi.fn().mockResolvedValue({
    domain: 'api.example.com',
    address: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    uri: 'https://api.example.com/intelligence',
    version: '1',
    chainId: 'eip155:84532',
    type: 'eip191',
    nonce: 'test-nonce',
    issuedAt: '2026-01-01T00:00:00.000Z',
    signature: '0xsiwxsig',
  }),
  mockEncodeSIWxHeader: vi.fn().mockReturnValue('base64-encoded-siwx-header'),
}));

vi.mock('@x402/extensions/sign-in-with-x', () => ({
  createSIWxPayload: mockCreateSIWxPayload,
  encodeSIWxHeader: mockEncodeSIWxHeader,
}));

describe('payments/x402', () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let walletClient: ReturnType<typeof createMockWalletClient>;
  const originalFetch = globalThis.fetch;
  const testUrl = 'https://api.example.com/intelligence';

  beforeEach(() => {
    publicClient = createMockPublicClient();
    walletClient = createMockWalletClient();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('non-402 responses', () => {
    it('should return immediately on 200 response without payment', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(200, { data: 'free content' }));

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      expect(result.paymentMade).toBe(false);
      expect(result.response.status).toBe(200);
      expect(walletClient.signTypedData).not.toHaveBeenCalled();
    });

    it('should return immediately on 404 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(404, { error: 'Not found' }));

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      expect(result.paymentMade).toBe(false);
      expect(result.response.status).toBe(404);
    });

    it('should return on 500 response without payment', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(createMockResponse(500, { error: 'Server error' }));

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      expect(result.paymentMade).toBe(false);
    });
  });

  describe('402 payment flow', () => {
    const paymentRequirement: X402PaymentRequirement = {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '1000000', // 1 USDC
      resource: testUrl,
      description: 'Intelligence API access',
      mimeType: 'application/json',
      payTo: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`,
      maxTimeoutSeconds: 300,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
      extra: { name: 'USD Coin', version: '2' },
    };

    function setup402ThenSuccess() {
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          // First call: 402
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(paymentRequirement),
            }),
          );
        }
        // Second call: 200 with content
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });
    }

    it('should sign ERC-3009 payment and retry on 402', async () => {
      setup402ThenSuccess();
      walletClient.signTypedData.mockResolvedValue('0xpaymentsig' as `0x${string}`);

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      expect(result.paymentMade).toBe(true);
      expect(result.amount).toBe(1000000n);
      expect(result.response.status).toBe(200);
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      expect(walletClient.signTypedData).toHaveBeenCalledOnce();
    });

    it('should include payment proof in retry headers', async () => {
      setup402ThenSuccess();
      walletClient.signTypedData.mockResolvedValue('0xpaymentsig' as `0x${string}`);

      await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      const secondCall = (globalThis.fetch as any).mock.calls[1];
      const headers = secondCall[1].headers;
      // v2 protocol uses PAYMENT-SIGNATURE header with base64-encoded proof
      const paymentHeader = headers.get('PAYMENT-SIGNATURE');
      expect(paymentHeader).toBeTruthy();

      // Decode the base64 payment proof (v2 format)
      const decoded = JSON.parse(atob(paymentHeader));
      expect(decoded.x402Version).toBe(2);
      expect(decoded.payload.authorization.from).toBe(TEST_ACCOUNT);
      expect(decoded.payload.authorization.to.toLowerCase()).toBe(paymentRequirement.payTo.toLowerCase());
      expect(decoded.payload.signature).toBe('0xpaymentsig');
    });

    it('should sign correct ERC-3009 typed data', async () => {
      setup402ThenSuccess();

      await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      const signCall = walletClient.signTypedData.mock.calls[0][0] as any;
      expect(signCall.domain.name).toBe('USD Coin');
      expect(signCall.domain.version).toBe('2');
      // getAddress returns EIP-55 checksummed addresses
      expect(signCall.domain.verifyingContract.toLowerCase()).toBe(paymentRequirement.asset.toLowerCase());
      expect(signCall.primaryType).toBe('TransferWithAuthorization');
      expect(signCall.message.from).toBe(TEST_ACCOUNT);
      expect(signCall.message.to.toLowerCase()).toBe(paymentRequirement.payTo.toLowerCase());
      expect(signCall.message.value).toBe(1000000n);
    });

    it('should pass method and body options to initial request', async () => {
      setup402ThenSuccess();

      await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        method: 'POST',
        body: '{"query":"test"}',
        headers: { 'Content-Type': 'application/json' },
      });

      const firstCall = (globalThis.fetch as any).mock.calls[0];
      expect(firstCall[1].method).toBe('POST');
      expect(firstCall[1].body).toBe('{"query":"test"}');
    });

    it('should throw when payment exceeds maxAmount budget', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(402, null, {
          'X-Payment-Required': JSON.stringify(paymentRequirement),
        }),
      );

      await expect(
        fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
          maxAmount: 500000n, // 0.5 USDC, less than the 1 USDC required
        }),
      ).rejects.toThrow('Payment of 1 USDC exceeds maximum of 0.50 USDC');
    });

    it('should not throw when payment is within maxAmount budget', async () => {
      setup402ThenSuccess();

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        maxAmount: 2000000n, // 2 USDC, more than the 1 USDC required
      });

      expect(result.paymentMade).toBe(true);
    });

    it('should return without payment when 402 has no X-Payment-Required header', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(402, null),
      );

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      expect(result.paymentMade).toBe(false);
      expect(result.response.status).toBe(402);
      expect(walletClient.signTypedData).not.toHaveBeenCalled();
    });

    it('should use chain id from publicClient', async () => {
      // Override to mainnet chain with matching mainnet USDC asset
      const mainnetRequirement = {
        ...paymentRequirement,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`,
      };
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(mainnetRequirement),
            }),
          );
        }
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });
      publicClient.chain = { id: 8453 };

      await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      const signCall = walletClient.signTypedData.mock.calls[0][0] as any;
      expect(signCall.domain.chainId).toBe(8453);
    });

    it('should handle base64-encoded v2 PAYMENT-REQUIRED header', async () => {
      const calls: number[] = [];
      const base64Requirement = btoa(JSON.stringify(paymentRequirement));
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          return Promise.resolve(
            createMockResponse(402, null, {
              'PAYMENT-REQUIRED': base64Requirement,
            }),
          );
        }
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });
      walletClient.signTypedData.mockResolvedValue('0xpaymentsig' as `0x${string}`);

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      expect(result.paymentMade).toBe(true);
      expect(result.amount).toBe(1000000n);
      expect(result.response.status).toBe(200);
    });

    it('should reject unrecognized asset address (H-3 regression)', async () => {
      const fakeRequirement = {
        ...paymentRequirement,
        asset: '0xDEADBEEFDEADBEEFDEADBEEFDEADBEEFDEADBEEF' as `0x${string}`,
      };
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(402, null, {
          'X-Payment-Required': JSON.stringify(fakeRequirement),
        }),
      );

      await expect(
        fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl),
      ).rejects.toThrow('Payment asset is not a recognized USDC address for this chain');
      expect(walletClient.signTypedData).not.toHaveBeenCalled();
    });
  });

  describe('SIWx identity flow', () => {
    const siwxPaymentRequirement = {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '1000000',
      resource: testUrl,
      description: 'Intelligence API access',
      mimeType: 'application/json',
      payTo: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`,
      maxTimeoutSeconds: 300,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
      extra: { name: 'USDC', version: '2' },
      extensions: {
        'sign-in-with-x': {
          info: {
            domain: 'api.example.com',
            uri: testUrl,
            version: '1',
            nonce: 'server-nonce',
            issuedAt: '2026-01-01T00:00:00.000Z',
          },
          supportedChains: [
            { chainId: 'eip155:84532', type: 'eip191' },
          ],
          schema: { $schema: '', type: 'object' as const, properties: {}, required: [] },
        },
      },
    };

    it('should attempt SIWx when smartAccount provided and extension present', async () => {
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          // First: 402 with SIWx extension
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(siwxPaymentRequirement),
            }),
          );
        }
        // Second (SIWx retry): 200 — access granted via session
        return Promise.resolve(createMockResponse(200, { data: 'session content' }));
      });

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        smartAccount: TEST_SMART_ACCOUNT,
      });

      expect(result.paymentMade).toBe(false);
      expect(result.paymentMethod).toBe('session');
      expect(result.response.status).toBe(200);
      // Should have made 2 calls: initial 402, SIWx retry
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      // Should NOT have signed ERC-3009 typed data (no payment)
      expect(walletClient.signTypedData).not.toHaveBeenCalled();
      // Should have created SIWx payload with the smart account address
      expect(mockCreateSIWxPayload).toHaveBeenCalledOnce();
      const siwxArgs = mockCreateSIWxPayload.mock.calls[0];
      expect(siwxArgs[0].chainId).toBe('eip155:84532');
      expect(siwxArgs[1].account.address).toBe(TEST_SMART_ACCOUNT);
    });

    it('should fall through to payment when SIWx returns 402', async () => {
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          // First: 402 with SIWx extension
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(siwxPaymentRequirement),
            }),
          );
        }
        if (calls.length === 2) {
          // Second (SIWx retry): still 402 — not recognized
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(siwxPaymentRequirement),
            }),
          );
        }
        // Third (ERC-3009 payment): 200
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        smartAccount: TEST_SMART_ACCOUNT,
      });

      expect(result.paymentMade).toBe(true);
      expect(result.paymentMethod).toBe('x402');
      // 3 calls: initial 402, SIWx retry (402), ERC-3009 payment (200)
      expect(globalThis.fetch).toHaveBeenCalledTimes(3);
      expect(walletClient.signTypedData).toHaveBeenCalledOnce();
    });

    it('should skip SIWx when no smartAccount provided', async () => {
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(siwxPaymentRequirement),
            }),
          );
        }
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl);

      // Without smartAccount, should skip SIWx and go straight to payment
      expect(result.paymentMade).toBe(true);
      expect(result.paymentMethod).toBe('x402');
      // 2 calls: initial 402, ERC-3009 payment (200)
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });

    it('should skip SIWx when 402 has no sign-in-with-x extension', async () => {
      const noSiwxRequirement = {
        ...siwxPaymentRequirement,
        extensions: undefined,
      };
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(noSiwxRequirement),
            }),
          );
        }
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        smartAccount: TEST_SMART_ACCOUNT,
      });

      // Should skip SIWx and go straight to payment
      expect(result.paymentMade).toBe(true);
      expect(result.paymentMethod).toBe('x402');
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      // signMessage should NOT have been called (no SIWx attempt)
      expect(walletClient.signMessage).not.toHaveBeenCalled();
    });

    it('should include SIGN-IN-WITH-X header in SIWx retry', async () => {
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(siwxPaymentRequirement),
            }),
          );
        }
        return Promise.resolve(createMockResponse(200, { data: 'session content' }));
      });

      await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        smartAccount: TEST_SMART_ACCOUNT,
      });

      // Second call should have the SIGN-IN-WITH-X header
      const secondCall = (globalThis.fetch as any).mock.calls[1];
      const headers = secondCall[1].headers;
      const siwxHeader = headers.get('SIGN-IN-WITH-X');
      expect(siwxHeader).toBe('base64-encoded-siwx-header');
    });
  });

  describe('smart account payment flow', () => {
    const paymentRequirement: X402PaymentRequirement = {
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '1000000', // 1 USDC
      resource: testUrl,
      description: 'Intelligence API access',
      mimeType: 'application/json',
      payTo: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`,
      maxTimeoutSeconds: 300,
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`,
      extra: { name: 'USD Coin', version: '2' },
    };

    function setup402ForSmartAccount() {
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          // First call: 402
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(paymentRequirement),
            }),
          );
        }
        // Second call: 200 with content (paid via smart account)
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });
    }

    it('should use smartAccountTransfer callback when provided', async () => {
      setup402ForSmartAccount();
      const mockSmartAccountTransfer = vi.fn().mockResolvedValue(
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`,
      );
      walletClient.signTypedData.mockResolvedValue('0xpaymentsig' as `0x${string}`);

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        smartAccount: TEST_SMART_ACCOUNT,
        smartAccountTransfer: mockSmartAccountTransfer,
      });

      expect(result.paymentMade).toBe(true);
      expect(result.paymentMethod).toBe('smart-account');
      expect(result.settlementVerified).toBe(true);
      expect(result.amount).toBe(1000000n);
      expect(mockSmartAccountTransfer).toHaveBeenCalledOnce();

      // Verify the callback received correct params
      const params = mockSmartAccountTransfer.mock.calls[0][0];
      expect(params.usdcAddress.toLowerCase()).toBe('0x036cbd53842c5426634e7929541ec2318f3dcf7e');
      expect(params.payTo.toLowerCase()).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
      expect(params.amount).toBe(1000000n);
      expect(params.calldata).toMatch(/^0xcf092995/); // bytes variant selector

      // The retry request should have X-Payment-Tx header
      const secondCall = (globalThis.fetch as any).mock.calls[1];
      const headers = secondCall[1].headers;
      expect(headers.get('X-Payment-Tx')).toBe(
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      );
      expect(headers.get('X-Payment-From')).toBe(TEST_SMART_ACCOUNT);
    });

    it('should sign typed data with from=smartAccount (not EOA)', async () => {
      setup402ForSmartAccount();
      const mockSmartAccountTransfer = vi.fn().mockResolvedValue(
        '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890' as `0x${string}`,
      );
      walletClient.signTypedData.mockResolvedValue('0xpaymentsig' as `0x${string}`);

      await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        smartAccount: TEST_SMART_ACCOUNT,
        smartAccountTransfer: mockSmartAccountTransfer,
      });

      // Verify ERC-3009 typed data has from=smartAccount
      const signCall = walletClient.signTypedData.mock.calls[0][0] as any;
      expect(signCall.message.from.toLowerCase()).toBe(TEST_SMART_ACCOUNT.toLowerCase());
    });

    it('should fall back to ERC-3009 when no smartAccountTransfer callback', async () => {
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length === 1) {
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(paymentRequirement),
            }),
          );
        }
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });
      walletClient.signTypedData.mockResolvedValue('0xpaymentsig' as `0x${string}`);

      const result = await fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
        smartAccount: TEST_SMART_ACCOUNT,
        // No smartAccountTransfer callback
      });

      expect(result.paymentMade).toBe(true);
      expect(result.paymentMethod).toBe('x402'); // Standard ERC-3009 path
    });

    it('should throw (not fall back to EOA) when smartAccountTransfer fails', async () => {
      const calls: number[] = [];
      globalThis.fetch = vi.fn().mockImplementation(() => {
        calls.push(1);
        if (calls.length <= 1) {
          return Promise.resolve(
            createMockResponse(402, null, {
              'X-Payment-Required': JSON.stringify(paymentRequirement),
            }),
          );
        }
        return Promise.resolve(createMockResponse(200, { data: 'paid content' }));
      });
      walletClient.signTypedData.mockResolvedValue('0xpaymentsig' as `0x${string}`);

      const mockSmartAccountTransfer = vi.fn().mockRejectedValue(new Error('UserOp failed'));

      // SECURITY: Smart account failure must NOT fall back to EOA (would bypass guardrails)
      await expect(
        fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
          smartAccount: TEST_SMART_ACCOUNT,
          smartAccountTransfer: mockSmartAccountTransfer,
        }),
      ).rejects.toThrow('Smart account x402 payment failed: UserOp failed');
    });

    it('should propagate BUDGET_EXCEEDED from smart account path', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        createMockResponse(402, null, {
          'X-Payment-Required': JSON.stringify(paymentRequirement),
        }),
      );
      const mockSmartAccountTransfer = vi.fn();

      await expect(
        fetch402(publicClient, walletClient, TEST_ACCOUNT, testUrl, {
          smartAccount: TEST_SMART_ACCOUNT,
          smartAccountTransfer: mockSmartAccountTransfer,
          maxAmount: 500000n, // 0.5 USDC, less than the 1 USDC required
        }),
      ).rejects.toThrow('Payment of 1 USDC exceeds maximum of 0.50 USDC');
    });
  });
});
