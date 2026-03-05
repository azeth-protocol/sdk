import {
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
  type Hex,
  encodeFunctionData,
  http,
  createNonceManager,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  toSmartAccount,
  type SmartAccount,
  entryPoint07Abi,
  entryPoint07Address,
  getUserOperationHash,
} from 'viem/account-abstraction';
import { createSmartAccountClient, type SmartAccountClient as PermissionlessSmartAccountClient } from 'permissionless';
import { AzethAccountAbi } from '@azeth/common/abis';
import { AzethError, SUPPORTED_CHAINS, type ChainConfig, type SupportedChainName, getBundlerUrl, getPaymasterUrl, getServerBundlerUrl } from '@azeth/common';
import { encodeSimpleSingle, encodeSimpleBatch, encodeSingleExecution, encodeBatchExecution } from './execution.js';
import { createPaymasterMiddleware, type PaymasterPolicy } from './paymaster.js';

/** SmartAccountClient type with concrete SmartAccount (not `SmartAccount | undefined`).
 *  This ensures sendTransaction() doesn't require explicit `account` parameter. */
export type AzethSmartAccountClient = PermissionlessSmartAccountClient<Transport, Chain, SmartAccount>;

export interface SmartAccountClientConfig {
  publicClient: PublicClient<Transport, Chain>;
  walletClient: WalletClient<Transport, Chain, Account>;
  smartAccountAddress: `0x${string}`;
  bundlerUrl?: string;
  paymasterUrl?: string;
  /** Client-side sponsorship policy for paymaster gas sponsorship.
   *  Only applies when paymasterUrl is configured. */
  paymasterPolicy?: PaymasterPolicy;
  /** Optional guardian co-signing key. When set, every UserOperation gets a
   *  130-byte dual signature (owner 65 bytes + guardian 65 bytes), enabling
   *  operations that exceed standard spending limits. */
  guardianKey?: `0x${string}`;
  /** Azeth server URL. Used as bundler fallback on testnet — the server
   *  proxies bundler requests using its own PIMLICO_API_KEY so developers
   *  don't need their own key for getting started. */
  serverUrl?: string;
}

/**
 * Create a viem SmartAccount implementation for an existing deployed AzethAccount.
 *
 * This wraps a deployed AzethAccount v12 smart account as a viem SmartAccount
 * that can be used with permissionless's createSmartAccountClient to submit
 * UserOperations through ERC-4337 EntryPoint v0.7.
 *
 * The signing flow matches GuardianModule expectations:
 * - Computes getUserOperationHash (ERC-4337 standard)
 * - Signs with walletClient.signMessage({ message: { raw: hash } })
 * - This produces sign(keccak256("\x19Ethereum Signed Message:\n32" + userOpHash))
 * - GuardianModule._splitSignature expects ECDSA owner sig as first 65 bytes
 */
export async function createAzethSmartAccount(
  publicClient: PublicClient<Transport, Chain>,
  walletClient: WalletClient<Transport, Chain, Account>,
  smartAccountAddress: `0x${string}`,
  guardianKey?: `0x${string}`,
): Promise<SmartAccount> {
  const chainId = publicClient.chain?.id;
  if (!chainId) {
    throw new AzethError('Public client must have a chain configured', 'NETWORK_ERROR');
  }

  return toSmartAccount({
    client: publicClient,

    entryPoint: {
      abi: entryPoint07Abi,
      address: entryPoint07Address,
      version: '0.7',
    },

    // Override viem's default time-based nonce key manager.
    // viem defaults to Date.now() as the nonce key, which produces 192-bit
    // timestamp keys (e.g., key=1771722560333). Our EntryPoint nonces live
    // at key=0, so the SDK would sign a UserOp with nonce=(timestamp<<64|seq)
    // while the bundler/EntryPoint expects nonce=(0<<64|seq) — causing AA24.
    nonceKeyManager: createNonceManager({
      source: {
        get() { return 0; },
        set() {},
      },
    }),

    // Return the existing deployed account address
    getAddress: async () => smartAccountAddress,

    // Our account is already deployed — no factory needed
    getFactoryArgs: async () => ({
      factory: undefined,
      factoryData: undefined,
    }),

    // Encode calls into AzethAccount.execute() callData
    encodeCalls: async (calls) => {
      if (calls.length === 0) {
        throw new AzethError('At least one call is required', 'INVALID_INPUT');
      }

      if (calls.length === 1) {
        const call = calls[0];
        return encodeFunctionData({
          abi: AzethAccountAbi,
          functionName: 'execute',
          args: [
            encodeSimpleSingle(),
            encodeSingleExecution(
              call.to as `0x${string}`,
              call.value ?? 0n,
              (call.data ?? '0x') as Hex,
            ),
          ],
        });
      }

      // Batch execution: encode multiple calls into a single UserOp
      return encodeFunctionData({
        abi: AzethAccountAbi,
        functionName: 'execute',
        args: [
          encodeSimpleBatch(),
          encodeBatchExecution(
            calls.map(c => ({
              target: c.to as `0x${string}`,
              value: c.value ?? 0n,
              data: (c.data ?? '0x') as Hex,
            })),
          ),
        ],
      });
    },

    // Sign a personal message (EIP-191) via the owner EOA
    signMessage: async ({ message }) => {
      return walletClient.signMessage({ message });
    },

    // Sign a UserOperation: compute the ERC-4337 userOpHash and sign it
    signUserOperation: async (userOperation) => {
      const userOpForHash = {
        ...userOperation,
        sender: userOperation.sender ?? smartAccountAddress,
      };
      const hash = getUserOperationHash({
        chainId,
        entryPointAddress: entryPoint07Address,
        entryPointVersion: '0.7',
        userOperation: userOpForHash,
      });

      // Sign with EIP-191 personal sign: this produces
      // sign(keccak256("\x19Ethereum Signed Message:\n32" + hash))
      // which matches GuardianModule's ecrecover(hash.toEthSignedMessageHash(), v, r, s)
      const ownerSig = await walletClient.signMessage({ message: { raw: hash } });

      // Guardian co-signature: append 65-byte guardian sig to produce 130-byte dual signature
      if (guardianKey) {
        const guardianAccount = privateKeyToAccount(guardianKey);
        const guardianSig = await guardianAccount.signMessage({ message: { raw: hash } });
        // Concatenate: ownerSig (0x + 128 hex chars) + guardianSig (128 hex chars, no 0x prefix)
        return (ownerSig + guardianSig.slice(2)) as Hex;
      }

      return ownerSig;
    },

    // Sign typed data via the owner EOA
    signTypedData: async (typedData) => {
      return walletClient.signTypedData(typedData as Parameters<typeof walletClient.signTypedData>[0]);
    },

    // 65-byte dummy signature for gas estimation.
    // Must be a valid ECDSA signature (r=1, s=1, v=27) so tryRecover succeeds
    // and the full validateUserOp code path executes (guardrails, oracle, etc.).
    // An all-0xFF stub triggers ECDSAInvalidSignatureS, taking a short path that
    // causes the bundler to underestimate verificationGasLimit (AA26).
    getStubSignature: async () => {
      const stub65 = ('0x' + '00'.repeat(31) + '01' + '00'.repeat(31) + '01' + '1b') as Hex;
      if (guardianKey) {
        // 130-byte stub: two valid ECDSA dummy signatures for owner + guardian
        return (stub65 + stub65.slice(2)) as Hex;
      }
      return stub65;
    },
  });
}

