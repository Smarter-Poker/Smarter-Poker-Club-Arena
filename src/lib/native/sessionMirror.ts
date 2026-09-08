/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SESSION MIRROR — the session survives the webview's storage (native only)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The session lives in localStorage under 'smarter-poker-auth', and three
 * synchronous readers depend on that (src/lib/supabase.ts, authUtils.ts,
 * cachedIdentity.ts) - it is what lets the lobby paint before the SDK has
 * finished asking about the session. In a webview that storage works, and
 * after the in-app AuthPage signs a player in it persists across launches.
 * But it is the WEBVIEW's storage: iOS can evict website data under storage
 * pressure, and "Clear website data" wipes it. When that happens the player
 * is signed out for no reason they can see.
 *
 * So the session is mirrored, write-through, into native app storage
 * (@capacitor/preferences: UserDefaults / SharedPreferences, which belong to
 * the app and are not website data), and restored from there at boot BEFORE
 * any of the three readers runs. localStorage stays the live store, so none
 * of the readers change and the web is untouched.
 *
 * Loaded only from the native boot path. Never imported by the web bundle.
 */

import { AUTH_STORAGE_KEY } from '../authUtils';

const MIRROR_KEY = 'ca.session.v1';

/**
 * Boot: if the webview has no session but the app store does, put it back.
 * Returns true when a session was restored. Must run before initIdentityDNA().
 */
export async function restoreSessionFromNativeStore(): Promise<boolean> {
  try {
    if (localStorage.getItem(AUTH_STORAGE_KEY)) return false;
    const { Preferences } = await import('@capacitor/preferences');
    const { value } = await Preferences.get({ key: MIRROR_KEY });
    if (!value) return false;
    // Only a well-formed session goes back; a corrupt mirror is dropped.
    const parsed = JSON.parse(value) as { access_token?: unknown; refresh_token?: unknown };
    if (typeof parsed?.access_token !== 'string' || typeof parsed?.refresh_token !== 'string') {
      await Preferences.remove({ key: MIRROR_KEY });
      return false;
    }
    localStorage.setItem(AUTH_STORAGE_KEY, value);
    return true;
  } catch {
    return false;
  }
}

let mirroring = false;

/**
 * After boot: keep the app store equal to the webview store. The SDK writes
 * localStorage first and then emits the auth event, so reading the raw
 * stored value at event time mirrors exactly what the SDK persisted.
 */
export async function startSessionMirror(): Promise<void> {
  if (mirroring) return;
  mirroring = true;
  const [{ supabase }, { Preferences }] = await Promise.all([
    import('../supabase'),
    import('@capacitor/preferences'),
  ]);
  const sync = async (): Promise<void> => {
    try {
      const raw = localStorage.getItem(AUTH_STORAGE_KEY);
      if (raw) await Preferences.set({ key: MIRROR_KEY, value: raw });
      else await Preferences.remove({ key: MIRROR_KEY });
    } catch {
      /* best effort */
    }
  };
  supabase.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') {
      void Preferences.remove({ key: MIRROR_KEY }).catch(() => {});
      return;
    }
    // INITIAL_SESSION, SIGNED_IN, TOKEN_REFRESHED, USER_UPDATED: the stored
    // value is already on disk by the time the event fires.
    void sync();
  });
  await sync();
}

/** Sign-out path: clear the mirror too (called from the native shell). */
export async function clearNativeSessionMirror(): Promise<void> {
  try {
    const { Preferences } = await import('@capacitor/preferences');
    await Preferences.remove({ key: MIRROR_KEY });
  } catch {
    /* best effort */
  }
}
