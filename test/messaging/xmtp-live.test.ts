/**
 * XMTP Live Round-Trip Test
 *
 * Two real XMTP agent-sdk clients exchange messages on the dev network.
 * Skipped by default — run with: XMTP_LIVE_TEST=1 pnpm --filter @azeth/sdk test -- xmtp-live
 *
 * No real funds needed — XMTP dev network is free.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { XMTPClient } from '../../src/messaging/xmtp.js';

describe.skipIf(process.env['XMTP_LIVE_TEST'] !== '1')('XMTP Live Round-Trip', () => {
  const aliceKey = generatePrivateKey();
  const bobKey = generatePrivateKey();

  const alice = new XMTPClient();
  const bob = new XMTPClient();

  afterAll(async () => {
    await alice.destroy().catch(() => {});
    await bob.destroy().catch(() => {});
  }, 30_000);

  it('should initialize both clients on dev network', async () => {
    await alice.initialize(aliceKey, { env: 'dev' });
    await bob.initialize(bobKey, { env: 'dev' });

    expect(alice.isReady()).toBe(true);
    expect(bob.isReady()).toBe(true);
  }, 60_000);

  it('should exchange messages: Alice sends, Bob receives, Bob replies, Alice receives', async () => {
    // Derive addresses from keys for canReach check
    const { privateKeyToAccount } = await import('viem/accounts');
    const aliceAddr = privateKeyToAccount(aliceKey).address;
    const bobAddr = privateKeyToAccount(bobKey).address;

    // Set up Bob's message listener
    const bobReceived: string[] = [];
    const bobReady = new Promise<void>((resolve) => {
      bob.onMessage(async (msg) => {
        bobReceived.push(msg.content);
        resolve();
      });
    });

    // Alice sends to Bob
    const convId = await alice.sendMessage({
      to: bobAddr,
      content: 'Hello Bob, this is Alice!',
    });
    expect(convId).toBeTruthy();

    // Wait for Bob to receive
    await Promise.race([
      bobReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Bob did not receive message within timeout')), 45_000)),
    ]);
    expect(bobReceived).toContain('Hello Bob, this is Alice!');

    // Bob replies
    const aliceReceived: string[] = [];
    const aliceReady = new Promise<void>((resolve) => {
      alice.onMessage(async (msg) => {
        aliceReceived.push(msg.content);
        resolve();
      });
    });

    await bob.sendMessage({
      to: aliceAddr,
      content: 'Hi Alice, Bob here!',
    });

    // Wait for Alice to receive
    await Promise.race([
      aliceReady,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Alice did not receive reply within timeout')), 45_000)),
    ]);
    expect(aliceReceived).toContain('Hi Alice, Bob here!');
  }, 120_000);

  it('should report canReach for registered addresses', async () => {
    const { privateKeyToAccount } = await import('viem/accounts');
    const bobAddr = privateKeyToAccount(bobKey).address;

    const reachable = await bob.canReach(bobAddr);
    // Bob should be able to reach himself (registered on XMTP)
    expect(reachable).toBe(true);
  }, 30_000);
}, 180_000);
