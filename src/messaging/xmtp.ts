import crypto from 'node:crypto';
import {
  AzethError,
  type XMTPMessage,
  type XMTPConfig,
  type XMTPConversation,
  type MessageHandler,
} from '@azeth/common';
import { RateLimiter } from './rate-limiter.js';
import type { MessageRouter } from './message-router.js';

// Re-export types used by consumers
export type { XMTPConfig, XMTPConversation };

/** Parameters for sending a message via XMTP */
export interface SendMessageParams {
  /** Recipient Ethereum address */
  to: `0x${string}`;
  /** Message content (text) */
  content: string;
  /** Content type hint (default: 'text/plain') */
  contentType?: string;
}

/** Interface for the XMTP messaging client */
export interface MessagingClient {
  /** Initialize the client with a private key and optional config */
  initialize(privateKey: `0x${string}`, config?: XMTPConfig): Promise<void>;
  /** Send a message to an Ethereum address. Returns the conversation ID. */
  sendMessage(params: SendMessageParams): Promise<string>;
  /** Register a handler for incoming messages. Returns an unsubscribe function. */
  onMessage(handler: MessageHandler): () => void;
  /** Check if an address is reachable on the XMTP network */
  canReach(address: `0x${string}`): Promise<boolean>;
  /** List active conversations */
  getConversations(): Promise<XMTPConversation[]>;
  /** Whether the client has been successfully initialized */
  isReady(): boolean;
  /** Tear down the client, stopping the agent and clearing state */
  destroy(): Promise<void>;
}

/** Cached reachability result with expiry timestamp */
interface ReachabilityEntry {
  reachable: boolean;
  expiresAt: number;
}

/** XMTP messaging client backed by @xmtp/agent-sdk.
 *
 *  Provides E2E encrypted agent-to-agent messaging via the XMTP network.
 *  Messages are rate-limited per sender and reachability results are cached.
 */
export class XMTPClient implements MessagingClient {
  // We use `any` for the agent SDK types because they are imported dynamically
  // and declaring full type stubs would be fragile. The public API is fully typed.
  private _agent: { // eslint-disable-line @typescript-eslint/no-explicit-any
    client: {
      inboxId: string;
      canMessage: (identifiers: Array<{ identifier: string; identifierKind: number }>) => Promise<Map<string, boolean>>;
      conversations: {
        syncAll: (consentStates?: number[]) => Promise<void>;
        list: (opts?: { consentStates?: number[] }) => Promise<Array<{
          id: string;
          createdAt: Date;
          peerInboxId: string;
          messages: (opts?: { limit?: number }) => Promise<Array<{
            content: unknown;
            senderInboxId: string;
            sentAtNs: bigint;
          }>>;
        }>>;
        streamAllMessages: () => Promise<AsyncIterable<{
          content: unknown;
          senderInboxId: string;
          conversationId: string;
          sentAtNs: bigint;
        }>>;
        stream: () => Promise<AsyncIterable<{ sync: () => Promise<void> }>>;
      };
    };
    address: string;
    createDmWithAddress: (address: `0x${string}`) => Promise<{
      id: string;
      sendText: (text: string) => Promise<string>;
    }>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    on: (event: string, handler: (...args: unknown[]) => void) => void;
  } | null = null;

