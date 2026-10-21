import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

/** Public game attribution names the hosting union, never an individual creator. */
export function useClubGameHost(clubId: string | null, enabled: boolean): string | null {
  const [host, setHost] = useState<{ clubId: string; name: string } | null>(null);
  useEffect(() => {
    if (!clubId || !enabled) return;
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await supabase
          .from('union_clubs')
          .select('unions(name)')
          .eq('club_id', clubId)
          .maybeSingle();
        if (error) throw error;
        const union = (data as unknown as { unions?: { name?: string } | null } | null)?.unions;
        const name = typeof union?.name === 'string' ? union.name.trim() : '';
        if (!cancelled) setHost(name ? { clubId, name } : null);
      } catch (error) {
        if (!cancelled) {
          setHost(null);
          reportError(error, 'ClubData.game_host');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [clubId, enabled]);
  return enabled && host?.clubId === clubId ? host.name : null;
}
