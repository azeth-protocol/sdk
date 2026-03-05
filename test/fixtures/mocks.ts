import { vi } from 'vitest';
import type { AzethContractAddresses } from '@azeth/common';

/** Well-known test addresses */
export const TEST_OWNER = '0x1111111111111111111111111111111111111111' as `0x${string}`;
export const TEST_ACCOUNT = '0x2222222222222222222222222222222222222222' as `0x${string}`;
export const TEST_SMART_ACCOUNT = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD' as `0x${string}`;
export const TEST_RECIPIENT = '0x3333333333333333333333333333333333333333' as `0x${string}`;
export const TEST_TOKEN = '0x4444444444444444444444444444444444444444' as `0x${string}`;
export const TEST_MODULE = '0x5555555555555555555555555555555555555555' as `0x${string}`;
export const TEST_FACTORY = '0x6666666666666666666666666666666666666666' as `0x${string}`;
export const TEST_TX_HASH = '0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789' as `0x${string}`;
export const TEST_SALT = ('0x' + '00'.repeat(32)) as `0x${string}`;

/** Create a mock SmartAccountClient (permissionless) for UserOp-based operations.
 *  Mocks sendTransaction which is used for all state-changing smart account calls. */
export function createMockSmartAccountClient(overrides: Record<string, unknown> = {}) {
  return {
    sendTransaction: vi.fn().mockResolvedValue(TEST_TX_HASH),
    writeContract: vi.fn().mockResolvedValue(TEST_TX_HASH),
    signMessage: vi.fn().mockResolvedValue('0xmocksignature' as `0x${string}`),
    signTypedData: vi.fn().mockResolvedValue('0xmocktypedsig' as `0x${string}`),
    account: { address: TEST_SMART_ACCOUNT },
    chain: { id: 84532 },
    ...overrides,
  } as any;
}

/** Resolved contract addresses for test usage */
export const TEST_ADDRESSES: AzethContractAddresses = {
  factory: TEST_FACTORY,
  guardianModule: '0x7777777777777777777777777777777777777777' as `0x${string}`,
  trustRegistryModule: TEST_MODULE,
  paymentAgreementModule: '0x9999999999999999999999999999999999999999' as `0x${string}`,
  reputationModule: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`,
  priceOracle: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`,
  accountImplementation: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as `0x${string}`,
};

/** Create a mock PublicClient with configurable behavior */
export function createMockPublicClient(overrides: Record<string, unknown> = {}) {
  return {
    getBalance: vi.fn().mockResolvedValue(1000000000000000000n), // 1 ETH
    readContract: vi.fn().mockResolvedValue(0n),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({
      status: 'success',
      logs: [],
      blockNumber: 100n,
    }),
    getBlockNumber: vi.fn().mockResolvedValue(1000n),
    getBlock: vi.fn().mockResolvedValue({
      number: 1000n,
      timestamp: 1700000000n,
      transactions: [],
    }),
    chain: { id: 84532 },
    ...overrides,
  } as any;
}

/** Create a mock WalletClient with configurable behavior */
export function createMockWalletClient(overrides: Record<string, unknown> = {}) {
  return {
    writeContract: vi.fn().mockResolvedValue(TEST_TX_HASH),
    sendTransaction: vi.fn().mockResolvedValue(TEST_TX_HASH),
    signMessage: vi.fn().mockResolvedValue('0xmocksignature' as `0x${string}`),
    signTypedData: vi.fn().mockResolvedValue('0xmocktypedsig' as `0x${string}`),
    account: { address: TEST_OWNER },
    chain: { id: 84532 },
    ...overrides,
  } as any;
}

/** Create a mock fetch Response */
export function createMockResponse(status: number, body: unknown, headers?: Record<string, string>): Response {
  const headersObj = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : status === 402 ? 'Payment Required' : 'Error',
    headers: headersObj,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body, (_k, v) => typeof v === 'bigint' ? v.toString() : v)),
    clone: vi.fn(),
  } as unknown as Response;
}
