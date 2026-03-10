import {
  createPublicClient,
  createWalletClient,
  http,
  hexToBytes,
  bytesToHex,
  encodeFunctionData,
  getAddress,
  pad,
  toHex,
  type PublicClient,
  type WalletClient,
  type Chain,
  type Transport,
  type Account,
} from 'viem';
import { base, baseSepolia, sepolia as ethereumSepoliaChain, mainnet as ethereumChain } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import {
  AzethError,
  SUPPORTED_CHAINS,
  type SupportedChainName,
  type AzethContractAddresses,
  type RegistryEntry,
  type DiscoveryParams,
  type PaymentAgreement,
  type MessageHandler,
  type OnChainOpinion,
  type WeightedReputation,
  type ActiveOpinion,
  type OpinionEntry,
  type XMTPConfig,
  type XMTPConversation,
  type XMTPMessage,
} from '@azeth/common';
import { validateAddress, validateUrl, validatePositiveAmount } from './utils/validation.js';
import { resolveAddresses, requireAddress } from './utils/addresses.js';
import { withRetry } from './utils/retry.js';
import { AzethFactoryAbi, PaymentAgreementModuleAbi, TrustRegistryModuleAbi } from '@azeth/common/abis';
import { createAccount, getAccountAddress, type CreateAccountParams, type CreateAccountResult } from './account/create.js';
import { createAccountGasless } from './account/gasless.js';
import { setTokenWhitelist as setTokenWhitelistFn, setProtocolWhitelist as setProtocolWhitelistFn } from './account/guardian.js';
import { getBalance, getAllBalances, type BalanceResult } from './account/balance.js';
import type { AggregatedBalanceResult } from '@azeth/common';
import { transfer, type TransferParams, type TransferResult } from './account/transfer.js';
import { getHistory, type HistoryParams, type TransactionRecord } from './account/history.js';
import { deposit, type DepositParams, type DepositResult } from './account/deposit.js';
import { registerOnRegistry, updateMetadata, updateMetadataBatch, buildAgentURI, type RegisterParams, type RegisterResult, type MetadataUpdate } from './registry/register.js';
import {
  submitOpinion as submitOnChainOpinion,
  getWeightedReputation as getWeightedRep,
  getNetPaid as getNetPaidFn,
  getTotalNetPaidUSD as getTotalNetPaidUSDFn,
  getActiveOpinion as getActiveOpinionFn,
  readOpinion as readOnChainOpinion,
} from './reputation/opinion.js';
import { discoverServices, getRegistryEntry } from './registry/discover.js';
import { fetch402, type Fetch402Options, type Fetch402Result, type SmartAccountTransferCallback } from './payments/x402.js';
import { smartFetch402 as smartFetch402Fn, computeFeedbackValue, FAILURE_PENALTY_VALUE, type SmartFetch402Options, type SmartFetch402Result } from './payments/smart-fetch.js';
import { createPaymentAgreement, getAgreement, executeAgreement, executeAgreementAsKeeper, cancelAgreement as cancelAgreementFn, findAgreementWithPayee, getAgreementCount as getAgreementCountFn, canExecutePayment as canExecutePaymentFn, getNextExecutionTime as getNextExecutionTimeFn, getAgreementData as getAgreementDataFn, type CreateAgreementParams, type AgreementResult } from './payments/agreements.js';
import { createSignedFetch } from './auth/erc8128.js';
import { XMTPClient, type SendMessageParams } from './messaging/xmtp.js';
import { AzethEventEmitter, type AzethEventName, type AzethEventListener, type AzethEventMap } from './events/emitter.js';
import { BudgetManager, type BudgetConfig, type BudgetCheckResult } from './payments/budget.js';
import { createAzethSmartAccountClient, type AzethSmartAccountClient } from './utils/userop.js';
import type { PaymasterPolicy } from './utils/paymaster.js';

export interface AzethKitConfig {
  /** The account owner's private key */
  privateKey: `0x${string}`;
  /** Chain to connect to */
  chain: SupportedChainName;
  /** Custom RPC URL (optional) */
  rpcUrl?: string;
  /** Azeth server URL for indexed data and message relay */
  serverUrl?: string;
  /** ERC-4337 bundler URL for UserOperation submission.
   *  Required for state-changing smart account operations (transfers, payments, reputation).
   *  Resolution: explicit value > AZETH_BUNDLER_URL env > SUPPORTED_CHAINS default > error.
   *  Get a free key at https://dashboard.pimlico.io or https://portal.cdp.coinbase.com. */
  bundlerUrl?: string;
  /** ERC-4337 paymaster URL for gas sponsorship (optional).
   *  When provided, the paymaster will sponsor gas for UserOperations.
   *  Resolution: explicit value > AZETH_PAYMASTER_URL env > SUPPORTED_CHAINS default.
   *  When not configured, UserOps use self-paid gas (no single point of failure). */
  paymasterUrl?: string;
  /** Client-side sponsorship policy for paymaster gas sponsorship (optional).
   *  Defense-in-depth layer on top of the paymaster's server-side policies.
   *  Only applies when a paymaster is configured. */
  paymasterPolicy?: PaymasterPolicy;
  /** Override contract addresses (merged with chain defaults) */
  contractAddresses?: Partial<AzethContractAddresses>;
  /** XMTP messaging configuration (optional — messaging lazy-initializes on first use) */
  xmtp?: XMTPConfig;
  /** Budget configuration for x402 payments.
   *  When provided, enables reputation-aware spending limits. */
  budget?: BudgetConfig;
  /** Optional guardian co-signing key.
   *  Used to derive the guardian address for account creation and for interactive XMTP approval.
   *  Only auto-signs UserOperations when `guardianAutoSign` is also set to `true`.
   *  The address derived from this key must match the guardian set in the account's guardrails. */
  guardianKey?: `0x${string}`;
  /** When true AND guardianKey is set, the SDK auto-appends a guardian co-signature
   *  to every UserOperation, enabling operations that exceed standard spending limits.
   *  Must be explicitly set to `true` — defaults to `false` (guardian must confirm via XMTP). */
  guardianAutoSign?: boolean;
}

/** Simplified account creation — auto-fills owner, guardrails, and wraps into registry.
 *  Use this when you want sensible defaults without manual guardrail configuration. */
export interface SimpleCreateAccountParams {
  /** Display name for the trust registry entry */
  name: string;
  /** Entity type: 'agent', 'service', or 'infrastructure' */
  entityType: 'agent' | 'service' | 'infrastructure';
  /** Human-readable description */
  description: string;
  /** Service capabilities for discovery (e.g., ['weather-data', 'price-feed']) */
  capabilities?: string[];
  /** Service endpoint URL */
  endpoint?: string;
  /** Max per-transaction amount in USD (default: 100) */
  maxTxAmountUSD?: number;
  /** Daily spending limit in USD (default: 1000) */
  dailySpendLimitUSD?: number;
  /** Guardian address for co-signing high-value txs (default: self-guardian) */
  guardian?: `0x${string}`;
  /** Emergency withdrawal destination (default: owner) */
  emergencyWithdrawTo?: `0x${string}`;
}

/** Simplified opinion — rating from -100 to 100, auto-converts to WAD format */
export interface SimpleOpinion {
  /** Target service's ERC-8004 token ID */
  serviceTokenId: bigint;
  /** Rating from -100 to 100 (supports decimals like 85.5) */
  rating: number;
  /** Primary categorization tag (default: 'quality') */
  tag1?: string;
  /** Secondary categorization tag (default: '') */
  tag2?: string;
  /** Service endpoint being rated */
  endpoint?: string;
}

