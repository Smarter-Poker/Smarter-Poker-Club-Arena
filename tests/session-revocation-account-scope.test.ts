import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ getUser: vi.fn(), refreshSession: vi.fn(), signOut: vi.fn() }));
vi.mock('../src/lib/supabase', () => ({ supabase: { auth } }));
import {
  handleEngineAuthRejection,
  _resetSessionRevokedStateForTests,
} from '../src/lib/sessionRevoked';
import { AUTH_STORAGE_KEY } from '../src/lib/authUtils';
const session = (id: string) =>
  localStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ user: { id }, access_token: `token-${id}` })
  );
describe('revocation outcomes belong to their original account session', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
    _resetSessionRevokedStateForTests();
    localStorage.clear();
    session('A');
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  it('does not sign B out when the pending refresh of A is rejected', async () => {
    let finish!: (value: unknown) => void;
    let entered!: () => void;
    const refreshing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    auth.getUser.mockResolvedValue({ data: null, error: { code: 'session_not_found' } });
    auth.refreshSession.mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const verdict = handleEngineAuthRejection('old:A', true);
    await refreshing;
    session('B');
    finish({ data: null, error: { code: 'refresh_token_not_found' } });
    expect(await verdict).toBe('unknown');
    expect(auth.signOut).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!).user.id).toBe('B');
  });
  it('does not refresh B after the older getUser rejection arrives', async () => {
    let finish!: (value: unknown) => void, entered!: () => void;
    const reading = new Promise<void>((resolve) => {
      entered = resolve;
    });
    auth.getUser.mockImplementation(() => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const result = handleEngineAuthRejection('old:A', true);
    await reading;
    session('B');
    finish({ data: null, error: { code: 'session_not_found' } });
    expect(await result).toBe('unknown');
    expect(auth.refreshSession).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
  it('B starts its own probe while A is pending and coalesces only its own callers', async () => {
    let finishA!: (value: unknown) => void, finishB!: (value: unknown) => void;
    let enteredA!: () => void, enteredB!: () => void;
    const readingA = new Promise<void>((resolve) => {
      enteredA = resolve;
    });
    const readingB = new Promise<void>((resolve) => {
      enteredB = resolve;
    });
    auth.getUser
      .mockImplementationOnce(() => {
        enteredA();
        return new Promise((resolve) => {
          finishA = resolve;
        });
      })
      .mockImplementationOnce(() => {
        enteredB();
        return new Promise((resolve) => {
          finishB = resolve;
        });
      });
    const a = handleEngineAuthRejection('A', true);
    await readingA;
    session('B');
    const b = handleEngineAuthRejection('B', true);
    await readingB;
    const anotherB = handleEngineAuthRejection('B-again', true);
    finishA({ data: null, error: { code: 'session_not_found' } });
    expect(await a).toBe('unknown');
    finishB({ data: { user: { id: 'B' } }, error: null });
    expect(await b).toBe('alive');
    expect(await anotherB).toBe('alive');
    expect(auth.getUser).toHaveBeenCalledTimes(2);
    expect(auth.signOut).not.toHaveBeenCalled();
  });
  it('a still current definitively revoked A signs out locally', async () => {
    auth.getUser.mockResolvedValue({ data: null, error: { code: 'session_not_found' } });
    auth.refreshSession.mockResolvedValue({
      data: null,
      error: { code: 'refresh_token_not_found' },
    });
    auth.signOut.mockImplementation(async () => {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      return { error: null };
    });
    expect(await handleEngineAuthRejection('A', true)).toBe('revoked');
    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
  });
  it('missing identity is unknown and performs no auth or sign-out calls', async () => {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    expect(await handleEngineAuthRejection('missing', true)).toBe('unknown');
    expect(auth.getUser).not.toHaveBeenCalled();
    expect(auth.signOut).not.toHaveBeenCalled();
  });
  it('a deferred local sign-out rejection cannot clear a newly signed-in B', async () => {
    let fail!: (reason: Error) => void, entered!: () => void;
    const signingOut = new Promise<void>((resolve) => {
      entered = resolve;
    });
    auth.getUser.mockResolvedValue({ data: null, error: { code: 'session_not_found' } });
    auth.refreshSession.mockResolvedValue({
      data: null,
      error: { code: 'refresh_token_not_found' },
    });
    auth.signOut.mockImplementation(() => {
      entered();
      return new Promise((_resolve, reject) => {
        fail = reject;
      });
    });
    const result = handleEngineAuthRejection('A', true);
    await signingOut;
    session('B');
    fail(new Error('SDK sign-out failure'));
    expect(await result).toBe('unknown');
    expect(JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY)!).user.id).toBe('B');
  });
});
