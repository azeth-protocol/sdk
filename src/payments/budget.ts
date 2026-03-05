/** Reputation-aware budget manager for x402 payments.
 *
 *  Provides per-transaction and per-session spending limits that scale
 *  with the target service's on-chain reputation. Higher reputation =
 *  higher trust = higher allowed spending.
 *
 *  Budget tiers are configurable and layer ON TOP of the Guardian Module's
 *  on-chain dailySpendLimitUSD (which is the hard ceiling that can't be bypassed).
 *  This is a client-side soft limit for convenience and safety.
 */

import { AzethError } from '@azeth/common';

/** A single budget tier: reputation threshold → per-transaction limit */
export interface BudgetTier {
  /** Minimum reputation score to qualify for this tier (0-100) */
  minReputation: number;
  /** Maximum payment per transaction in token smallest unit (e.g., USDC 6 decimals) */
  maxPerTransaction: bigint;
  /** Tier label for display/logging */
  label: string;
}

/** Default budget tiers (ordered highest reputation first) */
export const DEFAULT_BUDGET_TIERS: readonly BudgetTier[] = [
  { minReputation: 90, maxPerTransaction: 5_000_000n, label: 'diamond' },  // $5.00 USDC
  { minReputation: 70, maxPerTransaction: 1_000_000n, label: 'gold' },     // $1.00 USDC
  { minReputation: 50, maxPerTransaction: 500_000n,   label: 'silver' },   // $0.50 USDC
  { minReputation: 0,  maxPerTransaction: 100_000n,   label: 'bronze' },   // $0.10 USDC
] as const;

/** Budget manager configuration */
export interface BudgetConfig {
  /** Custom budget tiers (overrides defaults). Must be sorted by minReputation descending. */
  tiers?: BudgetTier[];
  /** Maximum spending per session across all services (in token smallest unit).
   *  Default: 10,000,000 (10 USDC) */
  maxPerSession?: bigint;
  /** Whether to enforce budget checks (default: true).
   *  When false, budget is tracked but not enforced. */
  enforce?: boolean;
  /** Fallback per-tx limit when reputation is unknown (default: bronze tier) */
  unknownReputationLimit?: bigint;
}

/** Result of a budget check */
export interface BudgetCheckResult {
  allowed: boolean;
  reason?: string;
  /** The tier that was matched */
  tier?: string;
  /** Maximum allowed for this transaction */
  maxAllowed?: bigint;
  /** Remaining session budget */
  sessionRemaining?: bigint;
}

/** Record of a completed payment for budget tracking */
interface SpendRecord {
  amount: bigint;
  service: string;
  timestamp: number;
}

/** Manages spending limits based on service reputation.
 *
 *  Usage:
 *  ```ts
 *  const budget = new BudgetManager({ maxPerSession: 10_000_000n });
 *  const check = budget.checkBudget(amount, serviceReputation);
 *  if (!check.allowed) throw new Error(check.reason);
 *  // ... make payment ...
 *  budget.recordSpend(amount, serviceUrl);
 *  ```
 */
export class BudgetManager {
  private static readonly MAX_HISTORY = 10_000;

  private readonly _tiers: readonly BudgetTier[];
  private readonly _maxPerSession: bigint;
  private readonly _enforce: boolean;
  private readonly _unknownLimit: bigint;
  private _sessionSpent = 0n;
  private _history: SpendRecord[] = [];

  /** Promise-based mutex for atomic check-and-spend operations (C-1 fix) */
  private _lock: Promise<void> = Promise.resolve();

  constructor(config?: BudgetConfig) {
    this._tiers = config?.tiers ?? DEFAULT_BUDGET_TIERS;
    this._maxPerSession = config?.maxPerSession ?? 10_000_000n;
    this._enforce = config?.enforce ?? true;
    this._unknownLimit = config?.unknownReputationLimit ?? 100_000n; // $0.10 USDC
  }

