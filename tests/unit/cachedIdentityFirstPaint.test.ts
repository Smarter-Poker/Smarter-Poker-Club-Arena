/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE PLAYER'S OWN NAME AND FACE PAINT ON THE FIRST FRAME (2026-08-28)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Flash sweep: the header orb and the hero seat cold-opened as "Player" with
 * a generated monogram because the id needed to read the avatar cache only
 * arrived asynchronously. lib/cachedIdentity closes that loop by reading the
 * id synchronously from the persisted Supabase session and keying the cached
 * name/face to it. Pinned here: the id parse (both session shapes), the
 * per-account isolation, the merge semantics, and logout hygiene.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  cachedAuthUserId,
  hydrateIdentity,
  persistIdentity,
  clearCachedIdentity,
} from '../../src/lib/cachedIdentity';

const SSO = 'smarter-poker-auth';

describe('cachedAuthUserId', () => {
  beforeEach(() => localStorage.clear());

  it('reads the v2 session shape', () => {
    localStorage.setItem(SSO, JSON.stringify({ access_token: 'x', user: { id: 'user-1' } }));
    expect(cachedAuthUserId()).toBe('user-1');
  });

  it('reads the legacy wrapped shape', () => {
    localStorage.setItem(SSO, JSON.stringify({ currentSession: { user: { id: 'user-2' } } }));
    expect(cachedAuthUserId()).toBe('user-2');
  });

  it('answers null for no session, junk, or a shape without an id', () => {
    expect(cachedAuthUserId()).toBeNull();
    localStorage.setItem(SSO, 'not json {');
    expect(cachedAuthUserId()).toBeNull();
    localStorage.setItem(SSO, JSON.stringify({ user: { id: 42 } }));
    expect(cachedAuthUserId()).toBeNull();
  });
});

describe('hydrateIdentity / persistIdentity', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips name and avatar for the same account', () => {
    persistIdentity('user-1', { displayName: 'Dan', avatarUrl: 'https://x/a.png' });
    expect(hydrateIdentity('user-1')).toEqual({
      displayName: 'Dan',
      avatarUrl: 'https://x/a.png',
    });
  });

  it("never hands one account's identity to another — or to a guest", () => {
    persistIdentity('user-1', { displayName: 'Dan', avatarUrl: 'https://x/a.png' });
    expect(hydrateIdentity('user-2')).toEqual({ displayName: null, avatarUrl: null });
    expect(hydrateIdentity(null)).toEqual({ displayName: null, avatarUrl: null });
  });

  it('an avatar-only update keeps the cached name (and vice versa)', () => {
    persistIdentity('user-1', { displayName: 'Dan', avatarUrl: 'https://x/a.png' });
    persistIdentity('user-1', { avatarUrl: 'https://x/b.png' });
    expect(hydrateIdentity('user-1')).toEqual({
      displayName: 'Dan',
      avatarUrl: 'https://x/b.png',
    });
    persistIdentity('user-1', { displayName: 'Daniel' });
    expect(hydrateIdentity('user-1').avatarUrl).toBe('https://x/b.png');
    expect(hydrateIdentity('user-1').displayName).toBe('Daniel');
  });

  it('a different account replaces the entry wholesale — no field bleed', () => {
    persistIdentity('user-1', { displayName: 'Dan', avatarUrl: 'https://x/a.png' });
    persistIdentity('user-2', { displayName: 'Eve' });
    expect(hydrateIdentity('user-2')).toEqual({ displayName: 'Eve', avatarUrl: null });
    expect(hydrateIdentity('user-1')).toEqual({ displayName: null, avatarUrl: null });
  });

  it('logout forgets the identity', () => {
    persistIdentity('user-1', { displayName: 'Dan', avatarUrl: 'https://x/a.png' });
    clearCachedIdentity();
    expect(hydrateIdentity('user-1')).toEqual({ displayName: null, avatarUrl: null });
  });
});
