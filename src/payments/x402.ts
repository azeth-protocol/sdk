import {
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
  getAddress,
  toHex,
  encodeAbiParameters,
} from 'viem';
import { AzethError, formatTokenAmount, type X402PaymentRequirement, TOKENS } from '@azeth/common';
import { withRetry } from '../utils/retry.js';
import {
  createSIWxPayload,
  encodeSIWxHeader,
  type EVMSigner,
  type CompleteSIWxInfo,
  type SIWxExtension,
} from '@x402/extensions/sign-in-with-x';

/** USDC Transfer(address,address,uint256) event signature — keccak256('Transfer(address,address,uint256)') */
const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Verify that a settlement receipt contains a USDC Transfer event matching expectations.
 *
 *  Decodes Transfer event logs from the receipt and checks:
 *  - Transfer emitted from the expected USDC contract address
 *  - Recipient (`to`) matches the expected payTo address
 *  - Amount (`value`) >= the expected payment amount
 *
 *  @returns true if a matching Transfer event was found, false otherwise
 */
export function verifySettlementReceipt(
  receipt: { logs: ReadonlyArray<{ address: string; topics: ReadonlyArray<string>; data: string }> },
  expectedPayTo: string,
  expectedAsset: string,
  expectedAmount: bigint,
): boolean {
  const payToLower = expectedPayTo.toLowerCase();
  const assetLower = expectedAsset.toLowerCase();

  for (const log of receipt.logs) {
    // Must be from the expected USDC contract
    if (log.address.toLowerCase() !== assetLower) continue;
    if (log.topics.length < 3) continue;

    // topics[0] = Transfer event signature
    if (log.topics[0] !== TRANSFER_EVENT_TOPIC) continue;

    // topics[2] = indexed `to` address (left-padded to 32 bytes)
    const toAddress = `0x${log.topics[2]!.slice(26)}`.toLowerCase();
    if (toAddress !== payToLower) continue;

    // data = uint256 value
    const value = BigInt(log.data);
    if (value >= expectedAmount) return true;
  }

  return false;
}

/** Known USDC contract addresses per chain ID, used to validate x402 payment assets.
 *  EIP-712 domain name differs between chains: mainnet uses "USD Coin", Sepolia uses "USDC". */
const KNOWN_USDC: Record<number, { address: string; name: string; version: string }> = {
  8453: { address: TOKENS.base.USDC.toLowerCase(), name: 'USD Coin', version: '2' },
  84532: { address: TOKENS.baseSepolia.USDC.toLowerCase(), name: 'USDC', version: '2' },
};

/** Default maximum payment amount: 10 USDC (6 decimals) */
const DEFAULT_MAX_AMOUNT = 10_000_000n;

/** Maximum allowed validBefore window in seconds.
 *  HIGH-6 fix: Increased from 60 to 300 seconds. The 60s cap was too aggressive —
 *  during chain congestion, the server may need >60s to settle the ERC-3009 authorization.
 *  If settlement fails due to expiry, the client gets free service. 300s matches the x402
 *  spec default and is safe because each authorization is amount-locked and nonce-unique.
 *
 *  MEDIUM-3 (Audit): Trade-off — a 300s window means a captured (but unsettled) authorization
 *  remains valid for up to 5 minutes. This is acceptable because: (1) each authorization is
 *  nonce-unique so it can only be settled once, (2) the amount is exact (no over-authorization),
 *  and (3) reducing the window increases settlement failures during congestion, which gives
 *  the client free service (worse outcome for the server). */
const MAX_VALID_BEFORE_SECONDS = 300;

/** Parameters for executing a payment via a smart account (UserOp path).
 *  The callback receives the pre-encoded USDC calldata and returns the tx hash. */
export interface SmartAccountTransferParams {
  usdcAddress: `0x${string}`;
  payTo: `0x${string}`;
  amount: bigint;
  /** Full ABI-encoded transferWithAuthorization calldata (bytes variant, 0xcf092995) */
  calldata: `0x${string}`;
}

