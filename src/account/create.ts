import {
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
  keccak256,
  toBytes,
  pad,
  toHex,
} from 'viem';
import { AzethFactoryAbi } from '@azeth/common/abis';
import { AzethError, TOKENS, type Guardrails, type AzethContractAddresses } from '@azeth/common';
import { requireAddress } from '../utils/addresses.js';
import { withRetry } from '../utils/retry.js';
import { wrapContractError } from '../utils/errors.js';
import { buildAgentURI, type RegisterParams } from '../registry/register.js';

const ETH_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;

/** Derive default token whitelist from chain ID.
 *  Includes native ETH (address(0)), USDC, and WETH so that payment agreements
 *  and other executor-module operations work without manual whitelisting. */
function getDefaultTokenWhitelist(chainId?: number): `0x${string}`[] {
  if (chainId === 84532) return [ETH_ADDRESS, TOKENS.baseSepolia.USDC, TOKENS.baseSepolia.WETH];
  if (chainId === 8453) return [ETH_ADDRESS, TOKENS.base.USDC, TOKENS.base.WETH];
  if (chainId === 11155111) return [ETH_ADDRESS, TOKENS.ethereumSepolia.USDC, TOKENS.ethereumSepolia.WETH];
  if (chainId === 1) return [ETH_ADDRESS, TOKENS.ethereum.USDC, TOKENS.ethereum.WETH];
  return [ETH_ADDRESS]; // fallback: at least whitelist native ETH
}

export interface CreateAccountParams {
  owner: `0x${string}`;
  salt?: `0x${string}`;
  guardrails: Guardrails;
  protocols?: `0x${string}`[];
  tokens?: `0x${string}`[];
  /** Registry metadata for ERC-8004 trust registry registration.
   *  Pass undefined to skip registration (tokenId will be 0). */
  registry?: RegisterParams;
}

export interface CreateAccountResult {
  account: `0x${string}`;
  tokenId: bigint;
  txHash: `0x${string}`;
}

/** Deploy a new Azeth smart account via the AzethFactory v11 (one-call setup).
 *
 *  Single atomic transaction: deploys ERC-1967 proxy, installs all 4 modules,
 *  registers on ERC-8004 trust registry (optional), and permanently revokes factory access.
 */
export async function createAccount(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  addresses: AzethContractAddresses,
  params: CreateAccountParams,
): Promise<CreateAccountResult> {
  const factoryAddress = requireAddress(addresses, 'factory');

  // Auto-increment salt based on existing account count when no explicit salt is provided.
  // This allows one EOA to create up to MAX_ACCOUNTS_PER_OWNER (100) smart accounts.
  // Salt 0 = first account (backwards-compatible), 1 = second, etc.
  let salt: `0x${string}`;
  if (params.salt) {
    salt = params.salt;
  } else {
    const existing = await withRetry(() => publicClient.readContract({
      address: factoryAddress,
      abi: AzethFactoryAbi,
      functionName: 'getAccountsByOwner',
      args: [params.owner],
    })) as readonly `0x${string}`[];
    salt = pad(toHex(existing.length), { size: 32 });
  }
  const agentURI = params.registry ? buildAgentURI(params.registry) : '';

  let txHash: `0x${string}`;
  try {
    txHash = await walletClient.writeContract({
      address: factoryAddress,
      abi: AzethFactoryAbi,
      functionName: 'createAccount',
      args: [
        params.owner,
        salt,
        params.guardrails,
        params.protocols ?? [],
        params.tokens ?? getDefaultTokenWhitelist(publicClient.chain?.id),
        agentURI,
      ],
    });
  } catch (err: unknown) {
    throw wrapContractError(err, 'NETWORK_ERROR');
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

  if (receipt.status === 'reverted') {
    throw new AzethError('Transaction reverted', 'NETWORK_ERROR', { txHash });
  }

  // Parse AccountCreated event from receipt
  // Event: AccountCreated(address indexed account, address indexed owner, bytes32 salt, uint256 tokenId)
  const ACCOUNT_CREATED_TOPIC = keccak256(toBytes('AccountCreated(address,address,bytes32,uint256)'));
  let account: `0x${string}` = '0x0000000000000000000000000000000000000000';
  let tokenId = 0n;

  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === factoryAddress.toLowerCase()
      && log.topics[0] === ACCOUNT_CREATED_TOPIC
      && log.topics.length >= 3
    ) {
      // account is the first indexed topic (padded to 32 bytes)
      account = ('0x' + (log.topics[1] ?? '').slice(26)) as `0x${string}`;
      // tokenId is in the data field (non-indexed)
      if (log.data && log.data.length >= 130) {
        // data contains: salt (bytes32) + tokenId (uint256)
        // tokenId is at offset 32 bytes (64 hex chars) after 0x prefix
        tokenId = BigInt('0x' + log.data.slice(66, 130));
      }
      break;
    }
  }

  if (account === '0x0000000000000000000000000000000000000000') {
    // Fallback: compute deterministically
    account = await withRetry(() => publicClient.readContract({
      address: factoryAddress,
      abi: AzethFactoryAbi,
      functionName: 'getAddress',
      args: [params.owner, salt],
    })) as `0x${string}`;
  }

  return { account, tokenId, txHash };
}

/** Compute the deterministic address for an account without deploying */
export async function getAccountAddress(
  publicClient: PublicClient<Transport, Chain>,
  addresses: AzethContractAddresses,
  owner: `0x${string}`,
  salt: `0x${string}`,
): Promise<`0x${string}`> {
  const factoryAddress = requireAddress(addresses, 'factory');

  try {
    return await withRetry(() => publicClient.readContract({
      address: factoryAddress,
      abi: AzethFactoryAbi,
      functionName: 'getAddress',
      args: [owner, salt],
    })) as `0x${string}`;
  } catch (err: unknown) {
    throw wrapContractError(err, 'NETWORK_ERROR');
  }
}
