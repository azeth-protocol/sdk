import { describe, it, expect, vi, afterEach } from 'vitest';
import { secureFetch } from '../../src/payments/secure-fetch.js';
import type { SecureFetchGuard } from '../../src/payments/secure-fetch.js';
import { AzethError } from '@azeth/common';

/** Build a Response with an optional Location header (for redirect simulation). */
function resp(status: number, opts: { location?: string; body?: string } = {}): Response {
  const headers: Record<string, string> = {};
  if (opts.location) headers['location'] = opts.location;
  return new Response(opts.body ?? null, { status, headers });
}

const okGuard = () => vi.fn(async (_u: string) => ({})) as unknown as ReturnType<typeof vi.fn>;

describe('secureFetch (F9 SSRF hardening)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('without a guard, is a transparent passthrough to fetch (no redirect override)', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(resp(200, { body: 'ok' }));
    vi.stubGlobal('fetch', fakeFetch);

    const r = await secureFetch('https://svc.example/x', { method: 'GET' });

    expect(await r.text()).toBe('ok');
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    const [url, init] = fakeFetch.mock.calls[0]!;
    expect(url).toBe('https://svc.example/x');
    // Passthrough: we must NOT force redirect:'manual' for trusted/SDK-direct callers.
    expect((init as RequestInit).redirect).toBeUndefined();
  });

  it('with a guard, runs the guard then fetches with redirect:manual and the pinned dispatcher', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(resp(200, { body: 'data' }));
    vi.stubGlobal('fetch', fakeFetch);
    const dispatcher = { marker: 'pinned-agent' };
    const guard = vi.fn(async (_u: string) => ({ dispatcher }));

    const r = await secureFetch('https://svc.example/x', { method: 'GET', guard: guard as unknown as SecureFetchGuard });

    expect(await r.text()).toBe('data');
    expect(guard).toHaveBeenCalledWith('https://svc.example/x');
    const [, init] = fakeFetch.mock.calls[0]!;
    expect((init as RequestInit).redirect).toBe('manual');
    // The guard-provided connection pin is passed through to fetch.
    expect((init as { dispatcher?: unknown }).dispatcher).toBe(dispatcher);
  });

  it('propagates a guard rejection (SSRF block) and never fetches', async () => {
    const fakeFetch = vi.fn();
    vi.stubGlobal('fetch', fakeFetch);
    const guard = vi.fn(async (_u: string) => {
      throw new AzethError('URL resolves to a private or reserved IP address.', 'INVALID_INPUT');
    });

    await expect(
      secureFetch('https://evil.example/x', { guard: guard as unknown as SecureFetchGuard }),
    ).rejects.toThrow(/private or reserved IP/);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it("guardedRedirect:'error' refuses ANY redirect (so a payment proof never leaks)", async () => {
    const fakeFetch = vi.fn().mockResolvedValue(resp(302, { location: 'https://attacker.example/' }));
    vi.stubGlobal('fetch', fakeFetch);
    const guard = okGuard();

    await expect(
      secureFetch('https://svc.example/pay', {
        guard: guard as unknown as SecureFetchGuard,
        guardedRedirect: 'error',
        method: 'POST',
        headers: { 'PAYMENT-SIGNATURE': 'signed-auth' },
      }),
    ).rejects.toThrow(/refusing to follow/i);
    // The redirect target was NOT fetched — only the original request happened.
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("guardedRedirect:'follow' re-validates the redirect target before following", async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(resp(302, { location: 'https://cdn.example/final' }))
      .mockResolvedValueOnce(resp(200, { body: 'final-data' }));
    vi.stubGlobal('fetch', fakeFetch);
    const guard = okGuard();

    const r = await secureFetch('https://svc.example/x', {
      guard: guard as unknown as SecureFetchGuard,
      guardedRedirect: 'follow',
    });

    expect(await r.text()).toBe('final-data');
    // The guard ran on BOTH the original URL and the redirect target (per-hop re-validation).
    expect(guard).toHaveBeenNthCalledWith(1, 'https://svc.example/x');
    expect(guard).toHaveBeenNthCalledWith(2, 'https://cdn.example/final');
    expect(fakeFetch).toHaveBeenCalledTimes(2);
  });

  it('BLOCKS a redirect to a target the guard rejects — redirect-SSRF is closed', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(resp(302, { location: 'http://169.254.169.254/latest/meta-data/' }))
      .mockResolvedValue(resp(200, { body: 'CLOUD-CREDENTIALS' }));
    vi.stubGlobal('fetch', fakeFetch);
    // Guard allows the first (public) URL, then rejects the private redirect target.
    const guard = vi.fn()
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new AzethError('URL points to an internal or private network address.', 'INVALID_INPUT'));
    vi.stubGlobal('fetch', fakeFetch);

    await expect(
      secureFetch('https://svc.example/x', { guard: guard as unknown as SecureFetchGuard, guardedRedirect: 'follow' }),
    ).rejects.toThrow(/internal or private network/);
    // PROOF: the private metadata endpoint was NEVER fetched (only the initial request ran).
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it('throws after exceeding maxRedirects', async () => {
    const fakeFetch = vi.fn().mockResolvedValue(resp(302, { location: 'https://loop.example/next' }));
    vi.stubGlobal('fetch', fakeFetch);
    const guard = okGuard();

    await expect(
      secureFetch('https://svc.example/x', {
        guard: guard as unknown as SecureFetchGuard,
        guardedRedirect: 'follow',
        maxRedirects: 2,
      }),
    ).rejects.toThrow(/too many redirects/i);
  });

  it('downgrades to GET (no body) on a 303 redirect, per the Fetch spec', async () => {
    const fakeFetch = vi.fn()
      .mockResolvedValueOnce(resp(303, { location: 'https://svc.example/result' }))
      .mockResolvedValueOnce(resp(200, { body: 'result' }));
    vi.stubGlobal('fetch', fakeFetch);
    const guard = okGuard();

    await secureFetch('https://svc.example/x', {
      guard: guard as unknown as SecureFetchGuard,
      guardedRedirect: 'follow',
      method: 'POST',
      body: 'payload',
    });

    const secondInit = fakeFetch.mock.calls[1]![1] as RequestInit;
    expect(secondInit.method).toBe('GET');
    expect(secondInit.body).toBeUndefined();
  });
});
