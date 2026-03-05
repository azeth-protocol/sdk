import { describe, it, expect, vi, beforeEach } from 'vitest';
import { keccak256, toBytes } from 'viem';
import { createPaymentAgreement, getAgreement, executeAgreement, findAgreementWithPayee, isAgreementExecutable, getAgreementData } from '../../src/payments/agreements.js';
import {
  createMockPublicClient,
  createMockSmartAccountClient,
  TEST_ACCOUNT,
  TEST_RECIPIENT,
  TEST_TOKEN,
  TEST_TX_HASH,
  TEST_ADDRESSES,
} from '../fixtures/mocks.js';

vi.mock('@azeth/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@azeth/common')>();
  return {
    ...actual,
    AZETH_CONTRACTS: {
      baseSepolia: {
        factory: '0x6666666666666666666666666666666666666666' as `0x${string}`,
        guardianModule: '0x7777777777777777777777777777777777777777' as `0x${string}`,
        trustRegistryModule: '0x8888888888888888888888888888888888888888' as `0x${string}`,
        paymentAgreementModule: '0x9999999999999999999999999999999999999999' as `0x${string}`,
        reputationModule: '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as `0x${string}`,
        priceOracle: '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' as `0x${string}`,
        accountImplementation: '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC' as `0x${string}`,
      },
      base: {
        factory: '' as `0x${string}`,
        guardianModule: '' as `0x${string}`,
        trustRegistryModule: '' as `0x${string}`,
        paymentAgreementModule: '' as `0x${string}`,
        reputationModule: '' as `0x${string}`,
        priceOracle: '' as `0x${string}`,
        accountImplementation: '' as `0x${string}`,
      },
    },
  };
});

vi.mock('@azeth/common/abis', () => ({
  AzethAccountAbi: [],
  AzethFactoryAbi: [],
  GuardianModuleAbi: [],
  TrustRegistryModuleAbi: [],
  PaymentAgreementModuleAbi: [],
  ReputationModuleAbi: [],
}));

// Mock encodeFunctionData since we use empty ABIs in tests.
// The real ABIs are generated from Foundry artifacts; in unit tests we verify
// the call routing (sendTransaction called with correct `to` address) not the calldata encoding.
vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    encodeFunctionData: vi.fn().mockReturnValue('0xmockencoded'),
  };
});

const PAYMENT_MODULE = '0x9999999999999999999999999999999999999999' as `0x${string}`;
const AGREEMENT_CREATED_TOPIC = keccak256(toBytes('AgreementCreated(address,uint256,address,address,uint256,uint256,uint256)'));

