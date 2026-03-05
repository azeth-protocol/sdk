/** Typed event emitter for AzethKit lifecycle events.
 *
 *  Provides hooks for extensibility — auto-feedback, budget checks,
 *  rate limiting, and custom user logic can all subscribe to these events.
 *
 *  Pre-* events fire BEFORE the action (can inspect but not cancel).
 *  After-* events fire AFTER the action completes (with result data).
 *  Error events fire when an action fails.
 */

/** Payment event data emitted before/after x402 calls */
export interface PaymentEventData {
  /** The URL being paid for */
  url: string;
  /** HTTP method used */
  method: string;
  /** The service's payment recipient address */
  payTo?: `0x${string}`;
  /** Payment amount in token smallest unit */
  amount?: bigint;
  /** Chain ID */
  chainId?: number;
}

/** Successful payment result data */
export interface PaymentResultData extends PaymentEventData {
  /** Whether a payment was actually made (false if no 402 returned) */
  paymentMade: boolean;
  /** Response HTTP status code */
  statusCode: number;
  /** Response time in milliseconds */
  responseTimeMs: number;
  /** Transaction hash if payment was made */
  txHash?: `0x${string}`;
}

/** Transfer event data */
export interface TransferEventData {
  to: `0x${string}`;
  amount: bigint;
  token?: `0x${string}`;
}

/** Transfer result data */
export interface TransferResultData extends TransferEventData {
  txHash: `0x${string}`;
}

/** Deposit event data */
export interface DepositEventData {
  to: `0x${string}`;
  amount: bigint;
  token?: `0x${string}`;
}

/** Deposit result data */
export interface DepositResultData extends DepositEventData {
  txHash: `0x${string}`;
}

/** Error event data for any failed operation */
export interface ErrorEventData {
  operation: string;
  error: Error;
  context?: Record<string, unknown>;
}

/** Map of all AzethKit events to their data types */
export interface AzethEventMap {
  beforePayment: PaymentEventData;
  afterPayment: PaymentResultData;
  paymentError: ErrorEventData;
  beforeTransfer: TransferEventData;
  afterTransfer: TransferResultData;
  transferError: ErrorEventData;
  beforeDeposit: DepositEventData;
  afterDeposit: DepositResultData;
  depositError: ErrorEventData;
}

export type AzethEventName = keyof AzethEventMap;

/** Event listener function type */
export type AzethEventListener<T> = (data: T) => void | Promise<void>;

/** Typed event emitter that supports synchronous and async listeners */
export class AzethEventEmitter {
  /** M-10 fix: Maximum listeners per event to detect leaks */
  private _maxListeners = 50;
  private _listeners = new Map<string, Set<AzethEventListener<unknown>>>();
  private _warnedEvents = new Set<string>();

  /** Set the maximum number of listeners per event (M-10 fix).
   *  Exceeding this threshold logs a warning to help detect listener leaks. */
  setMaxListeners(n: number): void {
    this._maxListeners = n;
  }

  /** Subscribe to an event. Returns an unsubscribe function. */
  on<K extends AzethEventName>(
    event: K,
    listener: AzethEventListener<AzethEventMap[K]>,
  ): () => void {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener as AzethEventListener<unknown>);

    // M-10: Warn once per event if listener count exceeds max
    if (set.size > this._maxListeners && !this._warnedEvents.has(event)) {
      this._warnedEvents.add(event);
      console.warn(
        `AzethEventEmitter: Possible listener leak detected. Event '${event}' has ${set.size} listeners (max: ${this._maxListeners}).`,
      );
    }

    return () => {
      set!.delete(listener as AzethEventListener<unknown>);
      if (set!.size === 0) {
        this._listeners.delete(event);
        this._warnedEvents.delete(event);
      }
    };
  }

  /** Subscribe to an event for a single firing, then auto-unsubscribe. */
  once<K extends AzethEventName>(
    event: K,
    listener: AzethEventListener<AzethEventMap[K]>,
  ): () => void {
    const unsub = this.on(event, (data) => {
      unsub();
      return listener(data);
    });
    return unsub;
  }

  /** Emit an event to all listeners. Async listeners run concurrently.
   *  Errors in listeners are caught and logged, never propagated to callers. */
  async emit<K extends AzethEventName>(
    event: K,
    data: AzethEventMap[K],
  ): Promise<void> {
    const set = this._listeners.get(event);
    if (!set || set.size === 0) return;

    const promises: Promise<void>[] = [];
    for (const listener of set) {
      try {
        const result = listener(data);
        if (result && typeof (result as Promise<void>).then === 'function') {
          promises.push(
            (result as Promise<void>).catch(() => {
              // Swallow async listener errors — events must be non-blocking
            }),
          );
        }
      } catch {
        // Swallow sync listener errors
      }
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }
  }

  /** Remove all listeners for an event, or all events if no event specified. */
  removeAllListeners(event?: AzethEventName): void {
    if (event) {
      this._listeners.delete(event);
      this._warnedEvents.delete(event);
    } else {
      this._listeners.clear();
      this._warnedEvents.clear();
    }
  }

  /** Get the number of listeners for an event */
  listenerCount(event: AzethEventName): number {
    return this._listeners.get(event)?.size ?? 0;
  }
}
