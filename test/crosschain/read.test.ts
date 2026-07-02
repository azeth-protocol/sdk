import { describe, it, expect } from 'vitest';
import { AzethError } from '@azeth/common';
import {
  getProvenNetPaidUSD,
  getAggregateNetPaidUSD,
  getProvenDelta,
  getRegisteredChainIds,
  getL2ChainConfig,
  getCrossChainReputation,
} from '../../src/crosschain/read.js';
import { FIXTURE_PAIR, mockL1Reader } from '../fixtures/proofs.js';

const READER = '0xB28fEA196dcc198D92ee05962Cf4204a111F5d7d' as `0x${string}`;
const FROM = FIXTURE_PAIR.account0;
const TO = FIXTURE_PAIR.account1;
const WAD = 10n ** 18n;

describe('crosschain/read', () => {
  it('getProvenNetPaidUSD calls the reader with natural (from, to, chainId) order and returns bigint', async () => {
    const l1 = mockL1Reader({ getProvenNetPaidUSD: 12_340_000_000_000_000_000n });

    const result = await getProvenNetPaidUSD(l1, READER, FROM, TO, 84532n);

    expect(result).toBe(12_340_000_000_000_000_000n);
    expect(l1.readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: READER,
      functionName: 'getProvenNetPaidUSD',
      args: [FROM, TO, 84532n],
    }));
  });

  it('getAggregateNetPaidUSD passes explicit chainIds through without querying registered chains', async () => {
    const l1 = mockL1Reader({ getAggregateNetPaidUSD: 5n * WAD });

    const result = await getAggregateNetPaidUSD(l1, READER, FROM, TO, [84532n, 10n]);

    expect(result).toBe(5n * WAD);
    expect(l1.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getAggregateNetPaidUSD',
      args: [FROM, TO, [84532n, 10n]],
    }));
    const registeredCalls = l1.readContract.mock.calls.filter(
      (c: [{ functionName: string }]) => c[0].functionName === 'getRegisteredChainIds',
    );
    expect(registeredCalls).toHaveLength(0);
  });

  it('getAggregateNetPaidUSD defaults to getRegisteredChainIds() when chainIds are omitted', async () => {
    const l1 = mockL1Reader({ getRegisteredChainIds: [84532n], getAggregateNetPaidUSD: 9n * WAD });

    const result = await getAggregateNetPaidUSD(l1, READER, FROM, TO);

    expect(result).toBe(9n * WAD);
    const fnOrder = l1.readContract.mock.calls.map((c: [{ functionName: string }]) => c[0].functionName);
    expect(fnOrder[0]).toBe('getRegisteredChainIds');
    expect(l1.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getAggregateNetPaidUSD',
      args: [FROM, TO, [84532n]],
    }));
  });

  it('getProvenDelta canonicalizes (B, A) inputs and maps the struct with proven: true', async () => {
    const l1 = mockL1Reader({
      getProvenDelta: { usdDelta: -3n * WAD, l2BlockNumber: 42329663n, provenAt: 1749000000n },
    });

    const result = await getProvenDelta(l1, READER, TO, FROM, 84532n); // reversed inputs

    expect(l1.readContract).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'getProvenDelta',
      args: [FROM, TO, 84532n], // canonical order regardless of input order
    }));
    expect(result).toEqual({
      account0: FROM,
      account1: TO,
      chainId: 84532n,
      usdDelta: -3n * WAD,
      l2BlockNumber: 42329663n,
      provenAt: 1749000000n,
      proven: true,
    });
  });

  it('getProvenDelta reports proven: false and usdDelta 0n when provenAt is 0', async () => {
    const l1 = mockL1Reader(); // default getProvenDelta: zeroed struct

    const result = await getProvenDelta(l1, READER, FROM, TO, 84532n);

    expect(result.proven).toBe(false);
    expect(result.usdDelta).toBe(0n);
    expect(result.provenAt).toBe(0n);
  });

  it('getCrossChainReputation builds one row per registered chain with names and a summed total', async () => {
    const l1 = mockL1Reader({
      getRegisteredChainIds: [84532n],
      getProvenNetPaidUSD: 12_340_000_000_000_000_000n,
      getProvenDelta: { usdDelta: 12_340_000_000_000_000_000n, l2BlockNumber: 42329663n, provenAt: 1749000000n },
    });

    const result = await getCrossChainReputation(l1, READER, FROM, TO);

    expect(result.from).toBe(FROM);
    expect(result.to).toBe(TO);
    expect(result.registeredChainIds).toEqual([84532n]);
    expect(result.chains).toHaveLength(1);
    expect(result.chains[0]).toEqual({
      chainId: 84532n,
      chainName: 'Base Sepolia',
      netPaidUSD: 12_340_000_000_000_000_000n,
      proven: true,
      l2BlockNumber: 42329663n,
      provenAt: 1749000000n,
    });
    expect(result.totalNetPaidUSD).toBe(12_340_000_000_000_000_000n);
  });

  it('getCrossChainReputation returns total 0n and empty chains when nothing is registered', async () => {
    const l1 = mockL1Reader({ getRegisteredChainIds: [] });

    const result = await getCrossChainReputation(l1, READER, FROM, TO);

    expect(result.totalNetPaidUSD).toBe(0n);
    expect(result.chains).toEqual([]);
    expect(result.registeredChainIds).toEqual([]);
  });

  it('wraps read reverts as CONTRACT_ERROR (and labels unknown chain ids)', async () => {
    const l1 = mockL1Reader({
      getProvenNetPaidUSD: () => { throw new Error('boom'); },
    });

    try {
      await getProvenNetPaidUSD(l1, READER, FROM, TO, 84532n);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AzethError);
      expect((err as AzethError).code).toBe('CONTRACT_ERROR');
    }

    // bonus coverage: getRegisteredChainIds + getL2ChainConfig happy paths and
    // the `chain ${id}` fallback for unregistered SUPPORTED_CHAINS ids
    const happy = mockL1Reader({
      getRegisteredChainIds: [999n],
      getProvenNetPaidUSD: 1n,
      getProvenDelta: { usdDelta: 1n, l2BlockNumber: 1n, provenAt: 1n },
    });
    expect(await getRegisteredChainIds(happy, READER)).toEqual([999n]);
    const config = await getL2ChainConfig(happy, READER, 84532n);
    expect(config.rollupType).toBe(1);
    expect(config.active).toBe(true);
    const rep = await getCrossChainReputation(happy, READER, FROM, TO);
    expect(rep.chains[0]?.chainName).toBe('chain 999');
  });
});
