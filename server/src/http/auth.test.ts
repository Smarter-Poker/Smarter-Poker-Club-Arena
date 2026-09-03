import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { IncomingMessage } from 'http';

// Mock the Supabase client BEFORE importing the module under test.
const getUser = vi.fn();
vi.mock('../services/supabase.js', () => ({
  supabase: { auth: { getUser: (t: string) => getUser(t) } },
}));

import { authenticateRequest } from './auth.js';

function req(token?: string): IncomingMessage {
  return {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  } as unknown as IncomingMessage;
}

/** Build an unsigned/forged JWT with an arbitrary payload. */
function forgedToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.not-a-real-signature`;
}

describe('authenticateRequest - signature verification', () => {
  beforeEach(() => {
    getUser.mockReset();
  });

  it('rejects a forged token even with a valid-looking sub/exp (signature never checked before)', async () => {
    // GoTrue rejects the forged signature.
    getUser.mockResolvedValue({ data: null, error: { message: 'invalid signature' } });

    const token = forgedToken({ sub: 'victim-uuid', exp: 9_999_999_999 });
    const result = await authenticateRequest(req(token));

    expect(result).toBeNull();
    expect(getUser).toHaveBeenCalledWith(token);
  });

  it('accepts a token only after GoTrue verifies it, and caches the result', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'real-user' } }, error: null });

    const token = forgedToken({ sub: 'real-user', exp: 9_999_999_999 });
    const first = await authenticateRequest(req(token));
    const second = await authenticateRequest(req(token));

    expect(first).toEqual({ userId: 'real-user' });
    expect(second).toEqual({ userId: 'real-user' });
    // Second call served from cache — GoTrue hit only once.
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('coalesces a concurrent burst of the same token into one verification', async () => {
    let resolveVerify!: (v: unknown) => void;
    getUser.mockReturnValue(
      new Promise((r) => {
        resolveVerify = r;
      })
    );

    const token = forgedToken({ sub: 'burst-user', exp: 9_999_999_999 });
    const p1 = authenticateRequest(req(token));
    const p2 = authenticateRequest(req(token));
    const p3 = authenticateRequest(req(token));

    resolveVerify({ data: { user: { id: 'burst-user' } }, error: null });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toEqual({ userId: 'burst-user' });
    expect(r2).toEqual({ userId: 'burst-user' });
    expect(r3).toEqual({ userId: 'burst-user' });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it('returns null when no Authorization header is present', async () => {
    expect(await authenticateRequest(req())).toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });
});
