import { decodeErrorResult, type Abi } from 'viem';
import {
  AzethError,
  type AzethErrorCode,
} from '@azeth/common';
import {
  AzethAccountAbi,
  AzethFactoryAbi,
  GuardianModuleAbi,
  TrustRegistryModuleAbi,
  PaymentAgreementModuleAbi,
  ReputationModuleAbi,
} from '@azeth/common/abis';

/** All Azeth contract ABIs for error decoding */
const ALL_ABIS: Abi[] = [
  AzethAccountAbi as unknown as Abi,
  AzethFactoryAbi as unknown as Abi,
  GuardianModuleAbi as unknown as Abi,
  TrustRegistryModuleAbi as unknown as Abi,
  PaymentAgreementModuleAbi as unknown as Abi,
  ReputationModuleAbi as unknown as Abi,
];

/** Mapping from contract error name → AzethErrorCode + human-readable message */
const ERROR_MAP: Record<string, { code: AzethErrorCode; message: string }> = {
  // AzethFactory
  AccountAlreadyDeployed: { code: 'ACCOUNT_EXISTS', message: 'An account with this salt already exists.' },
  MaxAccountsPerOwnerReached: { code: 'INVALID_INPUT', message: 'Maximum accounts per owner reached (100).' },
  DeploymentFailed: { code: 'CONTRACT_ERROR', message: 'Smart account deployment failed.' },
  FailedDeployment: { code: 'CONTRACT_ERROR', message: 'Contract deployment failed.' },
  Create2EmptyBytecode: { code: 'CONTRACT_ERROR', message: 'Deployment bytecode is empty.' },

  // GuardianModule
  GuardianLimitExceeded: { code: 'BUDGET_EXCEEDED', message: 'Transaction exceeds guardian spending limit.' },
  ExecutorSpendExceedsLimit: { code: 'BUDGET_EXCEEDED', message: 'Executor spending exceeds daily limit.' },
  TokenNotWhitelisted: { code: 'GUARDIAN_REJECTED', message: 'Token is not on the guardian whitelist.' },
  NotGuardian: { code: 'UNAUTHORIZED', message: 'Caller is not the authorized guardian.' },
  NotTightening: { code: 'GUARDIAN_REJECTED', message: 'Guardrail changes must tighten limits (loosening requires timelock).' },
  TimelockNotExpired: { code: 'GUARDIAN_REJECTED', message: 'Timelock period has not expired yet.' },
  ChangeAlreadyPending: { code: 'GUARDIAN_REJECTED', message: 'A guardrail change is already pending.' },
  NoPendingChange: { code: 'GUARDIAN_REJECTED', message: 'No pending guardrail change to execute.' },
  NoPendingEmergency: { code: 'GUARDIAN_REJECTED', message: 'No pending emergency withdrawal to execute.' },
  InvalidGuardrails: { code: 'INVALID_INPUT', message: 'Invalid guardrails configuration.' },

  // AzethAccount
  OnlyEntryPoint: { code: 'UNAUTHORIZED', message: 'Only the ERC-4337 EntryPoint can call this function.' },
  OnlyOwner: { code: 'UNAUTHORIZED', message: 'Only the account owner can call this function.' },
  OnlyExecutor: { code: 'UNAUTHORIZED', message: 'Only an installed executor module can call this function.' },
  OnlyFactory: { code: 'UNAUTHORIZED', message: 'Only the factory can call this function.' },
  NotAuthorized: { code: 'UNAUTHORIZED', message: 'Caller is not authorized for this operation.' },
  ExecutionFailed: { code: 'CONTRACT_ERROR', message: 'Account execution failed.' },
  ModuleAlreadyInstalled: { code: 'INVALID_INPUT', message: 'Module is already installed on this account.' },
  ModuleNotInstalled: { code: 'INVALID_INPUT', message: 'Module is not installed on this account.' },
  UnsupportedCallType: { code: 'INVALID_INPUT', message: 'Unsupported call type for this execution mode.' },
  UnsupportedExecType: { code: 'INVALID_INPUT', message: 'Unsupported execution type.' },
  UnsupportedModuleType: { code: 'INVALID_INPUT', message: 'Unsupported module type.' },
  MismatchModuleTypeId: { code: 'INVALID_INPUT', message: 'Module type ID does not match expected type.' },
  MaxHooksReached: { code: 'INVALID_INPUT', message: 'Maximum number of hooks reached.' },
  NotSmartAccount: { code: 'UNAUTHORIZED', message: 'Target is not a smart account.' },
  BatchLengthMismatch: { code: 'INVALID_INPUT', message: 'Batch execution arrays have mismatched lengths.' },

  // TrustRegistryModule
  AlreadyRegistered: { code: 'ACCOUNT_EXISTS', message: 'This account is already registered on the trust registry.' },
  AlreadyInitialized: { code: 'INVALID_INPUT', message: 'Module is already initialized.' },
  NotInitialized: { code: 'ACCOUNT_NOT_FOUND', message: 'Account is not initialized on this module.' },
  NotRegistered: { code: 'SERVICE_NOT_FOUND', message: 'Account is not registered on the trust registry.' },
  InvalidAddress: { code: 'INVALID_INPUT', message: 'Invalid address provided.' },
  InvalidURI: { code: 'INVALID_INPUT', message: 'Invalid URI provided.' },
  InvalidOwner: { code: 'UNAUTHORIZED', message: 'Invalid owner for this operation.' },

  // ReputationModule
  NotAzethAccount: { code: 'UNAUTHORIZED', message: 'Caller is not a registered Azeth smart account.' },
  InsufficientPaymentUSD: { code: 'INSUFFICIENT_PAYMENT', message: 'You must pay the agent at least $1 USD before submitting an opinion.' },
  SelfRatingNotAllowed: { code: 'INVALID_INPUT', message: 'Cannot rate yourself.' },
  SiblingRatingNotAllowed: { code: 'INVALID_INPUT', message: 'Cannot rate a sibling account (same owner).' },
  InvalidAgentId: { code: 'INVALID_INPUT', message: 'Invalid agent token ID.' },
  InvalidValueDecimals: { code: 'INVALID_INPUT', message: 'Value decimals exceed maximum (18).' },

  // PaymentAgreementModule
  AgreementNotExists: { code: 'AGREEMENT_NOT_FOUND', message: 'Payment agreement does not exist.' },
  InvalidAgreement: { code: 'INVALID_INPUT', message: 'Invalid payment agreement parameters.' },
  SelfAgreement: { code: 'INVALID_INPUT', message: 'Cannot create a payment agreement with yourself.' },
  InsufficientBalance: { code: 'INSUFFICIENT_BALANCE', message: 'Insufficient balance for this operation.' },
  TransferFailed: { code: 'PAYMENT_FAILED', message: 'Token transfer failed.' },
};

