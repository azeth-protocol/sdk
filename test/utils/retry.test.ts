import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from '../../src/utils/retry.js';
import { AzethError } from '@azeth/common';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns immediately on first success without retrying', async () => {
    const fn = vi.fn().mockResolvedValue('ok');

    const promise = withRetry(fn);
    const result = await promise;

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on network error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new AzethError('fail', 'NETWORK_ERROR'))
      .mockResolvedValue('recovered');

    const promise = withRetry(fn, { maxRetries: 3, baseDelay: 100 });

    // Advance past the first retry delay
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries up to maxRetries then throws last error', async () => {
    vi.useRealTimers();

    const error = new AzethError('network down', 'NETWORK_ERROR');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxRetries: 2, baseDelay: 1 })).rejects.toThrow('network down');
    // 1 initial + 2 retries = 3 calls
    expect(fn).toHaveBeenCalledTimes(3);

    vi.useFakeTimers();
  });

  it('throws non-retryable errors immediately without retrying', async () => {
    const error = new AzethError('bad input', 'INVALID_INPUT');
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow('bad input');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('applies exponential backoff with increasing delays', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const fn = vi.fn()
      .mockRejectedValueOnce(new AzethError('fail', 'NETWORK_ERROR'))
      .mockRejectedValueOnce(new AzethError('fail', 'NETWORK_ERROR'))
      .mockResolvedValue('ok');

    // Use a deterministic jitter by seeding random
    vi.spyOn(Math, 'random').mockReturnValue(0);

    const promise = withRetry(fn, { maxRetries: 3, baseDelay: 100, maxDelay: 10000 });

    // First retry: baseDelay * 2^0 + jitter(0) = 100ms
    await vi.advanceTimersByTimeAsync(100);
    // Second retry: baseDelay * 2^1 + jitter(0) = 200ms
    await vi.advanceTimersByTimeAsync(200);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);

    // Verify delays were passed to setTimeout — first retry delay should be 100 (100*2^0 + 0)
    const delayCalls = setTimeoutSpy.mock.calls
      .filter(([, ms]) => typeof ms === 'number' && ms > 0)
      .map(([, ms]) => ms as number);

    // First delay: 100 * 2^0 = 100, second delay: 100 * 2^1 = 200
    expect(delayCalls).toContain(100);
    expect(delayCalls).toContain(200);

    setTimeoutSpy.mockRestore();
    vi.mocked(Math.random).mockRestore();
  });

  it('caps delay at maxDelay', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    const fn = vi.fn()
      .mockRejectedValueOnce(new AzethError('fail', 'NETWORK_ERROR'))
      .mockRejectedValueOnce(new AzethError('fail', 'NETWORK_ERROR'))
      .mockRejectedValueOnce(new AzethError('fail', 'NETWORK_ERROR'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 3, baseDelay: 1000, maxDelay: 2000 });

    // Advance through all retries
    await vi.advanceTimersByTimeAsync(10000);

    const result = await promise;
    expect(result).toBe('ok');

    // Third retry delay: 1000 * 2^2 = 4000 but capped at maxDelay=2000
    const delayCalls = setTimeoutSpy.mock.calls
      .filter(([, ms]) => typeof ms === 'number' && ms > 0)
      .map(([, ms]) => ms as number);

    // All delays should be <= maxDelay
    for (const delay of delayCalls) {
      expect(delay).toBeLessThanOrEqual(2000);
    }

    setTimeoutSpy.mockRestore();
    vi.mocked(Math.random).mockRestore();
  });

  it('retries on TypeError with fetch in message', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 1, baseDelay: 10 });
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('retries on errors containing network-related keywords', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxRetries: 1, baseDelay: 10 });
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses custom retryOn predicate when provided', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new AzethError('bad input', 'INVALID_INPUT'))
      .mockResolvedValue('ok');

    // Custom predicate: retry on everything
    const promise = withRetry(fn, {
      maxRetries: 1,
      baseDelay: 10,
      retryOn: () => true,
    });
    await vi.advanceTimersByTimeAsync(100);

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses default options when none provided', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new AzethError('net', 'NETWORK_ERROR'))
      .mockResolvedValue('result');

    const promise = withRetry(fn);
    // Default baseDelay is 1000, so advance past it
    await vi.advanceTimersByTimeAsync(2000);

    const result = await promise;
    expect(result).toBe('result');
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
