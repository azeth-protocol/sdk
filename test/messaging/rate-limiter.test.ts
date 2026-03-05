import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter } from '../../src/messaging/rate-limiter.js';

describe('messaging/rate-limiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    limiter?.destroy();
    vi.useRealTimers();
  });

  describe('checkLimit', () => {
    it('should allow messages within the limit', () => {
      limiter = new RateLimiter(3);

      expect(limiter.checkLimit('sender-a')).toBe(true);
      expect(limiter.checkLimit('sender-a')).toBe(true);
      expect(limiter.checkLimit('sender-a')).toBe(true);
    });

    it('should reject messages exceeding the limit', () => {
      limiter = new RateLimiter(2);

      expect(limiter.checkLimit('sender-a')).toBe(true);
      expect(limiter.checkLimit('sender-a')).toBe(true);
      expect(limiter.checkLimit('sender-a')).toBe(false);
    });

    it('should track limits per sender independently', () => {
      limiter = new RateLimiter(1);

      expect(limiter.checkLimit('sender-a')).toBe(true);
      expect(limiter.checkLimit('sender-b')).toBe(true);
      expect(limiter.checkLimit('sender-a')).toBe(false);
      expect(limiter.checkLimit('sender-b')).toBe(false);
    });

    it('should reset after the 1-minute window', () => {
      limiter = new RateLimiter(1);

      expect(limiter.checkLimit('sender-a')).toBe(true);
      expect(limiter.checkLimit('sender-a')).toBe(false);

      // Advance past 1 minute
      vi.advanceTimersByTime(61_000);

      expect(limiter.checkLimit('sender-a')).toBe(true);
    });

    it('should use default of 10 when no max provided', () => {
      limiter = new RateLimiter();

      for (let i = 0; i < 10; i++) {
        expect(limiter.checkLimit('sender-a')).toBe(true);
      }
      expect(limiter.checkLimit('sender-a')).toBe(false);
    });
  });

  describe('getRemainingQuota', () => {
    it('should return full quota for unknown sender', () => {
      limiter = new RateLimiter(5);
      expect(limiter.getRemainingQuota('new-sender')).toBe(5);
    });

    it('should return remaining quota after messages', () => {
      limiter = new RateLimiter(5);

      limiter.checkLimit('sender-a');
      limiter.checkLimit('sender-a');

      expect(limiter.getRemainingQuota('sender-a')).toBe(3);
    });

    it('should return 0 when limit is exhausted', () => {
      limiter = new RateLimiter(1);

      limiter.checkLimit('sender-a');

      expect(limiter.getRemainingQuota('sender-a')).toBe(0);
    });
  });

  describe('cleanup', () => {
    it('should purge stale entries after cleanup interval (5 min)', () => {
      limiter = new RateLimiter(10);

      limiter.checkLimit('sender-a');

      // Advance past the 1-minute window so entries are stale
      vi.advanceTimersByTime(61_000);

      // Advance to trigger the 5-minute cleanup interval
      vi.advanceTimersByTime(240_000); // Total: ~5 min

      // After cleanup, the quota should be full
      expect(limiter.getRemainingQuota('sender-a')).toBe(10);
    });
  });

  describe('destroy', () => {
    it('should stop the cleanup interval', () => {
      limiter = new RateLimiter(10);

      limiter.destroy();

      // Advance past cleanup interval — should not throw
      vi.advanceTimersByTime(600_000);
    });

    it('should be safe to call destroy multiple times', () => {
      limiter = new RateLimiter(10);

      expect(() => {
        limiter.destroy();
        limiter.destroy();
      }).not.toThrow();
    });

    it('should clear all tracked state', () => {
      limiter = new RateLimiter(10);
      limiter.checkLimit('sender-a');

      limiter.destroy();

      // After destroy, a new check should work with fresh state
      // (but the interval is stopped, so we just verify no throw)
      expect(limiter.getRemainingQuota('sender-a')).toBe(10);
    });
  });
});
