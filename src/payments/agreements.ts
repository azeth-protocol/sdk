import {
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
  keccak256,
  toBytes,
  encodeFunctionData,
} from 'viem';
import { PaymentAgreementModuleAbi } from '@azeth/common/abis';
import { AzethError, type AzethContractAddresses, type PaymentAgreement } from '@azeth/common';
import { requireAddress } from '../utils/addresses.js';
import { wrapContractError } from '../utils/errors.js';
import { withRetry } from '../utils/retry.js';
import type { AzethSmartAccountClient } from '../utils/userop.js';

export interface CreateAgreementParams {
  payee: `0x${string}`;
  token: `0x${string}`;
  amount: bigint;
  interval: number; // seconds
  endTime?: bigint; // Unix timestamp after which agreement expires (0 = no expiry)
  maxExecutions?: number;
  totalCap?: bigint; // Maximum total payout. Defaults to amount * maxExecutions (or amount * 365 if unlimited).
}

export interface AgreementResult {
  agreementId: bigint;
  txHash: `0x${string}`;
}

// AgreementCreated(address indexed account, uint256 indexed agreementId, address indexed payee, address token, uint256 amount, uint256 interval, uint256 endTime)
const AGREEMENT_CREATED_TOPIC = keccak256(toBytes('AgreementCreated(address,uint256,address,address,uint256,uint256,uint256)'));

/** Create a recurring payment agreement via ERC-4337 UserOperation.
 *
 *  Routes the call through the smart account so msg.sender = smart account address.
 *  The SmartAccountClient wraps the PaymentAgreementModule.createAgreement() call
 *  inside AzethAccount.execute() via a UserOp submitted to EntryPoint v0.7.
 */
export async function createPaymentAgreement(
  publicClient: PublicClient<Transport, Chain>,
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  params: CreateAgreementParams,
): Promise<AgreementResult> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(params.payee)) {
    throw new AzethError('Invalid payee address format', 'INVALID_INPUT', { field: 'payee' });
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(params.token)) {
    throw new AzethError('Invalid token address format', 'INVALID_INPUT', { field: 'token' });
  }
  if (params.amount <= 0n) {
    throw new AzethError('Payment amount must be positive', 'INVALID_INPUT', { field: 'amount' });
  }
  if (!Number.isInteger(params.interval) || params.interval < 1) {
    throw new AzethError('Interval must be a positive integer (seconds)', 'INVALID_INPUT', { field: 'interval' });
  }
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  let txHash: `0x${string}`;
  try {
    const data = encodeFunctionData({
      abi: PaymentAgreementModuleAbi,
      functionName: 'createAgreement',
      args: [
        params.payee,
        params.token,
        params.amount,
        BigInt(params.interval),
        params.endTime ?? 0n,
        BigInt(params.maxExecutions ?? 0),
        params.totalCap ?? (params.maxExecutions ? params.amount * BigInt(params.maxExecutions) : params.amount * 365n),
      ],
    });
    txHash = await smartAccountClient.sendTransaction({
      to: moduleAddress,
      value: 0n,
      data,
    });
  } catch (err: unknown) {
    throw wrapContractError(err, 'PAYMENT_FAILED');
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

  if (receipt.status === 'reverted') {
    throw new AzethError('Transaction reverted', 'CONTRACT_ERROR', { txHash });
  }

  // Parse AgreementCreated event for agreementId — filter by module address and event signature
  let agreementId = 0n;
  for (const log of receipt.logs) {
    if (log.address?.toLowerCase() === moduleAddress.toLowerCase() && log.topics[0] === AGREEMENT_CREATED_TOPIC && log.topics.length >= 3) {
      agreementId = BigInt(log.topics[2] ?? '0x0');
      break;
    }
  }

  return { agreementId, txHash };
}

/** Get agreement details */
export async function getAgreement(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  agreementId: bigint,
): Promise<PaymentAgreement> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  const result = await withRetry(() => publicClient.readContract({
    address: moduleAddress,
    abi: PaymentAgreementModuleAbi,
    functionName: 'getAgreement',
    args: [account, agreementId],
  })) as unknown as {
    payee: `0x${string}`;
    token: `0x${string}`;
    amount: bigint;
    interval: bigint;
    endTime: bigint;
    lastExecuted: bigint;
    maxExecutions: bigint;
    executionCount: bigint;
    totalCap: bigint;
    totalPaid: bigint;
    active: boolean;
  };

  return {
    id: agreementId,
    payee: result.payee,
    token: result.token,
    amount: result.amount,
    interval: result.interval,
    endTime: result.endTime,
    lastExecuted: result.lastExecuted,
    maxExecutions: result.maxExecutions,
    executionCount: result.executionCount,
    totalCap: result.totalCap,
    totalPaid: result.totalPaid,
    active: result.active,
  };
}

