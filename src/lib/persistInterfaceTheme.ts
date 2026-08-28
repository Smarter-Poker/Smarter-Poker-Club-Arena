import { supabase } from './supabase';

export type InterfaceTheme = 'dark' | 'light';

export interface PersistInterfaceThemeResult {
  ok: boolean;
  error?: unknown;
}

/*
 * Persist the interface mode selected inside Table Studio without replacing
 * the rest of profiles.settings. SettingsPage writes the complete settings
 * object, while the studio owns only this one key; reading and merging keeps
 * notification and gameplay preferences intact.
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
      const { data, error: readError } = await supabase
        .from('profiles')
        .select('settings')
        .eq('id', userId)
        .maybeSingle();

      if (readError) return readError;

      const stored = data?.settings;
      const currentSettings =
        stored && typeof stored === 'object' && !Array.isArray(stored)
          ? (stored as Record<string, unknown>)
          : {};

      const { error: writeError } = await supabase
        .from('profiles')
        .update({ settings: { ...currentSettings, theme } })
        .eq('id', userId);

      return writeError ?? undefined;
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
