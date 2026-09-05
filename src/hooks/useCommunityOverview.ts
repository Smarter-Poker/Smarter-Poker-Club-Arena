/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LIVE READINGS FOR THE COMMUNITY CENTER
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * /community was seven links and no numbers - it could not tell you whether a
 * connection request was waiting, or whether you had two friends or two
 * thousand. Dan 2026-09-05 asked for the sub pages to be done.
 *
 * One RPC, `fn_community_overview()`, does the counting server-side. It takes
 * no argument: every count is scoped to auth.uid(), so a browser cannot ask
 * about another account. See the 20260905070223 migration.
 *
 * `unions` is null - not 0 - for an account that is not on the union
 * allowlist, so the page can tell "not yours to see" apart from "yours, and
 * the answer is none".
 */

import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuthUser } from './useAuthUser';
import { reportError } from '../utils/errorReporter';

export interface CommunityOverview {
  friends: number;
  online: number;
  requests: number;
  challenges: number;
  clubs: number;
  /** null when this account may not operate the union network. */
  unions: number | null;
  canOperateUnionNetwork: boolean;
}

interface State {
  data: CommunityOverview | null;
  loading: boolean;
  error: string | null;
}

function parse(raw: unknown): CommunityOverview | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const num = (value: unknown): number => (typeof value === 'number' ? value : 0);
  return {
    friends: num(row.friends),
    online: num(row.online),
    requests: num(row.requests),
    challenges: num(row.challenges),
    clubs: num(row.clubs),
    unions: typeof row.unions === 'number' ? row.unions : null,
    canOperateUnionNetwork: row.can_operate_union_network === true,
  };
}

export function useCommunityOverview(): State & { refresh: () => void } {
  const { user } = useAuthUser();
  const [state, setState] = useState<State>({ data: null, loading: true, error: null });

  const load = useCallback(
    async (live: () => boolean) => {
      if (!user?.id) {
        if (live()) setState({ data: null, loading: false, error: null });
        return;
      }
      const { data, error } = await supabase.rpc('fn_community_overview');
      if (!live()) return;
      if (error) {
        reportError(error, 'useCommunityOverview');
        /* An unreadable answer is UNKNOWN, not zero. The page shows a dash and
           a retry rather than telling somebody with 1,309 friends they have
           none - the failure mode this page's own /friends sibling shipped for
           months. */
        setState({ data: null, loading: false, error: 'Live Readings Are Unavailable' });
        return;
      }
      setState({ data: parse(data), loading: false, error: null });
    },
    [user?.id]
  );

  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((prev) => ({ ...prev, loading: true }));
    void load(() => alive);
    return () => {
      alive = false;
    };
  }, [load, nonce]);

  return { ...state, refresh: useCallback(() => setNonce((n) => n + 1), []) };
}
