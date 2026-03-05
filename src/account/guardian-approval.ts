import crypto from 'node:crypto';
import { AzethError } from '@azeth/common';
import type { XMTPClient } from '../messaging/xmtp.js';

// ── Types ──────────────────────────────────────────────

/** Structured XMTP message sent from agent to guardian requesting co-signature */
export interface GuardianApprovalRequest {
  type: 'azeth:guardian_request';
  version: '1.0';
  requestId: string;
  chainId: number;
  account: `0x${string}`;
  userOpHash: `0x${string}`;
  operation: {
    type: 'transfer' | 'whitelist_add' | 'agreement' | 'payment' | 'other';
    description: string;
    to?: string;
    amount?: string;
    usdValue?: string;
  };
  reason: string;
  limits: {
    maxTxAmountUSD: string;
    dailySpendLimitUSD: string;
    guardianMaxTxAmountUSD: string;
    guardianDailySpendLimitUSD: string;
    dailySpentUSD: string;
  };
  expiresAt: string;
}

/** Structured XMTP message sent from guardian back to agent with decision */
export interface GuardianApprovalResponse {
  type: 'azeth:guardian_response';
  version: '1.0';
  requestId: string;
  decision: 'approved' | 'rejected';
  signature?: `0x${string}`;
  reason?: string;
}

/** In-memory record of a pending guardian approval request */
export interface PendingApproval {
  requestId: string;
  userOpHash: `0x${string}`;
  ownerSignature: `0x${string}`;
  guardianAddress: `0x${string}`;
  operation: GuardianApprovalRequest['operation'];
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  guardianSignature?: `0x${string}`;
  rejectionReason?: string;
  createdAt: number;
  expiresAt: number;
}

/** Result of a guardian approval request */
export type GuardianApprovalResult =
  | { status: 'approved'; signature: `0x${string}`; combinedSignature: `0x${string}` }
  | { status: 'rejected'; reason?: string }
  | { status: 'timeout'; requestId: string }
  | { status: 'error'; message: string };

// ── Pending Approvals Store (in-memory, per-process) ──

/** Audit #13 M-11 fix: Cap pending approvals to prevent unbounded memory growth */
const MAX_PENDING_APPROVALS = 1000;

const pendingApprovals = new Map<string, PendingApproval>();

/** Retrieve a pending approval by request ID. Auto-expires if past deadline. */
export function getPendingApproval(requestId: string): PendingApproval | undefined {
  const approval = pendingApprovals.get(requestId);
  if (approval && approval.status === 'pending' && Date.now() > approval.expiresAt) {
    approval.status = 'expired';
  }
  return approval;
}

/** Get all non-expired pending approvals. */
export function getAllPendingApprovals(): PendingApproval[] {
  return Array.from(pendingApprovals.values())
    .map(a => {
      if (a.status === 'pending' && Date.now() > a.expiresAt) a.status = 'expired';
      return a;
    })
    .filter(a => a.status === 'pending');
}

/** Remove all expired approvals from the store. */
export function clearExpiredApprovals(): void {
  for (const [id, approval] of pendingApprovals) {
    if (Date.now() > approval.expiresAt) pendingApprovals.delete(id);
  }
}

// ── Request Guardian Approval ──────────────────────────

/**
 * Send a guardian approval request via XMTP and poll for the response.
 *
 * The agent sends a structured JSON message to the guardian's address,
 * then polls XMTP for a response until timeout. On approval, the guardian's
 * signature is combined with the owner's signature (owner 65 bytes + guardian 65 bytes).
 *
 * @param xmtpClient - Initialized XMTPClient instance
 * @param guardianAddress - Ethereum address of the guardian
 * @param userOpHash - The UserOperation hash that needs co-signing
 * @param ownerSignature - The owner's EIP-191 signature of the userOpHash
 * @param chainId - The chain ID for the operation
 * @param account - The smart account address
 * @param operation - Human-readable operation details
 * @param reason - Why guardian approval is needed (e.g., EXCEEDS_TX_LIMIT)
 * @param limits - Current guardrail limits for context
 * @param options - Polling options (timeoutMs, pollIntervalMs)
 * @returns The approval result with combined signature, rejection reason, or timeout
 */
