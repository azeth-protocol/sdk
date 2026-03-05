import {
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
} from 'viem';
import { AzethError } from '@azeth/common';

export interface SignedRequest {
  signature: `0x${string}`;
  nonce: string;
  created: number;
  keyid: `0x${string}`;
}

/** Generate a nonce for ERC-8128 authentication */
function generateNonce(): string {
  const bytes = new Uint8Array(32); // H-8 fix: Increased from 16 to 32 bytes (256-bit entropy)
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Compute SHA-256 content digest for HTTP message signatures */
async function computeContentDigest(body: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  let binary = '';
  for (const byte of hashArray) {
    binary += String.fromCharCode(byte);
  }
  const hashBase64 = btoa(binary);
  return `sha-256=:${hashBase64}:`;
}

/** Build the ERC-8128 signature base string
 *  Follows the HTTP Signature specification for machine-native auth
 */
async function buildSignatureBase(
  method: string,
  url: string,
  body?: string,
  nonce?: string,
  created?: number,
): Promise<string> {
  const parsed = new URL(url);
  const parts = [
    `"@method": ${method.toUpperCase()}`,
    `"@path": ${parsed.pathname}`,
    `"@query": ${parsed.search || '?'}`,
    `"@authority": ${parsed.host}`,
  ];

  if (nonce) {
    parts.push(`"nonce": "${nonce}"`);
  }

  if (created !== undefined) {
    parts.push(`"created": ${created}`);
  }

  if (body) {
    const digest = await computeContentDigest(body);
    parts.push(`"content-digest": ${digest}`);
  }

  return parts.join('\n');
}

/** Sign an HTTP request with ERC-8128 */
export async function signRequest(
  walletClient: WalletClient<Transport, Chain, Account>,
  signer: `0x${string}`,
  method: string,
  url: string,
  body?: string,
): Promise<SignedRequest> {
  const nonce = generateNonce();
  const created = Math.floor(Date.now() / 1000);
  const signatureBase = await buildSignatureBase(method, url, body, nonce, created);

  const signature = await walletClient.signMessage({
    account: signer,
    message: signatureBase,
  });

  return { signature, nonce, created, keyid: signer };
}

/** Build the ERC-8128 Authorization header value */
export function buildAuthHeader(signed: SignedRequest): string {
  // CRITICAL-2 fix: Use cross-platform Uint8Array instead of Node.js Buffer
  // so this works in browsers, Deno, Cloudflare Workers, and edge runtimes.
  const hexStr = signed.signature.slice(2); // remove 0x prefix
  // H-3 fix: Validate signature is exactly 65 bytes (130 hex chars)
  if (hexStr.length !== 130) {
    throw new AzethError('Invalid signature length — expected 65 bytes', 'INVALID_INPUT', { field: 'signature' });
  }
  const sigBytes = new Uint8Array(hexStr.match(/.{2}/g)!.map(b => parseInt(b, 16)));
  // H-3 fix: Validate v value is canonical (27, 28, 0, or 1)
  const v = sigBytes[64];
  if (v !== 27 && v !== 28 && v !== 0 && v !== 1) {
    throw new AzethError('Invalid signature recovery value', 'INVALID_INPUT', { field: 'signature' });
  }
  const sigBase64 = btoa(String.fromCharCode(...sigBytes));
  return `ERC8128 sig=:${sigBase64}:; keyid="${signed.keyid}"; nonce="${signed.nonce}"; created=${signed.created}`;
}

/** Create a fetch wrapper that automatically adds ERC-8128 auth headers */
export function createSignedFetch(
  walletClient: WalletClient<Transport, Chain, Account>,
  signer: `0x${string}`,
): typeof fetch {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    // MEDIUM-12 fix: Reject non-string body types that can't be included in the signature base.
    // Without this, a ReadableStream/Blob/ArrayBuffer body would be silently excluded from the
    // content digest, causing the server to verify a signature over a request without the body hash.
    if (init?.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      throw new AzethError(
        'ERC-8128 signed fetch requires a string body for content digest. Convert your body to a string first.',
        'INVALID_INPUT',
        { field: 'body', bodyType: typeof init.body },
      );
    }
    const body = typeof init?.body === 'string' ? init.body : undefined;

    const signed = await signRequest(walletClient, signer, method, url, body);
    const authHeader = buildAuthHeader(signed);

    const headers = new Headers(init?.headers);
    headers.set('Authorization', authHeader);

    return fetch(input, { ...init, headers });
  };
}
