import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TEST_SMART_ACCOUNT, TEST_OWNER, TEST_ACCOUNT } from '../fixtures/mocks.js';
import { MOCK_PROOF } from '../fixtures/proofs.js';

const ETH_SEPOLIA_READER = '0xB28fEA196dcc198D92ee05962Cf4204a111F5d7d';
const ETH_MAINNET_READER = '0xE1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1';

// ── Hoisted spies ──────────────────────────────────────────────
const {
  mockBuildProof, mockProve, mockGetNetPaid, mockGetAggregate, mockGetDelta, mockGetRep,
  mockCreatePublicClient, mockCreateWalletClient, mockHttp, mockContracts,
} = vi.hoisted(() => {
  const fullAddresses = (trustL2Reader: string) => ({
    factory: '0x6666666666666666666666666666666666666666',
    guardianModule: '0x7777777777777777777777777777777777777777',
    trustRegistryModule: '0x8888888888888888888888888888888888888888',
    paymentAgreementModule: '0x9999999999999999999999999999999999999999',
    reputationModule: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    priceOracle: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
    accountImplementation: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC',
    trustL2Reader,
  });
  return {
    mockBuildProof: vi.fn(),
    mockProve: vi.fn(),
    mockGetNetPaid: vi.fn(),
    mockGetAggregate: vi.fn(),
    mockGetDelta: vi.fn(),
    mockGetRep: vi.fn(),
    mockCreatePublicClient: vi.fn(),
    mockCreateWalletClient: vi.fn(),
    mockHttp: vi.fn(),
    mockContracts: {
      baseSepolia: fullAddresses(''),
      ethereumSepolia: fullAddresses('0xB28fEA196dcc198D92ee05962Cf4204a111F5d7d'),
      base: fullAddresses(''),
      ethereum: fullAddresses('0xE1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1E1'),
    },
  };
});

// ── Module mocks ───────────────────────────────────────────────
vi.mock('../../src/crosschain/proof-builder.js', () => ({
  ANCHOR_STATE_REGISTRY_ABI: [],
  buildL2UsdDeltaProof: mockBuildProof,
  getAnchorState: vi.fn(),
}));

vi.mock('../../src/crosschain/prove.js', () => ({
  proveL2UsdDelta: mockProve,
}));

vi.mock('../../src/crosschain/read.js', () => ({
  getProvenNetPaidUSD: mockGetNetPaid,
  getAggregateNetPaidUSD: mockGetAggregate,
  getProvenDelta: mockGetDelta,
  getRegisteredChainIds: vi.fn(),
  getL2ChainConfig: vi.fn(),
  getCrossChainReputation: mockGetRep,
}));

vi.mock('../../src/messaging/xmtp.js', () => ({
  XMTPClient: vi.fn().mockImplementation(() => ({})),
}));

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: mockCreatePublicClient,
    createWalletClient: mockCreateWalletClient,
    http: mockHttp,
  };
});

vi.mock('viem/accounts', () => ({
  privateKeyToAccount: vi.fn(() => ({
    address: '0x1111111111111111111111111111111111111111' as `0x${string}`,
  })),
}));

vi.mock(import('@azeth/common'), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    AZETH_CONTRACTS: mockContracts as never,
  };
});

vi.mock('@azeth/common/abis', () => ({
  AzethAccountAbi: [],
  AzethFactoryAbi: [],
  GuardianModuleAbi: [],
  TrustRegistryModuleAbi: [],
  PaymentAgreementModuleAbi: [],
  ReputationModuleAbi: [],
  AzethOracleAbi: [],
  TrustL2ReaderAbi: [],
  ERC8004ReputationRegistryAbi: [],
}));

// Dynamic import AFTER all mocks are registered
const { AzethKit } = await import('../../src/client.js');
type AzethKitConfig = import('../../src/client.js').AzethKitConfig;

const TEST_PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' as `0x${string}`;
const COUNTERPARTY = TEST_ACCOUNT;

const baseConfig: AzethKitConfig = {
  privateKey: TEST_PRIVATE_KEY,
  chain: 'baseSepolia',
};

