import { describe, it, expect } from 'vitest';
import { parseCatalogBody, resolveIntent } from '../../src/payments/catalog-resolve.js';
import type { CatalogEntry } from '@azeth/common';

const PRICE_CATALOG: CatalogEntry[] = [
  { name: 'Get Price', path: '/{coinId}', pricing: '$0.01/request', paid: true, capabilities: ['price-feed'], params: { coinId: 'bitcoin, ethereum (eth), solana, usd-coin' } },
  { name: 'Get Fresh Price', path: '/{coinId}?fresh=true', pricing: '$0.02/request', paid: true, capabilities: ['price-feed'], params: { coinId: 'bitcoin, ethereum, solana' } },
  { name: 'List Coins', path: '/coins', paid: false, capabilities: ['price-feed'] },
];
const BASE = 'https://api.azeth.ai/api/v1/pricing';

describe('parseCatalogBody', () => {
  it('parses the {data:{catalog}} provider envelope, top-level {catalog}, and a bare array', () => {
    expect(parseCatalogBody(JSON.stringify({ data: { name: 'X', catalog: PRICE_CATALOG } }))).toHaveLength(3);
    expect(parseCatalogBody(JSON.stringify({ catalog: PRICE_CATALOG }))).toHaveLength(3);
    expect(parseCatalogBody(JSON.stringify(PRICE_CATALOG))).toHaveLength(3);
  });

  it('returns null for actual price DATA (not a catalog) and for non-JSON', () => {
    expect(parseCatalogBody(JSON.stringify({ data: { coinId: 'ethereum', price: 1756 } }))).toBeNull();
    expect(parseCatalogBody('not json')).toBeNull();
  });
});

describe('resolveIntent (F6 — deterministic, never mis-pays)', () => {
  const base = { entries: PRICE_CATALOG, parentCapabilities: ['price-feed'], capability: 'price-feed', baseUrl: BASE };

  it('resolves a loose intent token to the concrete priced URL', () => {
    const r = resolveIntent({ ...base, intent: ['bitcoin'] });
    expect(r.resolved?.url).toBe('https://api.azeth.ai/api/v1/pricing/bitcoin');
    expect(r.resolved?.entryName).toBe('Get Price'); // cheaper; tie → catalog order
    expect(r.resolved?.boundParams).toEqual({ coinId: 'bitcoin' });
  });

  it('resolves precise structured params (override intent)', () => {
    const r = resolveIntent({ ...base, params: { coinId: 'ethereum' } });
    expect(r.resolved?.url).toBe('https://api.azeth.ai/api/v1/pricing/ethereum');
  });

  it('resolves an ALIAS to the canonical value (eth → ethereum)', () => {
    const r = resolveIntent({ ...base, intent: ['eth'] });
    expect(r.resolved?.url).toBe('https://api.azeth.ai/api/v1/pricing/ethereum');
    expect(r.resolved?.boundParams).toEqual({ coinId: 'ethereum' });
  });

  it('a descriptor token selects the right variant (bitcoin + fresh → Fresh Price route)', () => {
    const r = resolveIntent({ ...base, intent: ['bitcoin', 'fresh'] });
    expect(r.resolved?.entryName).toBe('Get Fresh Price');
    expect(r.resolved?.url).toBe('https://api.azeth.ai/api/v1/pricing/bitcoin?fresh=true');
  });

  it('NEVER auto-pays an unknown value — returns the MENU on a miss', () => {
    const r = resolveIntent({ ...base, intent: ['dogecoin'] });
    expect(r.resolved).toBeUndefined();
    expect(r.reason).toBe('intent_unmatched');
    expect(r.options[0]?.params['coinId']).toContain('bitcoin'); // the agent can pick a valid value
  });

  it('returns no_capability_match (with the menu) when no entry matches the capability', () => {
    const r = resolveIntent({ ...base, capability: 'translation', intent: ['bitcoin'] });
    expect(r.resolved).toBeUndefined();
    expect(r.reason).toBe('no_capability_match');
  });

  it('excludes paid:false (free) entries from paid resolution', () => {
    const r = resolveIntent({ ...base, intent: ['coins'] }); // 'coins' is the free List-Coins path, not a coinId
    expect(r.resolved).toBeUndefined();
  });

  it('binds a free-form param and URL-encodes the value', () => {
    const cat: CatalogEntry[] = [{ name: 'Q', path: '/{q}', paid: true, capabilities: ['search'], params: { q: '' } }];
    const r = resolveIntent({ entries: cat, parentCapabilities: ['search'], capability: 'search', intent: ['a b'], baseUrl: 'https://x.example/s' });
    expect(r.resolved?.url).toBe('https://x.example/s/a%20b');
  });

  it('a static-path entry (no params) resolves with no intent needed', () => {
    const cat: CatalogEntry[] = [{ name: 'Latest', path: '/latest', paid: true, capabilities: ['price-feed'] }];
    const r = resolveIntent({ entries: cat, parentCapabilities: ['price-feed'], capability: 'price-feed', baseUrl: BASE });
    expect(r.resolved?.url).toBe('https://api.azeth.ai/api/v1/pricing/latest');
  });
});