/** Callback that submits a UserOp to execute transferWithAuthorization from the smart account.
 *  Returns the transaction hash of the settled UserOp. */
export type SmartAccountTransferCallback = (params: SmartAccountTransferParams) => Promise<`0x${string}`>;

export interface Fetch402Options {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  maxAmount?: bigint;
  autoReputation?: boolean;
  /** Smart account address for SIWx identity (address field in SIWE message).
   *  When set, the client will attempt SIWx authentication before paying.
   *  The EOA signs the SIWE message, but the smart account address is used
   *  so the server can look up agreements by smart account. */
  smartAccount?: `0x${string}`;
  /** M-7: Override the USDC EIP-712 domain name/version if needed.
   *  Defaults to known production values ('USD Coin', '2').
   *  Override if the USDC contract on your chain uses different domain parameters. */
  usdcDomain?: { name: string; version: string };
  /** When true, throws PAYMENT_FAILED if the server doesn't return a valid X-Payment-Tx
   *  header or if the on-chain settlement receipt shows a revert. Default: false (advisory). */
  strictSettlement?: boolean;
  /** Callback to execute payment via a smart account UserOp.
   *  When provided, the payment goes through the smart account (with guardian guardrails)
   *  instead of the x402 facilitator settling from the EOA. */
  smartAccountTransfer?: SmartAccountTransferCallback;
}

export interface Fetch402Result {
  response: Response;
  paymentMade: boolean;
  amount?: bigint;
  txHash?: `0x${string}`;
  /** Response time in milliseconds (measured from paid request to response) */
  responseTimeMs?: number;
  /** Whether on-chain settlement was verified after payment.
   *  True if the server returned an X-Payment-Tx header and the tx receipt shows success. */
  settlementVerified: boolean;
  /** How access was obtained.
   *  - 'x402': Standard x402 payment flow (ERC-3009 authorization signed and submitted)
   *  - 'smart-account': Payment via smart account UserOp (guardian guardrails enforced)
   *  - 'session': Access granted via SIWx identity (prior payment session or agreement)
   *  - 'none': No payment was required (non-402 response) */
  paymentMethod: 'x402' | 'smart-account' | 'session' | 'none';
}

/** Fetch a URL, automatically paying x402 requirements
 *
 *  Flow:
 *  1. Make initial request
 *  2. If 402 returned, parse payment requirements from X-Payment-Required header
 *  3. If SIWx extension present and smartAccount provided, attempt identity proof
 *  4. If SIWx grants access, return (no payment needed)
 *  5. If smartAccountTransfer callback provided, pay via smart account UserOp
 *     (guardian guardrails enforced on-chain). Throws on failure — NO EOA fallback.
 *  6. Otherwise (no smart account), sign ERC-3009 transferWithAuthorization from EOA
 *  7. Retry with payment proof header
 *
 *  SECURITY: When a smart account is configured (smartAccountTransfer + smartAccount),
 *  the EOA payment path is unreachable. This prevents guardian guardrail bypass.
 */
