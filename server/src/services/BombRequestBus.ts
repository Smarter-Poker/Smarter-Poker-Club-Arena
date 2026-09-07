/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ONE CHANNEL FOR EVERY MANUAL BOMB REQUEST (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS REPLACES
 *
 * `ServerTableEngineBase.subscribeManualBomb()` opened a Supabase Realtime
 * channel named `table:<tableId>` FOR EVERY BOMB-POT TABLE and joined it, so
 * the engine could hear the `bomb_pot_manual_requested` broadcast that
 * `fn_request_manual_bomb_pot` sends when an operator presses the button.
 *
 * One engine process holds ONE Realtime socket, and a socket has a hard cap of
 * 100 channels. With 76 bomb-pot tables open and a channel per live tournament
 * as well, the engine sat permanently over that cap: measured 2026-09-06,
 * 123,219 `ChannelRateLimitReached: Too many channels` errors in 24 hours -
 * roughly 1.4 every second, continuously, because every refused join is
 * retried. Past the cap the joins simply did not exist, so an unknown share of
 * bomb-pot tables were not listening at all.
 *
 * It also cost the thing this file was written to fix. Supabase Realtime runs
 * the channel layer and the WAL replication poller inside the SAME Elixir node,
 * so a rejected-join loop at 1.4/s is CPU taken from a poller that was already
 * failing to keep up (22.9 s of database time per 15 s of WAL).
 *
 * HOW IT WORKS NOW
 *
 * ONE channel, `engine:bomb-requests`, opened lazily the first time any table
 * asks and closed when the last one goes away. Every request carries its
 * `table_id` in the payload and is dispatched to the handler registered for
 * that table. 76 channels become 1; the cap stops being reachable.
 *
 * WHY A BROADCAST AT ALL, given it is best-effort: it is the FAST path. The
 * durable path is the `tables.bomb_pot_manual_pending` column, which
 * `fn_request_manual_bomb_pot` writes in the same transaction and the engine
 * re-reads on its throttled config refresh. An engine that restarted between
 * the click and the hand, or that never heard the broadcast, still fires the
 * bomb - just on the next refresh instead of instantly. Nothing here may
 * therefore be allowed to throw into a dealing loop.
 *
 * ORDERING NOTE. The database side of this change (broadcasting to
 * `engine:bomb-requests` instead of `table:<id>`) applies the moment its
 * migration lands, while the engine deploys on the next push to `server/**`.
 * In the window between the two, requests go to a topic nothing is listening
 * on and arrive via the column read instead. That degradation is the reason
 * the column exists and is why the two halves do not need to be simultaneous.
 */

import { supabase } from './supabase/client.js';

/** The one topic every manual bomb request is announced on. */
export const BOMB_REQUEST_TOPIC = 'engine:bomb-requests';

/** The broadcast event name, unchanged from the per-table channel it replaces. */
export const BOMB_REQUEST_EVENT = 'bomb_pot_manual_requested';

type Handler = () => void;

/** tableId -> the engine callback that marks a manual bomb as pushed. */
const handlers = new Map<string, Handler>();

/**
 * The single shared channel, or null when nobody is listening.
 *
 * Typed as the object `supabase.channel()` returns rather than as
 * `{ unsubscribe }`, because releasing it goes through
 * `supabase.removeChannel(ch)` and that needs the channel itself. See
 * `releaseChannel`.
 */
let channel: ReturnType<typeof supabase.channel> | null = null;

/**
 * Drop the shared channel from the client's registry and forget it.
 *
 * ═══ UNSUBSCRIBE IS NOT REMOVE (2026-09-06) ════════════════════════════════
 *
 * This used to call `channel.unsubscribe()`. That leaves the socket, but it
 * leaves the channel OBJECT in `supabase.getChannels()` - and
 * `supabase.channel(topic)` does not de-duplicate by topic, it appends. So
 * every open/close cycle of this bus stranded one dead entry under
 * `engine:bomb-requests`, and the next `ensureChannel()` created a SECOND
 * live channel on a topic that already had one.
 *
 * On a platform where bomb-pot tables open and close all day that accumulates
 * for the life of the process, against a socket whose hard cap of 100
 * channels is the exact thing this file was written to stop hitting - the
 * same leak in a smaller shape. `TournamentManagerBase.cleanupBroadcastChannel`
 * already went through `removeChannel` for this reason; this is the other half
 * of it.
 *
 * `removeChannel` unsubscribes as part of its own work, so nothing is skipped
 * by not calling `unsubscribe()` first.
 */
function releaseChannel(ch: ReturnType<typeof supabase.channel>): void {
  if (channel === ch) channel = null;
  try {
    void Promise.resolve(supabase.removeChannel(ch)).catch(() => {
      /* a channel that will not release cannot hold up a table shutdown */
    });
  } catch {
    /* nor can one that throws on the way out */
  }
}

/**
 * Open the shared channel if it is not already open.
 *
 * A failure to subscribe is survivable and deliberately not retried here: the
 * throttled column read is the backstop, and a retry loop against a Realtime
 * service that is refusing joins is precisely the behaviour this file removes.
 *
 * A TERMINAL status does release the handle, though, so the NEXT table to ask
 * opens a fresh one. That is recovery without a loop: `ensureChannel` is only
 * ever reached from `subscribeBombRequests`, which a table calls when it
 * starts and on its throttled config refresh. Without this, one
 * `CHANNEL_ERROR` left `channel` non-null for the life of the process and the
 * fast path was gone until the next deploy, silently - the shape 10.86 is
 * about: a handle that reads as open because nothing said otherwise.
 */
function ensureChannel(): void {
  if (channel) return;
  try {
    const ch = supabase
      .channel(BOMB_REQUEST_TOPIC)
      .on('broadcast', { event: BOMB_REQUEST_EVENT }, (message: unknown) => {
        try {
          const payload = (message as { payload?: { table_id?: unknown } } | null)?.payload;
          const tableId = typeof payload?.table_id === 'string' ? payload.table_id : null;
          if (!tableId) return;
          handlers.get(tableId)?.();
        } catch {
          /* a malformed broadcast must never reach a dealing loop */
        }
      });
    channel = ch;
    void ch.subscribe((status: string) => {
      // CLOSED is also what a deliberate release reports, and by then
      // `channel` is already null or another object, so releaseChannel's
      // identity check makes this a no-op rather than a double removal.
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (channel === ch) {
          console.warn(`[BombPot] shared bomb-request channel ${status}; releasing the handle`);
          releaseChannel(ch);
        }
      }
    });
  } catch (err) {
    console.warn('[BombPot] shared bomb-request channel failed to open:', err);
    channel = null;
  }
}

/**
 * Listen for manual bomb requests aimed at one table.
 *
 * Idempotent per table: registering twice replaces the handler rather than
 * opening anything new.
 */
export function subscribeBombRequests(tableId: string, onRequested: Handler): void {
  if (!tableId) return;
  handlers.set(tableId, onRequested);
  ensureChannel();
}

/**
 * Stop listening for one table, and release the shared channel once the last
 * table has gone. Safe to call for a table that never registered.
 */
export function unsubscribeBombRequests(tableId: string): void {
  handlers.delete(tableId);
  if (handlers.size > 0 || !channel) return;
  releaseChannel(channel);
}

/** Test seam: how many tables are currently listening. */
export function bombRequestListenerCount(): number {
  return handlers.size;
}

/** Test seam: whether the one shared channel is open. */
export function bombRequestChannelOpen(): boolean {
  return channel !== null;
}