/** Result from pay() — fetch402 result with auto-parsed response body */
export interface PayResult {
  /** Parsed response body (JSON object or raw text string) */
  data: unknown;
  /** Raw HTTP response (body already consumed) */
  response: Response;
  /** Whether an x402 payment was made */
  paymentMade: boolean;
  /** Payment amount in token base units (e.g., USDC with 6 decimals) */
  amount?: bigint;
  /** On-chain transaction hash of the payment */
  txHash?: `0x${string}`;
  /** Response time in milliseconds */
  responseTimeMs?: number;
  /** Whether on-chain settlement was verified */
  settlementVerified: boolean;
  /** How access was obtained */
  paymentMethod: 'x402' | 'smart-account' | 'session' | 'none';
}

/** AzethKit -- Trust Infrastructure SDK for the Machine Economy
 *
 *  Provides Phase 0 methods for machine participants:
 *  - create: Deploy a smart account + trust registry entry
 *  - transfer: Send ETH or tokens to another participant
 *  - getBalance: Check account balances
 *  - getHistory: Get transaction history
 *  - fetch402: Pay for x402-gated services (with budget enforcement)
 *  - publishService: Register on the trust registry
 *  - discoverServices: Find services by capability + reputation
 *  - createPaymentAgreement: Set up recurring payments
 *  - submitOpinion: Submit reputation opinion for a service
 *  - getWeightedReputation: Get payment-weighted reputation for an agent
 *  - getNetPaid: Get net payment delta with a counterparty
 *  - getActiveOpinion: Check active opinion for an agent
 *  - sendMessage: Send XMTP encrypted messages
 *  - onMessage: Listen for incoming messages
 *  - canReach: Check if an address is reachable on XMTP
 *
 *  Events: on('beforePayment'), on('afterPayment'), on('paymentError'),
 *          on('beforeTransfer'), on('afterTransfer'), on('transferError')
 */
export class AzethKit {
  readonly address: `0x${string}`;
  readonly chainName: SupportedChainName;
  readonly addresses: AzethContractAddresses;
  readonly publicClient: PublicClient<Transport, Chain>;
  private readonly walletClient: WalletClient<Transport, Chain, Account>;
  readonly serverUrl: string;

  /** All smart account addresses owned by this EOA, resolved from factory.
   *  null until createAccount() is called or resolveSmartAccount() resolves them. */
  private _smartAccounts: `0x${string}`[] | null = null;

  /** H-2 fix: Private key stored as Uint8Array for proper zeroing in destroy() */
  private _privateKeyBytes: Uint8Array;
  /** MEDIUM-7 fix: Track destroyed state to prevent use-after-destroy.
   *  H-6 fix (Audit #8): All state-changing methods now check this flag. */
  private _destroyed = false;
  private readonly _xmtpConfig: XMTPConfig | undefined;
  private _messaging: XMTPClient | null = null;
  private _messagingInitPromise: Promise<void> | null = null;

  /** Event emitter for lifecycle hooks */
  readonly events: AzethEventEmitter;

  /** Budget manager for x402 spending limits */
  readonly budget: BudgetManager;

  /** ERC-4337 bundler URL for UserOperation submission */
  private readonly _bundlerUrl: string | undefined;
  /** ERC-4337 paymaster URL for gas sponsorship */
  private readonly _paymasterUrl: string | undefined;
  /** Client-side paymaster sponsorship policy */
  private readonly _paymasterPolicy: PaymasterPolicy | undefined;
  /** Guardian co-signing key — used for address derivation and optional auto-signing */
  private readonly _guardianKey: `0x${string}` | undefined;
  /** When true, auto-append guardian co-signature to every UserOp */
  private readonly _guardianAutoSign: boolean;
  /** Cached SmartAccountClient instances keyed by smart account address */
  private readonly _smartAccountClients: Map<string, AzethSmartAccountClient> = new Map();

  private constructor(
    address: `0x${string}`,
    chainName: SupportedChainName,
    addresses: AzethContractAddresses,
    publicClient: PublicClient<Transport, Chain>,
    walletClient: WalletClient<Transport, Chain, Account>,
    serverUrl: string,
    privateKey: `0x${string}`,
    xmtpConfig?: XMTPConfig,
    budgetConfig?: BudgetConfig,
    bundlerUrl?: string,
    paymasterUrl?: string,
    paymasterPolicy?: PaymasterPolicy,
    guardianKey?: `0x${string}`,
    guardianAutoSign?: boolean,
  ) {
    this.address = address;
    this.chainName = chainName;
    this.addresses = addresses;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
    this.serverUrl = serverUrl;
    this._privateKeyBytes = hexToBytes(privateKey);
    this._xmtpConfig = xmtpConfig;
    this.events = new AzethEventEmitter();
    this.budget = new BudgetManager(budgetConfig);
    this._bundlerUrl = bundlerUrl;
    this._paymasterUrl = paymasterUrl;
    this._paymasterPolicy = paymasterPolicy;
    this._guardianKey = guardianKey;
    this._guardianAutoSign = guardianAutoSign === true;
  }

  /** Create an AzethKit instance from a private key
   *
   *  This connects to the chain and sets up clients for the owner's address.
   *  Call publishService() to register on the trust registry if not already registered.
   */
  static async create(config: AzethKitConfig): Promise<AzethKit> {
    // LOW-1 fix: Validate private key format before viem's privateKeyToAccount,
    // which gives an unhelpful error for malformed keys.
    if (!/^0x[0-9a-fA-F]{64}$/.test(config.privateKey)) {
      throw new AzethError(
        'Invalid private key format — expected 0x-prefixed 32-byte hex string (66 chars total)',
        'INVALID_INPUT',
        { field: 'privateKey' },
      );
    }

    const viemChains: Record<SupportedChainName, Chain> = {
      base,
      baseSepolia,
      ethereumSepolia: ethereumSepoliaChain,
      ethereum: ethereumChain,
    };
    const chain = viemChains[config.chain];
    const rpcUrl = config.rpcUrl ?? SUPPORTED_CHAINS[config.chain].rpcDefault;

    const account = privateKeyToAccount(config.privateKey);
    const addresses = resolveAddresses(config.chain, config.contractAddresses);

    const publicClient = createPublicClient({
      chain,
      transport: http(rpcUrl),
    }) as PublicClient<Transport, Chain>;

    const walletClient = createWalletClient({
      account,
      chain,
      transport: http(rpcUrl),
    }) as WalletClient<Transport, Chain, Account>;

    const serverUrl = config.serverUrl ?? 'https://api.azeth.ai';

    // Validate server URL format
    if (config.serverUrl) {
      try {
        const parsed = new URL(config.serverUrl);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          throw new AzethError('Server URL must use HTTP or HTTPS', 'INVALID_INPUT', { field: 'serverUrl' });
        }
      } catch (e) {
        if (e instanceof AzethError) throw e;
        throw new AzethError('Invalid server URL format', 'INVALID_INPUT', { field: 'serverUrl' });
      }
    }