export async function fetch402(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  account: `0x${string}`,
  url: string,
  options?: Fetch402Options,
): Promise<Fetch402Result> {
  const method = options?.method ?? 'GET';
  const headers = new Headers(options?.headers);

  // MEDIUM-8 fix: Add 30-second timeout to prevent indefinite hangs from slow/malicious servers
  const fetchTimeout = 30_000;

  // Initial request (retryable -- idempotent read)
  let response: Response;
  try {
    response = await withRetry(() => fetch(url, {
      method,
      headers,
      body: options?.body,
      signal: AbortSignal.timeout(fetchTimeout),
    }));
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to reach service',
      'NETWORK_ERROR',
      { originalError: err instanceof Error ? err.name : undefined, url },
    );
  }

  if (response.status !== 402) {
    return { response, paymentMade: false, settlementVerified: false, paymentMethod: 'none' };
  }

  // Parse 402 payment requirement — v2 header first, fall back to v1
  const requirementHeader = response.headers.get('PAYMENT-REQUIRED') ?? response.headers.get('X-Payment-Required');
  if (!requirementHeader) {
    return { response, paymentMade: false, settlementVerified: false, paymentMethod: 'none' };
  }

  let requirement: X402PaymentRequirement;
  // v2: preserve the original accept object and resource for echo-back in payment proof
  let v2Accept: Record<string, unknown> | undefined;
  try {
    // x402v2 base64-encodes the PAYMENT-REQUIRED header; v1 sends raw JSON.
    // Try base64 decode first, fall back to raw JSON for v1 compatibility.
    let jsonStr: string;
    try {
      jsonStr = atob(requirementHeader);
      if (!jsonStr.startsWith('{') && !jsonStr.startsWith('[')) throw new Error('not base64 JSON');
    } catch {
      jsonStr = requirementHeader;
    }
    const parsed = JSON.parse(jsonStr);

    // Normalize x402 v2 envelope to flat v1 requirement shape.
    // v2 wraps payment options in an `accepts` array; v1 uses flat fields.
    if (parsed.accepts && Array.isArray(parsed.accepts) && parsed.accepts.length > 0) {
      const accept = parsed.accepts[0];
      const resource = parsed.resource ?? {};
      // Preserve the EXACT original accept object for v2 echo-back.
      // The server uses deepEqual to match accepted against its requirements.
      v2Accept = accept;
      requirement = {
        scheme: accept.scheme ?? 'exact',
        network: accept.network ?? '',
        maxAmountRequired: accept.amount ?? '0',
        resource: resource.url ?? '',
        description: resource.description ?? '',
        mimeType: resource.mimeType ?? 'application/json',
        payTo: accept.payTo,
        maxTimeoutSeconds: accept.maxTimeoutSeconds ?? 300,
        asset: accept.asset,
        extra: accept.extra,
      } as X402PaymentRequirement;
      // Preserve extensions and resource on the requirement for downstream use
      (requirement as unknown as Record<string, unknown>).extensions = parsed.extensions;
      (requirement as unknown as Record<string, unknown>).__resource = resource;
    } else {
      requirement = parsed;
    }
  } catch {
    throw new AzethError(
      'Failed to parse X-Payment-Required header',
      'PAYMENT_FAILED',
      { header: requirementHeader },
    );
  }

  // ── SIWx identity attempt ──────────────────────────────────────────
  // Before paying, check if the server supports SIWx and we have a smart account.
  // If the server recognizes our wallet (via agreement or prior payment session),
  // access is granted without payment.
  const extensions = (requirement as unknown as Record<string, unknown>).extensions as
    Record<string, SIWxExtension> | undefined;
  const siwxExt = extensions?.['sign-in-with-x'];

  if (siwxExt?.info && siwxExt?.supportedChains?.length && options?.smartAccount) {
    const siwxResult = await attemptSIWx(
      walletClient, options.smartAccount, url, method, options, siwxExt, fetchTimeout,
    );
    if (siwxResult) return siwxResult;
    // SIWx didn't grant access — fall through to ERC-3009 payment
  }

  // ── Smart account payment path ────────────────────────────────────
  // When smartAccountTransfer callback is provided, the payment goes through the
  // smart account via UserOp with transferWithAuthorization. This enforces guardian
  // guardrails (spending limits, token whitelist) on-chain.
  //
  // SECURITY: When a smart account is configured, we MUST NOT fall back to the
  // EOA ERC-3009 path. Doing so would bypass guardian guardrails entirely.
  // If the smart account payment fails, the error must propagate.
  if (options?.smartAccountTransfer && options?.smartAccount) {
    const saResult = await attemptSmartAccountPayment(
      publicClient, walletClient, account, url, method, options, requirement, v2Accept, fetchTimeout,
    );
    if (saResult) return saResult;
    // attemptSmartAccountPayment returned null without throwing — this means a
    // non-critical validation issue (e.g., missing EIP-712 domain params in the
    // 402 response). Throw rather than silently falling back to EOA.
    throw new AzethError(
      'Smart account payment failed: the x402 server response is missing required fields for smart account settlement. '
      + 'Refusing to fall back to EOA payment (would bypass guardian guardrails).',
      'PAYMENT_FAILED',
      { smartAccount: options.smartAccount, url },
    );
  }

  // ── ERC-3009 payment flow ──────────────────────────────────────────
  // Follows the official @x402/evm exact scheme approach for v2 payments.

  // Resolve amount from the v2 `amount` field (v1 used `maxAmountRequired`)
  const amountStr = (requirement as unknown as Record<string, string>).amount ?? requirement.maxAmountRequired;
  let amount: bigint;
  try {
    amount = BigInt(amountStr);
  } catch {
    throw new AzethError(
      'Invalid payment amount in X-Payment-Required header',
      'PAYMENT_FAILED',
      { field: 'amount' },
    );
  }

  // H-1 fix: Reject negative or zero payment amounts
  if (amount <= 0n) {
    throw new AzethError(
      'Payment amount must be positive',
      'PAYMENT_FAILED',
      { field: 'amount' },
    );
  }

  // Check budget (default cap: 10 USDC if not specified)
  const effectiveMaxAmount = options?.maxAmount ?? DEFAULT_MAX_AMOUNT;
  if (amount > effectiveMaxAmount) {
    const requiredFmt = formatTokenAmount(amount, 6, 2);
    const maxFmt = formatTokenAmount(effectiveMaxAmount, 6, 2);
    throw new AzethError(
      `Payment of ${requiredFmt} USDC exceeds maximum of ${maxFmt} USDC`,
      'BUDGET_EXCEEDED',
      { required: `${requiredFmt} USDC`, max: `${maxFmt} USDC` },
    );
  }

  // Validate payTo is a valid Ethereum address
  const payTo = requirement.payTo;
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    throw new AzethError('Invalid payment recipient address', 'INVALID_INPUT', { field: 'payTo' });
  }

  // Validate asset is a known USDC address for this chain (H-3: prevent arbitrary asset injection)
  const chainId = publicClient.chain?.id ?? 8453;
  const knownToken = KNOWN_USDC[chainId];
  if (!knownToken) {
    throw new AzethError(
      `Unsupported chain ID ${chainId} for x402 payments`,
      'PAYMENT_FAILED',
      { chainId },
    );
  }
  const assetAddress = (requirement.asset as string).toLowerCase();
  if (assetAddress !== knownToken.address) {
    throw new AzethError(
      'Payment asset is not a recognized USDC address for this chain',
      'PAYMENT_FAILED',
      { asset: requirement.asset, expectedAsset: knownToken.address, chainId },
    );
  }

  // Validate server provides EIP-712 domain params in requirements.extra
  const extra = requirement.extra as Record<string, string> | undefined;
  if (!extra?.name || !extra?.version) {
    throw new AzethError(
      'Server did not provide EIP-712 domain parameters (name, version) in payment requirements',
      'PAYMENT_FAILED',
      { field: 'extra' },
    );
  }

  // Build ERC-3009 authorization following the official @x402/evm exact scheme.
  // Uses viem's toHex for nonce (matches official createNonce()),
  // getAddress for EIP-55 checksumming, and (now-600) for validAfter.
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const now = Math.floor(Date.now() / 1000);
  const maxValidBefore = now + MAX_VALID_BEFORE_SECONDS;
  const requestedValidBefore = now + (requirement.maxTimeoutSeconds || 300);

  const authorization = {
    from: getAddress(account),
    to: getAddress(payTo as `0x${string}`),
    value: amountStr,
    validAfter: (now - 600).toString(),
    validBefore: Math.min(requestedValidBefore, maxValidBefore).toString(),
    nonce,
  };

  // EIP-712 domain — use server-provided name/version from requirements.extra,
  // with caller override as escape hatch (M-7).
  const domainOverride = options?.usdcDomain;
  const domain = {
    name: domainOverride?.name ?? extra.name,
    version: domainOverride?.version ?? extra.version,
    chainId,
    verifyingContract: getAddress(requirement.asset as `0x${string}`),
  };

  const types = {
    TransferWithAuthorization: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'validAfter', type: 'uint256' },
      { name: 'validBefore', type: 'uint256' },
      { name: 'nonce', type: 'bytes32' },
    ],
  } as const;

  // Sign the typed data using the SAME values as the authorization payload.
  // The facilitator verifies by reconstructing the hash from the payload,
  // so the message must be derived from the authorization fields.
  let signature: `0x${string}`;
  try {
    signature = await walletClient.signTypedData({
      domain,
      types,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(authorization.from as `0x${string}`),
        to: getAddress(authorization.to as `0x${string}`),
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as `0x${string}`,
      },
    });
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to sign payment authorization',
      'PAYMENT_FAILED',
      { originalError: err instanceof Error ? err.name : undefined },
    );
  }

  // Build v2 payment proof following the official @x402/core client pattern.
  // - accepted: echoes back the EXACT server requirement object (deepEqual match required)
  // - resource: echoed from the 402 response (optional but included for completeness)
  // - payload: { authorization, signature } per the EVM exact scheme
  const parsedResource = (requirement as unknown as Record<string, unknown>).__resource;
  const paymentProof: Record<string, unknown> = {
    x402Version: 2,
    accepted: v2Accept ?? requirement,
    payload: {
      authorization,
      signature,
    },
  };
  if (parsedResource) {
    paymentProof.resource = parsedResource;
  }

  // Submit with payment proof — M-3: Do NOT use withRetry here.
  // The paid request carries a signed ERC-3009 authorization that the server will settle on-chain.
  // Retrying could cause duplicate settlement attempts, wasting gas or confusing error reporting.
  const retryHeaders = new Headers(options?.headers);
  // CRITICAL-2 fix: Use cross-platform btoa() instead of Node.js Buffer
  const encodedProof = btoa(JSON.stringify(paymentProof));
  retryHeaders.set('PAYMENT-SIGNATURE', encodedProof);

  const startTime = Date.now();
  try {
    response = await fetch(url, {
      method,
      headers: retryHeaders,
      body: options?.body,
      signal: AbortSignal.timeout(fetchTimeout),
    });
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to submit payment to service',
      'NETWORK_ERROR',
      { originalError: err instanceof Error ? err.name : undefined, url },
    );
  }
  const responseTimeMs = Date.now() - startTime;

  // If response is still 402 after payment, the payment was not accepted.
  // Decode the rejection reason from PAYMENT-REQUIRED header for diagnostics.
  if (response.status === 402) {
    let rejectionReason: string | undefined;
    const rejectionHeader = response.headers.get('PAYMENT-REQUIRED') ?? response.headers.get('payment-required');
    if (rejectionHeader) {
      try {
        let rejJson: string;
        try { rejJson = atob(rejectionHeader); } catch { rejJson = rejectionHeader; }
        const rejParsed = JSON.parse(rejJson);
        rejectionReason = rejParsed.error;
      } catch { /* ignore parse failures */ }
    }
    throw new AzethError(
      rejectionReason
        ? `Payment rejected: ${rejectionReason}`
        : 'Payment was not accepted by service',
      'PAYMENT_FAILED',
      { url, amount: amount.toString(), responseTimeMs, rejectionReason },
    );
  }

  // H-4: Verify on-chain settlement if server provides tx hash
  // V2: Parse PAYMENT-RESPONSE header first, fall back to X-Payment-Tx
  let settlementVerified = false;
  let txHash: `0x${string}` | undefined;

  const paymentResponseHeader = response.headers.get('PAYMENT-RESPONSE');
  let txHashHeader: string | null = null;
  if (paymentResponseHeader) {
    try {
      // x402v2 base64-encodes the PAYMENT-RESPONSE header; v1 sends raw JSON.
      let responseJsonStr: string;
      try {
        responseJsonStr = atob(paymentResponseHeader);
        if (!responseJsonStr.startsWith('{')) throw new Error('not base64 JSON');
      } catch {
        responseJsonStr = paymentResponseHeader;
      }
      const paymentResponse = JSON.parse(responseJsonStr);
      if (paymentResponse.transaction && /^0x[0-9a-fA-F]{64}$/.test(paymentResponse.transaction)) {
        txHashHeader = paymentResponse.transaction;
      }
    } catch {
      // Fall through to X-Payment-Tx
    }
  }
  if (!txHashHeader) {
    txHashHeader = response.headers.get('X-Payment-Tx');
  }
  const strict = options?.strictSettlement === true;

  if (txHashHeader && /^0x[0-9a-fA-F]{64}$/.test(txHashHeader)) {
    txHash = txHashHeader as `0x${string}`;
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
      if (receipt.status === 'success') {
        // Verify Transfer event matches expected payment parameters
        if (verifySettlementReceipt(receipt, payTo, requirement.asset as string, amount)) {
          settlementVerified = true;
        } else if (strict) {
          throw new AzethError(
            'Settlement receipt missing matching USDC Transfer event',
            'PAYMENT_FAILED',
            { txHash, expectedPayTo: payTo, expectedAsset: requirement.asset, expectedAmount: amount.toString() },
          );
        }
        // Non-strict: receipt succeeded but no matching Transfer — advisory only
      } else if (strict) {
        throw new AzethError(
          'Settlement transaction reverted',
          'PAYMENT_FAILED',
          { txHash, receiptStatus: receipt.status },
        );
      }
    } catch (err: unknown) {
      if (err instanceof AzethError) throw err;
      // Receipt fetch failed (RPC timeout, tx not mined, etc.)
      if (strict) {
        throw new AzethError(
          'Failed to verify settlement transaction',
          'PAYMENT_FAILED',
          { txHash, detail: err instanceof Error ? err.message : 'Receipt fetch failed' },
        );
      }
      // Non-strict: advisory only — don't fail the request
    }
  } else if (strict) {
    throw new AzethError(
      'Server did not return X-Payment-Tx settlement header',
      'PAYMENT_FAILED',
      { detail: 'strictSettlement requires the server to return a valid X-Payment-Tx header' },
    );
  }

  return {
    response,
    paymentMade: true,
    settlementVerified,
    amount,
    txHash,
    responseTimeMs,
    paymentMethod: 'x402',
  };
}

