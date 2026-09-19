/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  GLOBAL WAITLIST LISTENER — App-wide auto-seating (v3.0 — Hardened)
 * ═══════════════════════════════════════════════════════════════════════════════
 * Runs in the background (App.tsx) and listens for seat vacancies across all tables.
 * If a seat opens up and the active user is #1 on the waitlist, it auto-navigates.
 *
 * v3.0 Improvements:
 * - Exponential backoff on reconnect (1s → 2s → 4s → 8s → 16s → 30s cap)
 * - Max retry limit (5 attempts) to prevent infinite reconnection storms
 * - Channel factory registration with MasterBus for health-monitor auto-recovery
 * - cleanedUp guard to prevent zombie reconnects after unmount
 * - Removed unreliable 'system' event listener (subscribe callback handles all states)
 */

import { useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../../lib/supabase';
import { useAuthUser } from '../../hooks/useAuthUser';
import { masterBus } from '../../core/MasterBus';
import { useToast } from './Toast';
import { reportError } from '../../utils/errorReporter';
import { decideSeatOffer, holdDeadline } from './waitlistSeatOffer';

const WAITLIST_CHANNEL_KEY = 'global-waitlist-auto-seat';

const MAX_RETRIES = 5;
const BACKOFF_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000]; // Exponential backoff, capped at 30s

