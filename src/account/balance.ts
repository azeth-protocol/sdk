import {
  type PublicClient,
  type Chain,
  type Transport,
  erc20Abi,
  formatEther,
  formatUnits,
} from 'viem';
import {
  AzethError,
  TOKENS,
  formatTokenAmount,
  formatAddress,
  type SupportedChainName,
  type AggregatedBalanceResult,
  type AccountBalanceUSD,
  type TokenBalanceUSD,
} from '@azeth/common';
import { AzethFactoryAbi } from '@azeth/common/abis';
import { withRetry } from '../utils/retry.js';

export interface BalanceResult {
  /** Smart account ETH balance (primary identity) */
  eth: bigint;
  ethFormatted: string;
  /** Smart account USDC balance */
  usdc: bigint;
  usdcFormatted: string;
  /** Smart account tracked token balances */
  tokens: Record<string, { balance: bigint; formatted: string }>;
  /** EOA balances (for gas management) */
  eoa: {
    eth: bigint;
    ethFormatted: string;
  };
}

/** Get ETH and token balances for a smart account and its owner EOA.
 *
 *  Primary balances (eth, usdc, tokens) reflect the smart account.
 *  The eoa field shows the EOA's ETH balance for gas management.
 */
export async function getBalance(
  publicClient: PublicClient<Transport, Chain>,
  chainName: SupportedChainName,
  smartAccount: `0x${string}`,
  eoaAddress: `0x${string}`,
): Promise<BalanceResult> {
  // Fetch smart account ETH balance
  let ethBalance: bigint;
  try {
    ethBalance = await withRetry(() => publicClient.getBalance({ address: smartAccount }));
  } catch (err: unknown) {
    if (err instanceof AzethError) throw err;
    throw new AzethError(
      err instanceof Error ? err.message : 'Failed to fetch ETH balance',
      'NETWORK_ERROR',
      { originalError: err instanceof Error ? err.name : undefined },
    );
  }

  // Fetch EOA ETH balance (for gas management)
  let eoaEthBalance: bigint;
  try {
    eoaEthBalance = await withRetry(() => publicClient.getBalance({ address: eoaAddress }));
  } catch {
    eoaEthBalance = 0n; // Non-fatal — smart account balance is primary
  }

  const tokens: Record<string, { balance: bigint; formatted: string }> = {};
  let usdcBalance = 0n;

  const chainTokens = TOKENS[chainName];

  if (chainTokens.USDC && chainTokens.USDC !== ('0x' as `0x${string}`)) {
    try {
      usdcBalance = await withRetry(() => publicClient.readContract({
        address: chainTokens.USDC as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [smartAccount],
      }));
      tokens['USDC'] = { balance: usdcBalance, formatted: formatUnits(usdcBalance, 6) };
    } catch {
      // Token contract may not exist on this chain
    }
  }

  if (chainTokens.WETH && chainTokens.WETH !== ('0x' as `0x${string}`)) {
    try {
      const wethBalance = await withRetry(() => publicClient.readContract({
        address: chainTokens.WETH as `0x${string}`,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [smartAccount],
      }));
      tokens['WETH'] = { balance: wethBalance, formatted: formatEther(wethBalance) };
    } catch {
      // Token contract may not exist
    }
  }

  return {
    eth: ethBalance,
    ethFormatted: formatEther(ethBalance),
    usdc: usdcBalance,
    usdcFormatted: formatUnits(usdcBalance, 6),
    tokens,
    eoa: {
      eth: eoaEthBalance,
      ethFormatted: formatEther(eoaEthBalance),
    },
  };
}

/** Token metadata for resolving symbols and decimals */
interface TokenMeta { symbol: string; decimals: number }

const NATIVE_ETH = '0x0000000000000000000000000000000000000000';

