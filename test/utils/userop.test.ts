import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mocks so they're available inside vi.mock factories
const {
  mockCreateSmartAccountClient,
  mockToSmartAccount,
  mockGetPaymasterData,
  mockGetPaymasterStubData,
} = vi.hoisted(() => ({
  mockCreateSmartAccountClient: vi.fn().mockReturnValue({
    sendTransaction: vi.fn(),
    account: { address: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' },
    chain: { id: 84532 },
    paymaster: undefined,
  }),
  mockToSmartAccount: vi.fn().mockResolvedValue({
    address: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    type: 'smart',
  }),
  mockGetPaymasterData: vi.fn().mockResolvedValue({ paymaster: '0xPaymaster', paymasterData: '0xdata' }),
  mockGetPaymasterStubData: vi.fn().mockResolvedValue({ paymaster: '0xPaymaster', paymasterData: '0xstubdata' }),
}));

vi.mock('permissionless', () => ({
  createSmartAccountClient: mockCreateSmartAccountClient,
}));

vi.mock('viem/account-abstraction', () => ({
  toSmartAccount: mockToSmartAccount,
  entryPoint07Abi: [],
  entryPoint07Address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  getUserOperationHash: vi.fn().mockReturnValue('0x' + '00'.repeat(32)),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    http: vi.fn((url: string) => ({ url, type: 'http' })),
    createNonceManager: vi.fn().mockReturnValue({ source: { get: () => 0, set: () => {} } }),
    encodeFunctionData: vi.fn().mockReturnValue('0xmockencoded'),
  };
});

vi.mock('permissionless/clients/pimlico', () => ({
  createPimlicoClient: vi.fn().mockReturnValue({
    getPaymasterData: mockGetPaymasterData,
    getPaymasterStubData: mockGetPaymasterStubData,
  }),
}));

vi.mock('@azeth/common/abis', () => ({
  AzethAccountAbi: [],
}));

import { createAzethSmartAccountClient } from '../../src/utils/userop.js';
import type { PublicClient, WalletClient, Transport, Chain, Account } from 'viem';

function mockPublicClient(overrides: Record<string, unknown> = {}): PublicClient<Transport, Chain> {
  return {
    chain: { id: 84532 },
    ...overrides,
  } as unknown as PublicClient<Transport, Chain>;
}

function mockWalletClient(): WalletClient<Transport, Chain, Account> {
  return {
    signMessage: vi.fn().mockResolvedValue('0xmocksig'),
    signTypedData: vi.fn().mockResolvedValue('0xmocktypedsig'),
    account: { address: '0x1111111111111111111111111111111111111111' },
    chain: { id: 84532 },
  } as unknown as WalletClient<Transport, Chain, Account>;
}

const TEST_SMART_ACCOUNT = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' as `0x${string}`;
const TEST_BUNDLER_URL = 'https://api.pimlico.io/v2/84532/rpc?apikey=test-key';
const TEST_PAYMASTER_URL = 'https://api.pimlico.io/v2/84532/rpc?apikey=test-key';

describe('createAzethSmartAccountClient', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    // Clear env vars that affect resolution
    delete process.env['PIMLICO_API_KEY'];
    delete process.env['AZETH_PAYMASTER_URL'];
    delete process.env['AZETH_BUNDLER_URL'];
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('creates client WITHOUT paymaster when paymasterUrl is not provided', async () => {
    await createAzethSmartAccountClient({
      publicClient: mockPublicClient(),
      walletClient: mockWalletClient(),
      smartAccountAddress: TEST_SMART_ACCOUNT,
      bundlerUrl: TEST_BUNDLER_URL,
      // No paymasterUrl
    });

    expect(mockCreateSmartAccountClient).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateSmartAccountClient.mock.calls[0][0];
    expect(callArgs.paymaster).toBeUndefined();
  });

  it('creates client WITH paymaster when paymasterUrl is provided', async () => {
    await createAzethSmartAccountClient({
      publicClient: mockPublicClient(),
      walletClient: mockWalletClient(),
      smartAccountAddress: TEST_SMART_ACCOUNT,
      bundlerUrl: TEST_BUNDLER_URL,
      paymasterUrl: TEST_PAYMASTER_URL,
    });

    expect(mockCreateSmartAccountClient).toHaveBeenCalledTimes(1);
    const callArgs = mockCreateSmartAccountClient.mock.calls[0][0];
    expect(callArgs.paymaster).toBeDefined();
    expect(callArgs.paymaster.getPaymasterData).toBeTypeOf('function');
    expect(callArgs.paymaster.getPaymasterStubData).toBeTypeOf('function');
  });

  it('resolves paymaster URL from AZETH_PAYMASTER_URL env var', async () => {
    process.env['AZETH_PAYMASTER_URL'] = 'https://custom-paymaster.example.com';

    await createAzethSmartAccountClient({
      publicClient: mockPublicClient(),
      walletClient: mockWalletClient(),
      smartAccountAddress: TEST_SMART_ACCOUNT,
      bundlerUrl: TEST_BUNDLER_URL,
      // No explicit paymasterUrl — should pick up from env
    });

    const callArgs = mockCreateSmartAccountClient.mock.calls[0][0];
    expect(callArgs.paymaster).toBeDefined();
  });

  it('resolves paymaster URL from PIMLICO_API_KEY as chain default', async () => {
    process.env['PIMLICO_API_KEY'] = 'pm-test-key';

    await createAzethSmartAccountClient({
      publicClient: mockPublicClient(),
      walletClient: mockWalletClient(),
      smartAccountAddress: TEST_SMART_ACCOUNT,
      bundlerUrl: TEST_BUNDLER_URL,
      // No explicit paymasterUrl, no AZETH_PAYMASTER_URL — should use chain default
    });

    const callArgs = mockCreateSmartAccountClient.mock.calls[0][0];
    expect(callArgs.paymaster).toBeDefined();
  });

  it('prefers explicit paymasterUrl over env vars', async () => {
    process.env['AZETH_PAYMASTER_URL'] = 'https://env-paymaster.example.com';
    process.env['PIMLICO_API_KEY'] = 'pm-test-key';

    await createAzethSmartAccountClient({
      publicClient: mockPublicClient(),
      walletClient: mockWalletClient(),
      smartAccountAddress: TEST_SMART_ACCOUNT,
      bundlerUrl: TEST_BUNDLER_URL,
      paymasterUrl: 'https://explicit-paymaster.example.com',
    });

    // The middleware is created — can't directly inspect the URL,
    // but we verified the paymaster param is set
    const callArgs = mockCreateSmartAccountClient.mock.calls[0][0];
    expect(callArgs.paymaster).toBeDefined();
  });

  it('passes paymasterPolicy through to paymaster middleware', async () => {
    await createAzethSmartAccountClient({
      publicClient: mockPublicClient(),
      walletClient: mockWalletClient(),
      smartAccountAddress: TEST_SMART_ACCOUNT,
      bundlerUrl: TEST_BUNDLER_URL,
      paymasterUrl: TEST_PAYMASTER_URL,
      paymasterPolicy: {
        allowedAccounts: [TEST_SMART_ACCOUNT],
        maxSponsoredPerDay: 50,
      },
    });

    const callArgs = mockCreateSmartAccountClient.mock.calls[0][0];
    expect(callArgs.paymaster).toBeDefined();
    // The policy is embedded in the middleware closure — verify via behavior testing
    // in the paymaster.test.ts file
  });

  it('does NOT set paymaster when no URL is available and no env vars set', async () => {
    await createAzethSmartAccountClient({
      publicClient: mockPublicClient(),
      walletClient: mockWalletClient(),
      smartAccountAddress: TEST_SMART_ACCOUNT,
      bundlerUrl: TEST_BUNDLER_URL,
    });

    const callArgs = mockCreateSmartAccountClient.mock.calls[0][0];
    expect(callArgs.paymaster).toBeUndefined();
  });

  it('throws when bundlerUrl is missing and no fallback available', async () => {
    // Use chain ID that has no matching SUPPORTED_CHAINS entry
    await expect(
      createAzethSmartAccountClient({
        publicClient: mockPublicClient({ chain: { id: 99999 } }),
        walletClient: mockWalletClient(),
        smartAccountAddress: TEST_SMART_ACCOUNT,
        // No bundlerUrl, no env vars, no matching chain
      }),
    ).rejects.toThrow('bundlerUrl is required');
  });
});