/** Extract revert data hex from a viem error object using multiple strategies.
 *
 *  Viem wraps contract reverts in nested error objects with inconsistent
 *  structures across versions and RPC providers. This function cascades
 *  through every known location where revert data can appear.
 */
function extractRevertData(err: unknown): `0x${string}` | undefined {
  if (!(err instanceof Error)) return undefined;

  const viemErr = err as Error & {
    data?: `0x${string}` | { data?: `0x${string}` };
    cause?: Error & {
      data?: `0x${string}` | { data?: `0x${string}` };
      cause?: Error & { data?: `0x${string}` | { data?: `0x${string}` } };
    };
    walk?: (fn: (e: unknown) => boolean) => (Error & { data?: `0x${string}` }) | null;
  };

  // Strategy 1: Direct .data property
  if (typeof viemErr.data === 'string' && viemErr.data.startsWith('0x') && viemErr.data.length >= 10) {
    return viemErr.data as `0x${string}`;
  }
  if (viemErr.data && typeof viemErr.data === 'object' && typeof viemErr.data.data === 'string') {
    if (viemErr.data.data.startsWith('0x') && viemErr.data.data.length >= 10) {
      return viemErr.data.data as `0x${string}`;
    }
  }

  // Strategy 2: .cause chain (viem wraps errors 1-2 levels deep)
  if (viemErr.cause) {
    if (typeof viemErr.cause.data === 'string' && viemErr.cause.data.startsWith('0x') && viemErr.cause.data.length >= 10) {
      return viemErr.cause.data as `0x${string}`;
    }
    if (viemErr.cause.data && typeof viemErr.cause.data === 'object' && typeof viemErr.cause.data.data === 'string') {
      if (viemErr.cause.data.data.startsWith('0x') && viemErr.cause.data.data.length >= 10) {
        return viemErr.cause.data.data as `0x${string}`;
      }
    }
    // Third level
    if (viemErr.cause.cause) {
      if (typeof viemErr.cause.cause.data === 'string' && viemErr.cause.cause.data.startsWith('0x') && viemErr.cause.cause.data.length >= 10) {
        return viemErr.cause.cause.data as `0x${string}`;
      }
      if (viemErr.cause.cause.data && typeof viemErr.cause.cause.data === 'object' && typeof viemErr.cause.cause.data.data === 'string') {
        if (viemErr.cause.cause.data.data.startsWith('0x') && viemErr.cause.cause.data.data.length >= 10) {
          return viemErr.cause.cause.data.data as `0x${string}`;
        }
      }
    }
  }

  // Strategy 3: viem's .walk() method (available on BaseError)
  if (typeof viemErr.walk === 'function') {
    const found = viemErr.walk((e) => {
      const inner = e as Error & { data?: string };
      return typeof inner.data === 'string' && inner.data.startsWith('0x') && inner.data.length >= 10;
    });
    if (found && typeof found.data === 'string' && found.data.startsWith('0x')) {
      return found.data as `0x${string}`;
    }
  }

  // Strategy 4: Parse hex from error message (bundler errors embed revert data in text)
  const msg = viemErr.message;
  const hexMatch = msg.match(/(?:revert(?:ed)?|data|reason|error).*?(0x[0-9a-fA-F]{8,})/i);
  if (hexMatch?.[1] && hexMatch[1].length >= 10) {
    return hexMatch[1] as `0x${string}`;
  }

  return undefined;
}

