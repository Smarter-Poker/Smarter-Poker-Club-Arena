import { supabase } from '../lib/supabase';

export type DailyMissionAlertPreference = {
  enabled: boolean;
};

/**
 * Daily Mission reset reminders are deliberately opt-in. This preference is
 * separate from the device-wide push subscription: turning mission reminders
 * off must not silence seat alerts, messages, or tournament notices.
 */
export async function getDailyMissionAlertPreference(
  userId: string
): Promise<DailyMissionAlertPreference> {
  const { data, error } = await supabase
    .from('user_notification_preferences')
    .select('daily_mission_reminders')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return { enabled: data?.daily_mission_reminders === true };
}

export async function setDailyMissionAlertPreference(
  userId: string,
  enabled: boolean
): Promise<DailyMissionAlertPreference> {
  const { data, error } = await supabase
    .from('user_notification_preferences')
    .upsert({ user_id: userId, daily_mission_reminders: enabled }, { onConflict: 'user_id' })
    .select('daily_mission_reminders')
    .maybeSingle();

  if (error) throw error;
  if (!data) throw new Error('Daily Mission alert preference returned no receipt');
  if (
    typeof data.daily_mission_reminders !== 'boolean' ||
    data.daily_mission_reminders !== enabled
  ) {
    throw new Error('Daily Mission alert preference returned a contradictory receipt');
  }
  return { enabled };
}
