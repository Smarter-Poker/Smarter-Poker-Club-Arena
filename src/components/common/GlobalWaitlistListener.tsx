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

  // ─── Core subscription logic (extracted for reuse on reconnect) ───
  const setupChannel = useCallback(() => {
    if (!user?.id || cleanedUpRef.current) return;

    // Clean up any prior channel before creating a new one
    masterBus.removeRegisteredChannel(WAITLIST_CHANNEL_KEY);

    const channel = masterBus.getOrCreateChannel(WAITLIST_CHANNEL_KEY);
    channel.on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'table_seats',
      },
      async (payload) => {
        const vacatedTableId = (payload.old as any)?.table_id;
        if (!vacatedTableId) return;

        try {
          // Immediately query if the user is #1 on this table's waitlist
          const { data, error: waitlistErr } = await supabase
            .from('waitlist_entries')
            .select('id, position, poker_tables(name)')
            .eq('user_id', user.id)
            .eq('table_id', vacatedTableId)
            .maybeSingle();
          if (waitlistErr) console.error('[GlobalWaitlist] Query failed:', waitlistErr.message);

          if (data && data.position === 1) {
            const tableName = (data.poker_tables as any)?.name || 'the table';
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
              tableName: (data.poker_tables as any)?.name || 'Unknown',
            });
          }
        } catch (err) {
          console.error('[GlobalWaitlistListener] Error checking waitlist position:', err);
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
          console.warn(
            `[GlobalWaitlistListener] Max retries (${MAX_RETRIES}) reached — giving up. Will rely on MasterBus health monitor for recovery.`
          );
          return;
        }

        const delay = BACKOFF_DELAYS[Math.min(retryCountRef.current, BACKOFF_DELAYS.length - 1)];
        console.warn(
          `[GlobalWaitlistListener] ${status} — retry ${retryCountRef.current + 1}/${MAX_RETRIES} in ${delay}ms`
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

  useEffect(() => {
    cleanedUpRef.current = false;
    retryCountRef.current = 0;

    // Register channel factory so MasterBus health monitor can auto-recover
    masterBus.registerChannelFactory(WAITLIST_CHANNEL_KEY, () => {
      retryCountRef.current = 0; // Reset retries on health-monitor recovery
      setupChannel();
    });

    setupChannel();

    return () => {
      cleanedUpRef.current = true;
      masterBus.removeRegisteredChannel(WAITLIST_CHANNEL_KEY);
      masterBus.removeChannelFactory(WAITLIST_CHANNEL_KEY);
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    };
  }, [setupChannel]);

  return null; // Invisible global background listener
}
