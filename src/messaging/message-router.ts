import type {
  SkillDefinition,
  MessageRouterOptions,
  ServiceHandler,
  ServiceRequest,
  ServiceInquiry,
  ServiceResponse,
  ServiceDetailsResponse,
  CapabilitiesResponse,
  FriendRequest,
  FriendAccept,
  ErrorResponse,
  AckResponse,
} from '@azeth/common';
import { RateLimiter } from './rate-limiter.js';

// ── Named constants ──

/** Default maximum messages per sender per 60-second window */
const DEFAULT_MAX_MESSAGES_PER_MINUTE = 10;

/** Default minimum reputation score required to invoke services */
const DEFAULT_MIN_REPUTATION = 30;

/** Maximum tracked senders before the rate limiter evicts old entries */
const MAX_TRACKED_SENDERS = 10_000;

/** Parsed structured message with a required type field */
interface TypedMessage {
  type: string;
  [key: string]: unknown;
}

/** Message router for XMTP structured message dispatch.
 *
 *  Receives raw message strings, parses them, dispatches by type,
 *  and returns JSON response strings. Handles rate limiting, reputation
 *  gating, service execution, and capabilities advertising.
 */
export class MessageRouter {
  private readonly _skills: SkillDefinition[];
  private readonly _agentName: string;
  private readonly _agentAddress: `0x${string}`;
  private readonly _httpEndpoint?: string;
  private readonly _minReputationForService: number;
  private readonly _reputationChecker?: (address: string) => Promise<number>;
  private readonly _onFriendRequest?: (sender: string, req: FriendRequest) => Promise<void>;
  private readonly _onFriendAccept?: (sender: string, req: FriendAccept) => Promise<void>;
  private readonly _textFallbackHandler?: (sender: string, content: string) => Promise<string | null>;
  private readonly _handlers: Map<string, ServiceHandler> = new Map();
  private readonly _rateLimiter: RateLimiter;

  /** Create a new MessageRouter with the given options.
   *
   *  @param options - Router configuration including skills, agent identity, and callbacks
   */
  constructor(options: MessageRouterOptions) {
    this._skills = options.skills;
    this._agentName = options.agentName;
    this._agentAddress = options.agentAddress;
    this._httpEndpoint = options.httpEndpoint;
    this._minReputationForService = options.minReputationForService ?? DEFAULT_MIN_REPUTATION;
    this._reputationChecker = options.reputationChecker;
    this._onFriendRequest = options.onFriendRequest;
    this._onFriendAccept = options.onFriendAccept;
    this._textFallbackHandler = options.textFallbackHandler;
    this._rateLimiter = new RateLimiter(
      options.maxMessagesPerMinute ?? DEFAULT_MAX_MESSAGES_PER_MINUTE,
      MAX_TRACKED_SENDERS,
    );
  }

  /** Route an incoming message to the appropriate handler and return a JSON response.
   *
   *  Flow: rate limit check → JSON parse → structured dispatch or text fallback.
   *  All responses are valid JSON strings.
   *
   *  @param sender - Sender identifier (address or inbox ID)
   *  @param content - Raw message content string
   *  @returns JSON response string
   */
  async routeMessage(sender: string, content: string): Promise<string> {
    // Rate limit check
    if (!this._rateLimiter.checkLimit(sender)) {
      const resp: ErrorResponse = {
        type: 'error',
        error: 'Rate limit exceeded',
        code: 'RATE_LIMITED',
      };
      return JSON.stringify(resp);
    }

    // Try JSON parse
    try {
      const parsed: unknown = JSON.parse(content);
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'type' in parsed &&
        typeof (parsed as TypedMessage).type === 'string'
      ) {
        return await this._handleStructuredMessage(sender, parsed as TypedMessage);
      }
    } catch {
      // Not valid JSON — fall through to text handler
    }

