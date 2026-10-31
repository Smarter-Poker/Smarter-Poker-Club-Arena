import { supabase } from '../lib/supabase';
import { throwableService, type Throwable } from './ThrowableService';

/** Rankings come from committed usage, never clicks or an optimistic charge. */
export async function getThrowableFavorites(): Promise<Throwable[]> {
  const { data, error } = await supabase.rpc('fn_player_throwable_favorites');
  if (error) throw error;
  const items: Throwable[] = [];
  for (const row of data || []) {
    const item = throwableService.getThrowableById(row.throwable_id);
    if (item && !items.some((existing) => existing.id === item.id)) items.push(item);
    if (items.length === 10) break;
  }
  return items;
}
