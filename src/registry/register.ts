import {
  type PublicClient,
  type Chain,
  type Transport,
  type Hex,
  stringToHex,
  keccak256,
  toBytes,
  encodeFunctionData,
} from 'viem';
import { TrustRegistryModuleAbi } from '@azeth/common/abis';
import { AzethError, type AzethContractAddresses, type CatalogEntry } from '@azeth/common';
import { requireAddress } from '../utils/addresses.js';
import { wrapContractError } from '../utils/errors.js';
import type { AzethSmartAccountClient } from '../utils/userop.js';

export interface RegisterParams {
  name: string;
  description: string;
  entityType: 'agent' | 'service' | 'infrastructure';
  capabilities: string[];
  endpoint?: string;
  pricing?: string;
  catalog?: CatalogEntry[];
}

export interface RegisterResult {
  tokenId: bigint;
  txHash: `0x${string}`;
}

/** Build a data: URI from registration parameters */
export function buildAgentURI(params: RegisterParams): string {
  const metadata = {
    name: params.name,
    description: params.description,
    entityType: params.entityType,
    capabilities: params.capabilities,
    endpoint: params.endpoint ?? '',
    ...(params.pricing ? { pricing: params.pricing } : {}),
    ...(params.catalog?.length ? { catalog: params.catalog } : {}),
    version: '0.1.0',
  };
  return `data:application/json,${encodeURIComponent(JSON.stringify(metadata))}`;
}

/** Register on the ERC-8004 trust registry via the TrustRegistryModule.
 *
 *  Routes the call through the smart account so msg.sender = smart account address.
 *  The TrustRegistryModule checks _initialized[msg.sender], which is only true for
 *  the smart account — NOT the EOA. Using the smart account client ensures the
 *  module recognizes the caller.
 */
export async function registerOnRegistry(
  publicClient: PublicClient<Transport, Chain>,
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  params: RegisterParams,
): Promise<RegisterResult> {
  const moduleAddress = requireAddress(addresses, 'trustRegistryModule');
  const agentURI = buildAgentURI(params);

  let txHash: `0x${string}`;
  try {
    const data = encodeFunctionData({
      abi: TrustRegistryModuleAbi,
      functionName: 'registerOnRegistry',
      args: [agentURI],
    });
    txHash = await smartAccountClient.sendTransaction({
      to: moduleAddress,
      value: 0n,
      data,
    });
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });

  // M-4: Parse the Registered event log for tokenId with proper validation.
  // Check event signature and contract address to avoid matching unrelated logs.
  // Event: Registered(address indexed account, uint256 indexed tokenId, string agentURI)
  const REGISTERED_EVENT_TOPIC = keccak256(toBytes('Registered(address,uint256,string)'));

  let tokenId = 0n;
  for (const log of receipt.logs) {
    if (
      log.address.toLowerCase() === moduleAddress.toLowerCase()
      && log.topics[0] === REGISTERED_EVENT_TOPIC
      && log.topics.length >= 3
    ) {
      // tokenId is the second indexed topic
      tokenId = BigInt(log.topics[2] ?? '0x0');
      break;
    }
  }

  return { tokenId, txHash };
}

/** Update metadata for a registered account.
 *
 *  Routes the call through the smart account so msg.sender = smart account address.
 *  The contract expects `value` as bytes. This function accepts a string
 *  for convenience and encodes it as hex-encoded UTF-8 bytes.
 */
export async function updateMetadata(
  publicClient: PublicClient<Transport, Chain>,
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  key: string,
  value: string,
): Promise<`0x${string}`> {
  const moduleAddress = requireAddress(addresses, 'trustRegistryModule');

  let txHash: `0x${string}`;
  try {
    const data = encodeFunctionData({
      abi: TrustRegistryModuleAbi,
      functionName: 'updateMetadata',
      args: [key, stringToHex(value)],
    });
    txHash = await smartAccountClient.sendTransaction({
      to: moduleAddress,
      value: 0n,
      data,
    });
  } catch (err: unknown) {
    throw wrapContractError(err, 'REGISTRY_ERROR');
  }

  await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  return txHash;
}

export interface MetadataUpdate {
  key: string;
  value: string;
}

/** Update multiple metadata fields.
 *
 *  v1.3 LIMITATION — sequential, NOT atomic: the deployed GuardianModule cannot
 *  validate CALLTYPE_BATCH UserOperations. Its calldata decoder returns the
 *  type(uint256).max "force guardian" sentinel for batch mode, and the guardian
 *  co-sign check then compares that same sentinel against guardianMaxTxAmountUSD —
 *  no signature can ever satisfy it, so every batch UserOp fails AA24 (co-signed
 *  or not). Until a future module version decodes batch items individually, each
 *  key-value pair is sent as its own single-call UserOp in order. If update N
 *  fails, updates 1..N-1 have already landed.
 */
export async function updateMetadataBatch(
  publicClient: PublicClient<Transport, Chain>,
  smartAccountClient: AzethSmartAccountClient,
  addresses: AzethContractAddresses,
  account: `0x${string}`,
  updates: MetadataUpdate[],
): Promise<`0x${string}`> {
  if (updates.length === 0) {
    throw new AzethError('At least one metadata update is required', 'INVALID_INPUT');
  }

  // Sequential single-call path — see the v1.3 limitation note above. Returns the
  // final transaction hash; on partial failure the error reports how many landed.
  let txHash: `0x${string}` | undefined;
  for (let i = 0; i < updates.length; i++) {
    const { key, value } = updates[i]!;
    try {
      txHash = await updateMetadata(publicClient, smartAccountClient, addresses, account, key, value);
    } catch (err: unknown) {
      if (i > 0) {
        throw new AzethError(
          `Batch update failed at "${key}" (update ${i + 1} of ${updates.length}) — the first ${i} update(s) already landed on-chain. Updates are sequential on v1.3, not atomic.`,
          'REGISTRY_ERROR',
          { failedKey: key, applied: i, total: updates.length },
        );
      }
      throw wrapContractError(err, 'REGISTRY_ERROR');
    }
  }
  return txHash!;
}
