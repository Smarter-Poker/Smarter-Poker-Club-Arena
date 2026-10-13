import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from './supabase';
import { realtimeAdmission } from './realtimeAdmission';

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
    if (!signal.aborted) channel.subscribe(callback);
  } catch (error) {
    if (!signal.aborted) {
      callback(
        'CHANNEL_ERROR',
        error instanceof Error ? error : new Error('Realtime admission failed')
      );
    }
  }
}
