import { supabase } from './supabase.js';
import { reportError } from './errorReporter.js';

/** Preserve the existing opponent-timer message without retaining a channel. */
export async function broadcastTimeBankActivation(
  tableId: string,
  payload: Record<string, unknown>
): Promise<void> {
  let channel: ReturnType<typeof supabase.channel> | undefined;
  try {
    channel = supabase.channel(`table:${tableId}`);
    const receipt = await channel.httpSend('time_bank_activated', payload);
    if (receipt.success !== true) throw new Error('Time bank broadcast was not accepted');
  } catch (error) {
    reportError(error, 'ServerTableEngine.time_bank_broadcast_failed');
  } finally {
    if (channel) {
      try {
        await supabase.removeChannel(channel);
      } catch (error) {
        reportError(error, 'ServerTableEngine.time_bank_channel_release_failed');
      }
    }
  }
}