  /** Static Client class from @xmtp/agent-sdk, used for fetchInboxStates.
   *  The Agent's client instance doesn't expose this method, so we use the static version. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _ClientClass: { fetchInboxStates: (inboxIds: string[], env?: string) => Promise<Array<{ inboxId: string; identifiers: Array<{ identifier: string; identifierKind: number }> }>> } | null = null;
  private _xmtpEnv: string = 'production';

  private _handlers: MessageHandler[] = [];
  private _rateLimiter: RateLimiter | null = null;
  private _reachabilityCache: Map<string, ReachabilityEntry> = new Map();
  private _reachabilityCacheTtlMs: number = 300_000; // 5 minutes default
  private _maxMessageLength: number = 10_000;
  private _ready = false;
  private _listening = false;
  private _messageStreamAbort: (() => void) | null = null;
  private _convStreamAbort: (() => void) | null = null;
  private _messageRouter: MessageRouter | null = null;
  private _autoReply = false;

  /** Initialize the XMTP client with a private key.
   *
   *  Creates an XMTP Agent using the provided private key and config.
   *  Must be called before any messaging operations.
   *
   *  @param privateKey - Owner's private key (0x-prefixed hex)
   *  @param config - Optional XMTP configuration
   *  @throws AzethError if initialization fails
   */
  async initialize(privateKey: `0x${string}`, config?: XMTPConfig): Promise<void> {
    if (this._ready) return;

    // Dynamic import of @xmtp/agent-sdk to keep it optional at load time
    let Agent: unknown;
    let ClientClass: typeof this._ClientClass;
    let createUser: (key: `0x${string}`) => { account: { address: string } };
    let createSigner: (user: { account: { address: string } }) => unknown;
    try {
      const sdk = await import('@xmtp/agent-sdk');
      Agent = sdk.Agent;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ClientClass = sdk.Client as any;
      createUser = sdk.createUser as typeof createUser;
      createSigner = sdk.createSigner as typeof createSigner;
    } catch {
      throw new AzethError(
        'XMTP Agent SDK not installed. Run: pnpm add @xmtp/agent-sdk',
        'INVALID_INPUT',
      );
    }

    const user = createUser(privateKey);
    const signer = createSigner(user);

    // Resolve encryption key: config -> generate
    let dbEncryptionKey: Uint8Array;
    if (config?.dbEncryptionKey) {
      const hex = config.dbEncryptionKey.replace(/^0x/, '');
      if (hex.length !== 64) {
        throw new AzethError(
          'dbEncryptionKey must be exactly 32 bytes (64 hex chars)',
          'INVALID_INPUT',
          { field: 'dbEncryptionKey' },
        );
      }
      dbEncryptionKey = Buffer.from(hex, 'hex');
    } else {
      // MEDIUM-7 (Audit): Auto-generating a random encryption key. The XMTP local database
      // will be encrypted with this ephemeral key. On process restart, the key is lost and
      // the database becomes unreadable — all XMTP conversation history and group state will
      // be inaccessible. For persistent messaging, always provide config.dbEncryptionKey.
      console.warn(
        '[XMTPClient] No dbEncryptionKey provided — auto-generating ephemeral key. '
        + 'XMTP message history will be LOST on restart. Set dbEncryptionKey for persistence.',
      );
      dbEncryptionKey = crypto.randomBytes(32);
    }

    const env = config?.env ?? 'production';
    const dbPath = config?.dbPath ?? null;

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this._agent = await (Agent as any).create(signer, {
        env,
        dbPath,
        dbEncryptionKey,
      });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Sanitize XMTP-internal identifiers (InboxIDs, hex hashes) from error messages
      const sanitizedMsg = msg.replace(/[0-9a-fA-F]{32,}/g, '[redacted-id]');
      throw new AzethError(
        `XMTP client creation failed: ${sanitizedMsg}`,
        'NETWORK_ERROR',
        { cause: 'xmtp', originalError: e instanceof Error ? e.name : undefined },
      );
    }

    // Store Client class + env for static fetchInboxStates calls
    this._ClientClass = ClientClass ?? null;
    this._xmtpEnv = env;

