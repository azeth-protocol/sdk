// @azeth/sdk — Trust Infrastructure for the Machine Economy

export { AzethKit, type AzethKitConfig } from './client.js';

// Account operations
export { type CreateAccountParams, type CreateAccountResult } from './account/create.js';
export { type BalanceResult } from './account/balance.js';
export { getAllBalances } from './account/balance.js';
export { type TransferParams, type TransferResult } from './account/transfer.js';
export { type DepositParams, type DepositResult } from './account/deposit.js';
export { type HistoryParams, type TransactionRecord } from './account/history.js';
export { setTokenWhitelist, setProtocolWhitelist } from './account/guardian.js';

// Guardian approval protocol (XMTP-based co-signature flow)
export type {
  GuardianApprovalRequest,
  GuardianApprovalResponse,
  PendingApproval,
  GuardianApprovalResult,
} from './account/guardian-approval.js';
export {
  requestGuardianApproval,
  getPendingApproval,
  getAllPendingApprovals,
  clearExpiredApprovals,
  checkForGuardianResponse,
  tryParseGuardianRequest,
  tryParseGuardianResponse,
} from './account/guardian-approval.js';

// Registry operations
export { buildAgentURI, updateMetadata, updateMetadataBatch, type RegisterParams, type RegisterResult, type MetadataUpdate } from './registry/register.js';
export {
  discoverServices,
  getRegistryEntry,
  discoverServicesWithFallback,
  type DiscoveryWithFallbackResult,
  type DiscoveryFallbackOptions,
} from './registry/discover.js';

// Reputation operations
export {
  submitOpinion,
  getWeightedReputation,
  getWeightedReputationAll,
  getNetPaid,
  getTotalNetPaidUSD,
  getActiveOpinion,
  readOpinion,
  getReputationModuleAddress,
} from './reputation/opinion.js';

// Payment operations
export { type Fetch402Options, type Fetch402Result, verifySettlementReceipt } from './payments/x402.js';
export {
  type CreateAgreementParams,
  type AgreementResult,
  findAgreementWithPayee,
  cancelAgreement,
  executeAgreementAsKeeper,
  getAgreementCount,
  canExecutePayment,
  getNextExecutionTime,
  isAgreementExecutable,
  getAgreementData,
} from './payments/agreements.js';
export {
  smartFetch402,
  computeFeedbackValue,
  FAILURE_PENALTY_VALUE,
  type SmartFetch402Options,
  type SmartFetch402Result,
} from './payments/smart-fetch.js';

// Budget management
export {
  BudgetManager,
  reputationToScore,
  DEFAULT_BUDGET_TIERS,
  type BudgetConfig,
  type BudgetTier,
  type BudgetCheckResult,
} from './payments/budget.js';

// Event system
export {
  AzethEventEmitter,
  type AzethEventName,
  type AzethEventListener,
  type AzethEventMap,
  type PaymentEventData,
  type PaymentResultData,
  type TransferEventData,
  type TransferResultData,
  type DepositEventData,
  type DepositResultData,
  type ErrorEventData,
} from './events/emitter.js';

// ERC-4337 UserOp execution (smart account client)
export { createAzethSmartAccountClient, createAzethSmartAccount, type AzethSmartAccountClient } from './utils/userop.js';

// Paymaster (gas sponsorship)
export { type PaymasterPolicy, type PaymasterMiddleware } from './utils/paymaster.js';

// ERC-7579 execution encoding
export { encodeSimpleSingle, encodeSimpleBatch, encodeSingleExecution, encodeBatchExecution } from './utils/execution.js';

// Contract error decoding
export { decodeContractError, wrapContractError } from './utils/errors.js';

// Address resolution
export { resolveAddresses, requireAddress } from './utils/addresses.js';

// Auth
export { signRequest, buildAuthHeader, createSignedFetch } from './auth/erc8128.js';

// Messaging
export { XMTPClient, type SendMessageParams, type MessagingClient } from './messaging/xmtp.js';
export { RateLimiter } from './messaging/rate-limiter.js';
export { MessageRouter } from './messaging/message-router.js';

// Re-export common types for convenience
export type {
  AzethContractAddresses,
  TokenBalanceUSD,
  AccountBalanceUSD,
  AggregatedBalanceResult,
  ParticipantIdentity,
  EntityType,
  Guardrails,
  RegistryEntry,
  DiscoveryParams,
  ReputationScore,
  ReputationFeedback,
  OnChainOpinion,
  OnChainFeedback,
  WeightedReputation,
  ActiveOpinion,
  ActiveFeedback,
  PaymentDelta,
  OpinionEntry,
  FeedbackEntry,
  X402PaymentRequirement,
  PaymentAgreement,
  XMTPMessage,
  MessageHandler,
  XMTPConfig,
  XMTPConversation,
  StructuredMessage,
  ServiceRequest,
  ServiceInquiry,
  ServiceResponse,
  CapabilitiesResponse,
  ServiceDetail,
  ServiceDetailsResponse,
  MessageContext,
  FriendRequest,
  FriendAccept,
  ErrorResponse,
  AckResponse,
  ServiceHandler,
  SkillDefinition,
  MessageRouterOptions,
} from '@azeth/common';
