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
  estimateUserOperationGas,
  createBundlerClient,
  type BundlerClient,
  type UserOperationRequest,
  type EstimateUserOperationGasParameters,
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
  /** Self-guardian fast path: when the account's on-chain guardian IS the owner EOA,
   *  the owner signature doubles as the guardian signature (same key, same userOpHash
   *  → byte-identical 65-byte ECDSA sig). Setting this appends a copy of the owner
   *  signature to produce the 130-byte dual layout GuardianModule expects for
   *  guardian-tier operations (batch executions, guardrail changes, stale-oracle
   *  transfers) — without any separate guardian key. Adds no security and removes
   *  none: the caller already holds the only key the guardian check verifies.
   *  Ignored when guardianKey is set. */
  selfGuardianCosign?: boolean;
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
  estimateBundlerClient?: BundlerClient,
  selfGuardianCosign?: boolean,
): Promise<SmartAccount> {
  const chainId = publicClient.chain?.id;
  if (!chainId) {
    throw new AzethError('Public client must have a chain configured', 'NETWORK_ERROR');
  }

  // Late-bound self-reference so the estimateGas hook (invoked later, inside
  // prepareUserOperation) can pass `account` to estimateUserOperationGas.
  let smartAccountRef: SmartAccount | undefined;

  const account = await toSmartAccount({
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

      // Self-guardian fast path: guardian == owner, so the guardian signature over the
      // same userOpHash is byte-identical to the owner signature — duplicate it to form
      // the 130-byte dual layout. No second signing operation, no key duplication.
      if (selfGuardianCosign) {
        return (ownerSig + ownerSig.slice(2)) as Hex;
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
      if (guardianKey || selfGuardianCosign) {
        // 130-byte stub: two valid ECDSA dummy signatures for owner + guardian —
        // estimation must exercise the same dual-signature validation path that
        // the real signature will take (guardian tier costs more verification gas).
        return (stub65 + stub65.slice(2)) as Hex;
      }
      return stub65;
    },

    // Apply the verification-gas buffer DURING estimation, via viem's account-level
    // estimateGas hook. viem's prepareUserOperation invokes this hook BEFORE it fetches
    // the sending-paymaster signature and BEFORE sendUserOperation signs the owner sig,
    // so the buffered verificationGasLimit is what BOTH signatures cover (no AA34/AA24).
    //
    // This replaces a trailing `client.extend(estimateUserOperationGas)` override that
    // was dead code: permissionless binds prepareUserOperation to the inner bundler
    // client, which a trailing client.extend never reaches — so the bundler's raw
    // (un-buffered) estimate was used and an account's FIRST value-spend of the day
    // (cold daily-spend SSTORE, gated behind the owner-sig check in GuardianModule)
    // deterministically reverted with AA26.
    //
    // Passing `account` to estimateUserOperationGas is recursion-safe: that action
    // re-runs prepareUserOperation WITHOUT the 'gas' property, so this hook is not
    // re-entered. On ANY failure (or when no bundler client is available) we return
    // undefined → viem's own (un-buffered) estimate runs, i.e. never worse than before.
    userOperation: {
      estimateGas: async (userOperation: UserOperationRequest) => {
        if (!smartAccountRef || !estimateBundlerClient) return undefined;
        try {
          const hasPaymaster = Boolean((userOperation as { paymaster?: `0x${string}` }).paymaster);
          const estimate = await estimateUserOperationGas(estimateBundlerClient, {
            account: smartAccountRef,
            // Mirror viem's own estimate call (prepareUserOperation gas step): zeroish
            // defaults so bundlers don't reject nullish gas, plus paymaster gas fields
            // only when a paymaster is present.
            callGasLimit: 0n,
            preVerificationGas: 0n,
            verificationGasLimit: 0n,
            ...(hasPaymaster
              ? { paymasterPostOpGasLimit: 0n, paymasterVerificationGasLimit: 0n }
              : {}),
            ...userOperation,
          } as EstimateUserOperationGasParameters);
          return {
            ...estimate,
            verificationGasLimit: applyVerificationGasBuffer(estimate.verificationGasLimit),
          };
        } catch {
          return undefined;
        }
      },
    },
  });

  smartAccountRef = account;
  return account;
}

/**
 * Multiplier (numerator / denominator) applied to the bundler's estimated
 * `verificationGasLimit`.
 *
 * GuardianModule.validateUserOp burns a STATE-DEPENDENT amount of verification
 * gas: oracle staticcalls, a daily-spend SSTORE (cold ~20k / warm ~5k), and a
 * conditional epoch reset. The bundler estimates against on-chain state at
 * estimation time, but that slot can be cold (or the epoch can roll over) by
 * execution time, so the real verification cost can exceed a tight point
 * estimate — deterministically reverting with `AA26 over verificationGasLimit`.
 * A 1.5x buffer absorbs that variance; unused gas is refunded by the EntryPoint,
 * so over-provisioning is safe. This restores the headroom lost when the flat
 * 300K override was removed alongside the v22 GuardianModule estimation fix, but
 * as a proportional multiplier rather than a magic constant.
 *
 * The buffer is applied at GAS-ESTIMATION time (via the smart account's estimateGas
 * hook), NOT as a post-prepare mutation: prepareUserOperation fetches the
 * sending paymaster sponsorship signature and signs the owner signature AFTER the
 * gas step, so bumping verificationGasLimit afterwards would invalidate the
 * paymaster signature (AA34) and the owner signature (AA24). Buffering during
 * estimation means both are computed over the buffered value.
 */
const VERIFICATION_GAS_BUFFER_NUMERATOR = 3n;
const VERIFICATION_GAS_BUFFER_DENOMINATOR = 2n;

/** Apply the verification-gas safety buffer to a bundler estimate.
 *  See {@link VERIFICATION_GAS_BUFFER_NUMERATOR} for why this is needed. */
export function applyVerificationGasBuffer(verificationGasLimit: bigint): bigint {
  return (verificationGasLimit * VERIFICATION_GAS_BUFFER_NUMERATOR) / VERIFICATION_GAS_BUFFER_DENOMINATOR;
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
    resolvedBundlerUrl = getServerBundlerUrl(config.serverUrl, chainId);
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

  // Bundler client used by the smart account's estimateGas hook to apply the
  // verification-gas buffer during estimation (see createAzethSmartAccount).
  const estimateBundlerClient = createBundlerClient({
    client: publicClient,
    transport: http(resolvedBundlerUrl),
  });

  const smartAccount = await createAzethSmartAccount(
    publicClient,
    walletClient,
    smartAccountAddress,
    config.guardianKey,
    estimateBundlerClient,
    config.selfGuardianCosign,
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

  const client = createSmartAccountClient(clientConfig);

  // The verification-gas buffer is applied via the smart account's estimateGas hook
  // (see createAzethSmartAccount), NOT a trailing client.extend: permissionless binds
  // sendUserOperation/prepareUserOperation to the inner bundler client, so a trailing
  // client.extend's estimateUserOperationGas override is never consulted (dead code →
  // AA26 on cold daily-spend slots). The hook runs inside prepareUserOperation, before
  // the paymaster and owner signatures, so the buffered limit is covered by both.
  return client as AzethSmartAccountClient;
}
