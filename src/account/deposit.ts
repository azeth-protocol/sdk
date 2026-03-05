import {
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
  erc20Abi,
} from 'viem';
import { AzethError, type AzethContractAddresses } from '@azeth/common';
import { AzethFactoryAbi } from '@azeth/common/abis';
import { requireAddress } from '../utils/addresses.js';
import { withRetry } from '../utils/retry.js';

export interface DepositParams {
  /** The smart account to deposit into (must be owned by the caller) */
  to: `0x${string}`;
  /** Amount to deposit (in smallest unit) */
  amount: bigint;
  /** ERC-20 token address. Omit for native ETH deposit. */
  token?: `0x${string}`;
}

export interface DepositResult {
  txHash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  token: `0x${string}` | 'ETH';
}

/** Validate that a target address is an Azeth smart account owned by the depositor.
 *
 *  SECURITY CRITICAL: Both checks are on-chain reads and cannot be spoofed.
 *  1. factory.isAzethAccount(target) — confirms it's a real Azeth account
 *  2. factory.getOwnerOf(target) == depositor — confirms ownership
 *
 *  No TOCTOU risk: AzethAccount has no transferOwnership(), so ownership is immutable.
 */
export async function validateDepositTarget(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  depositor: `0x${string}`,
  target: `0x${string}`,
): Promise<void> {
  const factoryAddress = requireAddress(addresses, 'factory');

  // Check 1: Is this a real Azeth account?
  const isAzethAccount = await withRetry(() => publicClient.readContract({
    address: factoryAddress,
    abi: AzethFactoryAbi,
    functionName: 'isAzethAccount',
    args: [target],
  }));

  if (!isAzethAccount) {
    throw new AzethError(
      'Target is not a valid Azeth smart account',
      'INVALID_INPUT',
      { target, factory: factoryAddress },
    );
  }

  // Check 2: Does the depositor own this account?
  const owner = await withRetry(() => publicClient.readContract({
    address: factoryAddress,
    abi: AzethFactoryAbi,
    functionName: 'getOwnerOf',
    args: [target],
  }));

  if (owner.toLowerCase() !== depositor.toLowerCase()) {
    throw new AzethError(
      'Cannot deposit to a smart account you do not own',
      'UNAUTHORIZED',
      { target, owner, depositor },
    );
  }
}

/** Deposit ETH or ERC-20 tokens from the EOA to a self-owned smart account.
 *
 *  SECURITY: Validates on-chain that the target is:
 *  1. A real Azeth smart account (via factory.isAzethAccount)
 *  2. Owned by the depositor (via factory.getOwnerOf)
 */
export async function deposit(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  addresses: AzethContractAddresses,
  depositor: `0x${string}`,
  params: DepositParams,
): Promise<DepositResult> {
  if (params.amount <= 0n) {
    throw new AzethError('Deposit amount must be positive', 'INVALID_INPUT', { field: 'amount' });
  }

  // SECURITY: On-chain ownership verification
  await validateDepositTarget(publicClient, addresses, depositor, params.to);

  let txHash: `0x${string}`;

  try {
    if (!params.token) {
      // ETH deposit: simple value transfer to the smart account
      txHash = await walletClient.sendTransaction({
        to: params.to,
        value: params.amount,
      });
    } else {
      // ERC-20 deposit: transfer tokens to the smart account
      txHash = await walletClient.writeContract({
        address: params.token,
        abi: erc20Abi,
        functionName: 'transfer',
        args: [params.to, params.amount],
      });
    }
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    const message = err instanceof Error ? err.message : 'Deposit failed';
    const isInsufficientFunds = message.toLowerCase().includes('insufficient') ||
      message.toLowerCase().includes('exceeds balance');
    throw new AzethError(
      message,
      isInsufficientFunds ? 'INSUFFICIENT_BALANCE' : 'NETWORK_ERROR',
      { originalError: err instanceof Error ? err.name : undefined },
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

  if (receipt.status === 'reverted') {
    throw new AzethError('Deposit transaction reverted', 'NETWORK_ERROR', { txHash });
  }

  return {
    txHash,
    from: depositor,
    to: params.to,
    amount: params.amount,
    token: params.token ?? 'ETH',
  };
}
