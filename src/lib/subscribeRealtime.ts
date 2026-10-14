import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { realtimeAdmission } from './realtimeAdmission';

// Public SDK controls during the October 13 provider incident returned valid
// acknowledgments 20.4–33.6s after join. Keep the push alive for those replies
// until acknowledgment or failure; this does not change shared client, heartbeat,
// table transport, or HTTP transaction deadlines.
export const PAGE_REALTIME_JOIN_TIMEOUT_MS = 60_000;

/** Owners bind first and keep their ordinary cleanup/recovery. Cancellation
 * never closes a socket shared with other pages or lets a retired owner join.
 */
export async function subscribeRealtime(
  channel: RealtimeChannel,
  callback: (status: string, error?: Error) => void,
  signal: AbortSignal
): Promise<void> {
  try {
    await realtimeAdmission.ready(supabase.realtime, signal);
    if (!signal.aborted) {
      channel.timeout = PAGE_REALTIME_JOIN_TIMEOUT_MS;
      let retired = false;
      channel.subscribe((status, error) => {
        if (retired) return;
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // SDK 2.90 schedules another rejoin while the first is pending,
          // replacing its reference before a delayed reply arrives. Retire
          // this failed binding through the public API; its existing owner
          // retains recovery and creates the replacement. No second loop.
          retired = true;
          void channel.unsubscribe(supabase.realtime.timeout).catch(() => {
            // The owner still receives the original failure below.
          });
        }
        callback(status, error);
      });
    }
  } catch (error) {
    if (!signal.aborted) {
      callback(
        'CHANNEL_ERROR',
        error instanceof Error ? error : new Error('Realtime admission failed')
      );
    }
  }
}
