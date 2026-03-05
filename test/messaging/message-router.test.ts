import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageRouter } from '../../src/messaging/message-router.js';
import type { MessageRouterOptions, SkillDefinition } from '@azeth/common';

const AGENT_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678' as `0x${string}`;
const SENDER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

let activeRouter: MessageRouter | null = null;

function createRouter(overrides: Partial<MessageRouterOptions> = {}): MessageRouter {
  activeRouter = new MessageRouter({
    skills: [],
    agentName: 'TestAgent',
    agentAddress: AGENT_ADDRESS,
    ...overrides,
  });
  return activeRouter;
}

function parse(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

const FREE_SKILL: SkillDefinition = {
  name: 'echo',
  description: 'Echoes back the input',
};

const PAID_SKILL: SkillDefinition = {
  name: 'premium-analysis',
  description: 'Advanced market analysis',
  price: '$0.50',
  method: 'POST',
  tags: ['market', 'analysis'],
};

const MIXED_SKILLS: SkillDefinition[] = [
  FREE_SKILL,
  PAID_SKILL,
  { name: 'ping', description: 'Simple ping service' },
];

describe('messaging/message-router', () => {
  afterEach(() => {
    activeRouter?.destroy();
    activeRouter = null;
  });

  // ── Rate Limiting ──

  describe('rate limiting', () => {
    it('should allow messages under the limit', async () => {
      const router = createRouter({ maxMessagesPerMinute: 3, skills: MIXED_SKILLS });

      const r1 = parse(await router.routeMessage(SENDER, 'hello'));
      const r2 = parse(await router.routeMessage(SENDER, 'hello'));
      const r3 = parse(await router.routeMessage(SENDER, 'hello'));

      expect(r1.type).not.toBe('error');
      expect(r2.type).not.toBe('error');
      expect(r3.type).not.toBe('error');
    });

    it('should reject messages over the limit', async () => {
      const router = createRouter({ maxMessagesPerMinute: 2 });

      await router.routeMessage(SENDER, 'one');
      await router.routeMessage(SENDER, 'two');
      const result = parse(await router.routeMessage(SENDER, 'three'));

      expect(result.type).toBe('error');
      expect(result.error).toBe('Rate limit exceeded');
      expect(result.code).toBe('RATE_LIMITED');
    });

    it('should track senders independently', async () => {
      const router = createRouter({ maxMessagesPerMinute: 1 });

      const r1 = parse(await router.routeMessage('sender-a', 'hi'));
      const r2 = parse(await router.routeMessage('sender-b', 'hi'));

      expect(r1.type).not.toBe('error');
      expect(r2.type).not.toBe('error');

      // Both should now be limited
      const r3 = parse(await router.routeMessage('sender-a', 'hi'));
      const r4 = parse(await router.routeMessage('sender-b', 'hi'));
      expect(r3.type).toBe('error');
      expect(r4.type).toBe('error');
    });

    it('should allow messages after window expiration', async () => {
      vi.useFakeTimers();
      try {
        const router = createRouter({ maxMessagesPerMinute: 1 });

        await router.routeMessage(SENDER, 'one');
        const blocked = parse(await router.routeMessage(SENDER, 'two'));
        expect(blocked.type).toBe('error');

        // Advance past the 60s window
        vi.advanceTimersByTime(61_000);

        const allowed = parse(await router.routeMessage(SENDER, 'three'));
        expect(allowed.type).not.toBe('error');
      } finally {
        vi.useRealTimers();
      }
    });

    it('should use default limit of 10', async () => {
      const router = createRouter();

      for (let i = 0; i < 10; i++) {
        const r = parse(await router.routeMessage(SENDER, 'msg'));
        expect(r.type).not.toBe('error');
      }

      const blocked = parse(await router.routeMessage(SENDER, 'msg'));
      expect(blocked.type).toBe('error');
    });
  });

  // ── Service Request Routing ──

  describe('service-request', () => {
    it('should execute a free skill with a registered handler', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      router.registerHandler('echo', async (_sender, payload) => {
        return { echoed: payload };
      });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: { message: 'hello' },
        id: 'req-1',
      })));

      expect(result.type).toBe('service-response');
      expect(result.status).toBe('success');
      expect(result.requestId).toBe('req-1');
      expect(result.result).toEqual({ echoed: { message: 'hello' } });
    });

    it('should return error for free skill without a handler', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.type).toBe('service-response');
      expect(result.status).toBe('error');
      expect(result.result).toContain('No handler registered');
      expect(result.available).toEqual(['echo']);
    });

    it('should return payment-required for paid skill', async () => {
      const router = createRouter({
        skills: [PAID_SKILL],
        httpEndpoint: 'https://api.example.com',
      });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'premium-analysis',
        payload: {},
        id: 'req-2',
      })));

      expect(result.type).toBe('service-response');
      expect(result.status).toBe('payment-required');
      expect(result.requestId).toBe('req-2');
      expect(result.httpEndpoint).toBe('https://api.example.com/api/premium-analysis');
      expect(result.result).toContain('$0.50');
    });

    it('should return error with available list for unknown skill', async () => {
      const router = createRouter({ skills: MIXED_SKILLS });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'nonexistent',
        payload: {},
      })));

      expect(result.type).toBe('service-response');
      expect(result.status).toBe('error');
      expect(result.result).toContain('Unknown service: nonexistent');
      expect(result.available).toEqual(['echo', 'premium-analysis', 'ping']);
    });

    it('should match service names case-insensitively', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      router.registerHandler('echo', async () => 'ok');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'ECHO',
        payload: {},
      })));

      expect(result.type).toBe('service-response');
      expect(result.status).toBe('success');
      expect(result.result).toBe('ok');
    });

    it('should catch handler errors and return error response', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      router.registerHandler('echo', async () => {
        throw new Error('Handler exploded');
      });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
        id: 'req-err',
      })));

      expect(result.type).toBe('service-response');
      expect(result.status).toBe('error');
      expect(result.requestId).toBe('req-err');
      expect(result.result).toBe('Handler exploded');
    });
  });

  // ── Reputation Gating ──

  describe('reputation gating', () => {
    it('should reject service requests from senders below reputation threshold', async () => {
      const reputationChecker = vi.fn().mockResolvedValue(10);
      const router = createRouter({
        skills: [FREE_SKILL],
        reputationChecker,
        minReputationForService: 30,
      });
      router.registerHandler('echo', async () => 'ok');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.type).toBe('error');
      expect(result.code).toBe('INSUFFICIENT_REPUTATION');
      expect(reputationChecker).toHaveBeenCalledWith(SENDER);
    });

    it('should allow service requests from senders above reputation threshold', async () => {
      const reputationChecker = vi.fn().mockResolvedValue(50);
      const router = createRouter({
        skills: [FREE_SKILL],
        reputationChecker,
        minReputationForService: 30,
      });
      router.registerHandler('echo', async () => 'ok');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.type).toBe('service-response');
      expect(result.status).toBe('success');
    });

    it('should allow service requests when no reputation checker is set', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      router.registerHandler('echo', async () => 'ok');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.type).toBe('service-response');
      expect(result.status).toBe('success');
    });

    it('should use default minReputationForService of 30', async () => {
      const reputationChecker = vi.fn().mockResolvedValue(29);
      const router = createRouter({
        skills: [FREE_SKILL],
        reputationChecker,
        // no minReputationForService → default 30
      });
      router.registerHandler('echo', async () => 'ok');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.type).toBe('error');
      expect(result.code).toBe('INSUFFICIENT_REPUTATION');
    });

    it('should not check reputation for non-service-request messages', async () => {
      const reputationChecker = vi.fn().mockResolvedValue(0);
      const router = createRouter({
        skills: [FREE_SKILL],
        reputationChecker,
      });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-inquiry',
        service: 'echo',
      })));

      expect(result.type).toBe('service-details');
      expect(reputationChecker).not.toHaveBeenCalled();
    });

    it('should return error response when reputation checker throws', async () => {
      const reputationChecker = vi.fn().mockRejectedValue(new Error('RPC timeout'));
      const router = createRouter({
        skills: [FREE_SKILL],
        reputationChecker,
      });
      router.registerHandler('echo', async () => 'ok');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.type).toBe('error');
      expect(result.code).toBe('REPUTATION_CHECK_FAILED');
      expect(result.error).toContain('RPC timeout');
    });

    it('should return error response when reputation checker throws non-Error', async () => {
      const reputationChecker = vi.fn().mockRejectedValue('network down');
      const router = createRouter({
        skills: [FREE_SKILL],
        reputationChecker,
      });
      router.registerHandler('echo', async () => 'ok');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.type).toBe('error');
      expect(result.code).toBe('REPUTATION_CHECK_FAILED');
      expect(result.error).toContain('network down');
    });
  });

  // ── Service Inquiry ──

  describe('service-inquiry', () => {
    it('should return details for a known skill', async () => {
      const router = createRouter({
        skills: [PAID_SKILL],
        httpEndpoint: 'https://api.example.com',
      });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-inquiry',
        service: 'premium-analysis',
      })));

      expect(result.type).toBe('service-details');
      expect(result.service).toBe('premium-analysis');
      expect(result.available).toBe(true);
      expect(result.price).toBe('$0.50');
      expect(result.authentication).toBe('ERC-8128');
      expect(result.payment).toBe('x402');
    });

    it('should return available services for unknown skill', async () => {
      const router = createRouter({ skills: MIXED_SKILLS });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-inquiry',
        service: 'unknown-service',
      })));

      expect(result.type).toBe('service-details');
      expect(result.available).toBe(false);
      expect(result.allServices).toEqual(['echo', 'premium-analysis', 'ping']);
    });

    it('should match service name case-insensitively', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-inquiry',
        service: 'ECHO',
      })));

      expect(result.type).toBe('service-details');
      expect(result.available).toBe(true);
    });
  });

  // ── Friend Request / Accept ──

  describe('friend-request', () => {
    it('should call onFriendRequest callback and return ack', async () => {
      const onFriendRequest = vi.fn().mockResolvedValue(undefined);
      const router = createRouter({ onFriendRequest });

      const msg = {
        type: 'friend-request',
        agentAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        name: 'Alice',
        reputation: 85,
      };

      const result = parse(await router.routeMessage(SENDER, JSON.stringify(msg)));

      expect(result.type).toBe('ack');
      expect(result.received).toBe('friend-request');
      expect(result.note).toBeUndefined();
      expect(onFriendRequest).toHaveBeenCalledWith(SENDER, msg);
    });

    it('should return ack with note when no callback is registered', async () => {
      const router = createRouter();

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'friend-request',
        agentAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        name: 'Alice',
      })));

      expect(result.type).toBe('ack');
      expect(result.received).toBe('friend-request');
      expect(result.note).toBe('no handler registered');
    });
  });

  describe('friend-accept', () => {
    it('should call onFriendAccept callback and return ack', async () => {
      const onFriendAccept = vi.fn().mockResolvedValue(undefined);
      const router = createRouter({ onFriendAccept });

      const msg = {
        type: 'friend-accept',
        agentAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        name: 'Bob',
      };

      const result = parse(await router.routeMessage(SENDER, JSON.stringify(msg)));

      expect(result.type).toBe('ack');
      expect(result.received).toBe('friend-accept');
      expect(onFriendAccept).toHaveBeenCalledWith(SENDER, msg);
    });

    it('should return ack with note when no callback is registered', async () => {
      const router = createRouter();

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'friend-accept',
        agentAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        name: 'Bob',
      })));

      expect(result.type).toBe('ack');
      expect(result.received).toBe('friend-accept');
      expect(result.note).toBe('no handler registered');
    });
  });

  // ── Capabilities Request ──

  describe('capabilities request', () => {
    it('should return capabilities with correct free/paid separation', async () => {
      const router = createRouter({
        skills: MIXED_SKILLS,
        httpEndpoint: 'https://api.example.com',
      });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'capabilities',
      })));

      expect(result.type).toBe('capabilities');
      expect(result.agentAddress).toBe(AGENT_ADDRESS);
      expect(result.name).toBe('TestAgent');
      expect(result.freeServices).toEqual(['echo', 'ping']);
      expect(result.paidServices).toEqual(['premium-analysis']);
      expect(result.httpEndpoint).toBe('https://api.example.com');
      expect(Array.isArray(result.services)).toBe(true);
      expect((result.services as Array<Record<string, unknown>>).length).toBe(3);
    });

    it('should include usage examples', async () => {
      const router = createRouter({
        skills: MIXED_SKILLS,
        httpEndpoint: 'https://api.example.com',
      });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'capabilities',
      })));

      const usage = result.usage as { free: Record<string, unknown> | null; paid: string | null };
      expect(usage.free).toEqual({
        type: 'service-request',
        service: 'echo',
        payload: {},
      });
      expect(usage.paid).toContain('x402');
    });
  });

  // ── Unknown Structured Type ──

  describe('unknown structured type', () => {
    it('should return ack with the received type', async () => {
      const result = parse(await createRouter().routeMessage(SENDER, JSON.stringify({
        type: 'custom-event',
        data: 'something',
      })));

      expect(result.type).toBe('ack');
      expect(result.received).toBe('custom-event');
    });
  });

  // ── Text Message Fallback ──

  describe('text message fallback', () => {
    it('should use textFallbackHandler when provided', async () => {
      const textFallbackHandler = vi.fn().mockResolvedValue('Custom response');
      const router = createRouter({ textFallbackHandler });

      const result = await router.routeMessage(SENDER, 'hello there');

      expect(result).toBe('Custom response');
      expect(textFallbackHandler).toHaveBeenCalledWith(SENDER, 'hello there');
    });

    it('should fall back to capabilities when handler returns null', async () => {
      const textFallbackHandler = vi.fn().mockResolvedValue(null);
      const router = createRouter({
        textFallbackHandler,
        skills: [FREE_SKILL],
      });

      const result = parse(await router.routeMessage(SENDER, 'hello'));

      expect(result.type).toBe('capabilities');
      expect(textFallbackHandler).toHaveBeenCalled();
    });

    it('should return capabilities when no handler and skills exist', async () => {
      const router = createRouter({ skills: MIXED_SKILLS });

      const result = parse(await router.routeMessage(SENDER, 'hello'));

      expect(result.type).toBe('capabilities');
      expect(result.name).toBe('TestAgent');
    });

    it('should return info message when no handler and no skills', async () => {
      const router = createRouter();

      const result = parse(await router.routeMessage(SENDER, 'hello'));

      expect(result.type).toBe('info');
      expect(result.message).toContain('TestAgent');
      expect(result.message).toContain('no services configured');
    });
  });

  // ── JSON Parsing Edge Cases ──

  describe('JSON parsing', () => {
    it('should treat malformed JSON as text', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });

      const result = parse(await router.routeMessage(SENDER, '{not: valid json'));

      expect(result.type).toBe('capabilities');
    });

    it('should treat JSON without type field as text', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({ data: 'no type' })));

      expect(result.type).toBe('capabilities');
    });

    it('should treat JSON with non-string type as text', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({ type: 123 })));

      expect(result.type).toBe('capabilities');
    });

    it('should handle JSON array as text', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });

      const result = parse(await router.routeMessage(SENDER, JSON.stringify([1, 2, 3])));

      expect(result.type).toBe('capabilities');
    });

    it('should handle JSON null as text', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });

      const result = parse(await router.routeMessage(SENDER, 'null'));

      expect(result.type).toBe('capabilities');
    });
  });

  // ── Handler Registration ──

  describe('handler registration', () => {
    it('should register and invoke a handler', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      const handler = vi.fn().mockResolvedValue({ success: true });

      router.registerHandler('echo', handler);

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: { key: 'value' },
      })));

      expect(result.status).toBe('success');
      expect(handler).toHaveBeenCalledWith(SENDER, { key: 'value' });
    });

    it('should remove a handler', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      router.registerHandler('echo', async () => 'ok');
      router.removeHandler('echo');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.status).toBe('error');
      expect(result.result).toContain('No handler registered');
    });

    it('should return registered handler names', async () => {
      const router = createRouter({ skills: MIXED_SKILLS });
      router.registerHandler('echo', async () => 'ok');
      router.registerHandler('ping', async () => 'pong');

      const names = router.getRegisteredHandlers();
      expect(names).toEqual(['echo', 'ping']);
    });

    it('should return empty array when no handlers registered', () => {
      const router = createRouter();
      expect(router.getRegisteredHandlers()).toEqual([]);
    });

    it('should handle case-insensitive handler registration', async () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      router.registerHandler('ECHO', async () => 'registered with uppercase');

      const result = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: {},
      })));

      expect(result.status).toBe('success');
      expect(result.result).toBe('registered with uppercase');
    });
  });

  // ── buildCapabilities ──

  describe('buildCapabilities', () => {
    it('should return empty arrays with no skills', () => {
      const router = createRouter();
      const caps = router.buildCapabilities();

      expect(caps.type).toBe('capabilities');
      expect(caps.services).toEqual([]);
      expect(caps.freeServices).toEqual([]);
      expect(caps.paidServices).toEqual([]);
      expect(caps.usage?.free).toBeNull();
      expect(caps.usage?.paid).toBeNull();
    });

    it('should correctly categorize mixed free and paid skills', () => {
      const router = createRouter({
        skills: MIXED_SKILLS,
        httpEndpoint: 'https://api.example.com',
      });
      const caps = router.buildCapabilities();

      expect(caps.freeServices).toEqual(['echo', 'ping']);
      expect(caps.paidServices).toEqual(['premium-analysis']);
      expect(caps.services.length).toBe(3);

      // First free skill in usage example
      expect(caps.usage?.free).toEqual({
        type: 'service-request',
        service: 'echo',
        payload: {},
      });
      expect(caps.usage?.paid).toContain('x402');
    });

    it('should include all service details', () => {
      const router = createRouter({ skills: [PAID_SKILL] });
      const caps = router.buildCapabilities();
      const svc = caps.services[0]!;

      expect(svc.name).toBe('premium-analysis');
      expect(svc.description).toBe('Advanced market analysis');
      expect(svc.price).toBe('$0.50');
      expect(svc.method).toBe('POST');
    });

    it('should default method to POST', () => {
      const router = createRouter({
        skills: [{ name: 'test', description: 'test svc' }],
      });
      const caps = router.buildCapabilities();

      expect(caps.services[0]!.method).toBe('POST');
    });

    it('should include null for price on free skills', () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      const caps = router.buildCapabilities();

      expect(caps.services[0]!.price).toBeNull();
    });

    it('should only have free usage example when no paid skills', () => {
      const router = createRouter({ skills: [FREE_SKILL] });
      const caps = router.buildCapabilities();

      expect(caps.usage?.free).not.toBeNull();
      expect(caps.usage?.paid).toBeNull();
    });

    it('should only have paid usage example when no free skills', () => {
      const router = createRouter({
        skills: [PAID_SKILL],
        httpEndpoint: 'https://api.example.com',
      });
      const caps = router.buildCapabilities();

      expect(caps.usage?.free).toBeNull();
      expect(caps.usage?.paid).not.toBeNull();
    });
  });

  // ── Destroy ──

  describe('destroy', () => {
    it('should stop the rate limiter cleanup timer', () => {
      vi.useFakeTimers();
      try {
        const router = createRouter();
        router.destroy();
        // Advancing timers should not throw after destroy
        vi.advanceTimersByTime(600_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should be safe to call destroy multiple times', () => {
      const router = createRouter();
      expect(() => {
        router.destroy();
        router.destroy();
      }).not.toThrow();
    });
  });

  // ── LRU Eviction ──

  describe('LRU eviction', () => {
    it('should handle many unique senders without crashing', async () => {
      const router = createRouter({ maxMessagesPerMinute: 1 });

      // Send from many senders — should not throw
      for (let i = 0; i < 100; i++) {
        await router.routeMessage(`sender-${i}`, 'hi');
      }

      // Should still be responsive
      const result = parse(await router.routeMessage('final-sender', 'hello'));
      expect(result.type).toBe('info');
    });
  });

  // ── Integration: Multiple Message Types ──

  describe('integration', () => {
    let router: MessageRouter;

    beforeEach(() => {
      router = createRouter({
        skills: MIXED_SKILLS,
        httpEndpoint: 'https://api.example.com',
      });
      router.registerHandler('echo', async (_sender, payload) => payload);
      router.registerHandler('ping', async () => ({ pong: true }));
    });

    it('should handle a full conversation flow', async () => {
      // 1. Capabilities inquiry
      const caps = parse(await router.routeMessage(SENDER, JSON.stringify({ type: 'capabilities' })));
      expect(caps.type).toBe('capabilities');

      // 2. Service inquiry for a specific skill
      const inquiry = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-inquiry',
        service: 'echo',
      })));
      expect(inquiry.type).toBe('service-details');
      expect(inquiry.available).toBe(true);

      // 3. Free service request
      const echoResult = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'echo',
        payload: { message: 'test' },
      })));
      expect(echoResult.status).toBe('success');

      // 4. Paid service request
      const paidResult = parse(await router.routeMessage(SENDER, JSON.stringify({
        type: 'service-request',
        service: 'premium-analysis',
        payload: {},
      })));
      expect(paidResult.status).toBe('payment-required');

      // 5. Plain text message
      const text = parse(await router.routeMessage(SENDER, 'what can you do?'));
      expect(text.type).toBe('capabilities');
    });
  });
});
