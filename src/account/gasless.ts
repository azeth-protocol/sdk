import {
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
  keccak256,
  concatHex,
  pad,
  toBytes,
} from 'viem';
import { AzethFactoryAbi } from '@azeth/common/abis';
import {
  AzethError,
  AZETH_FACTORY_DOMAIN,
  CREATE_ACCOUNT_TYPES,
  type AzethContractAddresses,
} from '@azeth/common';
import { requireAddress } from '../utils/addresses.js';
import { withRetry } from '../utils/retry.js';
import type { CreateAccountParams, CreateAccountResult } from './create.js';

/** Result from the relay endpoint */
interface RelayResponse {
  data: {
    account: `0x${string}`;
    tokenId: string;
    txHash: `0x${string}`;
  };
  error?: { code: string; message: string };
}

/** Hash an address array the same way the contract does: keccak256(abi.encodePacked(addresses)).
 *  Solidity's abi.encodePacked on address[] pads each element to 32 bytes (not 20). */
function hashAddressArray(addresses: `0x${string}`[]): `0x${string}` {
  if (addresses.length === 0) return keccak256(new Uint8Array(0));
  return keccak256(concatHex(addresses.map((a) => pad(a, { size: 32 }))));
}

/** Sign CreateAccount params with EIP-712 for gasless relay submission */
export async function signCreateAccount(
  walletClient: WalletClient<Transport, Chain, Account>,
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  params: CreateAccountParams,
  agentURI: string,
  salt: `0x${string}`,
): Promise<{ signature: `0x${string}`; nonce: bigint }> {
  const factoryAddress = requireAddress(addresses, 'factory');
  const chainId = publicClient.chain?.id;
  if (!chainId) throw new AzethError('Chain ID not available', 'NETWORK_ERROR');

  // Read current nonce from factory
  const nonce = await withRetry(() => publicClient.readContract({
    address: factoryAddress,
    abi: AzethFactoryAbi,
    functionName: 'nonces',
    args: [params.owner],
  })) as bigint;

  // Pre-hash dynamic fields (must match contract's keccak256(abi.encodePacked(...)))
  const protocolsHash = hashAddressArray(params.protocols ?? []);
  const tokensHash = hashAddressArray(params.tokens ?? []);
  const agentURIHash = keccak256(toBytes(agentURI));

  const signature = await walletClient.signTypedData({
    domain: {
      ...AZETH_FACTORY_DOMAIN,
      chainId: BigInt(chainId),
      verifyingContract: factoryAddress,
    },
    types: CREATE_ACCOUNT_TYPES,
    primaryType: 'CreateAccount',
    message: {
      owner: params.owner,
      salt,
      guardrails: {
        maxTxAmountUSD: params.guardrails.maxTxAmountUSD,
        dailySpendLimitUSD: params.guardrails.dailySpendLimitUSD,
        guardianMaxTxAmountUSD: params.guardrails.guardianMaxTxAmountUSD,
        guardianDailySpendLimitUSD: params.guardrails.guardianDailySpendLimitUSD,
        guardian: params.guardrails.guardian,
        emergencyWithdrawTo: params.guardrails.emergencyWithdrawTo,
      },
      protocolsHash,
      tokensHash,
      agentURIHash,
      nonce,
    },
  });

  return { signature, nonce };
}

/** Submit a signed CreateAccount to the relay endpoint.
 *  Returns null for 429 (rate-limited) or 503 (relay unavailable). */
export async function submitToRelay(
  serverUrl: string,
  params: CreateAccountParams,
  salt: `0x${string}`,
  agentURI: string,
  signature: `0x${string}`,
  chain: string,
): Promise<CreateAccountResult | null> {
  const response = await fetch(`${serverUrl}/api/v1/relay/create-account`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: params.owner,
      salt,
      guardrails: {
        maxTxAmountUSD: params.guardrails.maxTxAmountUSD.toString(),
        dailySpendLimitUSD: params.guardrails.dailySpendLimitUSD.toString(),
        guardianMaxTxAmountUSD: params.guardrails.guardianMaxTxAmountUSD.toString(),
        guardianDailySpendLimitUSD: params.guardrails.guardianDailySpendLimitUSD.toString(),
        guardian: params.guardrails.guardian,
        emergencyWithdrawTo: params.guardrails.emergencyWithdrawTo,
      },
      protocols: params.protocols ?? [],
      tokens: params.tokens ?? [],
      agentURI,
      signature,
      chain,
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!response.ok) {
    // 429 = rate limited, 503 = relay unavailable — caller should fall back
    if (response.status === 429 || response.status === 503) {
      return null;
    }
    const body = await response.json().catch(() => null) as RelayResponse | null;
    throw new AzethError(
      body?.error?.message ?? `Relay error: HTTP ${response.status}`,
      'NETWORK_ERROR',
    );
  }

  const body = await response.json() as RelayResponse;
  return {
    account: body.data.account,
    tokenId: BigInt(body.data.tokenId),
    txHash: body.data.txHash,
  };
}

/** Try gasless creation via relay, return null if relay unavailable or rate-limited.
 *  Falls back gracefully when the factory doesn't support createAccountWithSignature
 *  (nonces() call fails), relay is down, or relay returns 429/503. */
export async function createAccountGasless(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  addresses: AzethContractAddresses,
  params: CreateAccountParams,
  serverUrl: string,
  chain: string,
  salt: `0x${string}`,
  agentURI: string,
): Promise<CreateAccountResult | null> {
  try {
    const { signature } = await signCreateAccount(
      walletClient, publicClient, addresses, params, agentURI, salt,
    );
    return await submitToRelay(serverUrl, params, salt, agentURI, signature, chain);
  } catch {
    // Factory doesn't support gasless (nonces() reverts), relay down, timeout,
    // rate limited — fall back to direct on-chain tx
    return null;
  }
}
