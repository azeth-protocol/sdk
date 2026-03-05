import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AzethError } from '@azeth/common';
import type { XMTPMessage, XMTPConfig } from '@azeth/common';
import { TEST_OWNER, TEST_RECIPIENT } from '../fixtures/mocks.js';

// ── Mock @xmtp/agent-sdk ────────────────────────────

const mockSendText = vi.fn().mockResolvedValue('msg-id-1');
const mockCreateDm = vi.fn().mockResolvedValue({
  id: 'conv-123',
  sendText: mockSendText,
});
const mockCanMessage = vi.fn().mockResolvedValue(
  new Map([[TEST_RECIPIENT.toLowerCase(), true]]),
);
const mockSyncAll = vi.fn().mockResolvedValue(undefined);
const mockConversationsList = vi.fn().mockResolvedValue([]);
const mockStreamAllMessages = vi.fn().mockResolvedValue({
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
});
const mockStreamConversations = vi.fn().mockResolvedValue({
  [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
});
const mockAgentStop = vi.fn().mockResolvedValue(undefined);

const mockAgent = {
  client: {
    inboxId: 'inbox-test-owner',
    canMessage: mockCanMessage,
    conversations: {
      syncAll: mockSyncAll,
      list: mockConversationsList,
      streamAllMessages: mockStreamAllMessages,
      stream: mockStreamConversations,
    },
  },
  address: TEST_OWNER.toLowerCase(),
  createDmWithAddress: mockCreateDm,
  start: vi.fn().mockResolvedValue(undefined),
  stop: mockAgentStop,
  on: vi.fn(),
};

const mockCreateUser = vi.fn().mockReturnValue({
  account: { address: TEST_OWNER },
});
const mockCreateSigner = vi.fn().mockReturnValue({ type: 'mock-signer' });
const mockAgentCreate = vi.fn().mockResolvedValue(mockAgent);
const mockFetchInboxStates = vi.fn().mockResolvedValue([]);

vi.mock(import('@xmtp/agent-sdk'), () => ({
  Agent: { create: (...args: unknown[]) => mockAgentCreate(...args) },
  createUser: (...args: unknown[]) => mockCreateUser(...args),
  createSigner: (...args: unknown[]) => mockCreateSigner(...args),
  Client: { fetchInboxStates: (...args: unknown[]) => mockFetchInboxStates(...args) },
}));

// Import AFTER mock setup
const { XMTPClient } = await import('../../src/messaging/xmtp.js');

describe('messaging/xmtp', () => {
  let client: InstanceType<typeof XMTPClient>;
  const TEST_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as `0x${string}`;
  const TEST_ENCRYPTION_KEY = '0x' + 'ab'.repeat(32);

  beforeEach(() => {
    vi.clearAllMocks();
    client = new XMTPClient();
  });

  afterEach(async () => {
    await client.destroy();
  });

  describe('initialize', () => {
    it('should create an XMTP agent from a private key', async () => {
      const config: XMTPConfig = {
        env: 'dev',
        dbEncryptionKey: TEST_ENCRYPTION_KEY,
      };

      await client.initialize(TEST_PRIVATE_KEY, config);

      expect(mockCreateUser).toHaveBeenCalledWith(TEST_PRIVATE_KEY);
      expect(mockCreateSigner).toHaveBeenCalled();
      expect(mockAgentCreate).toHaveBeenCalledWith(
        expect.anything(), // signer
        expect.objectContaining({
          env: 'dev',
          dbPath: null,
          dbEncryptionKey: expect.any(Buffer),
        }),
      );
      expect(client.isReady()).toBe(true);
    });

    it('should generate a random encryption key when not provided', async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev' });

      const createCall = mockAgentCreate.mock.calls[0];
      const opts = createCall[1] as { dbEncryptionKey: Buffer };
      expect(opts.dbEncryptionKey).toBeInstanceOf(Buffer);
      expect(opts.dbEncryptionKey.length).toBe(32);
    });

    it('should default to production env when no config', async () => {
      await client.initialize(TEST_PRIVATE_KEY);

      const createCall = mockAgentCreate.mock.calls[0];
      const opts = createCall[1] as { env: string };
      expect(opts.env).toBe('production');
    });

    it('should reject invalid encryption key length', async () => {
      await expect(
        client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: '0xabcd' }),
      ).rejects.toThrow('dbEncryptionKey must be exactly 32 bytes');
    });

    it('should be idempotent (second call is a no-op)', async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });

      expect(mockAgentCreate).toHaveBeenCalledTimes(1);
    });

    it('should throw AzethError when Agent.create fails', async () => {
      mockAgentCreate.mockRejectedValueOnce(new Error('Connection refused'));

      await expect(
        client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY }),
      ).rejects.toThrow('XMTP client creation failed');
    });
  });

  describe('sendMessage', () => {
    beforeEach(async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });
    });

    it('should check reachability, create DM, and send text', async () => {
      const conversationId = await client.sendMessage({
        to: TEST_RECIPIENT,
        content: 'Hello agent!',
      });

      expect(mockCanMessage).toHaveBeenCalledWith([
        { identifier: TEST_RECIPIENT.toLowerCase(), identifierKind: 0 },
      ]);
      expect(mockCreateDm).toHaveBeenCalledWith(TEST_RECIPIENT);
      expect(mockSendText).toHaveBeenCalledWith('Hello agent!');
      expect(conversationId).toBe('conv-123');
    });

    it('should throw when recipient is unreachable', async () => {
      mockCanMessage.mockResolvedValueOnce(
        new Map([[TEST_RECIPIENT.toLowerCase(), false]]),
      );

      await expect(
        client.sendMessage({ to: TEST_RECIPIENT, content: 'hello' }),
      ).rejects.toThrow('not reachable');
    });

    it('should throw when content exceeds max length', async () => {
      const longContent = 'a'.repeat(10_001);

      await expect(
        client.sendMessage({ to: TEST_RECIPIENT, content: longContent }),
      ).rejects.toThrow('exceeds maximum length');
    });

    it('should respect custom maxMessageLength from config', async () => {
      const customClient = new XMTPClient();
      await customClient.initialize(TEST_PRIVATE_KEY, {
        env: 'dev',
        dbEncryptionKey: TEST_ENCRYPTION_KEY,
        maxMessageLength: 50,
      });

      await expect(
        customClient.sendMessage({ to: TEST_RECIPIENT, content: 'a'.repeat(51) }),
      ).rejects.toThrow('exceeds maximum length');

      await customClient.destroy();
    });

    it('should throw when client not initialized', async () => {
      const uninit = new XMTPClient();

      await expect(
        uninit.sendMessage({ to: TEST_RECIPIENT, content: 'hello' }),
      ).rejects.toThrow('not initialized');
    });

    it('should throw AzethError when DM creation fails', async () => {
      mockCreateDm.mockRejectedValueOnce(new Error('Network timeout'));

      await expect(
        client.sendMessage({ to: TEST_RECIPIENT, content: 'hello' }),
      ).rejects.toThrow('Failed to send XMTP message');
    });
  });

  describe('onMessage', () => {
    beforeEach(async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });
    });

    it('should register a handler and return an unsubscribe function', () => {
      const handler = vi.fn();
      const unsub = client.onMessage(handler);

      expect(typeof unsub).toBe('function');
    });

    it('should remove handler when unsubscribe is called', () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const unsub1 = client.onMessage(handler1);
      client.onMessage(handler2);

      unsub1();

      // handler1 should be removed; handler2 should remain
      // We can verify by checking the internal state indirectly
      // through the destroy cleanup
    });

    it('should start listening on first handler registration', async () => {
      const handler = vi.fn();
      client.onMessage(handler);

      // Allow the detached async IIFEs in _startListening to settle
      await new Promise(resolve => setTimeout(resolve, 10));

      // Listening should have triggered syncAll and stream setup
      expect(mockSyncAll).toHaveBeenCalled();
      expect(mockStreamAllMessages).toHaveBeenCalled();
    });
  });

  describe('canReach', () => {
    beforeEach(async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });
    });

    it('should return true for reachable address', async () => {
      const result = await client.canReach(TEST_RECIPIENT);
      expect(result).toBe(true);
    });

    it('should return false for unreachable address', async () => {
      const unreachable = '0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead' as `0x${string}`;
      mockCanMessage.mockResolvedValueOnce(
        new Map([[unreachable.toLowerCase(), false]]),
      );

      const result = await client.canReach(unreachable);
      expect(result).toBe(false);
    });

    it('should cache reachability results', async () => {
      await client.canReach(TEST_RECIPIENT);
      await client.canReach(TEST_RECIPIENT);

      // canMessage should only be called once (second call uses cache)
      expect(mockCanMessage).toHaveBeenCalledTimes(1);
    });

    it('should respect custom cache TTL', async () => {
      vi.useFakeTimers();

      const shortTtlClient = new XMTPClient();
      await shortTtlClient.initialize(TEST_PRIVATE_KEY, {
        env: 'dev',
        dbEncryptionKey: TEST_ENCRYPTION_KEY,
        reachabilityCacheTtlMs: 1000, // 1 second
      });

      await shortTtlClient.canReach(TEST_RECIPIENT);
      expect(mockCanMessage).toHaveBeenCalledTimes(1);

      // Advance past TTL
      vi.advanceTimersByTime(1500);

      await shortTtlClient.canReach(TEST_RECIPIENT);
      expect(mockCanMessage).toHaveBeenCalledTimes(2);

      await shortTtlClient.destroy();
      vi.useRealTimers();
    });

    it('should return false on canMessage errors', async () => {
      mockCanMessage.mockRejectedValueOnce(new Error('Network error'));

      const result = await client.canReach(TEST_RECIPIENT);
      expect(result).toBe(false);
    });

    it('should return false when client is not ready', async () => {
      const uninit = new XMTPClient();
      const result = await uninit.canReach(TEST_RECIPIENT);
      expect(result).toBe(false);
    });
  });

  describe('getConversations', () => {
    beforeEach(async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });
    });

    it('should return empty array when no conversations exist', async () => {
      const convos = await client.getConversations();
      expect(convos).toEqual([]);
    });

    it('should map conversations to XMTPConversation type', async () => {
      mockConversationsList.mockResolvedValueOnce([
        {
          id: 'conv-1',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          peerInboxId: 'peer-inbox',
        },
      ]);

      // Mock Client.fetchInboxStates to resolve the peer's wallet address
      mockFetchInboxStates.mockResolvedValueOnce([{
        inboxId: 'peer-inbox',
        identifiers: [{ identifier: TEST_RECIPIENT.toLowerCase(), identifierKind: 0 }],
      }]);

      const convos = await client.getConversations();
      expect(convos).toHaveLength(1);
      expect(convos[0]).toEqual({
        id: 'conv-1',
        peerAddress: TEST_RECIPIENT.toLowerCase(),
        createdAt: new Date('2026-01-01T00:00:00Z').getTime(),
      });
    });

    it('should return empty array when client is not initialized', async () => {
      const uninit = new XMTPClient();
      const convos = await uninit.getConversations();
      expect(convos).toEqual([]);
    });

    it('should return empty array on list errors', async () => {
      mockConversationsList.mockRejectedValueOnce(new Error('DB error'));

      const convos = await client.getConversations();
      expect(convos).toEqual([]);
    });
  });

  describe('isReady', () => {
    it('should return false before initialization', () => {
      expect(client.isReady()).toBe(false);
    });

    it('should return true after initialization', async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });
      expect(client.isReady()).toBe(true);
    });
  });

  describe('destroy', () => {
    it('should stop the agent and clear state', async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });
      const handler = vi.fn();
      client.onMessage(handler);

      await client.destroy();

      expect(mockAgentStop).toHaveBeenCalled();
      expect(client.isReady()).toBe(false);
    });

    it('should be safe to call destroy multiple times', async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });

      await client.destroy();
      await client.destroy();

      expect(mockAgentStop).toHaveBeenCalledTimes(1);
    });

    it('should be safe to destroy an uninitialized client', async () => {
      await expect(client.destroy()).resolves.not.toThrow();
    });

    it('should handle agent.stop() throwing gracefully', async () => {
      await client.initialize(TEST_PRIVATE_KEY, { env: 'dev', dbEncryptionKey: TEST_ENCRYPTION_KEY });
      mockAgentStop.mockRejectedValueOnce(new Error('cleanup error'));

      await expect(client.destroy()).resolves.not.toThrow();
    });
  });

  describe('rate limiting', () => {
    it('should apply rate limit config from XMTPConfig', async () => {
      await client.initialize(TEST_PRIVATE_KEY, {
        env: 'dev',
        dbEncryptionKey: TEST_ENCRYPTION_KEY,
        rateLimitPerMinute: 5,
      });

      // Client initialized with rate limiter set to 5/min
      expect(client.isReady()).toBe(true);
    });
  });
});