/** Build a token address → metadata map for the given chain */
function buildTokenMeta(chainName: SupportedChainName): Record<string, TokenMeta> {
  const meta: Record<string, TokenMeta> = {
    [NATIVE_ETH]: { symbol: 'ETH', decimals: 18 },
  };
  const chainTokens = TOKENS[chainName];
  if (chainTokens.USDC) {
    meta[chainTokens.USDC.toLowerCase()] = { symbol: 'USDC', decimals: 6 };
  }
  if (chainTokens.WETH) {
    meta[chainTokens.WETH.toLowerCase()] = { symbol: 'WETH', decimals: 18 };
  }
  return meta;
}

/** Format a bigint 18-decimal USD value to a human-readable string */
function formatUSD(value18: bigint): string {
  return `$${formatTokenAmount(value18, 18, 2)}`;
}

/** Map a raw on-chain TokenBalance to a client-friendly TokenBalanceUSD */
function mapTokenBalance(
  tb: { token: `0x${string}`; balance: bigint; usdValue: bigint },
  meta: Record<string, TokenMeta>,
): TokenBalanceUSD {
  const tokenAddr = tb.token.toLowerCase();
  const info = meta[tokenAddr] ?? { symbol: formatAddress(tb.token), decimals: 18 };
  return {
    token: tb.token,
    symbol: info.symbol,
    balance: tb.balance,
    balanceFormatted: formatTokenAmount(tb.balance, info.decimals),
    usdValue: tb.usdValue,
    usdFormatted: formatUSD(tb.usdValue),
  };
}

/** Get all balances for an owner's EOA + all smart accounts with USD values.
 *
 *  **Primary path:** Single RPC call via AzethFactory.getOwnerBalancesAndUSD(owner)
 *  which queries AzethOracle for Chainlink-powered USD aggregation.
 *
 *  **Fallback path:** If the aggregated oracle call reverts (e.g. due to a Chainlink
 *  feed issue or contract-level bug), falls back to individual balance queries.
 *  The fallback returns raw token balances WITHOUT USD values (usdValue = 0).
 *
 *  Returns: EOA at index 0, smart accounts at index 1+.
 *  Each account has per-token balances with USD values and a total.
 *  Grand total USD sums across all accounts.
 */
export async function getAllBalances(
  publicClient: PublicClient<Transport, Chain>,
  chainName: SupportedChainName,
  factoryAddress: `0x${string}`,
  owner: `0x${string}`,
): Promise<AggregatedBalanceResult> {
  // Primary path: aggregated oracle query (single RPC call)
  try {
    const result = await withRetry(() => publicClient.readContract({
      address: factoryAddress,
      abi: AzethFactoryAbi,
      functionName: 'getOwnerBalancesAndUSD',
      args: [owner],
    }));
    const rawBalances = result[0];
    const grandTotalUSD = result[1];

    const meta = buildTokenMeta(chainName);
    const accounts: AccountBalanceUSD[] = rawBalances.map((ab, i) => {
      // Deduplicate token entries: the on-chain oracle allocates balances[tokens.length+1]
      // and skips address(0) in the ERC-20 loop (already handled as native ETH at index 0).
      // This leaves a phantom zeroed entry {token: 0x0, balance: 0, usdValue: 0}.
      // Filter it out by tracking seen token addresses and dropping zero-balance duplicates.
      const seen = new Set<string>();
      const deduped = ab.balances.filter((tb) => {
        const key = tb.token.toLowerCase();
        if (seen.has(key) && tb.balance === 0n && tb.usdValue === 0n) return false;
        seen.add(key);
        return true;
      });
      return {
        account: ab.account,
        label: i === 0 ? 'EOA' : `Smart Account #${i}`,
        balances: deduped.map((tb) => mapTokenBalance(tb, meta)),
        totalUSD: ab.totalUSD,
        totalUSDFormatted: formatUSD(ab.totalUSD),
      };
    });

    return { accounts, grandTotalUSD, grandTotalUSDFormatted: formatUSD(grandTotalUSD) };
  } catch {
    // Fallback: individual balance queries without USD aggregation.
    // Known trigger: the on-chain oracle reverts when _supportedTokens includes
    // address(0) because Solidity try/catch cannot catch balanceOf() calls to
    // non-contract addresses (the call succeeds but returns empty data, failing
    // ABI decode). This is a contract-level issue — the fallback provides resilience.
    return _fallbackGetAllBalances(publicClient, chainName, factoryAddress, owner);
  }
}

