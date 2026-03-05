import { describe, it, expect } from 'vitest';
import { encodeErrorResult } from 'viem';
import {
  AzethFactoryAbi,
  ReputationModuleAbi,
  GuardianModuleAbi,
  TrustRegistryModuleAbi,
  PaymentAgreementModuleAbi,
  AzethAccountAbi,
} from '@azeth/common/abis';
import { AzethError } from '@azeth/common';
import { decodeContractError, wrapContractError } from '../../src/utils/errors.js';

describe('utils/errors', () => {
  describe('decodeContractError', () => {
    it('should decode AccountAlreadyDeployed to ACCOUNT_EXISTS', () => {
      const data = encodeErrorResult({
        abi: AzethFactoryAbi,
        errorName: 'AccountAlreadyDeployed',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('ACCOUNT_EXISTS');
      expect(result!.message).toContain('already exists');
    });

    it('should decode InsufficientPaymentUSD to INSUFFICIENT_PAYMENT', () => {
      const data = encodeErrorResult({
        abi: ReputationModuleAbi,
        errorName: 'InsufficientPaymentUSD',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('INSUFFICIENT_PAYMENT');
      expect(result!.message).toContain('$1 USD');
    });

    it('should decode SelfRatingNotAllowed to INVALID_INPUT', () => {
      const data = encodeErrorResult({
        abi: ReputationModuleAbi,
        errorName: 'SelfRatingNotAllowed',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('INVALID_INPUT');
      expect(result!.message).toContain('rate yourself');
    });

    it('should decode SiblingRatingNotAllowed to INVALID_INPUT', () => {
      const data = encodeErrorResult({
        abi: ReputationModuleAbi,
        errorName: 'SiblingRatingNotAllowed',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('INVALID_INPUT');
      expect(result!.message).toContain('sibling');
    });

    it('should decode NotAzethAccount to UNAUTHORIZED', () => {
      const data = encodeErrorResult({
        abi: ReputationModuleAbi,
        errorName: 'NotAzethAccount',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('UNAUTHORIZED');
      expect(result!.message).toContain('registered Azeth');
    });

    it('should decode GuardianLimitExceeded to BUDGET_EXCEEDED', () => {
      const data = encodeErrorResult({
        abi: PaymentAgreementModuleAbi,
        errorName: 'GuardianLimitExceeded',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('BUDGET_EXCEEDED');
    });

    it('should decode TokenNotWhitelisted to GUARDIAN_REJECTED', () => {
      const data = encodeErrorResult({
        abi: PaymentAgreementModuleAbi,
        errorName: 'TokenNotWhitelisted',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('GUARDIAN_REJECTED');
    });

    it('should decode AlreadyRegistered to ACCOUNT_EXISTS', () => {
      const data = encodeErrorResult({
        abi: TrustRegistryModuleAbi,
        errorName: 'AlreadyRegistered',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('ACCOUNT_EXISTS');
    });

    it('should decode InvalidAgreement to INVALID_INPUT', () => {
      const data = encodeErrorResult({
        abi: PaymentAgreementModuleAbi,
        errorName: 'InvalidAgreement',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('INVALID_INPUT');
    });

    it('should decode OnlyOwner to UNAUTHORIZED', () => {
      const data = encodeErrorResult({
        abi: AzethAccountAbi,
        errorName: 'OnlyOwner',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('UNAUTHORIZED');
    });

    it('should decode InsufficientBalance to INSUFFICIENT_BALANCE', () => {
      const data = encodeErrorResult({
        abi: AzethFactoryAbi,
        errorName: 'InsufficientBalance',
        args: [100n, 200n],
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('INSUFFICIENT_BALANCE');
    });

    it('should extract data from nested cause chain', () => {
      const data = encodeErrorResult({
        abi: AzethFactoryAbi,
        errorName: 'AccountAlreadyDeployed',
      });
      const inner = new Error('inner') as Error & { data: string };
      inner.data = data;
      const outer = new Error('outer') as Error & { cause: Error };
      outer.cause = inner;

      const result = decodeContractError(outer);
      expect(result).toBeDefined();
      expect(result!.code).toBe('ACCOUNT_EXISTS');
    });

    it('should extract hex from error message as last resort', () => {
      const data = encodeErrorResult({
        abi: ReputationModuleAbi,
        errorName: 'SelfRatingNotAllowed',
      });
      const err = new Error(`execution reverted: ${data}`);

      const result = decodeContractError(err);
      expect(result).toBeDefined();
      expect(result!.code).toBe('INVALID_INPUT');
    });

    it('should return undefined for non-contract errors', () => {
      const err = new Error('some random network error');
      const result = decodeContractError(err);
      expect(result).toBeUndefined();
    });

    it('should return undefined for non-Error values', () => {
      const result = decodeContractError('just a string');
      expect(result).toBeUndefined();
    });

    it('should return undefined for unknown selectors', () => {
      const err = new Error('revert') as Error & { data: string };
      err.data = '0xdeadbeef';
      const result = decodeContractError(err);
      expect(result).toBeUndefined();
    });
  });

  describe('wrapContractError', () => {
    it('should pass through AzethError unchanged', () => {
      const original = new AzethError('test', 'INVALID_INPUT');
      const result = wrapContractError(original, 'NETWORK_ERROR');
      expect(result).toBe(original);
      expect(result.code).toBe('INVALID_INPUT');
    });

    it('should decode contract errors into specific codes', () => {
      const data = encodeErrorResult({
        abi: ReputationModuleAbi,
        errorName: 'InsufficientPaymentUSD',
      });
      const err = makeViemError(data);

      const result = wrapContractError(err, 'REGISTRY_ERROR');
      expect(result).toBeInstanceOf(AzethError);
      expect(result.code).toBe('INSUFFICIENT_PAYMENT');
    });

    it('should use fallback code for non-contract errors', () => {
      const err = new Error('timeout');
      const result = wrapContractError(err, 'NETWORK_ERROR');
      expect(result).toBeInstanceOf(AzethError);
      expect(result.code).toBe('NETWORK_ERROR');
      expect(result.message).toBe('timeout');
    });

    it('should handle non-Error values with fallback code', () => {
      const result = wrapContractError('string error', 'REGISTRY_ERROR');
      expect(result).toBeInstanceOf(AzethError);
      expect(result.code).toBe('REGISTRY_ERROR');
      expect(result.message).toBe('Unknown error');
    });

    it('should detect AA error codes and map to CONTRACT_ERROR', () => {
      const err = new Error('UserOperation reverted during simulation with reason: AA23 reverted');
      const result = wrapContractError(err, 'NETWORK_ERROR');
      expect(result).toBeInstanceOf(AzethError);
      expect(result.code).toBe('CONTRACT_ERROR');
      expect(result.details?.aaErrorCode).toBe('AA23');
    });

    it('should detect AA24 in bundler error messages', () => {
      const err = new Error('execution reverted: AA24 signature error');
      const result = wrapContractError(err, 'NETWORK_ERROR');
      expect(result).toBeInstanceOf(AzethError);
      expect(result.code).toBe('CONTRACT_ERROR');
      expect(result.details?.aaErrorCode).toBe('AA24');
    });

    it('should map deployment errors to CONTRACT_ERROR', () => {
      const data = encodeErrorResult({
        abi: AzethFactoryAbi,
        errorName: 'DeploymentFailed',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('CONTRACT_ERROR');
    });

    it('should map ExecutionFailed to CONTRACT_ERROR', () => {
      const data = encodeErrorResult({
        abi: AzethAccountAbi,
        errorName: 'ExecutionFailed',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('CONTRACT_ERROR');
    });

    it('should map FailedDeployment to CONTRACT_ERROR', () => {
      const data = encodeErrorResult({
        abi: AzethFactoryAbi,
        errorName: 'FailedDeployment',
      });
      const err = makeViemError(data);
      const result = decodeContractError(err);

      expect(result).toBeDefined();
      expect(result!.code).toBe('CONTRACT_ERROR');
    });
  });
});

/** Create a mock viem-style error with revert data on .data */
function makeViemError(data: `0x${string}`): Error & { data: `0x${string}` } {
  const err = new Error('ContractFunctionExecutionError') as Error & { data: `0x${string}` };
  err.data = data;
  return err;
}