/** Attempt to decode a Solidity custom error from a thrown error object.
 *
 *  Tries each Azeth contract ABI in sequence until one successfully decodes
 *  the revert data. Returns the mapped AzethErrorCode and a human-readable
 *  message, or undefined if the error is not a recognized contract revert.
 */
export function decodeContractError(err: unknown): { code: AzethErrorCode; message: string } | undefined {
  const data = extractRevertData(err);
  if (!data) return undefined;

  for (const abi of ALL_ABIS) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      const mapping = ERROR_MAP[decoded.errorName];
      if (mapping) {
        return mapping;
      }
      // Known error name but not in our map — return a generic decoded message
      return {
        code: 'CONTRACT_ERROR',
        message: `Contract error: ${decoded.errorName}`,
      };
    } catch {
      // This ABI doesn't match this selector — try next
    }
  }

  return undefined;
}

/** Wrap an unknown error, attempting contract error decoding first.
 *
 *  Drop-in replacement for the existing catch-block pattern:
 *    catch (err) { throw wrapContractError(err, 'NETWORK_ERROR'); }
 *
 *  If the error is already an AzethError, re-throws it unchanged.
 *  If the error contains revert data matching a known contract error,
 *  throws an AzethError with the specific code and message.
 *  Otherwise, throws an AzethError with the provided fallback code.
 */
export function wrapContractError(err: unknown, fallbackCode: AzethErrorCode): AzethError {
  if (err instanceof AzethError) return err;

  const decoded = decodeContractError(err);
  if (decoded) {
    return new AzethError(decoded.message, decoded.code, {
      originalError: err instanceof Error ? err.name : undefined,
    });
  }

  // Detect ERC-4337 AA error codes (AA21, AA23, AA24, AA25, etc.)
  const message = err instanceof Error ? err.message : String(err);
  const aaMatch = message.match(/AA(\d{2})/);
  if (aaMatch) {
    return new AzethError(
      message,
      'CONTRACT_ERROR',
      {
        aaErrorCode: `AA${aaMatch[1]}`,
        originalError: err instanceof Error ? err.name : undefined,
      },
    );
  }

  return new AzethError(
    err instanceof Error ? err.message : 'Unknown error',
    fallbackCode,
    { originalError: err instanceof Error ? err.name : undefined },
  );
}