    // Apply config
    this._reachabilityCacheTtlMs = config?.reachabilityCacheTtlMs ?? 300_000;
    this._maxMessageLength = config?.maxMessageLength ?? 10_000;
    this._rateLimiter = new RateLimiter(config?.rateLimitPerMinute ?? 10);
    this._autoReply = config?.autoReply ?? false;
    this._ready = true;
  }

  /** Send a text message to an Ethereum address.
   *
   *  Checks reachability, creates or finds a DM conversation, then sends.
   *
   *  @param params - Message parameters (to, content, contentType)
   *  @returns The conversation ID
   *  @throws AzethError if the recipient is unreachable, content exceeds limits, or sending fails
   */
  async sendMessage(params: SendMessageParams): Promise<string> {
    this._requireReady();

    if (params.content.length > this._maxMessageLength) {
      throw new AzethError(
        `Message content exceeds maximum length of ${this._maxMessageLength} characters`,
        'INVALID_INPUT',
        { field: 'content', maxLength: this._maxMessageLength },
      );
    }

    const reachable = await this.canReach(params.to);
    if (!reachable) {
      throw new AzethError(
        `Recipient ${params.to} is not reachable on the XMTP network`,
        'RECIPIENT_UNREACHABLE',
        { address: params.to },
      );
    }

    try {
      const dm = await this._agent!.createDmWithAddress(params.to);
      await dm.sendText(params.content);
      return dm.id;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Sanitize XMTP-internal identifiers (InboxIDs, hex hashes) from error messages
      const sanitizedMsg = msg.replace(/[0-9a-fA-F]{32,}/g, '[redacted-id]');
      throw new AzethError(
        `Failed to send XMTP message: ${sanitizedMsg}`,
        'NETWORK_ERROR',
        { cause: 'xmtp', originalError: e instanceof Error ? e.name : undefined },
      );
    }
  }

  /** Register a handler for incoming messages.
   *
   *  Starts the agent's message listener on first handler registration.
   *  Returns an unsubscribe function that removes the handler.
   *
   *  @param handler - Async function called for each incoming message
   *  @returns Unsubscribe function
   */
  onMessage(handler: MessageHandler): () => void {
    this._handlers.push(handler);

    if (!this._listening && this._ready) {
      this._startListening();
    }

    return () => {
      this._handlers = this._handlers.filter(h => h !== handler);
    };
  }

  /** Check if an Ethereum address is reachable on the XMTP network.
   *
   *  Results are cached with a configurable TTL (default 5 minutes).
   *  Returns `false` on errors rather than throwing.
   *
   *  @param address - Ethereum address to check
   *  @returns Whether the address can receive XMTP messages
   */
  async canReach(address: `0x${string}`): Promise<boolean> {
    if (!this._ready || !this._agent) return false;

    const key = address.toLowerCase();
    const cached = this._reachabilityCache.get(key);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.reachable;
    }

    try {
      const identifier = { identifier: key, identifierKind: 0 as const };
      const results = await this._agent.client.canMessage([identifier]);
      const reachable = results.get(key) ?? results.get(address) ?? false;

      this._reachabilityCache.set(key, {
        reachable,
        expiresAt: Date.now() + this._reachabilityCacheTtlMs,
      });

      return reachable;
    } catch {
      return false;
    }
  }

  /** List active XMTP conversations.
   *
   *  @returns Array of conversation summaries
   */
  async getConversations(): Promise<XMTPConversation[]> {
    if (!this._ready || !this._agent) return [];

    try {
      // Include Unknown (0) + Allowed (1) consent states so new incoming DMs are visible.
      // Without this, only Allowed conversations appear and new contacts are invisible.
      const consentStates = [0, 1]; // Unknown, Allowed
      await this._agent.client.conversations.syncAll(consentStates);
      const conversations = await this._agent.client.conversations.list({ consentStates });

      const results: XMTPConversation[] = [];
      for (const conv of conversations) {
        const peerAddress = await this._extractPeerAddress(conv);
        results.push({
          id: conv.id,
          peerAddress,
          createdAt: conv.createdAt.getTime(),
        });
      }
      return results;
    } catch {
      return [];
    }
  }

  /** Read recent messages from a specific conversation.
   *
   *  Syncs conversations first, then fetches messages from the conversation
   *  matching the given ID. Returns messages sorted by timestamp (newest first).
   *
   *  @param conversationId - The XMTP conversation ID to read from
   *  @param limit - Maximum number of messages to return (default 20, max 100)
   *  @returns Array of messages with sender, content, and timestamp
   */
  async getMessages(
    conversationId: string,
    limit: number = 20,
  ): Promise<XMTPMessage[]> {
    if (!this._ready || !this._agent) return [];

    const clampedLimit = Math.max(1, Math.min(100, limit));

    try {
      const consentStates = [0, 1]; // Unknown + Allowed
      await this._agent.client.conversations.syncAll(consentStates);
      const conversations = await this._agent.client.conversations.list({ consentStates });
      const conv = conversations.find(c => c.id === conversationId);
      if (!conv) return [];

      // Fetch more than requested to compensate for filtered internal messages
      const rawMessages = await conv.messages({ limit: clampedLimit + 10 });

      // Filter out XMTP internal messages (group membership events, etc.)
      // Only include messages with string content (actual user text).
      const textMessages = rawMessages.filter(msg => typeof msg.content === 'string');

      // Batch-resolve sender inbox IDs to Ethereum addresses
      const uniqueSenders = [...new Set(
        textMessages.map(m => m.senderInboxId).filter(Boolean),
      )];
      const senderMap = new Map<string, string>();
      if (uniqueSenders.length > 0 && this._ClientClass) {
        try {
          const states = await this._ClientClass.fetchInboxStates(
            uniqueSenders, this._xmtpEnv,
          );
          for (let i = 0; i < states.length; i++) {
            const state = states[i];
            if (state?.identifiers) {
              for (const id of state.identifiers) {
                if (id.identifierKind === 0 && id.identifier) {
                  senderMap.set(uniqueSenders[i]!, id.identifier);
                  break;
                }
              }
            }
          }
        } catch { /* resolution failed — fall back to inbox IDs */ }
      }

      return textMessages.slice(0, clampedLimit).map(msg => ({
        sender: senderMap.get(msg.senderInboxId) ?? msg.senderInboxId ?? 'unknown',
        content: msg.content as string,
        contentType: 'text/plain',
        timestamp: Number(msg.sentAtNs / 1_000_000n), // ns -> ms
        conversationId,
      } satisfies XMTPMessage));
    } catch {
      return [];
    }
  }

  /** Read recent messages from a conversation with a specific peer address.
   *
   *  Convenience method that finds the conversation by peer address
   *  and reads messages from it.
   *
   *  @param peerAddress - The Ethereum address of the conversation peer
   *  @param limit - Maximum number of messages to return (default 20, max 100)
   *  @returns Array of messages, or empty array if no conversation found
   */
  async getMessagesByPeer(
    peerAddress: `0x${string}`,
    limit: number = 20,
  ): Promise<XMTPMessage[]> {
    const conversations = await this.getConversations();
    const conv = conversations.find(
      c => c.peerAddress.toLowerCase() === peerAddress.toLowerCase(),
    );
    if (!conv) return [];
    return this.getMessages(conv.id, limit);
  }

  /** Whether the client has been successfully initialized and is ready */
  isReady(): boolean {
    return this._ready;
  }

  /** Attach a MessageRouter for structured message dispatch.
   *
   *  When a router is set and autoReply is enabled (via XMTPConfig or by
   *  setting autoReply=true here), incoming messages are automatically
   *  routed through the router and responses sent back to the sender.
   *
   *  @param router - The MessageRouter instance to use for dispatch
   *  @param autoReply - Enable auto-reply (default: uses config value)
   */
  setRouter(router: MessageRouter, autoReply?: boolean): void {
    this._messageRouter = router;
    if (autoReply !== undefined) {
      this._autoReply = autoReply;
    }
  }

  /** Tear down the XMTP client.
   *
   *  Stops the agent, clears all handlers, caches, and timers.
   */
  async destroy(): Promise<void> {
    this._ready = false;
    this._listening = false;

    if (this._messageStreamAbort) {
      this._messageStreamAbort();
      this._messageStreamAbort = null;
    }

    if (this._convStreamAbort) {
      this._convStreamAbort();
      this._convStreamAbort = null;
    }

    if (this._agent) {
      try {
        await this._agent.stop();
      } catch {
        // Best-effort cleanup
      }
      this._agent = null;
    }

    this._handlers = [];
    this._reachabilityCache.clear();
    this._messageRouter = null;
    this._autoReply = false;

    if (this._rateLimiter) {
      this._rateLimiter.destroy();
      this._rateLimiter = null;
    }
  }

  // ── Private ──────────────────────────────────────

  private _requireReady(): void {
    if (!this._ready || !this._agent) {
      throw new AzethError(
        'XMTP client not initialized. Call initialize() first.',
        'INVALID_INPUT',
      );
    }
  }

  /** Start streaming incoming messages and new conversations */
  private _startListening(): void {
    if (this._listening || !this._agent) return;
    this._listening = true;

    const agent = this._agent;
    let abortMessages = false;
    let abortConvs = false;

    this._messageStreamAbort = () => { abortMessages = true; };
    this._convStreamAbort = () => { abortConvs = true; };

    // Stream all messages from existing conversations
    void (async () => {
      try {
        await agent.client.conversations.syncAll([0, 1]); // Unknown + Allowed
        const stream = await agent.client.conversations.streamAllMessages();
        for await (const message of stream) {
          if (abortMessages) break;
          // Skip our own messages
          if (message.senderInboxId === agent.client.inboxId) continue;
          await this._handleIncoming(message);
        }
      } catch (err: unknown) {
        if (!abortMessages) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error('[XMTPClient] Message stream error:', msg);
          this._listening = false;
        }
      }
    })();

    // Stream new conversations to pick up first messages from new contacts
    void (async () => {
      try {
        const stream = await agent.client.conversations.stream();
        for await (const conv of stream) {
          if (abortConvs) break;
          await conv.sync();
        }
      } catch (err: unknown) {
        if (!abortConvs) {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          console.error('[XMTPClient] Conversation stream error:', msg);
        }
      }
    })();
  }

  /** Process a single incoming message from the stream */
  private async _handleIncoming(message: {
    content: unknown;
    senderInboxId: string;
    conversationId: string;
    sentAtNs: bigint;
  }): Promise<void> {
    // Skip XMTP internal messages (group membership events, etc.)
    if (typeof message.content !== 'string') return;

    const content = message.content;

    // Audit #10: Drop oversized messages to prevent memory exhaustion
    const MAX_MESSAGE_SIZE = 65_536; // 64KB
    if (content.length > MAX_MESSAGE_SIZE) {
      return;
    }

    // Rate limit per sender inbox ID
    if (this._rateLimiter && !this._rateLimiter.checkLimit(message.senderInboxId)) {
      return;
    }

    // XMTPMessage.sender is typed as `string` to accommodate XMTP inbox IDs
    // which are not necessarily valid Ethereum addresses.
    const sender = message.senderInboxId ?? 'unknown';

    const xmtpMessage: XMTPMessage = {
      sender,
      content,
      contentType: 'text/plain',
      timestamp: Number(message.sentAtNs / 1_000_000n), // ns -> ms
      conversationId: message.conversationId,
    };

    for (const handler of this._handlers) {
      try {
        await handler(xmtpMessage);
      } catch {
        // Individual handler errors should not crash the stream
      }
    }

    // Auto-reply via router if enabled
    if (this._messageRouter && this._autoReply) {
      try {
        const response = await this._messageRouter.routeMessage(sender, content);
        // Send response back to the sender's conversation
        const conversations = await this._agent!.client.conversations.list({ consentStates: [0, 1] });
        const conv = conversations.find(c => c.id === message.conversationId);
        if (conv) {
          // Use the conversation's send method via DM creation
          // (createDmWithAddress handles finding or creating the conversation)
          const peerAddress = await this._extractPeerAddress(conv);
          const dm = await this._agent!.createDmWithAddress(peerAddress);
          await dm.sendText(response);
        }
      } catch {
        // Auto-reply errors should not crash the stream
      }
    }
  }

  /** Extract peer address from a conversation object.
   *
   *  Uses `peerInboxId` + `client.fetchInboxStates()` to resolve the peer's
   *  wallet address. This avoids `conv.members()` which throws an internal
   *  error in XMTP SDK v5 due to private field access issues on listed conversations.
   */
  private async _extractPeerAddress(conv: {
    peerInboxId: string;
  }): Promise<`0x${string}`> {
    try {
      const peerInboxId = conv.peerInboxId;
      if (peerInboxId && this._ClientClass) {
        // Use the static Client.fetchInboxStates — the Agent's client instance
        // doesn't expose this method despite the type declarations claiming so.
        const states = await this._ClientClass.fetchInboxStates(
          [peerInboxId],
          this._xmtpEnv,
        );
        const state = states?.[0];
        if (state?.identifiers) {
          for (const id of state.identifiers) {
            // identifierKind 0 = Ethereum address
            if (id.identifierKind === 0 && id.identifier) {
              return id.identifier as `0x${string}`;
            }
          }
        }
      }
    } catch {
      // fetchInboxStates can fail on network errors — fall through to sentinel
    }
    // L-13 fix (Audit #8): Return a clearly invalid sentinel rather than the zero address,
    // which could be confused with a real address and cause accidental fund transfers.
    return '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as `0x${string}`;
  }
}
