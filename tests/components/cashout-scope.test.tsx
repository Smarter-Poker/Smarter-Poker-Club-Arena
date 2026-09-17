import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, renderHook, cleanup } from '@testing-library/react';
const identity = vi.hoisted(() => ({
  userId: null as string | null,
  auth: new Set<(event: { payload: { isAuthenticated: boolean; userId?: string } }) => void>(),
}));
vi.mock('../../src/core/IdentityDNA', () => ({ getIdentityDNAStatus: () => ({
  loaded: !!identity.userId, authenticated: !!identity.userId, userId: identity.userId,
}) }));
vi.mock('../../src/core/MasterBus', () => ({ masterBus: {
  emit: vi.fn(), subscribe: vi.fn((name, handler) => {
    if (name === 'AUTH_STATE_CHANGED') identity.auth.add(handler);
    return () => { identity.auth.delete(handler); };
  }),
} }));
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
vi.mock('../../src/utils/clubIdResolver', () => ({ resolveClubUUID: async (id: string) => id }));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
import { useCashoutScope, useCashoutScopeKey } from '../../src/hooks/useCashoutScope';
const firstAccount = '10000000-0000-4000-8000-000000000001';
const otherAccount = '20000000-0000-4000-8000-000000000001';
function signIn(userId: string | null) {
  identity.userId = userId;
  for (const handler of identity.auth) handler({ payload: { isAuthenticated: !!userId, userId: userId ?? undefined } });
}
beforeEach(() => { signIn(null); signIn(firstAccount); });
afterEach(cleanup);
it('permanently invalidates an old account/club generation including A to B to A', () => {
  const { result, rerender, unmount } = renderHook(({ account, club }) => useCashoutScope(account, club), {
    initialProps: { account: firstAccount, club: 'first' },
  });
  const first = result.current;
  rerender({ account: firstAccount, club: 'first' });
  expect(result.current).toBe(first);
  expect(first()).toBe(true);
  signIn(otherAccount);
  rerender({ account: otherAccount, club: 'second' });
  expect(first()).toBe(false);
  const second = result.current;
  signIn(firstAccount);
  rerender({ account: firstAccount, club: 'first' });
  expect(first()).toBe(false);
  expect(second()).toBe(false);
  const current = result.current;
  expect(current()).toBe(true);
  unmount();
  expect(current()).toBe(false);
});

it('observes an actual auth epoch change even without an intermediate React render', () => {
  const { result, rerender } = renderHook(() => useCashoutScope(firstAccount, 'club'));
  const original = result.current;
  signIn(otherAccount); signIn(firstAccount);
  expect(original()).toBe(false);
  rerender();
  expect(result.current).not.toBe(original);
  expect(result.current()).toBe(true);
  expect(original()).toBe(false);
});

it('keeps unavailable identity stable until a loaded account can be captured', () => {
  signIn(null);
  const { result, rerender } = renderHook(() => useCashoutScope(firstAccount, 'club'));
  const unavailable = result.current;
  expect(unavailable()).toBe(false);
  rerender();
  expect(result.current).toBe(unavailable);
  signIn(firstAccount); rerender();
  expect(result.current()).toBe(true);
  expect(unavailable()).toBe(false);
});

it('the outer key changes on an actual batched auth ABA without a caller rerender and unsubscribes cleanly', () => {
  const before = identity.auth.size;
  const { result, unmount } = renderHook(() => useCashoutScopeKey(firstAccount, 'club'));
  const original = result.current;
  expect(identity.auth.size).toBe(before + 1);
  act(() => { signIn(otherAccount); signIn(firstAccount); });
  expect(result.current).not.toBe(original);
  const next = result.current;
  act(() => signIn(firstAccount));
  expect(result.current).toBe(next);
  unmount(); expect(identity.auth.size).toBe(before);
});

it('the outer key remains stable through repeated unavailable events and ordinary renders', () => {
  signIn(null);
  const { result, rerender } = renderHook(() => useCashoutScopeKey(firstAccount, 'club'));
  const unavailable = result.current;
  act(() => { signIn(null); signIn(null); }); rerender();
  expect(result.current).toBe(unavailable);
  act(() => signIn(firstAccount));
  expect(result.current).not.toBe(unavailable);
  const ready = result.current; rerender(); expect(result.current).toBe(ready);
  act(() => signIn(null));
  expect(result.current).not.toBe(ready);
  const retired = result.current; act(() => signIn(null)); rerender(); expect(result.current).toBe(retired);
});