export default function GlobalWaitlistListener() {
  const { user } = useAuthUser();
  const navigate = useNavigate();
  const toast = useToast();
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryCountRef = useRef(0);
  const cleanedUpRef = useRef(false);

  /**
   * The table ids this user is actually waiting on. Empty for almost everybody,
   * almost all of the time - which is the whole point (see setupChannel).
   */
  const watchedTableIdsRef = useRef<string[]>([]);

  /**
   * THE OFFER WE HAVE ALREADY SHOWN, per table, keyed to its DEADLINE.
   *
   * This exists so the seat offer does not depend on `payload.old`. Postgres
   * Changes only sends the columns in the table's REPLICA IDENTITY as the old
   * row, and Supabase documents that an RLS-enabled table sends only the
   * primary key there - `table_waitlist` is RLS-enabled, so `old.status` cannot
   * be relied on. The two branches below used to read exactly that:
   *
   *   old.status === 'notified'   gated the thaw re-seed, so it never fired
   *   old.status !== 'notified'   gated the offer, and `undefined !== 'notified'`
   *                               is always true, so it fired on EVERY touch
   *
   * which is a missed deadline update and a duplicate toast, from the same
   * missing field. Remembering what we showed makes both decisions locally and
   * leaves the answer correct whether or not the old row ever arrives.
   */
  const offeredHoldsRef = useRef<Map<string, string>>(new Map());

  /**
   * Re-read the authoritative FIFO position for ONE watched table and publish
   * it on the bus. Bounded: one table, one read, and only for a table this user
   * is actually queued on, so an unfilterable or unrelated event cannot turn
   * into a fan of queries. Emits only for a genuinely waiting row - a
   * 'notified' row is position 0 and belongs to the seat-offer path, which owns
   * the banner while a hold is live.
   */
  const refreshQueuePosition = useCallback(async (tableId?: string | number | null) => {
    if (!tableId || cleanedUpRef.current) return;
    const id = String(tableId);
    if (!watchedTableIdsRef.current.includes(id)) return;
    try {
      const { waitlistService } = await import('../../services/WaitlistService');
      const pos = await waitlistService.getPosition(id);
      if (pos && pos.status === 'waiting' && pos.position > 0) {
        masterBus.emit('WAITLIST_POSITION_CHANGED', {
          tableId: id,
          position: pos.position,
          tableName: 'Unknown',
        });
      }
    } catch (err) {
      reportError(err, 'GlobalWaitlistListener.Error_checking_waitlist_position');
    }
  }, []);

  // ─── Core subscription logic (extracted for reuse on reconnect) ───
  const setupChannel = useCallback(() => {
    if (!user?.id || cleanedUpRef.current) return;

    // Clean up any prior channel before creating a new one.
    // FORCED on purpose (2026-08-28): this is a reconnect path that must end
    // up on a genuinely FRESH socket. Under the new refcount a plain release
    // would merely decrement, and getOrCreateChannel below would then hand
    // back the very channel this line meant to discard.
    masterBus.forceRemoveRegisteredChannel(WAITLIST_CHANNEL_KEY);

    /**
     * ═══════════════════════════════════════════════════════════════════════
     * THIS SUBSCRIPTION USED TO HAVE NO FILTER AT ALL.
     * ═══════════════════════════════════════════════════════════════════════
     *
     * This component is mounted in App.tsx for EVERY authenticated user, and it
     * listened to `table_seats` DELETE across the entire platform. Every seat
     * vacated anywhere - and the horse fleet manager cycles seats continuously -
     * was delivered to every connected client, and each delivery then ran a
     * `table_waitlist` query. With N users online and M vacancies a minute that
     * is N x M realtime messages AND N x M database queries per minute, forever,
     * to serve a feature that matters only to someone actually queuing.
     *
     * It is the same shape as the unfiltered listeners removed in April for
     * billing (~80% of 86M realtime messages), and it survived that cleanup.
     *
     * Now scoped to the tables this user is genuinely waitlisted on:
     *   - nobody on a waitlist  -> NO table_seats subscription at all, which is
     *     the overwhelming majority of sessions;
     *   - on a waitlist         -> `table_id=in.(...)`, typically one to three
     *     tables instead of every table in existence.
     *
     * The behaviour a player sees is identical: a seat opening at a table they
     * are NOT queued for could never have done anything except cost a query -
     * the handler's own `.eq('user_id', ...).eq('table_id', ...)` lookup
     * returned nothing and it fell through.
     */
    const watched = watchedTableIdsRef.current;
    if (watched.length === 0) {
      console.debug('[GlobalWaitlistListener] No waitlist entries - not subscribing');
      return;
    }

    const channel = masterBus.getOrCreateChannel(WAITLIST_CHANNEL_KEY);
    channel.on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'table_seats',
        filter: `table_id=in.(${watched.join(',')})`,
      },
      async () => {
        /* THIS HANDLER CANNOT READ THE TABLE OFF THE EVENT, and no publication
           change would let it. Two documented Postgres Changes behaviours:

             1. DELETE events are not filterable. The `table_id=in.(...)` filter
                above is accepted and then ignored for DELETE, so if table_seats
                were ever published this would receive every seat vacated
                anywhere on the platform.
             2. The old row carries only the REPLICA IDENTITY columns, and for
                an RLS-enabled table Supabase documents that as the primary key
                alone. table_seats is RLS-enabled with primary key `id`, so
                `old.table_id` is undefined - and raising the table to REPLICA
                IDENTITY FULL does not change that while RLS is on.

           It read `old.table_id` and returned early when it was missing, so it
           was a guaranteed no-op wearing the shape of a working handler.

           The watched set is small - the tables THIS user is queued on - and it
           is already known locally, so refreshing those positions needs nothing
           from the payload. That is correct for an unfilterable DELETE too: an
           unrelated table's event costs one bounded refresh of the user's own
           queue rather than a wrong answer.

           It still cannot fire today: table_seats is not published (14,582,928
           writes, which is why the trim keeps it out). It is kept rather than
           deleted because the authoritative position refresh below is the
           behaviour a future carrier has to drive, and it is now correct for
           one. The live position signal comes from table_waitlist changes. */
        const watchedNow = [...watchedTableIdsRef.current];
        if (watchedNow.length === 0) return;

        /* Dan 2026-08-26 waitlist fix — this used to AUTO-NAVIGATE whoever
           read `position === 1` off their own row. That column is NOT NULL
           DEFAULT 1 and is never renumbered, so effectively EVERYONE was
           "#1", stale left/seated rows included, and players got yanked to
           tables they had no claim on. The seat OFFER is now driven by the
           engine's authoritative claim — the row flipping to 'notified',
           handled on the watch channel below. This handler only refreshes
           the queue-position badge, from a real FIFO count. */
        try {
          const { waitlistService } = await import('../../services/WaitlistService');
          for (const tableId of watchedNow) {
            const pos = await waitlistService.getPosition(tableId);
            if (pos && pos.status === 'waiting' && pos.position > 0) {
              masterBus.emit('WAITLIST_POSITION_CHANGED', {
                tableId,
                position: pos.position,
                tableName: 'Unknown',
              });
            }
          }
        } catch (err) {
          reportError(err, 'GlobalWaitlistListener.Error_checking_waitlist_position');
        }
      }
    );

    // ── SEAT GRANTED ── when hero is INSERTed into a seat on a waited table,
    // emit WAITLIST_CHANGED so ClubHomePage re-queries and clears the badge.
    // Previously only DELETE was watched, so badges stuck when the engine seated
    // someone via INSERT (no preceding DELETE on a fresh seat slot).
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'table_seats',
        filter: `table_id=in.(${watched.join(',')})`,
      },
      (payload) => {
        if ((payload.new as { user_id?: string })?.user_id === user.id) {
          masterBus.emit('WAITLIST_CHANGED', undefined as void);
        }
      }
    );

    /* ── THE QUEUE POSITION, FROM A TABLE THAT IS ACTUALLY PUBLISHED ────────
       Both table_seats handlers above are dead and are going to stay dead: the
       table carries 14,582,928 writes and publishing it to move a badge is the
       exact trade the 2026-09-06 trim exists to refuse.

       But a vacated seat was only ever a PROXY for the thing the badge shows.
       FIFO position is computed from table_waitlist, and that is where it
       changes: somebody ahead leaves, is notified, or claims their seat. Those
       are table_waitlist writes, and table_waitlist IS published - it is one of
       the twenty-three restored on 2026-09-19, with 15 recorded writes, four
       live rows and eight columns. The signal is both cheaper and more
       authoritative than the seat event it replaces.

       Scope: the tables THIS user is queued on. Other players' rows arrive
       because `waitlist_public_queue_read` grants authenticated users SELECT on
       any row whose status is 'waiting' or 'notified', so postgres_changes
       passes them - the queue is deliberately public, and nothing private is
       carried here. INSERT and UPDATE only: those accept a filter, and their
       `new` row is complete regardless of replica identity. DELETE is left to
       the handler above precisely because it can be neither filtered nor read.

       The user's own row also matches this filter, and that is fine: one bounded
       position read is the correct response either way. */
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'table_waitlist',
        filter: `table_id=in.(${watched.join(',')})`,
      },
      (payload) => {
        void refreshQueuePosition((payload.new as { table_id?: string } | undefined)?.table_id);
      }
    );
    channel.on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'table_waitlist',
        filter: `table_id=in.(${watched.join(',')})`,
      },
      (payload) => {
        void refreshQueuePosition((payload.new as { table_id?: string } | undefined)?.table_id);
      }
    );

    channel.subscribe((status) => {
      if (cleanedUpRef.current) return;

      if (status === 'SUBSCRIBED') {
        console.debug('[GlobalWaitlistListener] Connected and listening');
        retryCountRef.current = 0; // Reset on success
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        if (retryCountRef.current >= MAX_RETRIES) {
          console.debug(
            `[GlobalWaitlistListener] Max retries (${MAX_RETRIES}) reached - giving up. Will rely on MasterBus health monitor for recovery.`
          );
          return;
        }

        const delay = BACKOFF_DELAYS[Math.min(retryCountRef.current, BACKOFF_DELAYS.length - 1)];
        console.debug(
          `[GlobalWaitlistListener] ${status} - retry ${retryCountRef.current + 1}/${MAX_RETRIES} in ${delay}ms`
        );
        retryCountRef.current++;

        if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = setTimeout(() => {
          if (!cleanedUpRef.current) {
            setupChannel();
          }
        }, delay);
      }
    });
  }, [user?.id, navigate, toast, refreshQueuePosition]);

  /**
   * Keep `watchedTableIdsRef` in step with the user's actual waitlist, and
   * re-subscribe whenever the SET of tables changes.
   *
   * This is what makes the filter above safe. Without it, joining a waitlist
   * after page load would leave the listener scoped to the old set (or not
   * subscribed at all) and the auto-seat would silently stop working - which
   * would be a worse bug than the cost it fixes.
   *
   * `table_waitlist` filtered to `user_id=eq.<uid>` is a handful of rows for one
   * person, not a platform-wide feed, so this listener is cheap in exactly the
   * way the old one was not.
   */
  const refreshWatchedTables = useCallback(async () => {
    if (!user?.id || cleanedUpRef.current) return;
    try {
      // ACTIVE rows only (2026-08-26): left/seated/cleared/expired rows kept
      // dead tables in the watched set — and kept "You Are Waitlisted" alive
      // for queues the player was no longer in.
      const { data, error } = await supabase
        .from('table_waitlist')
        .select('table_id, status, hold_expires_at, notified_at')
        .eq('user_id', user.id)
        .in('status', ['waiting', 'notified']);
      if (error) {
        reportError(error, 'GlobalWaitlistListener.refreshWatchedTables');
        return;
      }
      type WatchedRow = {
        table_id: string;
        status?: string | null;
        hold_expires_at?: string | null;
        notified_at?: string | null;
      };
      const rows = (data || []) as WatchedRow[];

      /* SEED THE OFFER MEMORY FROM THE AUTHORITATIVE READ.
         Two things depend on this. A player who reloads mid-hold gets the
         banner back with the real remaining time, instead of nothing until the
         next UPDATE happens to arrive. And a hold we have already recorded will
         not toast again when the thaw moves its deadline: the handler re-emits
         for the banner and stays quiet, which is what the 2026-09-01 thaw fix
         intended before old.status silently disabled it. */
      for (const row of rows) {
        if (!row.table_id || row.status !== 'notified') continue;
        const tableId = String(row.table_id);
        const deadline = holdDeadline(row);
        if (offeredHoldsRef.current.get(tableId) === (deadline ?? '')) continue;
        offeredHoldsRef.current.set(tableId, deadline ?? '');
        masterBus.emit('WAITLIST_SEAT_OFFERED', {
          tableId,
          tableName: '',
          holdExpiresAt: deadline,
        });
      }
      /* A row that is no longer notified must forget its offer, or a genuine
         later re-offer on the same table would be deduped into silence. */
      const stillNotified = new Set(
        rows.filter((r) => r.status === 'notified').map((r) => String(r.table_id))
      );
      for (const tableId of [...offeredHoldsRef.current.keys()]) {
        if (!stillNotified.has(tableId)) offeredHoldsRef.current.delete(tableId);
      }

      const next = Array.from(new Set(rows.map((r) => r.table_id).filter(Boolean))).sort();
      const prev = watchedTableIdsRef.current;
      const changed = next.length !== prev.length || next.some((id, i) => id !== prev[i]);
      if (!changed) return;
      watchedTableIdsRef.current = next;
      retryCountRef.current = 0;
      setupChannel();
    } catch (err) {
      reportError(err, 'GlobalWaitlistListener.refreshWatchedTables');
    }
  }, [user?.id, setupChannel]);

  useEffect(() => {
    cleanedUpRef.current = false;
    retryCountRef.current = 0;

    // Register channel factory so MasterBus health monitor can auto-recover
    masterBus.registerChannelFactory(WAITLIST_CHANNEL_KEY, () => {
      retryCountRef.current = 0; // Reset retries on health-monitor recovery
      setupChannel();
    });

    // Seed the watched set, then subscribe. setupChannel is a no-op until the
    // set is known, so this ordering matters.
    void refreshWatchedTables();

    // A user-scoped listener on their OWN waitlist rows: joining or leaving a
    // queue re-scopes the seat listener above. Cheap - one person's rows.
    const watchKey = `${WAITLIST_CHANNEL_KEY}-watch`;
    let watchChannel: ReturnType<typeof masterBus.getOrCreateChannel> | null = null;
    if (user?.id) {
      watchChannel = masterBus.getOrCreateChannel(watchKey);
      watchChannel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'table_waitlist',
            filter: `user_id=eq.${user.id}`,
          },
          (payload) => {
            /* ── THE SEAT OFFER (Dan 2026-08-26) ──────────────────────────
               The engine claims the queue head by flipping the row to
               'notified' (notifyWaitlistSeatOpen). That UPDATE lands here on
               the player's own realtime channel — the authoritative "your
               seat is open" signal. Show a clickable popup that takes them
               straight to their table; the push notification and the
               notifications-page row are the out-of-app copies of the same
               offer. */
            type WaitlistPayload = {
              new?: {
                status?: string;
                table_id?: string | number;
                notified_at?: string | null;
                hold_expires_at?: string | null;
              };
              eventType?: string;
            };
            const newRow = (payload as WaitlistPayload).new;

            /* ── THE SEAT OFFER, DECIDED WITHOUT THE OLD ROW ──────────────
               The engine claims the queue head by flipping the row to
               'notified' (notifyWaitlistSeatOpen). That UPDATE lands here on
               the player's own realtime channel: the authoritative "your seat
               is open" signal.

               What decides NEW OFFER versus DEADLINE MOVED is now what we
               remember showing, not `old.status`, which an RLS-enabled table
               does not reliably send (see offeredHoldsRef). Three outcomes:

                 nothing remembered      -> a new offer. Banner, name, toast.
                 remembered, new deadline -> the thaw moved the hold. Re-emit so
                                             the countdown re-seeds, no toast:
                                             the player already has this offer.
                 remembered, same deadline -> a duplicate or an unrelated touch
                                             on the row. Ignored.

               The third case is new protection: a redelivery, or any other
               UPDATE that leaves the row notified with the same deadline, used
               to reach the offer branch and toast again. */
            const decision = decideSeatOffer({
              eventType: (payload as WaitlistPayload).eventType,
              row: newRow,
              remembered: newRow?.table_id
                ? offeredHoldsRef.current.get(String(newRow.table_id))
                : undefined,
            });

            if (decision.action === 'forget') {
              /* The hold ended: seated, left, cleared or expired. Forget it so
                 a genuine later re-offer on this table toasts again instead of
                 being deduped into silence. */
              offeredHoldsRef.current.delete(decision.tableId);
            } else if (decision.action === 'offer' || decision.action === 'reseed') {
              const offeredTableId = decision.tableId;
              const deadline = decision.deadline;
              offeredHoldsRef.current.set(offeredTableId, deadline ?? '');
              masterBus.emit('WAITLIST_SEAT_OFFERED', {
                tableId: offeredTableId,
                tableName: '',
                holdExpiresAt: deadline,
              });

              if (decision.action === 'offer') {
                /* Name the table. The banner card is otherwise anonymous -
                   "Seat Held 0:47" with no indication of WHERE - and a player
                   queued on more than one table cannot tell which seat is
                   being held. One small read, only when an offer actually
                   arrives, and the card still renders immediately if it
                   fails: the emit happened first with no name, and the name
                   follows if it resolves. */
                void supabase
                  .from('tables')
                  .select('name')
                  .eq('id', offeredTableId)
                  .maybeSingle()
                  .then(({ data }) => {
                    if (data?.name) {
                      masterBus.emit('WAITLIST_SEAT_OFFERED', {
                        tableId: offeredTableId,
                        tableName: String(data.name),
                        holdExpiresAt: deadline,
                      });
                    }
                  });
                /* 60 SECONDS, NOT 15 (Dan 2026-08-30): the seat is now HELD for
                   this player for 60s (fn_offer_open_seat + atomic_table_buyin
                   SEAT_RESERVED guard), so the popup lives exactly as long as
                   the hold. Tapping it lands on the table with the buy-in
                   screen already open (?buyin=1). */
                toast.success(
                  'A Seat Just Opened For You. It Is Held For 60 Seconds. Tap Here To Take It.',
                  60000,
                  () => navigate(`/table/${offeredTableId}?buyin=1`)
                );
              }
            }
            void refreshWatchedTables();
            masterBus.emit('WAITLIST_CHANGED', undefined as void);
          }
        )
        .subscribe();
    }

    return () => {
      cleanedUpRef.current = true;
      masterBus.removeRegisteredChannel(WAITLIST_CHANNEL_KEY);
      masterBus.removeChannelFactory(WAITLIST_CHANNEL_KEY);
      masterBus.removeRegisteredChannel(watchKey);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [setupChannel, refreshWatchedTables, user?.id]);

  return null; // Invisible global background listener
}