    return new AzethKit(
      account.address,
      config.chain,
      addresses,
      publicClient,
      walletClient,
      serverUrl,
      config.privateKey,
      config.xmtp,
      config.budget,
      config.bundlerUrl,
      config.paymasterUrl,
      config.paymasterPolicy,
      config.guardianKey,
      config.guardianAutoSign,
    );
  }

  // ──────────────────────────────────────────────
  // Event system
  // ──────────────────────────────────────────────

  /** Subscribe to a lifecycle event. Returns an unsubscribe function. */
  on<K extends AzethEventName>(
    event: K,
    listener: AzethEventListener<AzethEventMap[K]>,
  ): () => void {
    return this.events.on(event, listener);
  }

  /** Subscribe to a lifecycle event for a single firing. */
  once<K extends AzethEventName>(
    event: K,
    listener: AzethEventListener<AzethEventMap[K]>,
  ): () => void {
    return this.events.once(event, listener);
  }

  // ──────────────────────────────────────────────
  // Account operations
  // ──────────────────────────────────────────────

  /** H-6 fix (Audit #8): Guard all state-changing methods against use-after-destroy.
   *  After destroy(), the walletClient may still hold a working key copy in memory.
   *  This prevents accidental operations on a "destroyed" instance. */
  private _requireNotDestroyed(): void {
    if (this._destroyed) {
      throw new AzethError('AzethKit instance has been destroyed', 'INVALID_INPUT');
    }
  }

  /** The first (default) smart account address owned by this EOA, or null if not yet resolved */
  get smartAccount(): `0x${string}` | null {
    return this._smartAccounts?.[0] ?? null;
  }

  /** All smart account addresses owned by this EOA, or null if not yet resolved */
  get smartAccounts(): readonly `0x${string}`[] | null {
    return this._smartAccounts;
  }

  /** Resolve all smart account addresses from the on-chain factory.
   *  Queries factory.getAccountsByOwner(ownerAddress).
   *  Caches the result for subsequent calls.
   *
   *  @returns Array of smart account addresses owned by this EOA
   */
  async getSmartAccounts(): Promise<readonly `0x${string}`[]> {
    if (this._smartAccounts) return this._smartAccounts;
    this._requireNotDestroyed();

    const factoryAddress = requireAddress(this.addresses, 'factory');

    const accounts = await withRetry(() => this.publicClient.readContract({
      address: factoryAddress,
      abi: AzethFactoryAbi,
      functionName: 'getAccountsByOwner',
      args: [this.address],
    }));

    this._smartAccounts = [...(accounts ?? [])];
    return this._smartAccounts;
  }

  /** Resolve the default (first) smart account address from the on-chain factory.
   *  Caches the result for subsequent calls.
   *
   *  @throws AzethError if no account is found for this owner
   */
  async resolveSmartAccount(): Promise<`0x${string}`> {
    const accounts = await this.getSmartAccounts();

    if (accounts.length === 0) {
      throw new AzethError(
        'No smart account found for this owner. Call createAccount() first.',
        'ACCOUNT_NOT_FOUND',
        { owner: this.address },
      );
    }

    return accounts[0];
  }

  /** Set the active smart account for subsequent operations (payments, transfers, etc.).
   *  Reorders the internal accounts array so the specified address becomes the default.
   *  All methods that use `resolveSmartAccount()` or `_smartAccounts[0]` will use it.
   *
   *  @param address - Address of one of your smart accounts (must already be in the accounts list)
   *  @throws AzethError if no accounts are loaded or the address is not found
   */
  setActiveAccount(address: `0x${string}`): void {
    if (!this._smartAccounts || this._smartAccounts.length === 0) {
      throw new AzethError(
        'No smart accounts loaded. Call getSmartAccounts() first.',
        'ACCOUNT_NOT_FOUND',
      );
    }
    const normalized = getAddress(address);
    const idx = this._smartAccounts.findIndex(a => getAddress(a) === normalized);
    if (idx === -1) {
      throw new AzethError(
        `Address ${address} is not one of your smart accounts.`,
        'ACCOUNT_NOT_FOUND',
        { address },
      );
    }
    if (idx > 0) {
      const [target] = this._smartAccounts.splice(idx, 1);
      this._smartAccounts.unshift(target!);
    }
  }

  /** Deploy a new Azeth smart account via the AzethFactory v11 (one-call setup).
   *
   *  Single atomic transaction: deploys ERC-1967 proxy, installs all 4 modules,
   *  registers on ERC-8004 trust registry (optional), and permanently revokes factory access.
   *
   *  Accepts either full params (CreateAccountParams) or simplified params
   *  (SimpleCreateAccountParams) that auto-fill owner, guardrails, and registry.
   *
   *  @example Simplified (recommended for most cases):
   *  ```typescript
   *  await agent.createAccount({
   *    name: 'WeatherOracle',
   *    entityType: 'service',
   *    description: 'Real-time weather data',
   *    capabilities: ['weather-data'],
   *    endpoint: 'http://localhost:3402',
   *  });
   *  ```
   *
   *  @example Full control:
   *  ```typescript
   *  await agent.createAccount({
   *    owner: agent.address,
   *    guardrails: { maxTxAmountUSD: 500n * 10n**18n, ... },
   *    registry: { name: 'WeatherOracle', entityType: 'service', ... },
   *  });
   *  ```
   */
  async createAccount(params: CreateAccountParams | SimpleCreateAccountParams): Promise<CreateAccountResult> {
    this._requireNotDestroyed();

    let fullParams: CreateAccountParams;
    if ('owner' in params) {
      fullParams = params;
    } else {
      const maxTx = params.maxTxAmountUSD ?? 100;
      const dailyLimit = params.dailySpendLimitUSD ?? 1000;
      fullParams = {
        owner: this.address,
        guardrails: {
          maxTxAmountUSD: BigInt(Math.round(maxTx)) * 10n ** 18n,
          dailySpendLimitUSD: BigInt(Math.round(dailyLimit)) * 10n ** 18n,
          guardianMaxTxAmountUSD: BigInt(Math.round(maxTx * 5)) * 10n ** 18n,
          guardianDailySpendLimitUSD: BigInt(Math.round(dailyLimit * 5)) * 10n ** 18n,
          guardian: params.guardian ?? this.address,
          emergencyWithdrawTo: params.emergencyWithdrawTo ?? this.address,
        },
        registry: {
          name: params.name,
          description: params.description,
          entityType: params.entityType,
          capabilities: params.capabilities ?? [],
          endpoint: params.endpoint,
        },
      };
    }

    // Try gasless creation via relay first (if serverUrl is configured).
    // The relay pays gas using createAccountWithSignature. Falls back to direct tx
    // if relay is unavailable (503), rate-limited (429), or any network error occurs.
    if (this.serverUrl) {
      // Pre-compute salt and agentURI (same logic as create.ts) so both paths are consistent
      let salt: `0x${string}`;
      if (fullParams.salt) {
        salt = fullParams.salt;
      } else {
        const existing = await withRetry(() => this.publicClient.readContract({
          address: requireAddress(this.addresses, 'factory'),
          abi: AzethFactoryAbi,
          functionName: 'getAccountsByOwner',
          args: [fullParams.owner],
        })) as readonly `0x${string}`[];
        salt = pad(toHex(existing.length), { size: 32 });
      }
      const agentURI = fullParams.registry ? buildAgentURI(fullParams.registry) : '';

      const gaslessResult = await createAccountGasless(
        this.publicClient, this.walletClient, this.addresses,
        fullParams, this.serverUrl, this.chainName, salt, agentURI,
      );
      if (gaslessResult) {
        if (!this._smartAccounts) {
          this._smartAccounts = [gaslessResult.account];
        } else {
          this._smartAccounts.push(gaslessResult.account);
        }
        return gaslessResult;
      }
      // Relay failed — pass pre-computed salt to avoid duplicate RPC call in fallback
      fullParams.salt = salt;
    }

    const result = await createAccount(this.publicClient, this.walletClient, this.addresses, fullParams);
    // Cache the newly created account
    if (!this._smartAccounts) {
      this._smartAccounts = [result.account];
    } else {
      this._smartAccounts.push(result.account);
    }
    return result;
  }

  /** Compute the deterministic address for an account without deploying */
  async getAccountAddress(salt: `0x${string}`): Promise<`0x${string}`> {
    return getAccountAddress(this.publicClient, this.addresses, this.address, salt);
  }

  /** Transfer ETH or ERC-20 tokens from a smart account to another address.
   *
   *  Executes via AzethAccount.execute() so transfers go through the smart account,
   *  not the EOA directly. Defaults to the first smart account if none specified.
   *
   *  @param params - Transfer parameters (to, amount, token)
   *  @param fromAccount - Optional: specific smart account to transfer from (defaults to first)
   */
  async transfer(params: TransferParams, fromAccount?: `0x${string}`): Promise<TransferResult> {
    this._requireNotDestroyed();
    validateAddress(params.to, 'to');
    if (params.amount <= 0n) {
      throw new AzethError('Transfer amount must be positive', 'INVALID_INPUT', { field: 'amount' });
    }

    await this.events.emit('beforeTransfer', {
      to: params.to,
      amount: params.amount,
      token: params.token,
    });

    let result: TransferResult;
    try {
      const account = fromAccount ?? await this.resolveSmartAccount();
      const smartAccountClient = await this._getSmartAccountClient(account);
      result = await transfer(smartAccountClient, account, params, this.publicClient, this.addresses);
    } catch (err: unknown) {
      await this.events.emit('transferError', {
        operation: 'transfer',
        error: err instanceof Error ? err : new Error(String(err)),
        context: { to: params.to, amount: params.amount.toString() },
      });
      throw err;
    }

    await this.events.emit('afterTransfer', {
      to: params.to,
      amount: params.amount,
      token: params.token,
      txHash: result.txHash,
    });

    return result;
  }

  /** Get ETH and token balances for the smart account (primary) and EOA (gas).
   *
   *  @param forAccount - Optional: specific smart account to check (defaults to first)
   */
  async getBalance(forAccount?: `0x${string}`): Promise<BalanceResult> {
    const account = forAccount ?? await this.resolveSmartAccount();
    return getBalance(this.publicClient, this.chainName, account, this.address);
  }

  /** Get balances for ALL accounts (EOA + all smart accounts) with USD values.
   *  Single RPC call via AzethFactory.getOwnerBalancesAndUSD().
   *
   *  Returns: EOA at index 0, smart accounts at index 1+.
   *  Each account has per-token balances with USD values and a total.
   *  Grand total USD sums across all accounts.
   */
  async getAllBalances(): Promise<AggregatedBalanceResult> {
    const factoryAddress = requireAddress(this.addresses, 'factory');
    return getAllBalances(this.publicClient, this.chainName, factoryAddress, this.address);
  }

  /** Get transaction history for a smart account.
   *
   *  @param params - History params (limit, offset)
   *  @param forAccount - Optional: specific smart account (defaults to first)
   */
  async getHistory(params?: HistoryParams, forAccount?: `0x${string}`): Promise<TransactionRecord[]> {
    const account = forAccount ?? await this.resolveSmartAccount();
    // Pass known token addresses for ERC-20 deposit tracking
    const { TOKENS } = await import('@azeth/common');
    const tokens = TOKENS[this.chainName];
    const tokenAddresses = [tokens.USDC, tokens.WETH].filter(Boolean) as `0x${string}`[];
    return getHistory(this.publicClient, account, this.serverUrl, params, this.addresses.reputationModule, tokenAddresses);
  }

  /** Deposit ETH or ERC-20 tokens from the owner EOA to a self-owned smart account.
   *
   *  SECURITY: On-chain validation ensures the target is:
   *  1. A real Azeth smart account (factory.isAzethAccount)
   *  2. Owned by this EOA (factory.getOwnerOf)
   */
  async deposit(params: DepositParams): Promise<DepositResult> {
    this._requireNotDestroyed();
    validateAddress(params.to, 'to');
    if (params.amount <= 0n) {
      throw new AzethError('Deposit amount must be positive', 'INVALID_INPUT', { field: 'amount' });
    }

    await this.events.emit('beforeDeposit', {
      to: params.to,
      amount: params.amount,
      token: params.token,
    });

    let result: DepositResult;
    try {
      result = await deposit(
        this.publicClient, this.walletClient, this.addresses, this.address, params,
      );
    } catch (err: unknown) {
      await this.events.emit('depositError', {
        operation: 'deposit',
        error: err instanceof Error ? err : new Error(String(err)),
        context: { to: params.to, amount: params.amount.toString() },
      });
      throw err;
    }

    await this.events.emit('afterDeposit', {
      to: params.to,
      amount: params.amount,
      token: params.token,
      txHash: result.txHash,
    });

    return result;
  }

  /** Deposit ETH or ERC-20 tokens to this account's smart account.
   *  Convenience wrapper that auto-resolves the smart account address. */
  async depositToSelf(params: Omit<DepositParams, 'to'>): Promise<DepositResult> {
    const account = await this.resolveSmartAccount();
    return this.deposit({ ...params, to: account });
  }

  // ──────────────────────────────────────────────
  // Guardian management
  // ──────────────────────────────────────────────

  /** Update the token whitelist on the GuardianModule.
   *  Tokens must be whitelisted for executor-module operations (e.g., PaymentAgreementModule).
   *
   *  @param token - Token address (use 0x0...0 for native ETH)
   *  @param allowed - true to whitelist, false to remove
   *  @param account - Optional: specific smart account (defaults to first)
   */
  async setTokenWhitelist(
    token: `0x${string}`,
    allowed: boolean,
    account?: `0x${string}`,
  ): Promise<`0x${string}`> {
    this._requireNotDestroyed();
    const resolvedAccount = account ?? await this.resolveSmartAccount();
    const smartAccountClient = await this._getSmartAccountClient(resolvedAccount);
    return setTokenWhitelistFn(smartAccountClient, this.addresses, token, allowed);
  }

  /** Update the protocol whitelist on the GuardianModule.
   *  Protocols must be whitelisted for executor-module operations.
   *
   *  @param protocol - Protocol/contract address
   *  @param allowed - true to whitelist, false to remove
   *  @param account - Optional: specific smart account (defaults to first)
   */
  async setProtocolWhitelist(
    protocol: `0x${string}`,
    allowed: boolean,
    account?: `0x${string}`,
  ): Promise<`0x${string}`> {
    this._requireNotDestroyed();
    const resolvedAccount = account ?? await this.resolveSmartAccount();
    const smartAccountClient = await this._getSmartAccountClient(resolvedAccount);
    return setProtocolWhitelistFn(smartAccountClient, this.addresses, protocol, allowed);
  }

  // ──────────────────────────────────────────────
  // x402 payments
  // ──────────────────────────────────────────────

  /** Fetch a URL, automatically paying x402 requirements.
   *
   *  If the service returns 402, the SDK signs an ERC-3009 payment authorization,
   *  retries the request with the payment proof.
   *
   *  Budget checking: If a BudgetManager is configured (default), the payment amount is
   *  checked against reputation-aware spending tiers before signing.
   *
   *  @param url - Service URL to fetch
   *  @param options - Fetch options including budget overrides
   *  @param serviceReputation - Optional reputation score (0-100) for budget tier lookup
   */
  async fetch402(
    url: string,
    options?: Fetch402Options,
    serviceReputation?: number,
  ): Promise<Fetch402Result> {
    this._requireNotDestroyed();
    validateUrl(url, 'url');
    const method = options?.method ?? 'GET';

    // C-1 fix: Wrap budget check + payment + recordSpend in an atomic lock
    // to prevent concurrent async payments from bypassing limits (TOCTOU race).
    return this.budget.acquireBudgetLock(async () => {
      // Pre-flight: only check session-level budget capacity.
      // Reputation-tier per-tx limits are deferred to post-402 when the actual
      // price is known — the pre-flight effectiveMaxAmount ($10 default) would
      // always exceed the unknown-reputation tier limit ($0.10), blocking all
      // payments to unrated services.
      const effectiveMaxAmount = options?.maxAmount ?? 10_000_000n; // DEFAULT_MAX_AMOUNT from x402.ts
      const sessionRemaining = this.budget.getRemaining();
      if (effectiveMaxAmount > sessionRemaining) {
        throw new AzethError(
          `Session budget insufficient: ${effectiveMaxAmount} requested, ${sessionRemaining} remaining`,
          'BUDGET_EXCEEDED',
          { sessionRemaining: sessionRemaining.toString() },
        );
      }

      // Audit #13 M-13 fix: Pre-payment budget tier estimate check.
      // Advisory only — emits event if the maxAmount would exceed the tier limit.
      // The on-chain maxAmount is the hard limit; this gives early UX feedback.
      if (options?.maxAmount && serviceReputation !== undefined) {
        const preTierCheck = this.budget.checkBudget(options.maxAmount, serviceReputation);
        if (!preTierCheck.allowed) {
          await this.events.emit('paymentError', {
            operation: 'budget_tier_pre_check',
            error: new Error(preTierCheck.reason ?? 'Pre-payment tier check: maxAmount may exceed tier limit'),
            context: { url, maxAmount: options.maxAmount.toString(), tier: preTierCheck.tier },
          });
        }
      }

      await this.events.emit('beforePayment', { url, method });

      const startTime = Date.now();
      // Lazily resolve smart account for SIWx identity.
      // Uses cached _smartAccounts if available, otherwise makes one on-chain call
      // to the factory (getAccountsByOwner). Catches gracefully — if no smart account
      // exists yet, SIWx is skipped and the agent pays directly via EOA.
      let smartAccount = this._smartAccounts?.[0];
      if (smartAccount === undefined) {
        try {
          smartAccount = await this.resolveSmartAccount();
        } catch {
          // No smart account found — proceed without SIWx
        }
      }

      // Build smartAccountTransfer callback when smart account + bundler are available.
      // Routes x402 payments through PaymentAgreementModule.pay() to capture
      // protocol fees on-chain. The module validates the transferWithAuth calldata,
      // checks guardian spending limits, executes the payment, and adds the fee.
      // Accept serverUrl as a bundler source — the server proxies bundler requests
      // via its own Pimlico key, so MCP users don't need AZETH_BUNDLER_URL.
      let smartAccountTransfer: SmartAccountTransferCallback | undefined;
      const payModuleAddr = this.addresses.paymentAgreementModule;
      const hasBundler = !!(this._bundlerUrl || this.serverUrl);
      if (smartAccount && hasBundler && payModuleAddr) {
        smartAccountTransfer = async (params) => {
          const sac = await this._getSmartAccountClient(smartAccount);
          const payData = encodeFunctionData({
            abi: PaymentAgreementModuleAbi,
            functionName: 'pay',
            args: [
              getAddress(params.usdcAddress),
              getAddress(params.payTo),
              params.amount,
              params.calldata,
            ],
          });
          return sac.sendTransaction({
            to: getAddress(payModuleAddr),
            value: 0n,
            data: payData,
          });
        };
      }

      let result: Fetch402Result;
      try {
        result = await fetch402(this.publicClient, this.walletClient, this.address, url, {
          ...options,
          smartAccount,
          smartAccountTransfer,
        });
      } catch (err: unknown) {
        await this.events.emit('paymentError', {
          operation: 'fetch402',
          error: err instanceof Error ? err : new Error(String(err)),
          context: { url, method },
        });
        throw err;
      }

      const responseTimeMs = result.responseTimeMs ?? (Date.now() - startTime);

      await this.events.emit('afterPayment', {
        url,
        method,
        paymentMade: result.paymentMade,
        statusCode: result.response.status,
        responseTimeMs,
        amount: result.amount,
        txHash: result.txHash,
        chainId: this.publicClient.chain?.id,
      });

      // Record spending in budget manager (inside lock for atomicity).
      // Post-payment tier check: now that the actual amount is known, validate
      // against reputation-aware tiers. This is advisory — the on-chain maxAmount
      // in fetch402 is the hard limit. We still record the spend either way.
      if (result.paymentMade && result.amount) {
        const tierCheck = this.budget.checkBudget(result.amount, serviceReputation);
        if (!tierCheck.allowed) {
          // Log for observability but don't throw — payment already signed.
          await this.events.emit('paymentError', {
            operation: 'budget_tier_exceeded',
            error: new Error(tierCheck.reason ?? 'Post-payment tier check failed'),
            context: { url, amount: result.amount.toString(), tier: tierCheck.tier },
          });
        }
        this.budget.recordSpend(result.amount, url);
      }

      return result;
    });
  }

  /** Discover, pay, and rate a service in one call.
   *
   *  Given a capability (e.g., "price-feed"), discovers the best-reputation service,
   *  pays for it via x402, falls back to alternatives on failure, and submits
   *  reputation feedback automatically.
   *
   *  Budget lock: Held for the entire retry sequence to prevent concurrent calls
   *  from exhausting budget between retries.
   *
   *  Feedback lifecycle: Feedback is awaited (not fire-and-forget) so that callers
   *  like the MCP tool can safely call destroy() after this method returns without
   *  killing in-flight UserOps. Feedback errors are caught and never propagate.
   *
   *  @param capability - Service capability to discover (e.g., 'price-feed', 'market-data')
   *  @param options - Smart fetch options (minReputation, maxRetries, autoFeedback, etc.)
   */
  async smartFetch402(
    capability: string,
    options?: SmartFetch402Options,
  ): Promise<SmartFetch402Result> {
    this._requireNotDestroyed();

    return this.budget.acquireBudgetLock(async () => {
      // Pre-flight: only check session-level budget capacity.
      // Same rationale as fetch402 — actual amount unknown until 402 response.
      const effectiveMaxAmount = options?.maxAmount ?? 10_000_000n;
      const sessionRemaining = this.budget.getRemaining();
      if (effectiveMaxAmount > sessionRemaining) {
        throw new AzethError(
          `Session budget insufficient: ${effectiveMaxAmount} requested, ${sessionRemaining} remaining`,
          'BUDGET_EXCEEDED',
          { sessionRemaining: sessionRemaining.toString() },
        );
      }

      // Resolve smart account for SIWx identity
      let smartAccount = this._smartAccounts?.[0];
      if (smartAccount === undefined) {
        try {
          smartAccount = await this.resolveSmartAccount();
        } catch {
          // No smart account — proceed without SIWx, feedback will be skipped
        }
      }

      // Build smartAccountTransfer callback — routes through pay() for fee capture
      let smartAccountTransfer: SmartAccountTransferCallback | undefined;
      const payModuleAddr2 = this.addresses.paymentAgreementModule;
      const hasBundler2 = !!(this._bundlerUrl || this.serverUrl);
      if (smartAccount && hasBundler2 && payModuleAddr2) {
        smartAccountTransfer = async (params) => {
          const sac = await this._getSmartAccountClient(smartAccount);
          const payData = encodeFunctionData({
            abi: PaymentAgreementModuleAbi,
            functionName: 'pay',
            args: [
              getAddress(params.usdcAddress),
              getAddress(params.payTo),
              params.amount,
              params.calldata,
            ],
          });
          return sac.sendTransaction({
            to: getAddress(payModuleAddr2),
            value: 0n,
            data: payData,
          });
        };
      }

      const result = await smartFetch402Fn(
        this.publicClient,
        this.walletClient,
        this.address,
        this.serverUrl,
        capability,
        {
          ...options,
          smartAccount,
          smartAccountTransfer,
        },
        this.chainName,
      );

      await this.events.emit('afterPayment', {
        url: result.service.endpoint ?? '',
        method: options?.method ?? 'GET',
        paymentMade: result.paymentMade,
        statusCode: result.response.status,
        responseTimeMs: result.responseTimeMs ?? 0,
        amount: result.amount,
        txHash: result.txHash,
        chainId: this.publicClient.chain?.id,
      });

      // Record spending in budget manager (inside lock for atomicity)
      if (result.paymentMade && result.amount) {
        this.budget.recordSpend(result.amount, result.service.endpoint ?? capability);
      }

      // Reputation feedback — only if we have a smart account and a payment was made.
      // Awaited (not fire-and-forget) so destroy() is safe to call after this returns.
      // Errors are swallowed — feedback must never fail the payment flow.
      const autoFeedback = options?.autoFeedback ?? true;
      if (autoFeedback && result.paymentMade && smartAccount) {
        try {
          const sac = await this._getSmartAccountClient(smartAccount);
          // Submit positive feedback for the successful service
          const feedbackValue = computeFeedbackValue(result.responseTimeMs ?? 0);
          await this._submitSmartFeedback(sac, result.service, feedbackValue, 'quality', 'x402');

          // Submit negative feedback for services that failed during routing
          if (result.failedServices) {
            for (const failed of result.failedServices) {
              await this._submitSmartFeedback(sac, failed.service, FAILURE_PENALTY_VALUE, 'reliability', 'x402');
            }
          }
        } catch {
          // Feedback must never block or fail the payment result
        }
      }

      return result;
    });
  }

  /** Submit reputation feedback for smartFetch402 routing.
   *  Errors are swallowed — this must never fail the payment flow.
   *
   *  opinionURI: empty string (auto-generated opinions have no external URI)
   *  opinionHash: zero bytes32 (no off-chain content to hash)
   */
  private async _submitSmartFeedback(
    smartAccountClient: AzethSmartAccountClient,
    service: RegistryEntry,
    value: number,
    tag1: string,
    tag2: string,
  ): Promise<void> {
    try {
      const opinion: OnChainOpinion = {
        agentId: service.tokenId,
        value: BigInt(value) * 10n ** 18n, // WAD: convert integer rating to 18-decimal
        valueDecimals: 18,                 // WAD: always store in 18-decimal format
        tag1,
        tag2,
        endpoint: service.endpoint ?? '',
        // Auto-generated opinions: no external URI or off-chain content to reference
        opinionURI: '',
        opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      };
      await submitOnChainOpinion(this.publicClient, smartAccountClient, this.addresses, this.address, opinion);
    } catch {
      // Fire-and-forget semantics — never propagate
    }
  }

  /** Pay for an x402-gated service and return parsed response data.
   *
   *  Convenience wrapper around fetch402 that auto-parses the response body.
   *  Returns JSON objects for JSON responses, raw text for others.
   *
   *  @param url - Service URL to fetch and pay for
   *  @param options - Fetch options (method, body, maxAmount, etc.)
   *  @returns PayResult with parsed `data` field
   *
   *  @example
   *  ```typescript
   *  const result = await agent.pay('https://api.example.com/data');
   *  console.log(result.data); // parsed JSON response
   *  ```
   */
  async pay(url: string, options?: Fetch402Options): Promise<PayResult> {
    const result = await this.fetch402(url, options);
    const text = await result.response.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { ...result, data };
  }

  // ──────────────────────────────────────────────
  // Trust registry
  // ──────────────────────────────────────────────

  /** Register on the ERC-8004 trust registry, or update metadata if already registered.
   *
   *  If the smart account is already registered (e.g., via createAccount with registry params),
   *  this method gracefully falls back to updating the metadata fields instead of reverting.
   */
  async publishService(params: RegisterParams): Promise<RegisterResult> {
    this._requireNotDestroyed();
    const account = await this.resolveSmartAccount();
    const smartAccountClient = await this._getSmartAccountClient(account);

    // Check if already registered to avoid AlreadyRegistered revert
    const moduleAddress = this.addresses.trustRegistryModule;
    if (moduleAddress) {
      let isRegistered = false;
      try {
        isRegistered = await this.publicClient.readContract({
          address: moduleAddress,
          abi: TrustRegistryModuleAbi,
          functionName: 'isRegistered',
          args: [account],
        }) as boolean;
      } catch {
        // If check fails, proceed with registration attempt
      }

      if (isRegistered) {
        // Already registered — update metadata instead
        const updates: MetadataUpdate[] = [];
        if (params.name) updates.push({ key: 'name', value: params.name });
        if (params.description) updates.push({ key: 'description', value: params.description });
        if (params.capabilities.length > 0) {
          updates.push({ key: 'capabilities', value: JSON.stringify(params.capabilities) });
        }
        if (params.endpoint) updates.push({ key: 'endpoint', value: params.endpoint });

        let txHash = '0x' as `0x${string}`;
        if (updates.length > 0) {
          txHash = await updateMetadataBatch(
            this.publicClient, smartAccountClient, this.addresses, this.address, updates,
          );
        }

        return { tokenId: 0n, txHash };
      }
    }

    return registerOnRegistry(
      this.publicClient, smartAccountClient, this.addresses, this.address, params,
    );
  }

  /** Discover services by capability and reputation */
  async discoverServices(params: DiscoveryParams): Promise<RegistryEntry[]> {
    // Clamp limit to [1, 100] and offset to >= 0
    const clamped = { ...params };
    if (clamped.limit !== undefined) {
      clamped.limit = Math.max(1, Math.min(100, clamped.limit));
    }
    if (clamped.offset !== undefined) {
      clamped.offset = Math.max(0, clamped.offset);
    }
    return discoverServices(this.serverUrl, clamped);
  }

  /** Update metadata for this account's trust registry entry.
   *
   *  @param key - Metadata key (e.g., 'endpoint', 'description', 'capabilities')
   *  @param value - Metadata value as string (will be hex-encoded internally)
   *  @returns Transaction hash
   */
  async updateServiceMetadata(key: string, value: string): Promise<`0x${string}`> {
    this._requireNotDestroyed();
    const account = await this.resolveSmartAccount();
    const smartAccountClient = await this._getSmartAccountClient(account);
    return updateMetadata(
      this.publicClient, smartAccountClient, this.addresses, this.address, key, value,
    );
  }

  /** Update multiple metadata fields in a single batch transaction.
   *
   *  @param updates - Array of { key, value } pairs to update
   *  @returns Transaction hash of the batch UserOp
   */
  async updateServiceMetadataBatch(updates: MetadataUpdate[]): Promise<`0x${string}`> {
    this._requireNotDestroyed();
    const account = await this.resolveSmartAccount();
    const smartAccountClient = await this._getSmartAccountClient(account);
    return updateMetadataBatch(
      this.publicClient, smartAccountClient, this.addresses, this.address, updates,
    );
  }

  // ──────────────────────────────────────────────
  // Payment agreements
  // ──────────────────────────────────────────────

  /** Create a recurring payment agreement */
  async createPaymentAgreement(params: CreateAgreementParams): Promise<AgreementResult> {
    this._requireNotDestroyed();
    validateAddress(params.payee, 'payee');
    validatePositiveAmount(params.amount, 'amount');
    const account = await this.resolveSmartAccount();
    const smartAccountClient = await this._getSmartAccountClient(account);
    return createPaymentAgreement(
      this.publicClient, smartAccountClient, this.addresses, this.address, params,
    );
  }

  /** Find an active payment agreement with a specific payee.
   *  Searches from newest to oldest, returning the first match.
   *
   *  @param payee - The payee address to search for
   *  @param token - Optional token address to filter by
   *  @returns The first matching active agreement, or null
   */
  async findAgreementWithPayee(
    payee: `0x${string}`,
    token?: `0x${string}`,
  ): Promise<PaymentAgreement | null> {
    validateAddress(payee, 'payee');
    const account = await this.resolveSmartAccount();
    return findAgreementWithPayee(
      this.publicClient, this.addresses, account, payee, token,
    );
  }

  /** Get details of a specific payment agreement */
  async getAgreement(agreementId: bigint, account?: `0x${string}`): Promise<PaymentAgreement> {
    const resolvedAccount = account ?? await this.resolveSmartAccount();
    return getAgreement(this.publicClient, this.addresses, resolvedAccount, agreementId);
  }

  /** Execute a due payment agreement.
   *
   *  Auto-detects own vs foreign account:
   *  - Own account: executes via UserOp from the payer's smart account (self-execution)
   *  - Foreign account: executes as keeper — routes via the caller's own smart account
   *    or falls back to direct EOA call if the caller has no smart account
   */
  async executeAgreement(agreementId: bigint, account?: `0x${string}`): Promise<`0x${string}`> {
    this._requireNotDestroyed();
    const resolvedAccount = account ?? await this.resolveSmartAccount();

    // Check if this is our own account or a foreign one
    const ownAccounts = await this.getSmartAccounts();
    const isOwnAccount = ownAccounts.some(
      (a) => a.toLowerCase() === resolvedAccount.toLowerCase(),
    );

    if (isOwnAccount) {
      // Self-execution: build UserOp from the payer's own smart account
      const smartAccountClient = await this._getSmartAccountClient(resolvedAccount);
      return executeAgreement(
        this.publicClient, smartAccountClient, this.addresses, resolvedAccount, agreementId,
      );
    }

    // Keeper execution: the resolved account belongs to someone else.
    // Route via the caller's own smart account if available, else direct EOA.
    let keeperSmartAccountClient: AzethSmartAccountClient | null = null;
    if (ownAccounts.length > 0) {
      keeperSmartAccountClient = await this._getSmartAccountClient(ownAccounts[0]);
    }

    return executeAgreementAsKeeper(
      this.publicClient,
      keeperSmartAccountClient,
      this.walletClient,
      this.addresses,
      resolvedAccount,
      agreementId,
    );
  }

  /** Cancel an active payment agreement. Only the payer can cancel.
   *  @param account - Optional: specific smart account that owns the agreement (defaults to first)
   */
  async cancelAgreement(agreementId: bigint, account?: `0x${string}`): Promise<`0x${string}`> {
    this._requireNotDestroyed();
    const resolvedAccount = account ?? await this.resolveSmartAccount();
    const smartAccountClient = await this._getSmartAccountClient(resolvedAccount);
    return cancelAgreementFn(
      this.publicClient, smartAccountClient, this.addresses, agreementId,
    );
  }

  /** Get the total number of agreements for an account */
  async getAgreementCount(account?: `0x${string}`): Promise<bigint> {
    const resolvedAccount = account ?? await this.resolveSmartAccount();
    return getAgreementCountFn(this.publicClient, this.addresses, resolvedAccount);
  }

  /** Check if a payment agreement can be executed right now */
  async canExecutePayment(
    agreementId: bigint,
    account?: `0x${string}`,
  ): Promise<{ executable: boolean; reason: string }> {
    const resolvedAccount = account ?? await this.resolveSmartAccount();
    return canExecutePaymentFn(this.publicClient, this.addresses, resolvedAccount, agreementId);
  }

  /** Get the next execution timestamp for a payment agreement */
  async getNextExecutionTime(
    agreementId: bigint,
    account?: `0x${string}`,
  ): Promise<bigint> {
    const resolvedAccount = account ?? await this.resolveSmartAccount();
    return getNextExecutionTimeFn(this.publicClient, this.addresses, resolvedAccount, agreementId);
  }

  /** Get comprehensive agreement data in a single RPC call.
   *  Combines agreement details + executability + isDue + nextExecutionTime + count. */
  async getAgreementData(
    agreementId: bigint,
    account?: `0x${string}`,
  ): Promise<{
    agreement: PaymentAgreement;
    executable: boolean;
    reason: string;
    isDue: boolean;
    nextExecutionTime: bigint;
    count: bigint;
  }> {
    const resolvedAccount = account ?? await this.resolveSmartAccount();
    return getAgreementDataFn(this.publicClient, this.addresses, resolvedAccount, agreementId);
  }

  // ──────────────────────────────────────────────
  // Reputation
  // ──────────────────────────────────────────────

  /** Submit a reputation opinion for an agent via the ReputationModule.
   *
   *  Accepts either full OnChainOpinion params or simplified SimpleOpinion with a rating.
   *  Requires a positive net USD payment from this account to the target agent.
   *
   *  @example Simplified:
   *  ```typescript
   *  await agent.submitOpinion({
   *    serviceTokenId: service.tokenId,
   *    rating: 85,        // -100 to 100
   *    tag1: 'quality',   // optional
   *  });
   *  ```
   *
   *  @example Full control:
   *  ```typescript
   *  await agent.submitOpinion({
   *    agentId: 1024n,
   *    value: 85n * 10n**18n,
   *    valueDecimals: 18,
   *    tag1: 'quality', tag2: 'x402',
   *    endpoint: 'https://...', opinionURI: '', opinionHash: '0x...',
   *  });
   *  ```
   */
  async submitOpinion(opinion: OnChainOpinion | SimpleOpinion): Promise<`0x${string}`> {
    this._requireNotDestroyed();

    let fullOpinion: OnChainOpinion;
    if ('agentId' in opinion) {
      fullOpinion = opinion;
    } else {
      if (opinion.rating < -100 || opinion.rating > 100) {
        throw new AzethError('Rating must be between -100 and 100', 'INVALID_INPUT', { field: 'rating' });
      }
      fullOpinion = {
        agentId: opinion.serviceTokenId,
        value: BigInt(Math.round(opinion.rating * 1e18)),
        valueDecimals: 18,
        tag1: opinion.tag1 ?? 'quality',
        tag2: opinion.tag2 ?? '',
        endpoint: opinion.endpoint ?? '',
        opinionURI: '',
        opinionHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
      };
    }

    const account = await this.resolveSmartAccount();
    const smartAccountClient = await this._getSmartAccountClient(account);
    return submitOnChainOpinion(
      this.publicClient, smartAccountClient, this.addresses, this.address, fullOpinion,
    );
  }

  /** Get payment-weighted reputation for an agent.
   *
   *  @param agentId - Target agent's ERC-8004 token ID
   *  @param raters - Optional list of rater addresses. If omitted, defaults to empty array.
   */
  async getWeightedReputation(
    agentId: bigint,
    raters?: `0x${string}`[],
  ): Promise<WeightedReputation> {
    return getWeightedRep(
      this.publicClient, this.addresses, agentId, raters ?? [],
    );
  }

  /** Get the net payment between this account and a counterparty.
   *
   *  - **No token** (default): Returns total net paid in 18-decimal USD, aggregated across
   *    all tokens via the on-chain oracle. Always >= 0. This is what the contract uses
   *    to gate reputation opinions.
   *  - **With token**: Returns the signed per-token delta. Positive means this account
   *    has paid more; negative means the counterparty has paid more.
   *
   *  @param counterparty - The other account address
   *  @param token - Optional token address. Omit for total USD. Use 0x0 for native ETH.
   */
  async getNetPaid(counterparty: `0x${string}`, token?: `0x${string}`): Promise<bigint> {
    if (token) {
      return getNetPaidFn(
        this.publicClient, this.addresses, this.address, counterparty, token,
      );
    }
    return getTotalNetPaidUSDFn(
      this.publicClient, this.addresses, this.address, counterparty,
    );
  }

  /** Get active opinion state for this account's opinion on an agent.
   *
   *  @param agentId - Target agent's ERC-8004 token ID
   *  @param account - Smart account address to query. Defaults to first smart account.
   *  @returns Active opinion index and existence flag
   */
  async getActiveOpinion(agentId: bigint, account?: `0x${string}`): Promise<ActiveOpinion> {
    const smartAccount = account ?? await this.resolveSmartAccount();
    return getActiveOpinionFn(
      this.publicClient, this.addresses, smartAccount, agentId,
    );
  }

  /** Read a single opinion entry from the on-chain registry */
  async readOpinion(
    agentId: bigint,
    clientAddress: `0x${string}`,
    opinionIndex: bigint,
  ): Promise<OpinionEntry> {
    return readOnChainOpinion(
      this.publicClient, this.chainName, agentId, clientAddress, opinionIndex,
    );
  }

  // ──────────────────────────────────────────────
  // Messaging
  // ──────────────────────────────────────────────

  /** Send an encrypted message via XMTP.
   *
   *  Lazy-initializes the XMTP client on first call.
   *
   *  @param params - Message parameters (to, content)
   *  @returns The conversation ID
   */
  async sendMessage(params: SendMessageParams): Promise<string> {
    this._requireNotDestroyed();
    validateAddress(params.to, 'to');
    const client = await this._ensureMessaging();
    return client.sendMessage(params);
  }

  /** Listen for incoming XMTP messages.
   *
   *  The handler is registered immediately. If the XMTP client has not been
   *  initialized yet, it will be initialized asynchronously when the first
   *  handler is registered.
   *
   *  @param handler - Async function called for each incoming message
   *  @returns Unsubscribe function
   */
  onMessage(handler: MessageHandler): () => void {
    this._requireNotDestroyed();
    const client = this._getOrCreateMessaging();
    const unsub = client.onMessage(handler);

    // Kick off initialization if not already started
    if (!client.isReady()) {
      void this._ensureMessaging();
    }

    return unsub;
  }

  /** Check if an address is reachable on the XMTP network.
   *
   *  @param address - Ethereum address to check
   *  @returns Whether the address can receive XMTP messages
   */
  async canReach(address: `0x${string}`): Promise<boolean> {
    validateAddress(address, 'address');
    const client = await this._ensureMessaging();
    return client.canReach(address);
  }

  /** List active XMTP conversations.
   *
   *  Lazy-initializes the XMTP client on first call.
   *
   *  @returns Array of conversation summaries with peer address and creation time
   */
  async getConversations(): Promise<XMTPConversation[]> {
    this._requireNotDestroyed();
    const client = await this._ensureMessaging();
    return client.getConversations();
  }

  /** Read recent messages from a conversation with a peer.
   *
   *  @param peerAddress - Ethereum address of the conversation peer
   *  @param limit - Max messages to return (default 20, max 100)
   *  @returns Array of messages sorted by timestamp
   */
  async getMessages(peerAddress: `0x${string}`, limit?: number): Promise<XMTPMessage[]> {
    this._requireNotDestroyed();
    validateAddress(peerAddress, 'peerAddress');
    const client = await this._ensureMessaging();
    return client.getMessagesByPeer(peerAddress, limit);
  }

  // ──────────────────────────────────────────────
  // Auth helpers
  // ──────────────────────────────────────────────

  /** Get a fetch function that automatically adds ERC-8128 auth headers */
  getSignedFetch(): typeof fetch {
    return createSignedFetch(this.walletClient, this.address);
  }

  // ──────────────────────────────────────────────
  // Cleanup
  // ──────────────────────────────────────────────

  /** Clean up resources (XMTP agent, timers, etc.) and zero sensitive material.
   *  IMPORTANT: Call this when done with the AzethKit instance to zero private key
   *  bytes from memory. Use in a try/finally block for safety. */
  async destroy(): Promise<void> {
    this._destroyed = true;
    this.events.removeAllListeners();
    if (this._messaging) {
      await this._messaging.destroy();
      this._messaging = null;
      this._messagingInitPromise = null;
    }
    // H-2 fix: Zero the private key bytes in-place (Uint8Array.fill mutates the buffer)
    this._privateKeyBytes.fill(0);
    // H-6 fix (Audit #8): walletClient retains its own internal copy of the key.
    // Nulling it ensures subsequent calls throw rather than silently succeeding.
    // Note: JS strings are immutable and cannot be reliably zeroed — zeroing of
    // _privateKeyBytes is best-effort defense-in-depth, not a guarantee.
    (this as Record<string, unknown>)['walletClient'] = null;
  }

  // ──────────────────────────────────────────────
  // Private
  // ──────────────────────────────────────────────

  /** Get or create a SmartAccountClient for a specific smart account address.
   *
   *  Uses permissionless's createSmartAccountClient with a custom viem SmartAccount
   *  implementation that routes all state-changing calls through ERC-4337 UserOperations.
   *
   *  Lazily created and cached per smart account address.
   */
  private async _getSmartAccountClient(smartAccountAddress: `0x${string}`): Promise<AzethSmartAccountClient> {
    const key = smartAccountAddress.toLowerCase();
    const cached = this._smartAccountClients.get(key);
    if (cached) return cached;

    const client = await createAzethSmartAccountClient({
      publicClient: this.publicClient,
      walletClient: this.walletClient,
      smartAccountAddress,
      bundlerUrl: this._bundlerUrl,
      paymasterUrl: this._paymasterUrl,
      paymasterPolicy: this._paymasterPolicy,
      // Only pass guardian key for auto-signing when explicitly enabled.
      // When guardianAutoSign is false, operations exceeding limits will require
      // interactive approval (XMTP) rather than being auto-signed.
      guardianKey: this._guardianAutoSign ? this._guardianKey : undefined,
      // Pass serverUrl so the bundler URL resolution can fall back to the
      // Azeth server's bundler proxy on testnet (zero-friction onboarding).
      serverUrl: this.serverUrl,
    });

    this._smartAccountClients.set(key, client);
    return client;
  }

  /** Get or create the XMTPClient instance (without initialization) */
  private _getOrCreateMessaging(): XMTPClient {
    if (!this._messaging) {
      this._messaging = new XMTPClient();
    }
    return this._messaging;
  }

  /** Ensure the XMTP client is initialized. Returns the ready client. */
  private async _ensureMessaging(): Promise<XMTPClient> {
    // MEDIUM-7 fix: Prevent using zeroed private key after destroy()
    if (this._destroyed) {
      throw new AzethError('AzethKit has been destroyed — cannot initialize messaging', 'INVALID_INPUT');
    }

    const client = this._getOrCreateMessaging();

    if (client.isReady()) return client;

    // Deduplicate concurrent init calls
    if (!this._messagingInitPromise) {
      this._messagingInitPromise = client.initialize(
        bytesToHex(this._privateKeyBytes) as `0x${string}`,
        this._xmtpConfig,
      );
    }

    await this._messagingInitPromise;
    return client;
  }
}