/** Attempt SIWx identity proof to get access without payment.
 *
 *  Creates a SIWE message signed by the EOA but with the smart account as the address,
 *  so the server can look up agreements/sessions by smart account address.
 *  The server verifies via EIP-1271 (smart account's isValidSignature recognizes EOA owner).
 *
 *  @returns Fetch402Result if access was granted, null if SIWx failed (fall through to payment)
 */
async function attemptSIWx(
  walletClient: WalletClient<Transport, Chain, Account>,
  smartAccount: `0x${string}`,
  url: string,
  method: string,
  options: Fetch402Options | undefined,
  siwxExt: SIWxExtension,
  fetchTimeout: number,
): Promise<Fetch402Result | null> {
  try {
    // Select the first EVM chain from supportedChains
    const evmChain = siwxExt.supportedChains.find(c => c.chainId.startsWith('eip155:'));
    if (!evmChain) return null;

    // Build CompleteSIWxInfo: merge server info with selected chain
    const completeSIWxInfo: CompleteSIWxInfo = {
      ...siwxExt.info,
      chainId: evmChain.chainId,
      type: evmChain.type,
      signatureScheme: evmChain.signatureScheme,
    };

    // Create EVMSigner adapter: EOA signs but smart account address is used in SIWE message.
    // The server verifies via EIP-1271: smart account's isValidSignature() recognizes the EOA owner.
    const siwxSigner: EVMSigner = {
      signMessage: (args: { message: string }) =>
        walletClient.signMessage({ message: args.message }),
      account: { address: smartAccount },
    };

    // Create signed payload and encode header
    const payload = await createSIWxPayload(completeSIWxInfo, siwxSigner);
    const headerValue = encodeSIWxHeader(payload);

    // Retry request with SIWx identity header
    const siwxHeaders = new Headers(options?.headers);
    siwxHeaders.set('SIGN-IN-WITH-X', headerValue);

    const siwxResponse = await fetch(url, {
      method,
      headers: siwxHeaders,
      body: options?.body,
      signal: AbortSignal.timeout(fetchTimeout),
    });

    // If NOT 402, SIWx succeeded — access granted without payment
    if (siwxResponse.status !== 402) {
      return {
        response: siwxResponse,
        paymentMade: false,
        settlementVerified: false,
        paymentMethod: 'session',
      };
    }

    // Still 402 — server didn't recognize us, fall through to payment
    return null;
  } catch {
    // SIWx attempt failed (signing error, network error, etc.) — non-fatal
    return null;
  }
}