/**
 * Create a permissionless SmartAccountClient for an AzethAccount.
 *
 * The SmartAccountClient handles the full ERC-4337 flow:
 * 1. Encodes calls via account.encodeCalls()
 * 2. Gets nonce from EntryPoint
 * 3. Estimates gas via bundler
 * 4. Signs UserOp via account.signUserOperation()
 * 5. Submits to bundler via eth_sendUserOperation
 * 6. Waits for receipt and returns transaction hash
 *
 * @param config - Configuration with clients, smart account address, and bundler URL
 * @returns A SmartAccountClient that can be used for sendTransaction/writeContract
 */
export async function createAzethSmartAccountClient(
  config: SmartAccountClientConfig,
): Promise<AzethSmartAccountClient> {
  const { publicClient, walletClient, smartAccountAddress, bundlerUrl, paymasterPolicy } = config;

  const chainId = publicClient.chain?.id;
  if (!chainId) {
    throw new AzethError('Public client must have a chain configured', 'NETWORK_ERROR');
  }

  // Resolve chain name from chain ID for URL resolution
  const chainName = (Object.entries(SUPPORTED_CHAINS) as [SupportedChainName, ChainConfig][])
    .find(([, c]) => c.id === chainId)?.[0];

  // Resolve bundler URL: explicit config > env var > chain base URL + API key > error
  let resolvedBundlerUrl = bundlerUrl;
  if (!resolvedBundlerUrl) {
    if (chainName) {
      const apiKey = typeof globalThis.process !== 'undefined'
        ? globalThis.process.env?.['PIMLICO_API_KEY']
        : undefined;
      resolvedBundlerUrl = getBundlerUrl(chainName, apiKey);
    }
  }
  // Fallback: use Azeth server bundler proxy (testnet gas sponsorship)
  if (!resolvedBundlerUrl && config.serverUrl) {
    resolvedBundlerUrl = getServerBundlerUrl(config.serverUrl);
  }
  if (!resolvedBundlerUrl) {
    throw new AzethError(
      'bundlerUrl is required for UserOperation submission. ' +
      'Set PIMLICO_API_KEY or AZETH_BUNDLER_URL env var, or pass bundlerUrl in AzethKitConfig. ' +
      'Get a free key at https://dashboard.pimlico.io or https://portal.cdp.coinbase.com.',
      'INVALID_INPUT',
      { chainId },
    );
  }

  // Resolve paymaster URL: explicit config > env var > chain default (same as bundler for Pimlico)
  let resolvedPaymasterUrl = config.paymasterUrl;
  if (!resolvedPaymasterUrl) {
    resolvedPaymasterUrl = typeof globalThis.process !== 'undefined'
      ? globalThis.process.env?.['AZETH_PAYMASTER_URL']
      : undefined;
    if (!resolvedPaymasterUrl && chainName) {
      const apiKey = typeof globalThis.process !== 'undefined'
        ? globalThis.process.env?.['PIMLICO_API_KEY']
        : undefined;
      resolvedPaymasterUrl = getPaymasterUrl(chainName, apiKey);
    }
  }

  const smartAccount = await createAzethSmartAccount(
    publicClient,
    walletClient,
    smartAccountAddress,
    config.guardianKey,
  );

  // Build SmartAccountClient config with optional paymaster
  const clientConfig: Parameters<typeof createSmartAccountClient>[0] = {
    account: smartAccount,
    chain: publicClient.chain,
    bundlerTransport: http(resolvedBundlerUrl),
    client: publicClient,
  };

  // Wire paymaster middleware when URL is available.
  // The middleware handles graceful fallback: if the paymaster rejects or is
  // unreachable, the UserOp falls back to self-paid gas (no crash).
  if (resolvedPaymasterUrl) {
    clientConfig.paymaster = createPaymasterMiddleware(resolvedPaymasterUrl, paymasterPolicy);
  }

  return createSmartAccountClient(clientConfig) as AzethSmartAccountClient;
}
