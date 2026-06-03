import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoist mocks so they're available inside vi.mock factories
const {
  mockCreateSmartAccountClient,
  mockToSmartAccount,
  mockGetPaymasterData,
  mockGetPaymasterStubData,
  mockEstimateUserOperationGas,
} = vi.hoisted(() => ({
  // Returns a fresh client per call with a minimal viem-style `.extend` that
  // applies the decorator's actions onto the client (so the estimateUserOperationGas
  // override installed by createAzethSmartAccountClient is observable).
  mockCreateSmartAccountClient: vi.fn().mockImplementation(() => {
    const base: Record<string, unknown> = {
      sendTransaction: vi.fn(),
      account: { address: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' },
      chain: { id: 84532 },
      paymaster: undefined,
    };
    base['extend'] = (fn: (c: Record<string, unknown>) => Record<string, unknown>) => Object.assign(base, fn(base));
    return base;
  }),
  mockToSmartAccount: vi.fn().mockResolvedValue({
    address: '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD',
    type: 'smart',
  }),
  mockGetPaymasterData: vi.fn().mockResolvedValue({ paymaster: '0xPaymaster', paymasterData: '0xdata' }),
  mockGetPaymasterStubData: vi.fn().mockResolvedValue({ paymaster: '0xPaymaster', paymasterData: '0xstubdata' }),
  mockEstimateUserOperationGas: vi.fn(),
}));

vi.mock('permissionless', () => ({
  createSmartAccountClient: mockCreateSmartAccountClient,
}));

vi.mock('viem/account-abstraction', () => ({
  toSmartAccount: mockToSmartAccount,
  entryPoint07Abi: [],
  entryPoint07Address: '0x0000000071727De22E5E9d8BAf0edAc6f37da032',
  getUserOperationHash: vi.fn().mockReturnValue('0x' + '00'.repeat(32)),
  estimateUserOperationGas: mockEstimateUserOperationGas,
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

import { createAzethSmartAccountClient, applyVerificationGasBuffer } from '../../src/utils/userop.js';
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

  // F-2: native value-spends deterministically AA26'd because the SDK took the
  // bundler's verificationGasLimit estimate verbatim, leaving no headroom for
  // GuardianModule's state-dependent validation gas (cold daily-spend SSTORE,
  // epoch reset). The buffer MUST be applied during gas estimation — a post-prepare
  // mutation bumps verificationGasLimit after the paymaster has already signed the
  // (un-buffered) op → AA34, and after the owner sig is computed → AA24.
  it('buffers verificationGasLimit during gas estimation, with no post-prepare hook (F-2)', async () => {
    mockEstimateUserOperationGas.mockResolvedValue({
      callGasLimit: 50_000n,
      verificationGasLimit: 100_000n,
      preVerificationGas: 40_000n,
    });

    const client = await createAzethSmartAccountClient({
      publicClient: mockPublicClient(),
      walletClient: mockWalletClient(),
      smartAccountAddress: TEST_SMART_ACCOUNT,
      bundlerUrl: TEST_BUNDLER_URL,
    });

    // The buffer must NOT be wired as a prepareUserOperation hook (that's what
    // produced the AA34 regression by bumping gas after the paymaster signed).
    const callArgs = mockCreateSmartAccountClient.mock.calls[0][0];
    expect(callArgs.userOperation?.prepareUserOperation).toBeUndefined();

    // It overrides estimateUserOperationGas instead: viem's prepareUserOperation
    // calls this during the gas step, BEFORE fetching the sending paymaster data
    // and BEFORE sendUserOperation signs — so the buffered limit is what both cover.
    const estimate = client as unknown as {
      estimateUserOperationGas: (args: unknown) => Promise<{
        verificationGasLimit: bigint;
        callGasLimit: bigint;
        preVerificationGas: bigint;
      }>;
    };
    const gas = await estimate.estimateUserOperationGas({});

    expect(mockEstimateUserOperationGas).toHaveBeenCalled();
    expect(gas.verificationGasLimit).toBe(150_000n); // 100k * 3/2
    // Every other gas field passes through untouched.
    expect(gas.callGasLimit).toBe(50_000n);
    expect(gas.preVerificationGas).toBe(40_000n);
  });
});

describe('applyVerificationGasBuffer', () => {
  it('scales the estimate by 1.5x (the AA26 fix for F-2)', () => {
    // The exact verificationGasLimit (101136) the bundler returned for the
    // transfer that deterministically reverted with AA26 in the MCP test.
    expect(applyVerificationGasBuffer(101_136n)).toBe(151_704n);
    expect(applyVerificationGasBuffer(100_000n)).toBe(150_000n);
    expect(applyVerificationGasBuffer(0n)).toBe(0n);
  });

  it('always returns at least the input (headroom is never negative)', () => {
    for (const estimate of [1n, 12_345n, 80_000n, 101_136n, 500_000n]) {
      expect(applyVerificationGasBuffer(estimate)).toBeGreaterThanOrEqual(estimate);
    }
  });
});