/** Attempt payment via smart account UserOp with transferWithAuthorization.
 *
 *  Signs ERC-3009 typed data with `from` = smartAccount (not EOA), then ABI-encodes
 *  transferWithAuthorization(bytes variant, 0xcf092995) and calls the smartAccountTransfer
 *  callback to submit it as a UserOp. The smart account's GuardianModule validates the
 *  UserOp against spending limits, and USDC verifies the EOA signature via ERC-1271.
 *
 *  SECURITY: Errors are propagated, NOT swallowed. The caller must not fall back to
 *  EOA payment when this function throws — doing so would bypass guardian guardrails.
 *
 *  @returns Fetch402Result if payment succeeded, null only for non-critical validation
 *  issues (e.g., missing EIP-712 domain params in the 402 response)
 *  @throws AzethError for all operational failures (bundler rejection, UserOp failure, etc.)
 */
async function attemptSmartAccountPayment(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  eoaAccount: `0x${string}`,
  url: string,
  method: string,
  options: Fetch402Options,
  requirement: X402PaymentRequirement,
  v2Accept: Record<string, unknown> | undefined,
  fetchTimeout: number,
): Promise<Fetch402Result | null> {
  try {
    const smartAccount = options.smartAccount!;
    const smartAccountTransfer = options.smartAccountTransfer!;

    // Resolve amount
    const amountStr = (requirement as unknown as Record<string, string>).amount ?? requirement.maxAmountRequired;
    let amount: bigint;
    try {
      amount = BigInt(amountStr);
    } catch {
      return null; // Let standard flow handle the error
    }

    if (amount <= 0n) return null;

    // Budget check
    const effectiveMaxAmount = options.maxAmount ?? DEFAULT_MAX_AMOUNT;
    if (amount > effectiveMaxAmount) {
      const requiredFmt = formatTokenAmount(amount, 6, 2);
      const maxFmt = formatTokenAmount(effectiveMaxAmount, 6, 2);
      throw new AzethError(
        `Payment of ${requiredFmt} USDC exceeds maximum of ${maxFmt} USDC`,
        'BUDGET_EXCEEDED',
        { required: `${requiredFmt} USDC`, max: `${maxFmt} USDC` },
      );
    }

    // Validate payTo
    const payTo = requirement.payTo;
    if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) return null;

    // Validate asset
    const chainId = publicClient.chain?.id ?? 8453;
    const knownToken = KNOWN_USDC[chainId];
    if (!knownToken) return null;
    const assetAddress = (requirement.asset as string).toLowerCase();
    if (assetAddress !== knownToken.address) return null;

    // Validate EIP-712 domain params
    const extra = requirement.extra as Record<string, string> | undefined;
    if (!extra?.name || !extra?.version) return null;

    // Build ERC-3009 authorization with from = smartAccount
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
    const now = Math.floor(Date.now() / 1000);
    const maxValidBefore = now + MAX_VALID_BEFORE_SECONDS;
    const requestedValidBefore = now + (requirement.maxTimeoutSeconds || 300);
    const validAfter = BigInt(now - 600);
    const validBefore = BigInt(Math.min(requestedValidBefore, maxValidBefore));

    const domainOverride = options.usdcDomain;
    const domain = {
      name: domainOverride?.name ?? extra.name,
      version: domainOverride?.version ?? extra.version,
      chainId,
      verifyingContract: getAddress(requirement.asset as `0x${string}`),
    };

    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    } as const;

    // EOA signs ERC-3009 typed data with from = smartAccount
    const signature = await walletClient.signTypedData({
      domain,
      types,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(smartAccount),
        to: getAddress(payTo as `0x${string}`),
        value: amount,
        validAfter,
        validBefore,
        nonce: nonce as `0x${string}`,
      },
    });

    // ABI-encode transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)
    // Selector 0xcf092995 — the `bytes` signature variant that supports ERC-1271
    const encodedArgs = encodeAbiParameters(
      [
        { type: 'address' },  // from
        { type: 'address' },  // to
        { type: 'uint256' },  // value
        { type: 'uint256' },  // validAfter
        { type: 'uint256' },  // validBefore
        { type: 'bytes32' },  // nonce
        { type: 'bytes' },    // signature
      ],
      [
        getAddress(smartAccount),
        getAddress(payTo as `0x${string}`),
        amount,
        validAfter,
        validBefore,
        nonce as `0x${string}`,
        signature,
      ],
    );
    const calldata = `0xcf092995${encodedArgs.slice(2)}` as `0x${string}`;

    // Submit via UserOp — the SmartAccountClient builds and signs the UserOp,
    // the bundler submits it, and the GuardianModule enforces spending limits.
    const txHash = await smartAccountTransfer({
      usdcAddress: getAddress(requirement.asset as `0x${string}`),
      payTo: getAddress(payTo as `0x${string}`),
      amount,
      calldata,
    });

    // Retry request with pre-settled proof headers
    const retryHeaders = new Headers(options.headers);
    retryHeaders.set('X-Payment-Tx', txHash);
    retryHeaders.set('X-Payment-From', smartAccount);

    const startTime = Date.now();
    const response = await fetch(url, {
      method,
      headers: retryHeaders,
      body: options.body,
      signal: AbortSignal.timeout(fetchTimeout),
    });
    const responseTimeMs = Date.now() - startTime;

    return {
      response,
      paymentMade: true,
      settlementVerified: true, // We settled it ourselves via UserOp
      amount,
      txHash,
      responseTimeMs,
      paymentMethod: 'smart-account',
    };
  } catch (err: unknown) {
    // SECURITY: All errors must propagate — falling back to EOA would bypass
    // guardian guardrails. The caller (fetch402) should never silently degrade
    // from smart account to EOA payment.
    if (err instanceof AzethError) throw err;

    // Include full error for debugging (truncate at 2000 chars to avoid overflow)
    const rawMsg = err instanceof Error ? err.message : String(err);
    const fullMsg = rawMsg.slice(0, 2000);

    throw new AzethError(
      `Smart account x402 payment failed: ${fullMsg}`,
      'PAYMENT_FAILED',
      { smartAccount: options.smartAccount, operation: 'smart_account_x402' },
    );
  }
}