/** Audit #13 M-14 fix: Cap the number of agreements scanned to prevent RPC flooding */
const MAX_AGREEMENT_SCAN = 100;

/** Find an active agreement from a given account to a specific payee.
 *  Iterates from newest to oldest (newest more likely active).
 *  Scans at most MAX_AGREEMENT_SCAN agreements to prevent O(n) RPC calls.
 *
 *  @param publicClient - viem public client for on-chain reads
 *  @param addresses - Contract addresses containing paymentAgreementModule
 *  @param account - The payer's smart account address
 *  @param payee - The payee address to match
 *  @param token - Optional token address to filter by
 *  @returns The first matching active agreement, or null
 */
export async function findAgreementWithPayee(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  payee: `0x${string}`,
  token?: `0x${string}`,
): Promise<PaymentAgreement | null> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  // Get agreement count
  let count: bigint;
  try {
    count = await withRetry(() => publicClient.readContract({
      address: moduleAddress,
      abi: PaymentAgreementModuleAbi,
      functionName: 'getAgreementCount',
      args: [account],
    })) as bigint;
  } catch {
    return null;
  }

  if (count === 0n) return null;

  const now = BigInt(Math.floor(Date.now() / 1000));

  // Cap scan to most recent MAX_AGREEMENT_SCAN agreements to prevent RPC flooding
  const scanLimit = count < BigInt(MAX_AGREEMENT_SCAN) ? count : BigInt(MAX_AGREEMENT_SCAN);
  const startIndex = count - 1n;
  const endIndex = count - scanLimit;

  // Iterate from newest to oldest (most recent agreements are most likely active)
  for (let i = startIndex; i >= endIndex; i--) {
    let agreement: PaymentAgreement;
    try {
      agreement = await getAgreement(publicClient, addresses, account, i);
    } catch {
      continue;
    }

    if (!agreement.active) continue;
    if (agreement.payee.toLowerCase() !== payee.toLowerCase()) continue;
    if (token && agreement.token.toLowerCase() !== token.toLowerCase()) continue;
    if (agreement.endTime !== 0n && agreement.endTime <= now) continue;
    if (agreement.maxExecutions !== 0n && agreement.executionCount >= agreement.maxExecutions) continue;

    return agreement;
  }

  return null;
}

/** Execute a due payment agreement via ERC-4337 UserOperation.
 *
 *  Routes the call through the smart account so msg.sender = smart account address.
 */
export async function executeAgreement(
  publicClient: PublicClient<Transport, Chain>,
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  agreementId: bigint,
): Promise<`0x${string}`> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  let txHash: `0x${string}`;
  try {
    const data = encodeFunctionData({
      abi: PaymentAgreementModuleAbi,
      functionName: 'executeAgreement',
      args: [account, agreementId],
    });
    txHash = await smartAccountClient.sendTransaction({
      to: moduleAddress,
      value: 0n,
      data,
    });
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to execute agreement',
      'PAYMENT_FAILED',
      { operation: 'agreement_execution', originalError: err instanceof Error ? err.name : undefined },
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

  if (receipt.status === 'reverted') {
    throw new AzethError('Transaction reverted', 'CONTRACT_ERROR', { txHash });
  }

  return txHash;
}

/** Execute a payment agreement as a third-party keeper.
 *
 *  The contract's executeAgreement() is permissionless — any msg.sender can trigger it.
 *  When the caller is NOT the payer (i.e., it's a keeper or payee), we cannot build a
 *  UserOp for the payer's smart account (AA24 signature mismatch). Instead:
 *
 *  - If the keeper has their own smart account: route via the keeper's SmartAccountClient
 *    (the keeper's smart account calls the module, which executes on the payer's account)
 *  - If the keeper has no smart account: call the module directly from the keeper's EOA
 *    via walletClient.writeContract()
 */
export async function executeAgreementAsKeeper(
  publicClient: PublicClient<Transport, Chain>,
  keeperSmartAccountClient: AzethSmartAccountClient | null,
  walletClient: WalletClient<Transport, Chain, Account>,
  addresses: AzethContractAddresses,
  payerAccount: `0x${string}`,
  agreementId: bigint,
): Promise<`0x${string}`> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  let txHash: `0x${string}`;
  try {
    const data = encodeFunctionData({
      abi: PaymentAgreementModuleAbi,
      functionName: 'executeAgreement',
      args: [payerAccount, agreementId],
    });

    if (keeperSmartAccountClient) {
      // Route via keeper's own smart account (UserOp from keeper's account)
      txHash = await keeperSmartAccountClient.sendTransaction({
        to: moduleAddress,
        value: 0n,
        data,
      });
    } else {
      // Direct EOA call — keeper has no smart account
      txHash = await walletClient.writeContract({
        address: moduleAddress,
        abi: PaymentAgreementModuleAbi,
        functionName: 'executeAgreement',
        args: [payerAccount, agreementId],
      });
    }
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to execute agreement as keeper',
      'PAYMENT_FAILED',
      { operation: 'agreement_execution', originalError: err instanceof Error ? err.name : undefined },
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

  if (receipt.status === 'reverted') {
    throw new AzethError('Transaction reverted', 'CONTRACT_ERROR', { txHash });
  }

  return txHash;
}

