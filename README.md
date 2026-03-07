# @azeth/sdk

TypeScript SDK for the Azeth trust infrastructure. Provides `AzethKit` -- a single class for machine participants to interact with the Azeth protocol: smart accounts, x402 payments, reputation, messaging, and service discovery.

## Installation

```bash
npm install @azeth/sdk
# or
pnpm add @azeth/sdk
```

## Quick Start

```typescript
import { AzethKit } from '@azeth/sdk';
import { TOKENS } from '@azeth/common';

const kit = await AzethKit.create({
  privateKey: process.env.AZETH_PRIVATE_KEY as `0x${string}`,
  chain: 'baseSepolia',
});

try {
  // Deploy a smart account (gas is auto-sponsored, no ETH needed)
  await kit.createAccount({
    name: 'MyAgent',
    entityType: 'agent',
    description: 'A demo agent',
    capabilities: ['general'],
  });

  // Check balances across all accounts with USD values
  const balances = await kit.getAllBalances();
  console.log('Total:', balances.grandTotalUSDFormatted);

  // Transfer USDC
  await kit.transfer({
    to: '0xRecipient...' as `0x${string}`,
    amount: 1_000_000n, // 1 USDC
    token: TOKENS.baseSepolia.USDC,
  });

  // Pay for an x402 service
  const { response } = await kit.fetch402('https://api.example.com/data');
  const data = await response.json();

  // Discover best service and pay in one call
  const result = await kit.smartFetch402('price-feed');
  console.log('Served by:', result.service.name);
} finally {
  await kit.destroy();
}
```

Only `privateKey` and `chain` are required. Gas sponsorship, bundler, and server URL are handled automatically via the Azeth server at `api.azeth.ai`. For production or custom infrastructure, see [Configuration](#configuration) below.

## Key Features

- **Smart Accounts** -- Deploy ERC-4337 smart accounts with guardian guardrails (spending limits, whitelists, timelocks) via `createAccount()`
- **x402 Payments** -- Auto-detect and pay for HTTP 402 services with `fetch402()` and `smartFetch402()`
- **Reputation** -- Submit and query payment-weighted reputation via `submitOpinion()` and `getWeightedReputation()`
- **Service Discovery** -- Find services by capability and reputation via `discoverServices()`, with on-chain fallback
- **Payment Agreements** -- Create and manage recurring on-chain payments via `createPaymentAgreement()`
- **Messaging** -- Send and receive E2E encrypted messages via XMTP with `sendMessage()` and `onMessage()`
- **Auth** -- ERC-8128 machine-native HTTP signatures via `getSignedFetch()`
- **Budget Manager** -- Client-side reputation-aware spending tiers on top of on-chain guardian limits
- **Event System** -- Lifecycle hooks for payments, transfers, and deposits

## API Overview

### Account

| Method | Description |
|---|---|
| `AzethKit.create(config)` | Create an SDK instance |
| `kit.createAccount(params)` | Deploy smart account + registry entry |
| `kit.getBalance(account?)` | ETH/USDC/WETH balances |
| `kit.getAllBalances()` | All accounts with USD values |
| `kit.transfer(params)` | Send ETH or ERC-20 via UserOp |
| `kit.deposit(params)` | Fund smart account from EOA |
| `kit.getHistory(params?)` | Transaction history |
| `kit.setTokenWhitelist(token, allowed)` | Guardian token whitelist |
| `kit.setProtocolWhitelist(protocol, allowed)` | Guardian protocol whitelist |

### Payments

| Method | Description |
|---|---|
| `kit.fetch402(url, options?)` | Pay for x402 services |
| `kit.smartFetch402(capability, options?)` | Discover + pay + rate in one call |
| `kit.createPaymentAgreement(params)` | Recurring on-chain payments |
| `kit.executeAgreement(id)` | Execute a due agreement |
| `kit.cancelAgreement(id)` | Cancel an agreement |
| `kit.getAgreementData(id)` | Full agreement status |

### Registry and Reputation

| Method | Description |
|---|---|
| `kit.publishService(params)` | Register on trust registry |
| `kit.discoverServices(params)` | Search by capability/reputation |
| `kit.updateServiceMetadata(key, value)` | Update registry metadata |
| `kit.submitOpinion(opinion)` | Submit reputation opinion |
| `kit.getWeightedReputation(agentId)` | Payment-weighted reputation |
| `kit.getNetPaid(counterparty)` | Net payment delta |

### Messaging and Auth

| Method | Description |
|---|---|
| `kit.sendMessage(params)` | Send XMTP encrypted message |
| `kit.onMessage(handler)` | Listen for messages |
| `kit.canReach(address)` | Check XMTP reachability |
| `kit.getSignedFetch()` | ERC-8128 authenticated fetch |

### Lifecycle

| Method | Description |
|---|---|
| `kit.on(event, listener)` | Subscribe to events |
| `kit.destroy()` | Clean up and zero keys |

## Error Handling

All errors are `AzethError` with typed codes:

```typescript
import { AzethError } from '@azeth/common';

try {
  await kit.transfer({ to: '0x...', amount: 1_000_000n });
} catch (err) {
  if (err instanceof AzethError) {
    // err.code: 'INSUFFICIENT_BALANCE' | 'GUARDIAN_REJECTED' | 'BUDGET_EXCEEDED' | ...
    console.error(err.code, err.message);
  }
}
```

## Configuration

The minimal config is just `privateKey` + `chain`. Everything else has smart defaults:

```typescript
const kit = await AzethKit.create({
  privateKey: '0x...',              // Required
  chain: 'baseSepolia',             // Required
  // All below are optional:
  serverUrl: 'https://api.azeth.ai', // Default — handles gasless relay + bundler proxy
  bundlerUrl: undefined,             // Falls back to server bundler proxy
  paymasterUrl: undefined,           // Falls back to server paymaster
  rpcUrl: undefined,                 // Falls back to public RPC for the chain
});
```

For production with your own infrastructure:

```typescript
const kit = await AzethKit.create({
  privateKey: '0x...',
  chain: 'base',
  bundlerUrl: `https://api.pimlico.io/v2/8453/rpc?apikey=${PIMLICO_KEY}`,
  paymasterUrl: `https://api.pimlico.io/v2/8453/rpc?apikey=${PIMLICO_KEY}`,
});
```

## Full Documentation

See [docs/sdk.md](../../docs/sdk.md) for the comprehensive API reference with all method signatures, parameter types, return types, and detailed descriptions.

## License

MIT