describe('payments/agreements', () => {
  let publicClient: ReturnType<typeof createMockPublicClient>;
  let smartAccountClient: ReturnType<typeof createMockSmartAccountClient>;

  beforeEach(() => {
    publicClient = createMockPublicClient();
    smartAccountClient = createMockSmartAccountClient();
    vi.clearAllMocks();
  });

  describe('createPaymentAgreement', () => {
    it('should create a payment agreement and return agreementId', async () => {
      const agreementIdHex = '0x0000000000000000000000000000000000000000000000000000000000000007';
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          {
            address: PAYMENT_MODULE,
            topics: [
              AGREEMENT_CREATED_TOPIC,
              '0x' + TEST_ACCOUNT.slice(2).padStart(64, '0'),
              agreementIdHex,
              '0x' + TEST_RECIPIENT.slice(2).padStart(64, '0'),
            ],
            data: '0x',
          },
        ],
      });

      const result = await createPaymentAgreement(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
        payee: TEST_RECIPIENT,
        token: TEST_TOKEN,
        amount: 1000000n,
        interval: 86400, // daily
      });

      expect(result.txHash).toBe(TEST_TX_HASH);
      expect(result.agreementId).toBe(7n);
      // Should route through smart account via sendTransaction (UserOp)
      expect(smartAccountClient.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: PAYMENT_MODULE,
          value: 0n,
          data: expect.any(String),
        }),
      );
    });

    it('should return agreementId 0 when no matching log found', async () => {
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [],
      });

      const result = await createPaymentAgreement(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
        payee: TEST_RECIPIENT,
        token: TEST_TOKEN,
        amount: 1000000n,
        interval: 86400,
      });

      expect(result.agreementId).toBe(0n);
    });

    it('should ignore logs from other addresses', async () => {
      const agreementIdHex = '0x0000000000000000000000000000000000000000000000000000000000000007';
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'success',
        logs: [
          {
            address: '0x0000000000000000000000000000000000000001',
            topics: [
              AGREEMENT_CREATED_TOPIC,
              '0x' + TEST_ACCOUNT.slice(2).padStart(64, '0'),
              agreementIdHex,
            ],
            data: '0x',
          },
        ],
      });

      const result = await createPaymentAgreement(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
        payee: TEST_RECIPIENT,
        token: TEST_TOKEN,
        amount: 1000000n,
        interval: 86400,
      });

      expect(result.agreementId).toBe(0n);
    });

    it('should throw when transaction is reverted', async () => {
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'reverted',
        logs: [],
      });

      await expect(
        createPaymentAgreement(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, {
          payee: TEST_RECIPIENT,
          token: TEST_TOKEN,
          amount: 1000000n,
          interval: 86400,
        }),
      ).rejects.toThrow('Transaction reverted');
    });
  });

  describe('getAgreement', () => {
    it('should read agreement details from contract', async () => {
      publicClient.readContract.mockResolvedValue({
        payee: TEST_RECIPIENT,
        token: TEST_TOKEN,
        amount: 1000000n,
        interval: 86400n,
        endTime: 0n,
        lastExecuted: 1700000000n,
        maxExecutions: 12n,
        executionCount: 3n,
        active: true,
      });

      const result = await getAgreement(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 1n);

      expect(result.id).toBe(1n);
      expect(result.payee).toBe(TEST_RECIPIENT);
      expect(result.token).toBe(TEST_TOKEN);
      expect(result.amount).toBe(1000000n);
      expect(result.interval).toBe(86400n);
      expect(result.lastExecuted).toBe(1700000000n);
      expect(result.maxExecutions).toBe(12n);
      expect(result.executionCount).toBe(3n);
      expect(result.active).toBe(true);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: PAYMENT_MODULE,
          functionName: 'getAgreement',
          args: [TEST_ACCOUNT, 1n],
        }),
      );
    });

    it('should handle inactive agreements', async () => {
      publicClient.readContract.mockResolvedValue({
        payee: TEST_RECIPIENT,
        token: TEST_TOKEN,
        amount: 1000000n,
        interval: 86400n,
        endTime: 0n,
        lastExecuted: 1700000000n,
        maxExecutions: 5n,
        executionCount: 5n,
        active: false,
      });

      const result = await getAgreement(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 2n);

      expect(result.active).toBe(false);
    });
  });

  describe('executeAgreement', () => {
    it('should execute a due agreement via UserOp', async () => {
      const txHash = await executeAgreement(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, 1n);

      expect(txHash).toBe(TEST_TX_HASH);
      // Should route through smart account via sendTransaction (UserOp)
      expect(smartAccountClient.sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          to: PAYMENT_MODULE,
          value: 0n,
          data: expect.any(String),
        }),
      );
    });

    it('should wait for transaction receipt', async () => {
      await executeAgreement(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, 1n);

      expect(publicClient.waitForTransactionReceipt).toHaveBeenCalledWith({ hash: TEST_TX_HASH, timeout: 120_000 });
    });

    it('should throw when transaction is reverted', async () => {
      publicClient.waitForTransactionReceipt.mockResolvedValue({
        status: 'reverted',
        logs: [],
      });

      await expect(
        executeAgreement(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, 1n),
      ).rejects.toThrow('Transaction reverted');
    });

    it('should propagate errors from sendTransaction', async () => {
      smartAccountClient.sendTransaction.mockRejectedValue(new Error('AgreementNotDue'));

      await expect(
        executeAgreement(publicClient, smartAccountClient, TEST_ADDRESSES, TEST_ACCOUNT, 1n),
      ).rejects.toThrow('AgreementNotDue');
    });
  });

  describe('findAgreementWithPayee', () => {
    const mockAgreement = (overrides: Record<string, unknown> = {}) => ({
      payee: TEST_RECIPIENT,
      token: TEST_TOKEN,
      amount: 1000000n,
      interval: 86400n,
      endTime: 0n,
      lastExecuted: 1700000000n,
      maxExecutions: 0n,
      executionCount: 0n,
      totalCap: 0n,
      totalPaid: 0n,
      active: true,
      ...overrides,
    });

    it('should find matching active agreement', async () => {
      publicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getAgreementCount') return 2n;
        if (args.functionName === 'getAgreement') {
          // Agreement 1 (newest, checked first) matches
          if (args.args[1] === 1n) return mockAgreement();
          // Agreement 0
          return mockAgreement({ payee: '0x0000000000000000000000000000000000000001' as `0x${string}` });
        }
      });

      const result = await findAgreementWithPayee(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, TEST_RECIPIENT);

      expect(result).not.toBeNull();
      expect(result!.payee).toBe(TEST_RECIPIENT);
      expect(result!.active).toBe(true);
      expect(result!.id).toBe(1n);
    });

    it('should return null when no agreements exist', async () => {
      publicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getAgreementCount') return 0n;
      });

      const result = await findAgreementWithPayee(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, TEST_RECIPIENT);

      expect(result).toBeNull();
    });

    it('should skip inactive agreements', async () => {
      publicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getAgreementCount') return 2n;
        if (args.functionName === 'getAgreement') {
          // Agreement 1 (newest) is inactive
          if (args.args[1] === 1n) return mockAgreement({ active: false });
          // Agreement 0 is active and matches
          return mockAgreement();
        }
      });

      const result = await findAgreementWithPayee(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, TEST_RECIPIENT);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(0n);
      expect(result!.active).toBe(true);
    });

    it('should filter by token when specified', async () => {
      const otherToken = '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE' as `0x${string}`;

      publicClient.readContract.mockImplementation(async (args: any) => {
        if (args.functionName === 'getAgreementCount') return 2n;
        if (args.functionName === 'getAgreement') {
          // Agreement 1 (newest) has wrong token
          if (args.args[1] === 1n) return mockAgreement({ token: otherToken });
          // Agreement 0 has the correct token
          return mockAgreement({ token: TEST_TOKEN });
        }
      });

      const result = await findAgreementWithPayee(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, TEST_RECIPIENT, TEST_TOKEN);

      expect(result).not.toBeNull();
      expect(result!.token).toBe(TEST_TOKEN);
      expect(result!.id).toBe(0n);
    });

    it('should return null when no module address configured', async () => {
      const noModuleAddresses = {
        ...TEST_ADDRESSES,
        paymentAgreementModule: '' as `0x${string}`,
      };

      await expect(
        findAgreementWithPayee(publicClient, noModuleAddresses, TEST_ACCOUNT, TEST_RECIPIENT),
      ).rejects.toThrow('paymentAgreementModule address not configured');
    });
  });

  describe('isAgreementExecutable', () => {
    it('should return true when agreement is executable', async () => {
      publicClient.readContract.mockResolvedValue(true);

      const result = await isAgreementExecutable(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 0n);

      expect(result).toBe(true);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: PAYMENT_MODULE,
          functionName: 'isAgreementExecutable',
          args: [TEST_ACCOUNT, 0n],
        }),
      );
    });

    it('should return false when agreement is not executable', async () => {
      publicClient.readContract.mockResolvedValue(false);

      const result = await isAgreementExecutable(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 5n);

      expect(result).toBe(false);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'isAgreementExecutable',
          args: [TEST_ACCOUNT, 5n],
        }),
      );
    });
  });

  describe('getAgreementData', () => {
    it('should return agreement struct, executable flag, reason, isDue, nextExecutionTime, and count', async () => {
      const agreementStruct = {
        payee: TEST_RECIPIENT,
        token: TEST_TOKEN,
        amount: 1000000n,
        interval: 86400n,
        endTime: 0n,
        lastExecuted: 1700000000n,
        maxExecutions: 0n,
        executionCount: 0n,
        totalCap: 0n,
        totalPaid: 0n,
        active: true,
      };
      publicClient.readContract.mockResolvedValue([agreementStruct, true, '', true, 1700086400n, 3n]);

      const result = await getAgreementData(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 1n);

      expect(result.agreement.id).toBe(1n);
      expect(result.agreement.payee).toBe(TEST_RECIPIENT);
      expect(result.agreement.token).toBe(TEST_TOKEN);
      expect(result.agreement.amount).toBe(1000000n);
      expect(result.agreement.active).toBe(true);
      expect(result.executable).toBe(true);
      expect(result.reason).toBe('');
      expect(result.isDue).toBe(true);
      expect(result.nextExecutionTime).toBe(1700086400n);
      expect(result.count).toBe(3n);
      expect(publicClient.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          address: PAYMENT_MODULE,
          functionName: 'getAgreementData',
          args: [TEST_ACCOUNT, 1n],
        }),
      );
    });

    it('should return executable=false with reason for non-executable agreement', async () => {
      const agreementStruct = {
        payee: TEST_RECIPIENT,
        token: TEST_TOKEN,
        amount: 1000000n,
        interval: 86400n,
        endTime: 0n,
        lastExecuted: 1700000000n,
        maxExecutions: 0n,
        executionCount: 0n,
        totalCap: 0n,
        totalPaid: 0n,
        active: true,
      };
      publicClient.readContract.mockResolvedValue([agreementStruct, false, 'insufficient balance', false, 1700086400n, 1n]);

      const result = await getAgreementData(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 0n);

      expect(result.agreement.active).toBe(true);
      expect(result.executable).toBe(false);
      expect(result.reason).toBe('insufficient balance');
      expect(result.isDue).toBe(false);
      expect(result.count).toBe(1n);
    });

    it('should return zero struct for non-existent agreement', async () => {
      const zeroStruct = {
        payee: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        token: '0x0000000000000000000000000000000000000000' as `0x${string}`,
        amount: 0n,
        interval: 0n,
        endTime: 0n,
        lastExecuted: 0n,
        maxExecutions: 0n,
        executionCount: 0n,
        totalCap: 0n,
        totalPaid: 0n,
        active: false,
      };
      publicClient.readContract.mockResolvedValue([zeroStruct, false, 'agreement not found', false, 0n, 2n]);

      const result = await getAgreementData(publicClient, TEST_ADDRESSES, TEST_ACCOUNT, 999n);

      expect(result.agreement.id).toBe(999n);
      expect(result.agreement.payee).toBe('0x0000000000000000000000000000000000000000');
      expect(result.agreement.amount).toBe(0n);
      expect(result.agreement.active).toBe(false);
      expect(result.executable).toBe(false);
      expect(result.reason).toBe('agreement not found');
      expect(result.isDue).toBe(false);
      expect(result.nextExecutionTime).toBe(0n);
      expect(result.count).toBe(2n);
    });
  });
});