/** Cancel an active payment agreement via ERC-4337 UserOperation.
 *
 *  Routes the call through the smart account so msg.sender = smart account address.
 *  Only the payer (agreement creator) can cancel. Immediate effect, no timelock.
 */
export async function cancelAgreement(
  publicClient: PublicClient<Transport, Chain>,
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  agreementId: bigint,
): Promise<`0x${string}`> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  let txHash: `0x${string}`;
  try {
    const data = encodeFunctionData({
      abi: PaymentAgreementModuleAbi,
      functionName: 'cancelAgreement',
      args: [agreementId],
    });
    txHash = await smartAccountClient.sendTransaction({
      to: moduleAddress,
      value: 0n,
      data,
    });
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to cancel agreement',
      'PAYMENT_FAILED',
      { operation: 'agreement_cancel', originalError: err instanceof Error ? err.name : undefined },
    );
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

  if (receipt.status === 'reverted') {
    throw new AzethError('Transaction reverted', 'CONTRACT_ERROR', { txHash });
  }

  return txHash;
}

/** Get the total number of agreements for an account */
export async function getAgreementCount(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
): Promise<bigint> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  return await withRetry(() => publicClient.readContract({
    address: moduleAddress,
    abi: PaymentAgreementModuleAbi,
    functionName: 'getAgreementCount',
    args: [account],
  })) as bigint;
}

/** Check if a payment agreement can be executed right now.
 *  Returns [executable, reason] — reason explains why if not executable.
 */
export async function canExecutePayment(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  agreementId: bigint,
): Promise<{ executable: boolean; reason: string }> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  const result = await withRetry(() => publicClient.readContract({
    address: moduleAddress,
    abi: PaymentAgreementModuleAbi,
    functionName: 'canExecutePayment',
    args: [account, agreementId],
  })) as readonly [boolean, string];

  return { executable: result[0], reason: result[1] };
}

/** Check if a payment agreement is executable (ignoring interval timing).
 *  Checks: active, not expired, not maxed, not capped, guardian whitelist,
 *  guardian limits, and payer balance >= accrued amount. */
export async function isAgreementExecutable(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  agreementId: bigint,
): Promise<boolean> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');
  return await withRetry(() => publicClient.readContract({
    address: moduleAddress,
    abi: PaymentAgreementModuleAbi,
    functionName: 'isAgreementExecutable',
    args: [account, agreementId],
  })) as boolean;
}

/** Get comprehensive agreement data in a single RPC call.
 *  Combines getAgreement + isAgreementExecutable + isAgreementDue +
 *  getNextExecutionTime + getAgreementCount. */
export async function getAgreementData(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  agreementId: bigint,
): Promise<{
  agreement: PaymentAgreement;
  executable: boolean;
  reason: string;
  isDue: boolean;
  nextExecutionTime: bigint;
  count: bigint;
}> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');
  const result = await withRetry(() => publicClient.readContract({
    address: moduleAddress,
    abi: PaymentAgreementModuleAbi,
    functionName: 'getAgreementData',
    args: [account, agreementId],
  })) as readonly [any, boolean, string, boolean, bigint, bigint];

  return {
    agreement: {
      id: agreementId,
      payee: result[0].payee,
      token: result[0].token,
      amount: result[0].amount,
      interval: result[0].interval,
      endTime: result[0].endTime,
      lastExecuted: result[0].lastExecuted,
      maxExecutions: result[0].maxExecutions,
      executionCount: result[0].executionCount,
      totalCap: result[0].totalCap,
      totalPaid: result[0].totalPaid,
      active: result[0].active,
    },
    executable: result[1],
    reason: result[2],
    isDue: result[3],
    nextExecutionTime: result[4],
    count: result[5],
  };
}

/** Get the next execution timestamp for a payment agreement */
export async function getNextExecutionTime(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  agreementId: bigint,
): Promise<bigint> {
  const moduleAddress = requireAddress(addresses, 'paymentAgreementModule');

  return await withRetry(() => publicClient.readContract({
    address: moduleAddress,
    abi: PaymentAgreementModuleAbi,
    functionName: 'getNextExecutionTime',
    args: [account, agreementId],
  })) as bigint;
}
