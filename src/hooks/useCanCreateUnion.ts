/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MAY THIS ACCOUNT CREATE A UNION?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-04: "HIDE ALL CREATE UNION PAGE AND FUNCTIONALITY FOR ALL
 * ACCOUNTS EXCEPT FOR MINE."
 *
 * The ANSWER is not here and cannot be: `fn_can_i_create_a_union` reads the
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

type MountedRef = { current: boolean };

async function readCapabilityWithRetry<T>(
  read: () => PromiseLike<T> | Promise<T>,
  isMountedRef: MountedRef
): Promise<T> {
  /*
   * These RPCs are read-only permission questions even though PostgREST sends
   * RPCs as POST requests. The transport layer correctly refuses to replay an
   * arbitrary rejected POST because it may have executed; here the operation
   * is explicitly side-effect-free, so the component-level Supabase retry is
   * both safe and necessary. Keep the import lazy: this hook is in the entry
   * chunk and the retry path should not increase every player's first load.
   */
  const { retryFetch } = await import('../utils/retryFetch');
  return retryFetch(read, { maxRetries: 2, baseDelayMs: 300, isMountedRef });
}

function retryStoppedBecauseUnmounted(error: unknown): boolean {
  return error instanceof Error && error.name === 'Unmounted';
}

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
    const mounted = { current: true };
    setState({ allowed: false, checking: true });
    // No argument on purpose: the answer is about auth.uid(). The uuid-taking
    // fn_can_create_union is revoked from every browser role precisely so a
    // client cannot ask about somebody else.
    void readCapabilityWithRetry(() => supabase.rpc('fn_can_i_create_a_union'), mounted)
      .then(({ data, error }) => {
        if (!mounted.current) return;
        if (error) {
          reportError(error, 'useCanCreateUnion');
          setState({ allowed: false, checking: false });
          return;
        }
        setState({ allowed: data === true, checking: false });
      })
      .catch((error: unknown) => {
        if (!mounted.current || retryStoppedBecauseUnmounted(error)) return;
        reportError(error, 'useCanCreateUnion');
        setState({ allowed: false, checking: false });
      });
    return () => {
      mounted.current = false;
    };
  }, [user?.id]);

  return { canCreateUnion: state.allowed, checking: state.checking };
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MAY THIS ACCOUNT SEE THE UNION NETWORK?
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-09-05: "(AND THIS PAGE SHOULD BE HIDDEN TO EVERYONE EXECPT ME:
 * https://smarter.poker/hub/club-arena/unions)".
 *
 * IN THIS FILE, NOT ITS OWN, FOR TWO REASONS.
 *
 * One allowlist. `fn_can_i_operate_the_union_network()` reads
 * `public.union_creators` - the SAME table `fn_can_i_create_a_union()` reads -
 * so the directory and the create door can never disagree about who operates
 * the union network. Two questions about one list belong together; splitting
 * them is how they drift.
 *
 * And the entry chunk. ArenaSectionRail and HamburgerMenu both render on first
 * paint and both need this answer, so a separate module for it lands in the
 * bundle every player downloads before anything appears - which
 * `scripts/ci/entry-chunk-delta.mjs` correctly refused (207 modules against a
 * baseline of 206). useCanCreateUnion was already there for the same reason.
 * Adding a named export to a module already in the entry costs nothing.
 *
 * Fails CLOSED, exactly like its neighbour: not signed in, a network error, an
 * unreadable answer - all of them hide the destination. A wrong "yes" is an
 * empty directory; a wrong "no" is a link the one allowlisted account gets back
 * by reloading.
 *
 * This is the PAGE-level gate. It deliberately does not narrow the
 * `unions_public_browse` RLS policy: TablePage, CashierPage, ChipMintModal,
 * BadBeatJackpotPage, HomePage, UnionGamesPage, SettlementPage and the
 * tournament Unions tab all read `unions` for a name or an owner, several of
 * them on money paths. See the 20260905065612 migration header.
 */
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
    const mounted = { current: true };
    setState({ allowed: false, checking: true });
    // No argument on purpose: the answer is about auth.uid().
    void readCapabilityWithRetry(() => supabase.rpc('fn_can_i_operate_the_union_network'), mounted)
      .then(({ data, error }) => {
        if (!mounted.current) return;
        if (error) {
          reportError(error, 'useCanOperateUnionNetwork');
          setState({ allowed: false, checking: false });
          return;
        }
        setState({ allowed: data === true, checking: false });
      })
      .catch((error: unknown) => {
        if (!mounted.current || retryStoppedBecauseUnmounted(error)) return;
        reportError(error, 'useCanOperateUnionNetwork');
        setState({ allowed: false, checking: false });
      });
    return () => {
      mounted.current = false;
    };
  }, [user?.id]);

  return { canOperateUnionNetwork: state.allowed, checking: state.checking };
}
