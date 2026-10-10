import { supabase } from './supabase.js';

export type PlayerSessionVerdict = 'alive' | 'revoked' | 'unknown';
interface SessionDatabase {
  rpc: (
    name: string,
    args: Record<string, unknown>
  ) => PromiseLike<{ data: unknown; error: unknown }>;
}
export function tokenSessionId(token: string): string | null {
  try {
    const value = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8')
    ).session_id;
    return typeof value === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
      ? value
      : null;
  } catch {
    return null;
  }
}
/** Cryptographic identity must be verified before this helper is called. No grant cache. */
export async function playerSessionVerdict(
  userId: string,
  token: string,
  db: SessionDatabase = supabase
): Promise<PlayerSessionVerdict> {
  try {
    const { data, error } = await db.rpc('fn_ca_player_session_live', {
      p_user_id: userId,
      p_session_id: tokenSessionId(token),
    });
    if (error || typeof data !== 'boolean') return 'unknown';
    return data ? 'alive' : 'revoked';
  } catch {
    return 'unknown';
  }
}
/** Explicit transaction event, no correctness/repair polling or scheduled work. */
export function subscribePlayerSessionRevocations(
  onRevoke: (userId: string) => void,
  onRecovered?: (isCurrent: () => boolean) => void
): () => void {
  let disposed = false,
    subscribed = false,
    generation = 0;
  const channel = supabase
    .channel('engine-player-session-revocations')
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'ca_player_session_revocations' },
      (payload) => {
        if (disposed) return;
        const userId = (payload.new as Record<string, unknown>)?.user_id;
        if (typeof userId === 'string') onRevoke(userId);
      }
    )
    .subscribe((status) => {
      if (disposed) return;
      if (status !== 'SUBSCRIBED') {
        subscribed = false;
        generation++;
        return;
      }
      if (subscribed) return;
      subscribed = true;
      const original = ++generation;
      onRecovered?.(() => !disposed && subscribed && generation === original);
    });
  return () => {
    disposed = true;
    generation++;
    void supabase.removeChannel(channel);
  };
}
