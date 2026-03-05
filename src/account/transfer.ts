import {
  erc20Abi,
  encodeFunctionData,
  type Hex,
  type PublicClient,
  type Chain,
  type Transport,
} from 'viem';
import { AzethError, formatTokenAmount, type AzethContractAddresses } from '@azeth/common';
import { GuardianModuleAbi } from '@azeth/common/abis';
import { requireAddress } from '../utils/addresses.js';
import type { AzethSmartAccountClient } from '../utils/userop.js';

export interface TransferParams {
  to: `0x${string}`;
  token?: `0x${string}`; // undefined = ETH transfer
  amount: bigint;
}

export interface TransferResult {
  txHash: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  amount: bigint;
  token: `0x${string}` | 'ETH';
}

/** Reason enum values matching GuardianModule.ValidationReason order */
const VALIDATION_REASON_NAMES = [
  'OK',
  'ACCOUNT_NOT_INITIALIZED',
  'EXCEEDS_TX_LIMIT',
  'EXCEEDS_DAILY_LIMIT',
  'TARGET_NOT_WHITELISTED',
  'ORACLE_STALE',
  'GUARDIAN_REQUIRED',
] as const;

/** Format a bigint 18-decimal USD value for human-readable error messages */
function formatUSD(value18: bigint): string {
  return `$${formatTokenAmount(value18, 18, 2)}`;
}

/** Pre-flight guardrail check via GuardianModule.checkOperation().
 *
 *  Calls the on-chain view function to get structured validation reasons before
 *  submitting a UserOp that would fail with the opaque "AA24 signature error".
 *
 *  @throws AzethError('GUARDIAN_REJECTED') with human-readable details */
async function preflightCheck(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  smartAccount: `0x${string}`,
  params: TransferParams,
): Promise<void> {
  const guardianAddress = requireAddress(addresses, 'guardianModule');

  // Map transfer params to checkOperation params:
  // ETH: target=recipient, value=amount, token=address(0)
  // ERC-20: target=tokenContract, value=amount, token=tokenContract
  const target = params.token ?? params.to;
  const token: `0x${string}` = params.token ?? '0x0000000000000000000000000000000000000000';

  const [reason, details] = await publicClient.readContract({
    address: guardianAddress,
    abi: GuardianModuleAbi,
    functionName: 'checkOperation',
    args: [smartAccount, target, params.amount, token],
  });

  if (reason === 0) return; // OK

  const reasonName = VALIDATION_REASON_NAMES[reason] ?? 'UNKNOWN';

  const errorDetails: Record<string, unknown> = {
    reason: reasonName,
    usdValue: formatUSD(details.usdValue),
    dailySpentUSD: formatUSD(details.dailySpentUSD),
    maxTxAmountUSD: formatUSD(details.maxTxAmountUSD),
    dailySpendLimitUSD: formatUSD(details.dailySpendLimitUSD),
  };

  let message: string;
  switch (reason) {
    case 1: // ACCOUNT_NOT_INITIALIZED
      message = `Smart account ${smartAccount} is not initialized with GuardianModule`;
      break;
    case 2: // EXCEEDS_TX_LIMIT
      message = `Transfer of ${formatUSD(details.usdValue)} exceeds per-transaction limit of ${formatUSD(details.maxTxAmountUSD)}`;
      break;
    case 3: // EXCEEDS_DAILY_LIMIT
      message = `Transfer of ${formatUSD(details.usdValue)} would push daily spend to ${formatUSD(details.dailySpentUSD + details.usdValue)}, exceeding daily limit of ${formatUSD(details.dailySpendLimitUSD)}`;
      break;
    case 4: // TARGET_NOT_WHITELISTED
      message = `Target ${target} is not in the token or protocol whitelist. Add it via setTokenWhitelist() or setProtocolWhitelist()`;
      break;
    case 5: // ORACLE_STALE
      message = `Price oracle is stale — guardian co-signature required for this transfer`;
      break;
    case 6: // GUARDIAN_REQUIRED
      message = `Guardian co-signature required for this operation`;
      break;
    default:
      message = `Guardian validation failed (reason ${reason})`;
  }

  throw new AzethError(message, 'GUARDIAN_REJECTED', errorDetails);
}

/** Transfer ETH or ERC-20 tokens via the smart account using ERC-4337 UserOperations.
 *
 *  The SmartAccountClient builds a UserOperation that routes through EntryPoint v0.7,
 *  which calls executeUserOp() on the AzethAccount. This is the ONLY authorized path
 *  for state-changing operations on AzethAccount v12.
 *
 *  When publicClient and addresses are provided, a pre-flight guardrail check is
 *  performed via GuardianModule.checkOperation() to catch spending limit / whitelist
 *  failures with descriptive errors instead of the opaque "AA24 signature error".
 *
 *  M-12 fix (Audit #8): Rejects zero-amount transfers at the raw function level. */
export async function transfer(
  smartAccountClient: AzethSmartAccountClient,
  smartAccount: `0x${string}`,
  params: TransferParams,
  publicClient?: PublicClient<Transport, Chain>,
  addresses?: AzethContractAddresses,
): Promise<TransferResult> {
  // M-12 fix (Audit #8): Block negative amounts (bigint can go negative).
  // AUDIT-FIX: Also reject zero-amount transfers — they waste gas on a no-op.
  if (params.amount <= 0n) {
    throw new AzethError('Transfer amount must be greater than zero', 'INVALID_INPUT', { field: 'amount' });
  }

  // Pre-flight guardrail check: catch spending limit / whitelist failures early
  // with descriptive errors instead of opaque "AA24 signature error".
  if (publicClient && addresses) {
    await preflightCheck(publicClient, addresses, smartAccount, params);
  }

  let txHash: `0x${string}`;

  try {
    if (!params.token) {
      // ETH transfer via UserOp: sendTransaction encodes via account.encodeCalls()
      // which wraps in AzethAccount.execute(mode, encodeSingle(to, amount, "0x"))
      txHash = await smartAccountClient.sendTransaction({
        to: params.to,
        value: params.amount,
        data: '0x' as Hex,
      });
    } else {
      // ERC-20 transfer via UserOp: encode the ERC-20 transfer call,
      // then sendTransaction wraps in execute(mode, encodeSingle(token, 0, data))
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transfer',
        args: [params.to, params.amount],
      });
      txHash = await smartAccountClient.sendTransaction({
        to: params.token,
        value: 0n,
        data,
      });
    }
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    const message = err instanceof Error ? err.message : 'Transfer failed';
    const isInsufficientFunds = message.toLowerCase().includes('insufficient') ||
      message.toLowerCase().includes('exceeds balance');
    throw new AzethError(
      message,
      isInsufficientFunds ? 'INSUFFICIENT_BALANCE' : 'CONTRACT_ERROR',
      { originalError: err instanceof Error ? err.name : undefined },
    );
  }

  return {
    txHash,
    from: smartAccount,
    to: params.to,
    amount: params.amount,
    token: params.token ?? 'ETH',
  };
}
