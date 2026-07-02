import { describe, it, expect, vi } from 'vitest';
import { AzethError } from '@azeth/common';
import { proveL2UsdDelta } from '../../src/crosschain/prove.js';
import { MOCK_PROOF, MOCK_ANCHOR, FIXTURE_PAIR } from '../fixtures/proofs.js';
import { createMockWalletClient, TEST_TX_HASH } from '../fixtures/mocks.js';

const READER = '0xB28fEA196dcc198D92ee05962Cf4204a111F5d7d' as `0x${string}`;

/** L1 client mock for prove flows: getProvenDelta read + simulate/estimate/balance/receipt */
function proveL1Client(overrides: Record<string, unknown> = {}) {
  return {
    readContract: vi.fn().mockResolvedValue({ usdDelta: 0n, l2BlockNumber: 0n, provenAt: 0n }),
    simulateContract: vi.fn().mockResolvedValue({ request: { __kind: 'simulated-request' } }),
    estimateContractGas: vi.fn().mockResolvedValue(500_000n),
    getGasPrice: vi.fn().mockResolvedValue(2_000_000_000n),
    getBalance: vi.fn().mockResolvedValue(10n ** 18n),
    waitForTransactionReceipt: vi.fn().mockResolvedValue({ status: 'success' }),
    chain: { id: 11155111, name: 'Ethereum Sepolia' },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

async function expectAzethError(promise: Promise<unknown>, code: string): Promise<AzethError> {
  try {
    await promise;
    expect.unreachable('should have thrown');
  } catch (err) {
    expect(err).toBeInstanceOf(AzethError);
    expect((err as AzethError).code).toBe(code);
    return err as AzethError;
  }
  throw new Error('unreachable');
}

describe('crosschain/prove', () => {
  it('defaults to simulate-only with the exact 6-arg tuple and never writes', async () => {
    const l1 = proveL1Client();

    const result = await proveL2UsdDelta(l1, READER, MOCK_PROOF);

    expect(result.status).toBe('simulated');
    expect(result.account0).toBe(FIXTURE_PAIR.account0);
    expect(result.account1).toBe(FIXTURE_PAIR.account1);
    expect(result.chainId).toBe(84532n);
    expect(result.usdDelta).toBe(MOCK_PROOF.usdDelta);
    expect(result.anchorL2BlockNumber).toBe(MOCK_ANCHOR.l2BlockNumber);
    expect(result.txHash).toBeUndefined();

    expect(l1.simulateContract).toHaveBeenCalledTimes(1);
    expect(l1.simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      address: READER,
      functionName: 'proveL2UsdDelta',
      args: [
        MOCK_PROOF.chainId,
        MOCK_PROOF.account0,
        MOCK_PROOF.account1,
        MOCK_PROOF.stateRootProof,
        MOCK_PROOF.accountProof,
        MOCK_PROOF.storageProof,
      ],
    }));
  });

  it('throws INVALID_INPUT when broadcast: true without an l1WalletClient', async () => {
    const l1 = proveL1Client();

    const err = await expectAzethError(
      proveL2UsdDelta(l1, READER, MOCK_PROOF, { broadcast: true }),
      'INVALID_INPUT',
    );
    expect(err.message).toContain('l1WalletClient');
  });

  it('broadcast happy path: estimates gas, checks balance, writes the simulated request, waits for receipt', async () => {
    const l1 = proveL1Client();
    const wallet = createMockWalletClient();

    const result = await proveL2UsdDelta(l1, READER, MOCK_PROOF, {
      broadcast: true,
      l1WalletClient: wallet,
    });

    expect(result.status).toBe('broadcast');
    expect(result.txHash).toBe(TEST_TX_HASH);
    expect(result.gasEstimate).toBe(500_000n);
    expect(result.receiptStatus).toBe('confirmed');

    expect(l1.estimateContractGas).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'proveL2UsdDelta',
    }));
    expect(l1.getBalance).toHaveBeenCalledWith({ address: wallet.account.address });
    expect(wallet.writeContract).toHaveBeenCalledWith({ __kind: 'simulated-request' });
    expect(l1.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TEST_TX_HASH, timeout: 120_000 });
  });

  it('throws INSUFFICIENT_BALANCE (with balance/required details) before writing when L1 gas is unaffordable', async () => {
    const l1 = proveL1Client();
    l1.getBalance.mockResolvedValue(1n); // far below 500_000 * 2 gwei
    const wallet = createMockWalletClient();

    const err = await expectAzethError(
      proveL2UsdDelta(l1, READER, MOCK_PROOF, { broadcast: true, l1WalletClient: wallet }),
      'INSUFFICIENT_BALANCE',
    );
    expect(err.details?.['balance']).toBe(1n);
    expect(err.details?.['required']).toBe(500_000n * 2_000_000_000n);
    expect(err.message).toContain('Ethereum Sepolia');
    expect(wallet.writeContract).not.toHaveBeenCalled();
  });

  it('short-circuits to already-proven when the cache covers the current anchor (G5)', async () => {
    const l1 = proveL1Client();
    l1.readContract.mockResolvedValue({
      usdDelta: 42n * 10n ** 18n,
      l2BlockNumber: MOCK_ANCHOR.l2BlockNumber, // same anchor height
      provenAt: 1749000000n,
    });

    const result = await proveL2UsdDelta(l1, READER, MOCK_PROOF);

    expect(result.status).toBe('already-proven');
    expect(result.usdDelta).toBe(42n * 10n ** 18n);
    expect(result.anchorL2BlockNumber).toBe(MOCK_ANCHOR.l2BlockNumber);
    expect(result.cached).toMatchObject({
      usdDelta: 42n * 10n ** 18n,
      l2BlockNumber: MOCK_ANCHOR.l2BlockNumber,
      provenAt: 1749000000n,
      proven: true,
    });
    expect(l1.simulateContract).not.toHaveBeenCalled();
  });

  it('throws PROOF_INVALID ALREADY_PROVEN instead when skipIfAlreadyProven: false', async () => {
    const l1 = proveL1Client();
    l1.readContract.mockResolvedValue({
      usdDelta: 42n * 10n ** 18n,
      l2BlockNumber: MOCK_ANCHOR.l2BlockNumber + 10n, // newer than our proof's anchor
      provenAt: 1749000000n,
    });

    const err = await expectAzethError(
      proveL2UsdDelta(l1, READER, MOCK_PROOF, { skipIfAlreadyProven: false }),
      'PROOF_INVALID',
    );
    expect(err.details?.['reason']).toBe('ALREADY_PROVEN');
    expect(err.details?.['cachedL2BlockNumber']).toBe(MOCK_ANCHOR.l2BlockNumber + 10n);
  });

  it('maps an InvalidProof (0x09bde339) simulation revert to PROOF_INVALID', async () => {
    const l1 = proveL1Client();
    l1.simulateContract.mockRejectedValue(new Error('execution reverted, data: 0x09bde339'));

    const err = await expectAzethError(proveL2UsdDelta(l1, READER, MOCK_PROOF), 'PROOF_INVALID');
    expect(err.details?.['selector']).toBe('0x09bde339');
    expect(err.message).toContain('regenerate');
  });

  it('maps a ProofOutdated (0x0aaac1a5) race revert to PROOF_INVALID ALREADY_PROVEN', async () => {
    const l1 = proveL1Client();
    l1.simulateContract.mockRejectedValue(new Error('execution reverted, data: 0x0aaac1a5'));

    const err = await expectAzethError(proveL2UsdDelta(l1, READER, MOCK_PROOF), 'PROOF_INVALID');
    expect(err.details?.['reason']).toBe('ALREADY_PROVEN');
  });

  it('maps unknown-selector reverts to CONTRACT_ERROR', async () => {
    const l1 = proveL1Client();
    l1.simulateContract.mockRejectedValue(new Error('execution reverted, data: 0xdeadbeef00000000'));

    await expectAzethError(proveL2UsdDelta(l1, READER, MOCK_PROOF), 'CONTRACT_ERROR');
  });

  it('returns broadcast + receiptStatus pending WITH the txHash when the receipt wait times out (never throws away a broadcast tx)', async () => {
    const l1 = proveL1Client();
    l1.waitForTransactionReceipt.mockRejectedValue(
      new Error(`Timed out while waiting for transaction with hash "${TEST_TX_HASH}" to be confirmed.`),
    );
    const wallet = createMockWalletClient();

    const result = await proveL2UsdDelta(l1, READER, MOCK_PROOF, {
      broadcast: true,
      l1WalletClient: wallet,
    });

    expect(result.status).toBe('broadcast');
    expect(result.txHash).toBe(TEST_TX_HASH);
    expect(result.receiptStatus).toBe('pending');
    expect(wallet.writeContract).toHaveBeenCalledTimes(1);
  });

  it('returns receiptStatus pending without calling the wait when waitForReceipt: false', async () => {
    const l1 = proveL1Client();
    const wallet = createMockWalletClient();

    const result = await proveL2UsdDelta(l1, READER, MOCK_PROOF, {
      broadcast: true,
      l1WalletClient: wallet,
      waitForReceipt: false,
    });

    expect(result.status).toBe('broadcast');
    expect(result.txHash).toBe(TEST_TX_HASH);
    expect(result.receiptStatus).toBe('pending');
    expect(l1.waitForTransactionReceipt).not.toHaveBeenCalled();
  });

  it('throws CONTRACT_ERROR with txHash details when the broadcast receipt reverts', async () => {
    const l1 = proveL1Client();
    l1.waitForTransactionReceipt.mockResolvedValue({ status: 'reverted' });
    const wallet = createMockWalletClient();

    const err = await expectAzethError(
      proveL2UsdDelta(l1, READER, MOCK_PROOF, { broadcast: true, l1WalletClient: wallet }),
      'CONTRACT_ERROR',
    );
    expect(err.message).toBe('Transaction reverted');
    expect(err.details?.['txHash']).toBe(TEST_TX_HASH);
  });

  it('proceeds to simulate when the cache is older than the current anchor (re-prove allowed)', async () => {
    const l1 = proveL1Client();
    l1.readContract.mockResolvedValue({
      usdDelta: 7n * 10n ** 18n,
      l2BlockNumber: 100n, // < anchor 42329663n
      provenAt: 5n,
    });

    const result = await proveL2UsdDelta(l1, READER, MOCK_PROOF);

    expect(result.status).toBe('simulated');
    expect(l1.simulateContract).toHaveBeenCalledTimes(1);
  });
});
