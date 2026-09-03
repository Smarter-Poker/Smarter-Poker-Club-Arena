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
      async (payload) => {
        const vacatedTableId = (payload.old as { table_id?: string })?.table_id;
        if (!vacatedTableId) return;

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
          const pos = await waitlistService.getPosition(vacatedTableId);
          if (pos && pos.status === 'waiting' && pos.position > 0) {
            masterBus.emit('WAITLIST_POSITION_CHANGED', {
              tableId: vacatedTableId,
              position: pos.position,
              tableName: 'Unknown',
            });
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
  }, [user?.id, navigate, toast]);

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
        .select('table_id')
        .eq('user_id', user.id)
        .in('status', ['waiting', 'notified']);
      if (error) {
        reportError(error, 'GlobalWaitlistListener.refreshWatchedTables');
        return;
      }
      const next = Array.from(
        new Set((data || []).map((r: { table_id: string }) => r.table_id).filter(Boolean))
      ).sort();
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
              old?: { status?: string };
              eventType?: string;
            };
            const newRow = (payload as WaitlistPayload).new;
            const oldRow = (payload as WaitlistPayload).old;
            if (
              (payload as WaitlistPayload).eventType === 'UPDATE' &&
              newRow?.status === 'notified' &&
              oldRow?.status !== 'notified' &&
              newRow?.table_id
            ) {
              const offeredTableId = String(newRow.table_id);
              /* The banner needs the DEADLINE, not a duration: a tab that was
                 backgrounded, or a component that mounts late, must show the
                 true remaining time instead of restarting the clock at sixty.
                 Falls back to notified_at + 60s for a row written before
                 hold_expires_at existed. */
              const holdExpiresAt =
                newRow.hold_expires_at ??
                (newRow.notified_at
                  ? new Date(new Date(newRow.notified_at).getTime() + 60_000).toISOString()
                  : null);
              /* Name the table. The banner card is otherwise anonymous - "Seat
                 Held 0:47" with no indication of WHERE - and a player queued
                 on more than one table cannot tell which seat is being held.
                 One small read, only when an offer actually arrives, and the
                 card still renders immediately if it fails: the emit happens
                 first with no name, and the name follows if it resolves. */
              masterBus.emit('WAITLIST_SEAT_OFFERED', {
                tableId: offeredTableId,
                tableName: '',
                holdExpiresAt,
              });
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
                      holdExpiresAt,
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
