import { supabase } from './supabase';

export type InterfaceTheme = 'dark' | 'light';

export interface PersistInterfaceThemeResult {
  ok: boolean;
  error?: unknown;
}

/*
 * Persist the interface mode selected inside Table Studio without replacing
 * the rest of profiles.settings. The database function applies jsonb_set in a
 * single UPDATE, so another device can save notification/gameplay preferences
 * at the same time without either client writing an older whole-object copy.
 *
 * Writes are serialized per account. A fast Light -> Dark tap sequence must
 * finish in tap order instead of allowing the slower first request to become
 * the durable value.
 */
const writeTails = new Map<string, Promise<void>>();

export async function persistInterfaceTheme(
  userId: string,
  theme: InterfaceTheme
): Promise<PersistInterfaceThemeResult> {
  if (!userId) return { ok: false, error: new Error('not signed in') };

  const previousTail = writeTails.get(userId) ?? Promise.resolve();
  const task = previousTail.then(async (): Promise<unknown | undefined> => {
    try {
      const { error } = await supabase.rpc('fn_set_interface_theme', { p_theme: theme });
      return error ?? undefined;
    } catch (error) {
      return error;
    }
  });

  const tail = task.then(() => undefined);
  writeTails.set(userId, tail);
  const error = await task;
  if (writeTails.get(userId) === tail) writeTails.delete(userId);

  return error ? { ok: false, error } : { ok: true };
}
