import { describe, it, expect } from 'vitest';
import { verifySettlementReceipt } from '../../src/payments/x402.js';

const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const USDC_ADDRESS = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAY_TO = '0x2222222222222222222222222222222222222222';
const FROM_ADDR = '0x1111111111111111111111111111111111111111';

/** Build a Transfer event log with the correct topic structure */
function makeTransferLog(
  contractAddress: string,
  from: string,
  to: string,
  value: bigint,
) {
  // topics[1] and topics[2] are left-padded to 32 bytes
  const padded = (addr: string) => '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
  return {
    address: contractAddress,
    topics: [
      TRANSFER_EVENT_TOPIC,
      padded(from),
      padded(to),
    ],
    data: '0x' + value.toString(16).padStart(64, '0'),
  };
}

describe('verifySettlementReceipt', () => {
  it('returns true for a valid receipt with matching Transfer event', () => {
    const receipt = {
      logs: [makeTransferLog(USDC_ADDRESS, FROM_ADDR, PAY_TO, 1_000_000n)],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(true);
  });

  it('returns true when Transfer amount exceeds expected', () => {
    const receipt = {
      logs: [makeTransferLog(USDC_ADDRESS, FROM_ADDR, PAY_TO, 5_000_000n)],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(true);
  });

  it('returns false when receipt has no Transfer event logs', () => {
    const receipt = { logs: [] as never[] };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(false);
  });

  it('returns false when Transfer is to wrong recipient', () => {
    const wrongRecipient = '0x3333333333333333333333333333333333333333';
    const receipt = {
      logs: [makeTransferLog(USDC_ADDRESS, FROM_ADDR, wrongRecipient, 1_000_000n)],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(false);
  });

  it('returns false when Transfer amount is below expected', () => {
    const receipt = {
      logs: [makeTransferLog(USDC_ADDRESS, FROM_ADDR, PAY_TO, 500_000n)],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(false);
  });

  it('returns false when Transfer is from wrong contract address', () => {
    const wrongContract = '0x4444444444444444444444444444444444444444';
    const receipt = {
      logs: [makeTransferLog(wrongContract, FROM_ADDR, PAY_TO, 1_000_000n)],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(false);
  });

  it('returns false when log has wrong event signature topic', () => {
    const receipt = {
      logs: [{
        address: USDC_ADDRESS,
        topics: [
          '0x0000000000000000000000000000000000000000000000000000000000000000',
          '0x' + FROM_ADDR.slice(2).padStart(64, '0'),
          '0x' + PAY_TO.slice(2).padStart(64, '0'),
        ],
        data: '0x' + (1_000_000n).toString(16).padStart(64, '0'),
      }],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(false);
  });

  it('returns false when log has insufficient topics', () => {
    const receipt = {
      logs: [{
        address: USDC_ADDRESS,
        topics: [TRANSFER_EVENT_TOPIC],
        data: '0x' + (1_000_000n).toString(16).padStart(64, '0'),
      }],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(false);
  });

  it('handles case-insensitive address comparison', () => {
    const receipt = {
      logs: [makeTransferLog(
        USDC_ADDRESS.toUpperCase().replace('0X', '0x'),
        FROM_ADDR,
        PAY_TO.toUpperCase().replace('0X', '0x'),
        1_000_000n,
      )],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO.toLowerCase(), USDC_ADDRESS.toLowerCase(), 1_000_000n)).toBe(true);
  });

  it('finds matching Transfer among multiple logs', () => {
    const otherContract = '0x5555555555555555555555555555555555555555';
    const receipt = {
      logs: [
        // Non-matching: wrong contract
        makeTransferLog(otherContract, FROM_ADDR, PAY_TO, 1_000_000n),
        // Non-matching: wrong recipient
        makeTransferLog(USDC_ADDRESS, FROM_ADDR, '0x6666666666666666666666666666666666666666', 1_000_000n),
        // Matching
        makeTransferLog(USDC_ADDRESS, FROM_ADDR, PAY_TO, 1_000_000n),
      ],
    };

    expect(verifySettlementReceipt(receipt, PAY_TO, USDC_ADDRESS, 1_000_000n)).toBe(true);
  });
});