export async function requestGuardianApproval(
  xmtpClient: XMTPClient,
  guardianAddress: `0x${string}`,
  userOpHash: `0x${string}`,
  ownerSignature: `0x${string}`,
  chainId: number,
  account: `0x${string}`,
  operation: GuardianApprovalRequest['operation'],
  reason: string,
  limits: GuardianApprovalRequest['limits'],
  options?: { timeoutMs?: number; pollIntervalMs?: number },
): Promise<GuardianApprovalResult> {
  const timeoutMs = options?.timeoutMs ?? 30_000;
  const pollIntervalMs = options?.pollIntervalMs ?? 2_000;
  const requestId = crypto.randomUUID();
  const expiresAt = Date.now() + 5 * 60 * 1000; // 5 min expiry

  // Audit #13 M-11 fix: Auto-cleanup expired entries and enforce size cap
  clearExpiredApprovals();
  if (pendingApprovals.size >= MAX_PENDING_APPROVALS) {
    // Evict oldest entries (Map iterates in insertion order)
    const evictCount = Math.ceil(MAX_PENDING_APPROVALS * 0.1);
    let removed = 0;
    for (const key of pendingApprovals.keys()) {
      if (removed >= evictCount) break;
      pendingApprovals.delete(key);
      removed++;
    }
  }

  // Store pending approval
  const pending: PendingApproval = {
    requestId,
    userOpHash,
    ownerSignature,
    guardianAddress,
    operation,
    reason,
    status: 'pending',
    createdAt: Date.now(),
    expiresAt,
  };
  pendingApprovals.set(requestId, pending);

  // Build request message
  const request: GuardianApprovalRequest = {
    type: 'azeth:guardian_request',
    version: '1.0',
    requestId,
    chainId,
    account,
    userOpHash,
    operation,
    reason,
    limits,
    expiresAt: new Date(expiresAt).toISOString(),
  };

  // Send via XMTP
  try {
    await xmtpClient.sendMessage({
      to: guardianAddress,
      content: JSON.stringify(request),
    });
  } catch (err) {
    pendingApprovals.delete(requestId);
    throw new AzethError(
      `Failed to send guardian approval request via XMTP: ${err instanceof Error ? err.message : String(err)}`,
      'NETWORK_ERROR',
    );
  }

  // Poll for response
  const startTime = Date.now();
  const deadline = startTime + timeoutMs;

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));

    const result = await checkForGuardianResponse(xmtpClient, guardianAddress, requestId, startTime);
    if (result) {
      if (result.decision === 'approved' && result.signature) {
        pending.status = 'approved';
        pending.guardianSignature = result.signature;
        // Combine: owner signature (65 bytes) + guardian signature (65 bytes)
        const combinedSignature = (ownerSignature + result.signature.slice(2)) as `0x${string}`;
        return { status: 'approved', signature: result.signature, combinedSignature };
      } else {
        pending.status = 'rejected';
        pending.rejectionReason = result.reason;
        return { status: 'rejected', reason: result.reason };
      }
    }
  }

  // Timeout — approval stays pending for later retrieval via azeth_guardian_status
  return { status: 'timeout', requestId };
}

// ── Check for Response ─────────────────────────────────

/**
 * Check XMTP messages from the guardian for a response to a specific request.
 *
 * Reads recent messages from the guardian's conversation and looks for a
 * matching `azeth:guardian_response` message.
 *
 * @param xmtpClient - Initialized XMTPClient instance
 * @param guardianAddress - Guardian's Ethereum address
 * @param requestId - The approval request ID to match
 * @param afterTimestamp - Only consider messages after this timestamp (ms)
 * @returns The parsed response, or null if no matching response found
 */
export async function checkForGuardianResponse(
  xmtpClient: XMTPClient,
  guardianAddress: `0x${string}`,
  requestId: string,
  afterTimestamp?: number,
): Promise<GuardianApprovalResponse | null> {
  try {
    // Use getMessagesByPeer to read messages from the guardian
    const messages = await xmtpClient.getMessagesByPeer(guardianAddress, 20);

    for (const msg of messages) {
      // Skip messages from before our request
      if (afterTimestamp && msg.timestamp < afterTimestamp) continue;

      const parsed = tryParseGuardianResponse(msg.content);
      if (parsed && parsed.requestId === requestId) {
        return parsed;
      }
    }
  } catch {
    // XMTP read failure — non-fatal, will retry on next poll
  }
  return null;
}

// ── Parse Guardian Response ────────────────────────────

/** Try to parse a message string as a GuardianApprovalResponse. Returns null if not a valid response. */
export function tryParseGuardianResponse(content: string): GuardianApprovalResponse | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.type !== 'azeth:guardian_response') return null;
    if (parsed.version !== '1.0') return null;
    if (typeof parsed.requestId !== 'string') return null;
    if (parsed.decision !== 'approved' && parsed.decision !== 'rejected') return null;

    return {
      type: 'azeth:guardian_response',
      version: '1.0',
      requestId: parsed.requestId,
      decision: parsed.decision,
      // Audit #13 H-6 fix: Validate signature format (0x + 130 hex chars = 65 bytes)
      signature: (typeof parsed.signature === 'string'
        && /^0x[0-9a-fA-F]{130}$/.test(parsed.signature))
        ? parsed.signature as `0x${string}` : undefined,
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
    };
  } catch {
    return null;
  }
}

// ── Parse Guardian Request ─────────────────────────────

/** Try to parse a message string as a GuardianApprovalRequest. Returns null if not a valid request. */
export function tryParseGuardianRequest(content: string): GuardianApprovalRequest | null {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.type !== 'azeth:guardian_request') return null;
    if (parsed.version !== '1.0') return null;
    if (typeof parsed.requestId !== 'string') return null;
    if (typeof parsed.userOpHash !== 'string') return null;
    if (typeof parsed.chainId !== 'number') return null;
    if (typeof parsed.account !== 'string') return null;
    if (typeof parsed.operation !== 'object' || parsed.operation === null) return null;
    if (typeof parsed.reason !== 'string') return null;
    if (typeof parsed.limits !== 'object' || parsed.limits === null) return null;
    if (typeof parsed.expiresAt !== 'string') return null;

    return parsed as unknown as GuardianApprovalRequest;
  } catch {
    return null;
  }
}