    // Text fallback
    return await this._handleTextMessage(sender, content);
  }

  /** Register a handler function for a named service.
   *
   *  The handler will be invoked when a `service-request` message
   *  arrives for a free skill matching the given name.
   *
   *  @param serviceName - Service name (case-insensitive matching at dispatch time)
   *  @param handler - Async function that processes the request payload
   */
  registerHandler(serviceName: string, handler: ServiceHandler): void {
    this._handlers.set(serviceName.toLowerCase(), handler);
  }

  /** Remove a previously registered handler for a service.
   *
   *  @param serviceName - Service name to unregister
   */
  removeHandler(serviceName: string): void {
    this._handlers.delete(serviceName.toLowerCase());
  }

  /** Get the names of all services that have registered handlers.
   *
   *  @returns Array of service names with active handlers
   */
  getRegisteredHandlers(): string[] {
    return Array.from(this._handlers.keys());
  }

  /** Build the capabilities response advertising this agent's services.
   *
   *  @returns CapabilitiesResponse with service catalog, free/paid separation, and usage examples
   */
  buildCapabilities(): CapabilitiesResponse {
    const freeSkills = this._skills.filter(s => !s.price);
    const paidSkills = this._skills.filter(s => !!s.price);
    const firstFree = freeSkills[0];

    return {
      type: 'capabilities',
      agentAddress: this._agentAddress,
      name: this._agentName,
      services: this._skills.map(s => ({
        name: s.name,
        description: s.description,
        price: s.price ?? null,
        method: s.method ?? 'POST',
      })),
      freeServices: freeSkills.map(s => s.name),
      paidServices: paidSkills.map(s => s.name),
      httpEndpoint: this._httpEndpoint,
      usage: {
        free: firstFree
          ? { type: 'service-request', service: firstFree.name, payload: {} }
          : null,
        paid: paidSkills.length > 0
          ? `Use HTTP with x402 payment at ${this._httpEndpoint ?? '<http-endpoint>'}`
          : null,
      },
    };
  }

  /** Stop the rate limiter cleanup timer.
   *
   *  Call this when the router is no longer needed to prevent timer leaks.
   */
  destroy(): void {
    this._rateLimiter.destroy();
  }

  // ── Private: Structured message dispatch ──

  private async _handleStructuredMessage(sender: string, message: TypedMessage): Promise<string> {
    // Reputation gating for service requests
    if (message.type === 'service-request' && this._reputationChecker) {
      try {
        const rep = await this._reputationChecker(sender);
        if (rep < this._minReputationForService) {
          const resp: ErrorResponse = {
            type: 'error',
            error: 'Insufficient reputation to use services',
            code: 'INSUFFICIENT_REPUTATION',
          };
          return JSON.stringify(resp);
        }
      } catch (err: unknown) {
        const resp: ErrorResponse = {
          type: 'error',
          error: `Reputation check failed: ${err instanceof Error ? err.message : String(err)}`,
          code: 'REPUTATION_CHECK_FAILED',
        };
        return JSON.stringify(resp);
      }
    }

    switch (message.type) {
      case 'service-request':
        return this._handleServiceRequest(sender, message as unknown as ServiceRequest);

      case 'service-inquiry':
        return this._handleServiceInquiry(message as unknown as ServiceInquiry);

      case 'friend-request': {
        if (this._onFriendRequest) {
          await this._onFriendRequest(sender, message as unknown as FriendRequest);
          const resp: AckResponse = { type: 'ack', received: 'friend-request' };
          return JSON.stringify(resp);
        }
        const resp: AckResponse = { type: 'ack', received: 'friend-request', note: 'no handler registered' };
        return JSON.stringify(resp);
      }

      case 'friend-accept': {
        if (this._onFriendAccept) {
          await this._onFriendAccept(sender, message as unknown as FriendAccept);
          const resp: AckResponse = { type: 'ack', received: 'friend-accept' };
          return JSON.stringify(resp);
        }
        const resp: AckResponse = { type: 'ack', received: 'friend-accept', note: 'no handler registered' };
        return JSON.stringify(resp);
      }

      case 'capabilities':
        return JSON.stringify(this.buildCapabilities());

      default: {
        const resp: AckResponse = { type: 'ack', received: message.type };
        return JSON.stringify(resp);
      }
    }
  }

  private async _handleServiceRequest(sender: string, request: ServiceRequest): Promise<string> {
    // Find matching skill (case-insensitive)
    const skill = this._skills.find(
      s => s.name.toLowerCase() === request.service.toLowerCase(),
    );

    // Unknown skill
    if (!skill) {
      const caps = this.buildCapabilities();
      const resp: ServiceResponse = {
        type: 'service-response',
        requestId: request.id,
        status: 'error',
        result: `Unknown service: ${request.service}`,
        available: caps.services.map(s => s.name),
      };
      return JSON.stringify(resp);
    }

    // Paid skill — redirect to HTTP + x402
    if (skill.price) {
      const resp: ServiceResponse = {
        type: 'service-response',
        requestId: request.id,
        status: 'payment-required',
        result: `${request.service} costs ${skill.price}. Use HTTP with x402 payment.`,
        httpEndpoint: this._httpEndpoint
          ? `${this._httpEndpoint}/api/${skill.name}`
          : undefined,
        usage: `Pay via x402 at ${this._httpEndpoint ?? '<http-endpoint>'}/api/${skill.name}`,
      };
      return JSON.stringify(resp);
    }

    // Free skill — look up handler
    const handler = this._handlers.get(skill.name.toLowerCase());
    if (!handler) {
      const caps = this.buildCapabilities();
      const resp: ServiceResponse = {
        type: 'service-response',
        requestId: request.id,
        status: 'error',
        result: `No handler registered for service: ${skill.name}`,
        available: caps.services.map(s => s.name),
      };
      return JSON.stringify(resp);
    }

    // Execute handler
    try {
      const result = await handler(sender, request.payload);
      const resp: ServiceResponse = {
        type: 'service-response',
        requestId: request.id,
        status: 'success',
        result,
      };
      return JSON.stringify(resp);
    } catch (err: unknown) {
      const resp: ServiceResponse = {
        type: 'service-response',
        requestId: request.id,
        status: 'error',
        result: err instanceof Error ? err.message : String(err),
      };
      return JSON.stringify(resp);
    }
  }

  private _handleServiceInquiry(inquiry: ServiceInquiry): string {
    const skill = this._skills.find(
      s => s.name.toLowerCase() === inquiry.service.toLowerCase(),
    );

    if (skill) {
      const resp: ServiceDetailsResponse = {
        type: 'service-details',
        service: skill.name,
        available: true,
        description: skill.description,
        price: skill.price ?? null,
        method: skill.method ?? 'POST',
        paid: !!skill.price,
        capabilities: skill.tags ?? [],
        httpEndpoint: this._httpEndpoint
          ? `${this._httpEndpoint}/api/${skill.name}`
          : undefined,
        authentication: 'ERC-8128',
        payment: 'x402',
      };
      return JSON.stringify(resp);
    }

    const resp: ServiceDetailsResponse = {
      type: 'service-details',
      service: inquiry.service,
      available: false,
      allServices: this._skills.map(s => s.name),
    };
    return JSON.stringify(resp);
  }

  // ── Private: Text message fallback ──

  private async _handleTextMessage(sender: string, content: string): Promise<string> {
    // Try custom text fallback handler
    if (this._textFallbackHandler) {
      const result = await this._textFallbackHandler(sender, content);
      if (result !== null) {
        return result;
      }
    }

    // Default: return capabilities if skills exist
    if (this._skills.length > 0) {
      return JSON.stringify(this.buildCapabilities());
    }

    // No skills configured
    return JSON.stringify({
      type: 'info',
      message: `This agent (${this._agentName}) has no services configured.`,
    });
  }
}
