/** Per-sender rate limiter for incoming XMTP messages.
 *
 *  Tracks timestamps of recent messages per sender and rejects messages
 *  that exceed the configured rate. Stale entries are cleaned up on a
 *  configurable interval.
 */
export class RateLimiter {
  private readonly _limits: Map<string, number[]> = new Map();
  private readonly _maxPerMinute: number;
  /** M-6: Maximum number of tracked senders to prevent unbounded memory growth */
  private readonly _maxSenders: number;
  private _cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /** @param maxPerMinute Maximum messages per sender per minute (default 10)
   *  @param maxSenders Maximum tracked sender entries before eviction (default 10_000) */
  constructor(maxPerMinute = 10, maxSenders = 10_000) {
    this._maxPerMinute = maxPerMinute;
    this._maxSenders = maxSenders;
    this._cleanupInterval = setInterval(() => this._cleanup(), 300_000);
  }

  /** Check whether a sender is within their rate limit.
   *
   *  Records the current timestamp if allowed.
   *
   *  @param sender - Sender identifier (typically an address)
   *  @returns `true` if the message is within the limit, `false` if rate-limited
   */
  checkLimit(sender: string): boolean {
    const now = Date.now();
    const timestamps = this._limits.get(sender) ?? [];
    const recent = timestamps.filter(ts => now - ts < 60_000);

    if (recent.length >= this._maxPerMinute) {
      this._limits.set(sender, recent);
      return false;
    }

    // M-6: Evict oldest sender entry if at capacity (FIFO eviction)
    if (this._limits.size >= this._maxSenders && !this._limits.has(sender)) {
      const oldestKey = this._limits.keys().next().value;
      if (oldestKey !== undefined) this._limits.delete(oldestKey);
    }

    recent.push(now);
    this._limits.set(sender, recent);
    return true;
  }

  /** Get remaining message quota for a sender within the current minute window */
  getRemainingQuota(sender: string): number {
    const now = Date.now();
    const timestamps = this._limits.get(sender) ?? [];
    const recent = timestamps.filter(ts => now - ts < 60_000);
    return Math.max(0, this._maxPerMinute - recent.length);
  }

  /** Purge expired entries from all senders */
  private _cleanup(): void {
    const now = Date.now();
    for (const [sender, timestamps] of this._limits.entries()) {
      const recent = timestamps.filter(ts => now - ts < 60_000);
      if (recent.length === 0) {
        this._limits.delete(sender);
      } else {
        this._limits.set(sender, recent);
      }
    }
  }

  /** Stop the cleanup timer and clear all state */
  destroy(): void {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    this._limits.clear();
  }
}
