import { describe, it, expect, vi } from 'vitest';

// The guard resolves hostnames via dns.lookup (getaddrinfo). Mock it with a public default and
// override per-test — mirrors the proven pattern in mcp-server's payments.test.ts.
vi.mock('node:dns/promises', () => ({
  default: {
    lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
  },
}));

import dns from 'node:dns/promises';
import {
  validateExternalUrl,
  createPinnedLookup,
  createDefaultSsrfGuard,
  isPrivateIPv4,
  isPrivateIPv6,
} from '../../src/payments/ssrf-guard.js';

const mockedLookup = vi.mocked(dns.lookup);

describe('ssrf-guard (F9/F11 — single audited SSRF guard)', () => {
  describe('createPinnedLookup', () => {
    it('returns ONLY the pinned IP(s), ignoring the (attacker-controlled) hostname', () => {
      const lookup = createPinnedLookup(['203.0.113.7']);
      const single = vi.fn();
      lookup('evil.example.com', undefined, single);
      expect(single).toHaveBeenCalledWith(null, '203.0.113.7', 4);

      const all = vi.fn();
      lookup('evil.example.com', { all: true }, all);
      expect(all).toHaveBeenCalledWith(null, [{ address: '203.0.113.7', family: 4 }]);
    });
  });

  describe('isPrivate helpers', () => {
    it('flags private/reserved v4 and v6, allows public', () => {
      expect(isPrivateIPv4('10.0.0.1')).toBe(true);
      expect(isPrivateIPv4('192.168.1.1')).toBe(true);
      expect(isPrivateIPv4('169.254.1.1')).toBe(true);
      expect(isPrivateIPv4('127.0.0.1')).toBe(true);
      expect(isPrivateIPv4('8.8.8.8')).toBe(false);
      expect(isPrivateIPv6('::1')).toBe(true);
      expect(isPrivateIPv6('fd00::1')).toBe(true);
      expect(isPrivateIPv6('2606:4700::1111')).toBe(false);
    });
  });

  describe('validateExternalUrl', () => {
    it('rejects non-HTTPS before any DNS', async () => {
      await expect(validateExternalUrl('http://example.com/x')).rejects.toThrow(/HTTPS/i);
    });

    it('rejects localhost / private literals without DNS', async () => {
      await expect(validateExternalUrl('https://localhost/x')).rejects.toThrow(/internal or private/i);
      await expect(validateExternalUrl('https://192.168.1.1/x')).rejects.toThrow(/internal or private/i);
      await expect(validateExternalUrl('https://169.254.169.254/latest')).rejects.toThrow(/internal or private/i);
    });

    it('rejects a public hostname that RESOLVES to a private address (DNS rebinding)', async () => {
      mockedLookup.mockResolvedValueOnce([{ address: '10.0.0.5', family: 4 }] as never);
      await expect(validateExternalUrl('https://rebind.example.com/x')).rejects.toThrow(/private or reserved/i);
    });

    it('fails closed when DNS errors (ENOTFOUND → Hostname not found)', async () => {
      mockedLookup.mockRejectedValueOnce(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));
      await expect(validateExternalUrl('https://nope.example.com/x')).rejects.toThrow(/Hostname not found/i);
    });

    it('fails closed when DNS is unreachable (EAI_AGAIN → NETWORK_ERROR)', async () => {
      mockedLookup.mockRejectedValueOnce(Object.assign(new Error('temporary failure'), { code: 'EAI_AGAIN' }));
      await expect(validateExternalUrl('https://flaky.example.com/x')).rejects.toThrow(/cannot verify URL safety/i);
    });

    it('allows a public host and pins its public IPv4', async () => {
      mockedLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never);
      const v = await validateExternalUrl('https://example.com/x');
      expect(v.pinnedIPv4).toEqual(['93.184.216.34']);
    });
  });

  describe('createDefaultSsrfGuard', () => {
    it('blocks an unsafe URL and allows a public one (the secure-by-default guard)', async () => {
      const guard = createDefaultSsrfGuard();
      await expect(guard('http://example.com')).rejects.toThrow(/HTTPS/i);
      mockedLookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }] as never);
      await expect(guard('https://example.com/x')).resolves.toBeDefined();
    });
  });
});
