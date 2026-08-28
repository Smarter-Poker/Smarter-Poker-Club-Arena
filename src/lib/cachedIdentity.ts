/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * CACHED IDENTITY — the player's own name and face, before any network answers
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * 2026-08-28, first-paint flash sweep. Two of the most-seen surfaces in the
 * app cold-opened as somebody else:
 *
 *   - the GlobalHeader orb painted the monogram for the literal seed 'player'
 *     until supabase.auth resolved and the profile round trip returned;
 *   - the hero's own seat on the felt read "Player" with an empty avatar for
 *     the length of getAuthUser() PLUS a profiles query, on every table open.
 *
 * Both had the data cached one step away (useHeaderDataStore's 'ca-avatar-
 * cache' paints the avatar synchronously) but that cache is keyed by a user
 * id that itself only arrived asynchronously — a synchronous cache gated
 * behind an async key is still async.
 *
 * This module closes the loop:
 *
 *   cachedAuthUserId()  reads the user id SYNCHRONOUSLY from the persisted
 *                       Supabase session ('smarter-poker-auth', the SSO key
 *                       shared with the World Hub). It is a hint for painting
 *                       only — never treat it as authentication.
 *   hydrateIdentity()   returns the cached display name + avatar URL for that
 *                       id, and ONLY for that id. A bare value under a shared
 *                       key would flash the previous account's face at
 *                       whoever logs in next on a shared device.
 *   persistIdentity()   called by whoever fetched the real profile.
 *
 * The database remains the truth: every consumer still fetches and then
 * overwrites both its state and this cache. Entitlements (VIP, frames,
 * auras) are deliberately NOT cached here — see useHeaderDataStore's note on
 * lapsed cosmetics.
 */

const SSO_AUTH_KEY = 'smarter-poker-auth'; // STORAGE_KEYS.SSO_AUTH
const IDENTITY_KEY = 'ca-identity-cache';

interface CachedIdentity {
  u?: string;
  n?: string;
  a?: string;
}

/**
 * The signed-in user's id, synchronously, from the persisted session — or
 * null when no session is stored or the shape is unreadable. Handles both
 * the supabase-js v2 shape ({ user: { id } }) and the legacy wrapped shape
 * ({ currentSession: { user: { id } } }).
 */
export function cachedAuthUserId(): string | null {
  try {
    const raw = localStorage.getItem(SSO_AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as {
      user?: { id?: unknown };
      currentSession?: { user?: { id?: unknown } };
    };
    const id = parsed?.user?.id ?? parsed?.currentSession?.user?.id;
    return typeof id === 'string' && id ? id : null;
  } catch {
    return null;
  }
}

/** Cached name/avatar for userId, or nulls. Never another account's. */
export function hydrateIdentity(userId: string | null | undefined): {
  displayName: string | null;
  avatarUrl: string | null;
} {
  if (!userId) return { displayName: null, avatarUrl: null };
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    if (!raw) return { displayName: null, avatarUrl: null };
    const parsed = JSON.parse(raw) as CachedIdentity;
    if (parsed?.u !== userId) return { displayName: null, avatarUrl: null };
    return {
      displayName: typeof parsed.n === 'string' && parsed.n ? parsed.n : null,
      avatarUrl: typeof parsed.a === 'string' && parsed.a ? parsed.a : null,
    };
  } catch {
    return { displayName: null, avatarUrl: null };
  }
}

/**
 * Record what the database just said. Omitted fields keep their cached
 * value (so an avatar-only update cannot blank the name); a different user
 * id replaces the entry wholesale.
 */
export function persistIdentity(
  userId: string | null | undefined,
  identity: { displayName?: string | null; avatarUrl?: string | null }
): void {
  if (!userId) return;
  try {
    let previous: CachedIdentity = {};
    try {
      const raw = localStorage.getItem(IDENTITY_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CachedIdentity;
        if (parsed?.u === userId) previous = parsed;
      }
    } catch {
      /* corrupt previous entry: replace it */
    }
    const next: CachedIdentity = {
      u: userId,
      n: identity.displayName !== undefined ? identity.displayName || undefined : previous.n,
      a: identity.avatarUrl !== undefined ? identity.avatarUrl || undefined : previous.a,
    };
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode */
  }
}

/** Logout hygiene: forget the cached identity. */
export function clearCachedIdentity(): void {
  try {
    localStorage.removeItem(IDENTITY_KEY);
  } catch {
    /* unavailable */
  }
}