describe('AzethKit cross-chain methods', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // restore reader defaults (tests mutate these)
    mockContracts.ethereumSepolia.trustL2Reader = ETH_SEPOLIA_READER;
    mockContracts.ethereum.trustL2Reader = ETH_MAINNET_READER;
    mockContracts.baseSepolia.trustL2Reader = '';
    mockContracts.base.trustL2Reader = '';

    mockCreatePublicClient.mockImplementation((args?: { chain?: { id?: number } }) => ({
      readContract: vi.fn().mockImplementation((params: { functionName: string }) => {
        if (params.functionName === 'getAccountsByOwner') {
          return Promise.resolve([TEST_SMART_ACCOUNT]);
        }
        return Promise.resolve(0n);
      }),
      getBalance: vi.fn().mockResolvedValue(10n ** 18n),
      // echo the configured chain id, like a correctly-pointed RPC would
      getChainId: vi.fn().mockResolvedValue(args?.chain?.id ?? 84532),
      chain: args?.chain ?? { id: 84532 },
    }));
    mockCreateWalletClient.mockImplementation(() => ({
      account: { address: TEST_OWNER },
      writeContract: vi.fn(),
      chain: { id: 84532 },
    }));
    mockHttp.mockImplementation((url?: string) => ({ __transport: url }));

    mockBuildProof.mockResolvedValue(MOCK_PROOF);
    mockProve.mockResolvedValue({
      status: 'simulated',
      account0: MOCK_PROOF.account0,
      account1: MOCK_PROOF.account1,
      chainId: MOCK_PROOF.chainId,
      usdDelta: MOCK_PROOF.usdDelta,
      anchorL2BlockNumber: MOCK_PROOF.anchor.l2BlockNumber,
    });
    mockGetNetPaid.mockResolvedValue(0n);
    mockGetAggregate.mockResolvedValue(0n);
    mockGetDelta.mockResolvedValue({
      account0: MOCK_PROOF.account0,
      account1: MOCK_PROOF.account1,
      chainId: 84532n,
      usdDelta: 0n,
      l2BlockNumber: 0n,
      provenAt: 0n,
      proven: false,
    });
    mockGetRep.mockResolvedValue({
      from: TEST_OWNER, to: COUNTERPARTY, totalNetPaidUSD: 0n, chains: [], registeredChainIds: [],
    });
  });

  it('throws NETWORK_ERROR from getCrossChainNetPaid when the L1 trustL2Reader address is empty', async () => {
    mockContracts.ethereumSepolia.trustL2Reader = '';
    const kit = await AzethKit.create(baseConfig);

    await expect(kit.getCrossChainNetPaid(TEST_OWNER, COUNTERPARTY)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
      details: { field: 'trustL2Reader', chain: 'ethereumSepolia' },
    });
    expect(mockGetNetPaid).not.toHaveBeenCalled();
  });

  it('prefers the contractAddresses.trustL2Reader override over the L1 chain default', async () => {
    const override = '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE' as `0x${string}`;
    const kit = await AzethKit.create({
      ...baseConfig,
      contractAddresses: { trustL2Reader: override },
    });

    await kit.getCrossChainNetPaid(TEST_OWNER, COUNTERPARTY);

    expect(mockGetNetPaid).toHaveBeenCalledWith(
      expect.anything(), override, TEST_OWNER, COUNTERPARTY, 84532n,
    );
  });

  it('defaults buildCrossChainProof to the kit chain id (84532n) and the resolved smart account', async () => {
    const kit = await AzethKit.create(baseConfig);

    const proof = await kit.buildCrossChainProof({ counterparty: COUNTERPARTY });

    expect(proof).toBe(MOCK_PROOF);
    expect(mockBuildProof).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      ETH_SEPOLIA_READER,
      { chainId: 84532n, accountA: TEST_SMART_ACCOUNT, accountB: COUNTERPARTY },
    );
  });

  it('requires an explicit chainId when the kit is connected to the L1 chain', async () => {
    const kit = await AzethKit.create({ ...baseConfig, chain: 'ethereumSepolia' });

    await expect(kit.getCrossChainNetPaid(TEST_OWNER, COUNTERPARTY)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { chain: 'ethereumSepolia' },
    });

    // explicit chainId unblocks the same call
    await kit.getCrossChainNetPaid(TEST_OWNER, COUNTERPARTY, 84532n);
    expect(mockGetNetPaid).toHaveBeenCalledWith(
      expect.anything(), ETH_SEPOLIA_READER, TEST_OWNER, COUNTERPARTY, 84532n,
    );
  });

  it('defaults l1Chain by network: baseSepolia → ethereumSepolia, base → ethereum', async () => {
    // testnet pairing
    const sepoliaKit = await AzethKit.create(baseConfig);
    await sepoliaKit.getCrossChainNetPaid(TEST_OWNER, COUNTERPARTY);
    expect(mockGetNetPaid).toHaveBeenLastCalledWith(
      expect.anything(), ETH_SEPOLIA_READER, TEST_OWNER, COUNTERPARTY, 84532n,
    );

    // mainnet pairing
    const mainnetKit = await AzethKit.create({ ...baseConfig, chain: 'base' });
    await mainnetKit.getCrossChainNetPaid(TEST_OWNER, COUNTERPARTY);
    expect(mockGetNetPaid).toHaveBeenLastCalledWith(
      expect.anything(), ETH_MAINNET_READER, TEST_OWNER, COUNTERPARTY, 8453n,
    );
  });

  it('kit on L1 + explicit chainId builds the L2 archive client for the REQUESTED chain, not the kit chain', async () => {
    const kit = await AzethKit.create({ ...baseConfig, chain: 'ethereumSepolia' });
    mockCreatePublicClient.mockClear(); // drop create()-time client construction

    await kit.buildCrossChainProof({ counterparty: COUNTERPARTY, chainId: 84532n });

    // the proof builder's L2 client must point at Base Sepolia (id + public default RPC)
    const l2Call = mockCreatePublicClient.mock.calls.find(
      (c) => (c[0] as { chain?: { id?: number } })?.chain?.id === 84532,
    );
    expect(l2Call).toBeDefined();
    expect((l2Call![0] as { transport: { __transport: string } }).transport).toEqual({
      __transport: 'https://sepolia.base.org',
    });
    expect(mockBuildProof).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ chain: expect.objectContaining({ id: 84532 }) }),
      ETH_SEPOLIA_READER,
      { chainId: 84532n, accountA: TEST_SMART_ACCOUNT, accountB: COUNTERPARTY },
    );
  });

  it('kit on L1 + explicit l2ArchiveRpcUrl uses that archive endpoint for the requested L2', async () => {
    const archiveUrl = 'https://base-sepolia-archive.example/v2/key';
    const kit = await AzethKit.create({
      ...baseConfig,
      chain: 'ethereumSepolia',
      l2ArchiveRpcUrl: archiveUrl,
    });
    mockCreatePublicClient.mockClear();

    await kit.buildCrossChainProof({ counterparty: COUNTERPARTY, chainId: 84532n });

    const l2Call = mockCreatePublicClient.mock.calls.find(
      (c) => (c[0] as { chain?: { id?: number } })?.chain?.id === 84532,
    );
    expect(l2Call).toBeDefined();
    expect((l2Call![0] as { transport: { __transport: string } }).transport).toEqual({
      __transport: archiveUrl,
    });
  });

  it('kit on an L2 never reuses its own archive URL for a DIFFERENT L2 chainId (falls back to that chain default)', async () => {
    const kit = await AzethKit.create({
      ...baseConfig, // baseSepolia
      l2ArchiveRpcUrl: 'https://base-sepolia-archive.example',
    });
    mockCreatePublicClient.mockClear();

    await kit.buildCrossChainProof({ counterparty: COUNTERPARTY, chainId: 8453n });

    const l2Call = mockCreatePublicClient.mock.calls.find(
      (c) => (c[0] as { chain?: { id?: number } })?.chain?.id === 8453,
    );
    expect(l2Call).toBeDefined();
    expect((l2Call![0] as { transport: { __transport: string } }).transport).toEqual({
      __transport: 'https://mainnet.base.org',
    });
  });

  it('throws INVALID_INPUT for an unsupported explicit chainId instead of querying the wrong chain', async () => {
    const kit = await AzethKit.create(baseConfig);

    await expect(
      kit.buildCrossChainProof({ counterparty: COUNTERPARTY, chainId: 10n }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { field: 'chainId', chainId: 10n },
    });
    expect(mockBuildProof).not.toHaveBeenCalled();
  });

  it('throws INVALID_INPUT when the archive RPC serves a different chain than requested (eth_chainId fail-closed)', async () => {
    // simulate a mispointed archive endpoint: every client answers eth_chainId with the L1 id
    mockCreatePublicClient.mockImplementation(() => ({
      readContract: vi.fn().mockImplementation((params: { functionName: string }) => {
        if (params.functionName === 'getAccountsByOwner') {
          return Promise.resolve([TEST_SMART_ACCOUNT]);
        }
        return Promise.resolve(0n);
      }),
      getChainId: vi.fn().mockResolvedValue(11155111),
      chain: { id: 84532 },
    }));
    const kit = await AzethKit.create(baseConfig);

    await expect(
      kit.buildCrossChainProof({ counterparty: COUNTERPARTY }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      details: { field: 'l2ArchiveRpcUrl', expectedChainId: 84532n, actualChainId: 11155111n },
    });
    expect(mockBuildProof).not.toHaveBeenCalled();
  });

  it('destroy() nulls the lazily-cached L1 wallet signer and cross-chain clients (H-6 pattern)', async () => {
    const kit = await AzethKit.create(baseConfig);
    // materialize all three caches
    await kit.buildCrossChainProof({ counterparty: COUNTERPARTY });
    await kit.proveCrossChainReputation({ counterparty: COUNTERPARTY, proof: MOCK_PROOF, broadcast: true });

    const inner = kit as unknown as Record<string, unknown>;
    expect(inner['_l1WalletClient']).not.toBeNull();
    expect(inner['_l1PublicClient']).not.toBeNull();
    expect((inner['_l2ProofClients'] as Map<bigint, unknown>).size).toBeGreaterThan(0);

    await kit.destroy();

    expect(inner['_l1WalletClient']).toBeNull();
    expect(inner['_l1PublicClient']).toBeNull();
    expect((inner['_l2ProofClients'] as Map<bigint, unknown>).size).toBe(0);
    await expect(
      kit.proveCrossChainReputation({ counterparty: COUNTERPARTY, proof: MOCK_PROOF, broadcast: true }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('proveCrossChainReputation({ broadcast: false }) never constructs the L1 wallet client', async () => {
    const kit = await AzethKit.create(baseConfig);
    mockCreateWalletClient.mockClear(); // drop the create()-time wallet construction

    const result = await kit.proveCrossChainReputation({
      counterparty: COUNTERPARTY,
      proof: MOCK_PROOF,
      broadcast: false,
    });

    expect(result.status).toBe('simulated');
    expect(mockCreateWalletClient).not.toHaveBeenCalled();
    expect(mockProve).toHaveBeenCalledWith(
      expect.anything(), ETH_SEPOLIA_READER, MOCK_PROOF,
      { broadcast: false, l1WalletClient: undefined },
    );

    // and the pre-built proof skipped the builder entirely
    expect(mockBuildProof).not.toHaveBeenCalled();

    // complement: broadcast: true constructs exactly one L1 wallet client
    await kit.proveCrossChainReputation({
      counterparty: COUNTERPARTY,
      proof: MOCK_PROOF,
      broadcast: true,
    });
    expect(mockCreateWalletClient).toHaveBeenCalledTimes(1);
    const lastProveOptions = mockProve.mock.calls.at(-1)![3] as { broadcast: boolean; l1WalletClient: unknown };
    expect(lastProveOptions.broadcast).toBe(true);
    expect(lastProveOptions.l1WalletClient).toBeDefined();
  });
});
