import { describe, it, expect } from 'vitest';
import {
  BudgetManager,
  DEFAULT_BUDGET_TIERS,
  reputationToScore,
  type BudgetConfig,
} from '../../src/payments/budget.js';

describe('BudgetManager', () => {
  describe('DEFAULT_BUDGET_TIERS', () => {
    it('should have 4 tiers in descending reputation order', () => {
      expect(DEFAULT_BUDGET_TIERS).toHaveLength(4);
      expect(DEFAULT_BUDGET_TIERS[0].label).toBe('diamond');
      expect(DEFAULT_BUDGET_TIERS[1].label).toBe('gold');
      expect(DEFAULT_BUDGET_TIERS[2].label).toBe('silver');
      expect(DEFAULT_BUDGET_TIERS[3].label).toBe('bronze');
    });

    it('should have diamond at $5.00 for rep >= 90', () => {
      expect(DEFAULT_BUDGET_TIERS[0].minReputation).toBe(90);
      expect(DEFAULT_BUDGET_TIERS[0].maxPerTransaction).toBe(5_000_000n);
    });

    it('should have bronze at $0.10 for rep >= 0', () => {
      expect(DEFAULT_BUDGET_TIERS[3].minReputation).toBe(0);
      expect(DEFAULT_BUDGET_TIERS[3].maxPerTransaction).toBe(100_000n);
    });
  });

  describe('checkBudget', () => {
    it('should allow payment within diamond tier for high reputation', () => {
      const budget = new BudgetManager();
      const result = budget.checkBudget(4_000_000n, 95);

      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('diamond');
      expect(result.maxAllowed).toBe(5_000_000n);
    });

    it('should deny payment exceeding diamond tier', () => {
      const budget = new BudgetManager();
      const result = budget.checkBudget(6_000_000n, 95);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('diamond');
      expect(result.reason).toContain('exceeds');
    });

    it('should use gold tier for reputation 70-89', () => {
      const budget = new BudgetManager();
      const result = budget.checkBudget(500_000n, 75);

      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('gold');
    });

    it('should deny gold tier when amount exceeds $1.00', () => {
      const budget = new BudgetManager();
      const result = budget.checkBudget(1_500_000n, 75);

      expect(result.allowed).toBe(false);
      expect(result.tier).toBe('gold');
    });

    it('should use silver tier for reputation 50-69', () => {
      const budget = new BudgetManager();
      const result = budget.checkBudget(400_000n, 55);

      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('silver');
    });

    it('should use bronze tier for reputation 0-49', () => {
      const budget = new BudgetManager();
      const result = budget.checkBudget(50_000n, 25);

      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('bronze');
    });

    it('should use unknown limit for undefined reputation', () => {
      const budget = new BudgetManager();
      const result = budget.checkBudget(50_000n);

      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('unknown');
    });

    it('should deny when amount exceeds unknown limit', () => {
      const budget = new BudgetManager();
      const result = budget.checkBudget(200_000n);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('unknown');
    });

    it('should track session spending cumulatively', () => {
      const budget = new BudgetManager({ maxPerSession: 2_000_000n });

      budget.recordSpend(1_000_000n, 'service-a');
      const result = budget.checkBudget(1_500_000n, 95);

      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Session budget exceeded');
    });

    it('should allow spending up to session limit', () => {
      const budget = new BudgetManager({ maxPerSession: 2_000_000n });

      budget.recordSpend(500_000n, 'service-a');
      const result = budget.checkBudget(1_500_000n, 95);

      expect(result.allowed).toBe(true);
      expect(result.sessionRemaining).toBe(1_500_000n);
    });
  });

  describe('enforce option', () => {
    it('should not block when enforce is false (tracking only)', () => {
      const budget = new BudgetManager({ enforce: false });
      const result = budget.checkBudget(200_000n); // Exceeds unknown limit

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('unknown'); // Still reports the reason
    });

    it('should not block session limit when enforce is false', () => {
      const budget = new BudgetManager({ enforce: false, maxPerSession: 100n });
      budget.recordSpend(100n, 'service');
      const result = budget.checkBudget(1n, 95);

      expect(result.allowed).toBe(true);
      expect(result.reason).toContain('Session budget exceeded');
    });
  });

  describe('custom tiers', () => {
    it('should accept custom tier configuration', () => {
      const budget = new BudgetManager({
        tiers: [
          { minReputation: 80, maxPerTransaction: 10_000_000n, label: 'premium' },
          { minReputation: 0, maxPerTransaction: 1_000_000n, label: 'standard' },
        ],
      });

      const result = budget.checkBudget(8_000_000n, 85);
      expect(result.allowed).toBe(true);
      expect(result.tier).toBe('premium');
    });
  });

  describe('recordSpend', () => {
    it('should track cumulative spending', () => {
      const budget = new BudgetManager();

      budget.recordSpend(1_000_000n, 'service-a');
      budget.recordSpend(2_000_000n, 'service-b');

      expect(budget.getSessionSpent()).toBe(3_000_000n);
    });

    it('should record history entries', () => {
      const budget = new BudgetManager();

      budget.recordSpend(1_000_000n, 'service-a');
      budget.recordSpend(500_000n, 'service-b');

      const history = budget.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0].amount).toBe(1_000_000n);
      expect(history[0].service).toBe('service-a');
      expect(history[1].amount).toBe(500_000n);
    });
  });

  describe('getRemaining', () => {
    it('should return full session budget when nothing spent', () => {
      const budget = new BudgetManager({ maxPerSession: 5_000_000n });
      expect(budget.getRemaining()).toBe(5_000_000n);
    });

    it('should return remaining after spending', () => {
      const budget = new BudgetManager({ maxPerSession: 5_000_000n });
      budget.recordSpend(2_000_000n, 'service');
      expect(budget.getRemaining()).toBe(3_000_000n);
    });

    it('should return 0 when overspent (enforce=false)', () => {
      const budget = new BudgetManager({ maxPerSession: 100n, enforce: false });
      budget.recordSpend(200n, 'service');
      expect(budget.getRemaining()).toBe(0n);
    });
  });

  describe('reset', () => {
    it('should reset spending and history', () => {
      const budget = new BudgetManager();

      budget.recordSpend(1_000_000n, 'service');
      expect(budget.getSessionSpent()).toBe(1_000_000n);
      expect(budget.getHistory()).toHaveLength(1);

      budget.reset();

      expect(budget.getSessionSpent()).toBe(0n);
      expect(budget.getHistory()).toHaveLength(0);
    });
  });

  describe('getLimitForReputation', () => {
    it('should return diamond limit for reputation 95', () => {
      const budget = new BudgetManager();
      expect(budget.getLimitForReputation(95)).toBe(5_000_000n);
    });

    it('should return gold limit for reputation 75', () => {
      const budget = new BudgetManager();
      expect(budget.getLimitForReputation(75)).toBe(1_000_000n);
    });

    it('should return unknown limit for undefined', () => {
      const budget = new BudgetManager({ unknownReputationLimit: 50_000n });
      expect(budget.getLimitForReputation(undefined)).toBe(50_000n);
    });

    it('should return bronze limit for reputation 0', () => {
      const budget = new BudgetManager();
      expect(budget.getLimitForReputation(0)).toBe(100_000n);
    });
  });
});

describe('reputationToScore', () => {
  it('should return score for 0 decimals', () => {
    expect(reputationToScore(85n, 0)).toBe(85);
  });

  it('should handle decimal precision', () => {
    // 8500 with 2 decimals = 85.00
    expect(reputationToScore(8500n, 2)).toBe(85);
  });

  it('should clamp to 0', () => {
    expect(reputationToScore(-10n, 0)).toBe(0);
  });

  it('should clamp to 100', () => {
    expect(reputationToScore(150n, 0)).toBe(100);
  });

  it('should round decimals', () => {
    // 8550 with 2 decimals = 85.50 → rounds to 86
    expect(reputationToScore(8550n, 2)).toBe(86);
  });

  it('should handle high decimal precision', () => {
    // 90 * 10^18 with 18 decimals = 90
    expect(reputationToScore(90_000_000_000_000_000_000n, 18)).toBe(90);
  });
});
