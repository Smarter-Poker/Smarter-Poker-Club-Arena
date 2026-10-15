import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { reportError } from '../utils/errorReporter';
import { resolveClubUUIDStrict } from '../utils/clubIdResolver';

const MAX_RECENT = 50;
const MOVES = [
  'agent_wallet_send',
  'agent_wallet_claim_back',
  'club_bank_send',
  'club_bank_claim_back',
  'club_bank_reverse',
  'promo_wallet_send',
  'club_promo_wallet_send',
];

export function useRecentRecipients(
  userId: string | undefined,
  clubId: string | null,
  _sourceWallet: string
) {
  const scope = userId && clubId ? `${userId}:${clubId}` : null;
  const [state, setState] = useState<{ scope: string | null; ids: string[] }>({
    scope: null,
    ids: [],
  });
  useEffect(() => {
    let current = true;
    setState({ scope, ids: [] });
    if (!scope || !userId || !clubId) return;
    // Existing RLS controls access. Filter the actor before the bounded read so
    // another operator's activity or gameplay never crowds out these recents.
    void (async () => {
      try {
        const resolvedClub = await resolveClubUUIDStrict(clubId);
        if (!current) return;
        const { data, error } = await supabase
          .from('chip_transactions')
          .select('from_user_id,to_user_id,transaction_type,created_at')
          .eq('club_id', resolvedClub)
          .in('transaction_type', MOVES)
          .or(
            `and(from_user_id.eq.${userId},transaction_type.in.(agent_wallet_send,club_bank_send,promo_wallet_send,club_promo_wallet_send)),and(to_user_id.eq.${userId},transaction_type.in.(agent_wallet_claim_back,club_bank_claim_back,club_bank_reverse))`
          )
          .order('created_at', { ascending: false })
          .order('id', { ascending: false })
          .limit(250);
        if (!current) return;
        if (error) {
          reportError(error, 'useRecentRecipients.history');
          return;
        }
        const ids = [
          ...new Set(
            (data || []).flatMap((row) => {
              const claim = /claim_back|reverse/.test(row.transaction_type || '');
              if (claim ? row.to_user_id !== userId : row.from_user_id !== userId) return [];
              const other = claim ? row.from_user_id : row.to_user_id;
              return other && other !== userId ? [other] : [];
            })
          ),
        ].slice(0, MAX_RECENT);
        setState((previous) => ({
          scope,
          ids: [...new Set([...(previous.scope === scope ? previous.ids : []), ...ids])].slice(
            0,
            MAX_RECENT
          ),
        }));
      } catch (error) {
        if (current) reportError(error, 'useRecentRecipients.history');
      }
    })();
    return () => {
      current = false;
    };
  }, [scope, userId, clubId]);
  const addRecipient = useCallback(
    (id: string) => {
      if (!scope || !id) return;
      setState((previous) => ({
        scope,
        ids: [
          id,
          ...(previous.scope === scope ? previous.ids.filter((value) => value !== id) : []),
        ].slice(0, MAX_RECENT),
      }));
    },
    [scope]
  );
  return { recentIds: state.scope === scope ? state.ids : [], addRecipient };
}
