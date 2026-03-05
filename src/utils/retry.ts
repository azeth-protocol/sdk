import { AzethError } from '@azeth/common';

export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Base delay in ms before first retry (default: 1000) */
  baseDelay?: number;
  /** Maximum delay in ms between retries (default: 10000) */
  maxDelay?: number;
  /** Custom predicate to determine if an error is retryable */
  retryOn?: (error: unknown) => boolean;
}

/** LOW-8 fix: Retryable Node.js error codes (stable across versions, unlike message strings) */
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT',
]);

/** Default retry predicate: retries on network errors and 5xx status codes */
function isRetryableError(error: unknown): boolean {
  if (error instanceof AzethError) {
    return error.code === 'NETWORK_ERROR';
  }
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true;
  }
  if (error instanceof Error) {
    // LOW-8 fix: Prefer stable error codes over fragile string matching.
    // Node.js system errors (and undici) expose a `code` property.
    const errCode = (error as Error & { code?: string }).code;
    if (errCode && RETRYABLE_ERROR_CODES.has(errCode)) {
      return true;
    }
    // Fallback: string matching for environments without error codes
    const msg = error.message.toLowerCase();
    return msg.includes('network') ||
      msg.includes('econnrefused') ||
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('socket hang up') ||
      msg.includes('503') ||
      msg.includes('502') ||
      msg.includes('429');
  }
  return false;
}

/** Execute a function with exponential backoff retry logic.
 *
 *  Retries on network errors and 5xx-like failures by default.
 *  Uses exponential backoff with jitter to avoid thundering herd.
 *
 *  @throws The last error encountered after all retries are exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const maxRetries = options?.maxRetries ?? 3;
  const baseDelay = options?.baseDelay ?? 1000;
  const maxDelay = options?.maxDelay ?? 10000;
  const retryOn = options?.retryOn ?? isRetryableError;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      if (attempt >= maxRetries || !retryOn(err)) {
        throw err;
      }

      // Exponential backoff with jitter
      const exponentialDelay = baseDelay * Math.pow(2, attempt);
      const jitter = Math.random() * baseDelay;
      const delay = Math.min(exponentialDelay + jitter, maxDelay);

      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Unreachable but satisfies TypeScript
  throw lastError;
}
