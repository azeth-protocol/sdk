import { http } from 'viem';
import { entryPoint07Address } from 'viem/account-abstraction';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import type { GetPaymasterDataParameters, GetPaymasterDataReturnType, GetPaymasterStubDataParameters, GetPaymasterStubDataReturnType } from 'viem/account-abstraction';

/** Client-side sponsorship policy configuration.
 *  Defense-in-depth layer on top of the paymaster's own server-side policies.
 *  All checks are enforced before calling the paymaster RPC. */
export interface PaymasterPolicy {
  /** Only sponsor UserOps from these smart account addresses.
   *  When empty/undefined, sponsors all accounts. */
  allowedAccounts?: `0x${string}`[];
  /** Maximum number of sponsored UserOps per account per day (anti-Sybil).
   *  0 or undefined = no limit. */
  maxSponsoredPerDay?: number;
  /** Maximum gas cost (in wei) to sponsor per UserOp.
   *  UserOps exceeding this cost fall back to self-paid. */
  maxGasCostWei?: bigint;
}

/** Paymaster middleware shape expected by createSmartAccountClient */
export interface PaymasterMiddleware {
  getPaymasterData: (parameters: GetPaymasterDataParameters) => Promise<GetPaymasterDataReturnType>;
  getPaymasterStubData: (parameters: GetPaymasterStubDataParameters) => Promise<GetPaymasterStubDataReturnType>;
}

/** In-memory daily sponsorship counter.
 *  Resets at midnight UTC by tracking the current date string. */
class SponsorshipCounter {
  private counts = new Map<string, number>();
  private currentDay = '';

  /** Increment and return the new count for the given account.
   *  Returns 0-based pre-increment count (i.e., the count BEFORE this call). */
  incrementAndGet(account: string): number {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.currentDay) {
      this.counts.clear();
      this.currentDay = today;
    }
    const key = account.toLowerCase();
    const current = this.counts.get(key) ?? 0;
    this.counts.set(key, current + 1);
    return current;
  }
}

const dailyCounter = new SponsorshipCounter();

/** Estimate total gas cost in wei from UserOp gas fields.
 *  Uses maxFeePerGas * (callGasLimit + verificationGasLimit + preVerificationGas)
 *  as a conservative upper bound. Returns 0n if fields are missing. */
function estimateGasCostWei(params: GetPaymasterDataParameters): bigint {
  const maxFeePerGas = (params as Record<string, unknown>)['maxFeePerGas'] as bigint | undefined;
  const callGasLimit = (params as Record<string, unknown>)['callGasLimit'] as bigint | undefined;
  const verificationGasLimit = (params as Record<string, unknown>)['verificationGasLimit'] as bigint | undefined;
  const preVerificationGas = (params as Record<string, unknown>)['preVerificationGas'] as bigint | undefined;
  if (!maxFeePerGas) return 0n;
  const totalGas = (callGasLimit ?? 0n) + (verificationGasLimit ?? 0n) + (preVerificationGas ?? 0n);
  return maxFeePerGas * totalGas;
}

/** Check if the policy allows sponsoring this UserOp.
 *  Returns a reason string if denied, undefined if allowed. */
export function checkPolicy(
  policy: PaymasterPolicy | undefined,
  params: GetPaymasterDataParameters,
): string | undefined {
  if (!policy) return undefined;

  const sender = (params as Record<string, unknown>)['sender'] as `0x${string}` | undefined;

  // Check allowedAccounts
  if (policy.allowedAccounts && policy.allowedAccounts.length > 0 && sender) {
    const allowed = policy.allowedAccounts.some(
      (a) => a.toLowerCase() === sender.toLowerCase(),
    );
    if (!allowed) {
      return `Account ${sender} not in paymaster allowedAccounts`;
    }
  }

  // Check daily limit
  if (policy.maxSponsoredPerDay && policy.maxSponsoredPerDay > 0 && sender) {
    const countBefore = dailyCounter.incrementAndGet(sender);
    if (countBefore >= policy.maxSponsoredPerDay) {
      return `Account ${sender} exceeded daily sponsorship limit (${policy.maxSponsoredPerDay})`;
    }
  }

  // Check max gas cost
  if (policy.maxGasCostWei && policy.maxGasCostWei > 0n) {
    const cost = estimateGasCostWei(params);
    if (cost > 0n && cost > policy.maxGasCostWei) {
      return `Estimated gas cost ${cost} wei exceeds maxGasCostWei ${policy.maxGasCostWei}`;
    }
  }

  return undefined;
}

/** Create a paymaster middleware that wraps a PimlicoClient with graceful fallback
 *  and optional policy enforcement.
 *
 *  When the paymaster is unreachable or rejects the UserOp, the middleware returns
 *  empty paymaster data so the UserOp falls back to self-paid gas.
 *
 *  @param paymasterUrl - URL for the paymaster RPC endpoint
 *  @param policy - Optional sponsorship policy for client-side filtering
 *  @returns PaymasterMiddleware compatible with permissionless's createSmartAccountClient
 */
export function createPaymasterMiddleware(
  paymasterUrl: string,
  policy?: PaymasterPolicy,
): PaymasterMiddleware {
  const pimlicoClient = createPimlicoClient({
    transport: http(paymasterUrl),
    entryPoint: { address: entryPoint07Address, version: '0.7' },
  });

  return {
    getPaymasterData: async (params) => {
      // Policy check before calling the paymaster
      const policyDenial = checkPolicy(policy, params);
      if (policyDenial) {
        console.warn(`[azeth] Paymaster policy denied: ${policyDenial}. Falling back to self-paid gas.`);
        return {} as GetPaymasterDataReturnType;
      }

      try {
        return await pimlicoClient.getPaymasterData(params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[azeth] Paymaster getPaymasterData failed: ${message}. Falling back to self-paid gas.`);
        return {} as GetPaymasterDataReturnType;
      }
    },

    getPaymasterStubData: async (params) => {
      // Policy check applies to stub data too (same sender, same policy)
      const policyDenial = checkPolicy(policy, params as unknown as GetPaymasterDataParameters);
      if (policyDenial) {
        return {} as GetPaymasterStubDataReturnType;
      }

      try {
        return await pimlicoClient.getPaymasterStubData(params);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[azeth] Paymaster getPaymasterStubData failed: ${message}. Falling back to self-paid gas.`);
        return {} as GetPaymasterStubDataReturnType;
      }
    },
  };
}