  /** Acquire exclusive budget access for atomic check-and-spend.
   *
   *  Serializes concurrent async operations so that checkBudget + recordSpend
   *  cannot be interleaved by parallel payment flows (TOCTOU prevention).
   *
   *  Audit #10: Timeout prevents permanent deadlock if fn() never resolves.
   *  120s allows for full smart_pay cycle: discovery + on-chain settlement +
   *  UserOp bundling + retries + reputation feedback.
   *
   *  @param fn - The async function to execute while holding the lock
   *  @returns The return value of fn
   */
  async acquireBudgetLock<T>(fn: () => Promise<T>): Promise<T> {
    const LOCK_TIMEOUT_MS = 120_000;
    let release: () => void;
    const next = new Promise<void>(resolve => { release = resolve; });
    const prev = this._lock;
    this._lock = next;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AzethError('Budget lock timeout', 'NETWORK_ERROR')),
        LOCK_TIMEOUT_MS,
      );
    });

    try {
      await Promise.race([prev, timeout]);
      return await Promise.race([fn(), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      release!();
    }
  }

  /** Check if a payment is within budget.
   *
   *  @param amount - Payment amount in token smallest unit
   *  @param serviceReputation - Service's reputation score (0-100), or undefined if unknown
   *  @returns Budget check result with allowed/denied and reason
   */
  checkBudget(amount: bigint, serviceReputation?: number): BudgetCheckResult {
    const sessionRemaining = this._maxPerSession - this._sessionSpent;

    // Check session limit
    if (amount > sessionRemaining) {
      const result: BudgetCheckResult = {
        allowed: false,
        reason: `Session budget exceeded: ${amount} requested, ${sessionRemaining} remaining of ${this._maxPerSession} total`,
        sessionRemaining,
      };
      return this._enforce ? result : { ...result, allowed: true };
    }

    // Find matching tier
    const tier = this._findTier(serviceReputation);
    const maxAllowed = tier?.maxPerTransaction ?? this._unknownLimit;
    const tierLabel = tier?.label ?? 'unknown';

    // Check per-transaction limit
    if (amount > maxAllowed) {
      const result: BudgetCheckResult = {
        allowed: false,
        reason: `Amount ${amount} exceeds ${tierLabel} tier limit of ${maxAllowed} (reputation: ${serviceReputation ?? 'unknown'})`,
        tier: tierLabel,
        maxAllowed,
        sessionRemaining,
      };
      return this._enforce ? result : { ...result, allowed: true };
    }

    return {
      allowed: true,
      tier: tierLabel,
      maxAllowed,
      sessionRemaining,
    };
  }

  /** Record a completed payment.
   *
   *  History is capped at MAX_HISTORY entries (M-1 fix) to prevent unbounded growth.
   */
  recordSpend(amount: bigint, service: string): void {
    this._sessionSpent += amount;
    this._history.push({ amount, service, timestamp: Date.now() });
    if (this._history.length > BudgetManager.MAX_HISTORY) {
      this._history = this._history.slice(-BudgetManager.MAX_HISTORY);
    }
  }

  /** Get total spent this session */
  getSessionSpent(): bigint {
    return this._sessionSpent;
  }

  /** Get remaining session budget */
  getRemaining(): bigint {
    const remaining = this._maxPerSession - this._sessionSpent;
    return remaining > 0n ? remaining : 0n;
  }

  /** Get spending history */
  getHistory(): readonly SpendRecord[] {
    return this._history;
  }

  /** Reset session spending (e.g., for a new session) */
  reset(): void {
    this._sessionSpent = 0n;
    this._history = [];
  }

  /** Get the per-transaction limit for a given reputation score */
  getLimitForReputation(reputation?: number): bigint {
    return this._findTier(reputation)?.maxPerTransaction ?? this._unknownLimit;
  }

  private _findTier(reputation?: number): BudgetTier | undefined {
    if (reputation === undefined || reputation === null) return undefined;
    // Tiers are sorted by minReputation descending — first match wins
    for (const tier of this._tiers) {
      if (reputation >= tier.minReputation) {
        return tier;
      }
    }
    return undefined;
  }
}

/** Compute a reputation score (0-100) from on-chain summary data.
 *
 *  Converts the raw summaryValue/summaryValueDecimals from the ERC-8004
 *  Reputation Registry into a 0-100 integer score suitable for budget tier lookup.
 */
export function reputationToScore(summaryValue: bigint, summaryValueDecimals: number): number {
  if (summaryValueDecimals === 0) {
    const val = Number(summaryValue);
    return Math.max(0, Math.min(100, val));
  }
  const divisor = 10n ** BigInt(summaryValueDecimals);
  const score = Number(summaryValue) / Number(divisor);
  return Math.max(0, Math.min(100, Math.round(score)));
}
