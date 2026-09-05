/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MAY THIS ACCOUNT SEE THE UNION NETWORK?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-05: "(AND THIS PAGE SHOULD BE HIDDEN TO EVERYONE EXECPT ME:
 * https://smarter.poker/hub/club-arena/unions)".
 *
 * The ANSWER is not here. `fn_can_i_operate_the_union_network()` reads
 * `public.union_creators` - the SAME allowlist `fn_can_i_create_a_union()`
 * reads, so the directory and the create door can never disagree about who
 * operates the union network. This hook exists so the app does not OFFER a
 * destination the account is not meant to have.
 *
 * Fails CLOSED: not signed in, a network error, an unreadable answer - all of
 * them hide the destination. A wrong "yes" here is a page that renders an
 * empty directory; a wrong "no" is a link the one allowlisted account gets
 * back by reloading.
 *
 * This is the page-level gate. It deliberately does not narrow the
 * `unions_public_browse` RLS policy: TablePage, CashierPage, ChipMintModal,
 * BadBeatJackpotPage, HomePage, UnionGamesPage, SettlementPage and the
 * tournament Unions tab all read `unions` for a name or an owner, and several
 * of those are money paths. See the 20260905065612 migration header.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuthUser } from './useAuthUser';
import { reportError } from '../utils/errorReporter';

export function useCanOperateUnionNetwork(): {
  canOperateUnionNetwork: boolean;
  checking: boolean;
} {
  const { user } = useAuthUser();
  const [state, setState] = useState<{ allowed: boolean; checking: boolean }>({
    allowed: false,
    checking: true,
  });

  useEffect(() => {
    if (!user?.id) {
      setState({ allowed: false, checking: false });
      return;
    }
    let live = true;
    setState({ allowed: false, checking: true });
    // No argument on purpose: the answer is about auth.uid().
    supabase.rpc('fn_can_i_operate_the_union_network').then(({ data, error }) => {
      if (!live) return;
      if (error) {
        reportError(error, 'useCanOperateUnionNetwork');
        setState({ allowed: false, checking: false });
        return;
      }
      setState({ allowed: data === true, checking: false });
    });
    return () => {
      live = false;
    };
  }, [user?.id]);

  return { canOperateUnionNetwork: state.allowed, checking: state.checking };
}
