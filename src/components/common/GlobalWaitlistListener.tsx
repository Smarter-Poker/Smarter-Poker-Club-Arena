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

    // Clean up any prior channel before creating a new one
    masterBus.removeRegisteredChannel(WAITLIST_CHANNEL_KEY);

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
        const vacatedTableId = (payload.old as any)?.table_id;
        if (!vacatedTableId) return;

        try {
          // Immediately query if the user is #1 on this table's waitlist
          const { data, error: waitlistErr } = await supabase
            .from('table_waitlist')
            .select('id, position, tables(name)')
            .eq('user_id', user.id)
            .eq('table_id', vacatedTableId)
            .maybeSingle();
          if (waitlistErr) reportError(waitlistErr, 'GlobalWaitlistListener.Query_failed');

          if (data && data.position === 1) {
            const tableName = (data.tables as any)?.name || 'the table';
            toast.success(`Seat available at ${tableName}! Joining in 3s...`);
            // Auto-navigate to the table where the seat opened
            setTimeout(() => {
              navigate(`/table/${vacatedTableId}`);
            }, 3000);
          }

          // Emit position change for any waitlist entry
          if (data) {
            masterBus.emit('WAITLIST_POSITION_CHANGED', {
              tableId: vacatedTableId,
              position: data.position,
              tableName: (data.tables as any)?.name || 'Unknown',
            });
          }
        } catch (err) {
          reportError(err, 'GlobalWaitlistListener.Error_checking_waitlist_position');
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
      const { data, error } = await supabase
        .from('table_waitlist')
        .select('table_id')
        .eq('user_id', user.id);
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
          () => {
            void refreshWatchedTables();
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