/** Fallback balance fetcher: queries individual ETH + ERC-20 balances per account.
 *
 *  Called when the aggregated AzethOracle.getBalancesAndUSD() reverts on-chain.
 *  Returns balances with zero USD values since the oracle is unavailable.
 *
 *  @internal
 */
async function _fallbackGetAllBalances(
  publicClient: PublicClient<Transport, Chain>,
  chainName: SupportedChainName,
  factoryAddress: `0x${string}`,
  owner: `0x${string}`,
): Promise<AggregatedBalanceResult> {
  // 1. Get smart accounts from factory
  let smartAccounts: readonly `0x${string}`[] = [];
  try {
    smartAccounts = await withRetry(() => publicClient.readContract({
      address: factoryAddress,
      abi: AzethFactoryAbi,
      functionName: 'getAccountsByOwner',
      args: [owner],
    }));
  } catch {
    // If even getAccountsByOwner fails, return just the EOA
  }

  const allAccounts: `0x${string}`[] = [owner, ...(smartAccounts as `0x${string}`[])];
  const chainTokens = TOKENS[chainName];

  const accounts: AccountBalanceUSD[] = [];

  for (let i = 0; i < allAccounts.length; i++) {
    const account = allAccounts[i];
    const balances: TokenBalanceUSD[] = [];

    // Native ETH balance
    let ethBalance = 0n;
    try {
      ethBalance = await publicClient.getBalance({ address: account });
    } catch {
      // Non-fatal: RPC failure for this account
    }

    balances.push({
      token: '0x0000000000000000000000000000000000000000' as `0x${string}`,
      symbol: 'ETH',
      balance: ethBalance,
      balanceFormatted: formatTokenAmount(ethBalance, 18),
      usdValue: 0n,
      usdFormatted: '$0.00 (oracle unavailable)',
    });

    // USDC balance
    if (chainTokens.USDC && chainTokens.USDC !== ('0x' as `0x${string}`)) {
      let usdcBalance = 0n;
      try {
        usdcBalance = await publicClient.readContract({
          address: chainTokens.USDC as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account],
        });
      } catch {
        // Non-fatal: token contract may not exist
      }

      balances.push({
        token: chainTokens.USDC as `0x${string}`,
        symbol: 'USDC',
        balance: usdcBalance,
        balanceFormatted: formatTokenAmount(usdcBalance, 6),
        usdValue: 0n,
        usdFormatted: '$0.00 (oracle unavailable)',
      });
    }

    // WETH balance
    if (chainTokens.WETH && chainTokens.WETH !== ('0x' as `0x${string}`)) {
      let wethBalance = 0n;
      try {
        wethBalance = await publicClient.readContract({
          address: chainTokens.WETH as `0x${string}`,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [account],
        });
      } catch {
        // Non-fatal: token contract may not exist
      }

      balances.push({
        token: chainTokens.WETH as `0x${string}`,
        symbol: 'WETH',
        balance: wethBalance,
        balanceFormatted: formatTokenAmount(wethBalance, 18),
        usdValue: 0n,
        usdFormatted: '$0.00 (oracle unavailable)',
      });
    }

    accounts.push({
      account,
      label: i === 0 ? 'EOA' : `Smart Account #${i}`,
      balances,
      totalUSD: 0n,
      totalUSDFormatted: '$0.00 (oracle unavailable)',
    });
  }

  return {
    accounts,
    grandTotalUSD: 0n,
    grandTotalUSDFormatted: '$0.00 (oracle unavailable)',
  };
}
