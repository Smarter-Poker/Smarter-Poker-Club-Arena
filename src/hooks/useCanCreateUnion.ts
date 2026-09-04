/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MAY THIS ACCOUNT CREATE A UNION?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04: "HIDE ALL CREATE UNION PAGE AND FUNCTIONALITY FOR ALL
 * ACCOUNTS EXCEPT FOR MINE."
 *
 * The ANSWER is not here and cannot be: `fn_can_create_union` reads the
 * `union_creators` allowlist, and `trg_union_creation_is_allowlisted` on
 * `public.unions` refuses the insert no matter which client asks - the API
 * route runs as the service role and would otherwise bypass RLS entirely.
 * This hook exists so the app does not OFFER what the database will refuse.
 *
 * Fails CLOSED: not signed in, a network error, an unreadable answer - all of
 * them hide the control. A wrong "yes" here is a page that ends in a refusal
 * the person cannot act on; a wrong "no" is a control the one allowlisted
 * account can reach again by reloading.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { useAuthUser } from './useAuthUser';
import { reportError } from '../utils/errorReporter';

export function useCanCreateUnion(): { canCreateUnion: boolean; checking: boolean } {
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
    supabase.rpc('fn_can_create_union', { p_user_id: user.id }).then(({ data, error }) => {
      if (!live) return;
      if (error) {
        reportError(error, 'useCanCreateUnion');
        setState({ allowed: false, checking: false });
        return;
      }
      setState({ allowed: data === true, checking: false });
    });
    return () => {
      live = false;
    };
  }, [user?.id]);

  return { canCreateUnion: state.allowed, checking: state.checking };
}
