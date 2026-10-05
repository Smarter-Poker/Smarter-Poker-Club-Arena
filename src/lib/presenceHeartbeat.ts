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

/** One beat: the signed-in player is (or is no longer) here. */
export async function sendPresence(userId: string, online: boolean): Promise<void> {
  const { error } = await supabase.rpc('fn_update_presence', {
    p_user_id: userId,
    p_is_online: online,
  });
  if (error) throw error;
}

/**
 * Sign-out's last beat: online false, while the session still exists to send
 * it. Bounded, and it never blocks or fails a sign-out - if it does not land,
 * the heartbeat simply goes stale and the player reads offline within five
 * minutes anyway.
 */
export async function signalOffline(userId: string, timeoutMs = 2_000): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      sendPresence(userId, false),
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
