import { supabase } from './client.js';

/** Read the persisted choice on adoption, including after a cold engine start. */
export async function readAutoTimeBankPreferences(
  userIds: string[]
): Promise<Map<string, boolean>> {
  if (userIds.length === 0) return new Map();
  const { data, error } = await supabase
    .from('user_table_settings')
    .select('user_id, auto_time_bank')
    .in('user_id', userIds)
    .abortSignal(AbortSignal.timeout(4_000));
  if (error) throw new Error(`Time bank preferences unavailable: ${error.message}`);
  const preferences = new Map(userIds.map((id) => [id, true]));
  for (const row of data ?? []) preferences.set(row.user_id, row.auto_time_bank !== false);
  return preferences;
}
