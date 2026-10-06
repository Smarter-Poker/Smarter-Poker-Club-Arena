/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A PERSON IN THE ARENA HAS A HEARTBEAT (2026-10-05)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * "Online" has one definition (src/lib/profilePresence.ts): profiles.is_online
 * AND a last_seen heartbeat under five minutes old, answered by
 * fn_profile_presence. Horses keep that heartbeat from pg_cron (migration
 * 20261005174041). Until today only the World Hub's messenger wrote it for
 * people - Club Arena wrote neither column - so a person who used only the
 * arena read "offline" everywhere while a horse could read "online". That
 * difference alone told a person from a house player.
 *
 * So the signed-in player now beats through the same door the messenger
 * uses, fn_update_presence(own id, online), which stamps is_online and
 * last_seen together. This is the ONLY place in src that writes presence
 * (tests/presence-has-one-definition.law.test.ts); nothing writes
 * profiles.is_online directly, because a flag without a fresh last_seen is
 * exactly the stale-true row the one definition exists to ignore.
 */
import { supabase } from './supabase';
import { reportError } from '../utils/errorReporter';

/** How often a visible arena tab beats. Well inside the five-minute window. */
export const PRESENCE_HEARTBEAT_MS = 120_000;

/*
 * SIGN-OUT IS THE LAST BEAT (2026-10-05 audit). signalOffline runs while the
 * session still exists, and the signed-in tab keeps its interval until the
 * auth listener clears the user, which can be seconds later. A beat that fired
 * in that gap - or one already in flight that landed after the offline beat -
 * stamped the player online again, and they read online for five more minutes
 * after signing out. So signing out silences that account's beats until it
 * signs in again (resumePresence, called when the heartbeat starts for a
 * user), and the offline beat waits for any beat already sent.
 */
let silenced: string | null = null;
let inFlight: Promise<unknown> | null = null;

/** A heartbeat is starting for this user: a fresh sign-in may beat again. */
export function resumePresence(userId: string): void {
  if (silenced === userId) silenced = null;
}

/** One beat: the signed-in player is (or is no longer) here. */
export async function sendPresence(userId: string, online: boolean): Promise<void> {
  if (online && silenced === userId) return;
  /* Promise.resolve runs the request exactly once; the Supabase builder would
     send it again for every `then`, and the offline beat awaits this one. */
  const request = Promise.resolve(
    supabase.rpc('fn_update_presence', {
      p_user_id: userId,
      p_is_online: online,
    })
  );
  if (online) inFlight = request;
  const { error } = await request;
  if (error) throw error;
}

/**
 * Sign-out's last beat: online false, while the session still exists to send
 * it. Bounded, and it never blocks or fails a sign-out - if it does not land,
 * the heartbeat simply goes stale and the player reads offline within five
 * minutes anyway.
 */
export async function signalOffline(userId: string, timeoutMs = 2_000): Promise<void> {
  silenced = userId;
  const pending = inFlight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        if (pending) await pending.catch(() => undefined);
        await sendPresence(userId, false);
      })(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch (e) {
    reportError(e, 'presenceHeartbeat.signalOffline');
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Test seam: forget any sign-out and in-flight beat. */
export function resetPresenceHeartbeatForTests(): void {
  silenced = null;
  inFlight = null;
}
