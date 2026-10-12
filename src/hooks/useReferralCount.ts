import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';

/** Unknown reads stay unknown, and an old account's response cannot replace the current one. */
export function useReferralCount(accountId: string | null): number | null {
  const [reading, setReading] = useState<{ owner: string; count: number | null } | null>(null);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { count, error } = await supabase
          .from('referral_redemptions')
          .select('id', { count: 'exact', head: true })
          .eq('referrer_id', accountId);
        if (cancelled) return;
        if (error) reportError(error, 'useReferralCount');
        setReading({ owner: accountId, count: error ? null : count });
      } catch (error) {
        if (cancelled) return;
        reportError(error, 'useReferralCount');
        setReading({ owner: accountId, count: null });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);
  return reading?.owner === accountId ? reading.count : null;
}
