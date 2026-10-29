/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  useDownlineIds — "which of these players are MINE?"
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-25: "IF AN AGENT, SUPER AGENT, OR SUB AGENT HAS 'DOWNLINES' IN A
 * TOURNAMENT THEY SHOULD BE HIGHLIGHTED IN THE RANKINGS, TO EASILY SHOW THE
 * AGENT WHICH OF HIS PLAYERS ARE IN, AND HOW THEY ARE DOING."
 *
 * This hook answers exactly that and nothing else: given the signed-in player
 * and the club the tournament belongs to, it returns the set of user ids that
 * sit BENEATH that person, plus whether they carry a downline at all.
 *
 * A union tournament's club_id may be only its anchor club. Resolve the
 * existing fn_club_scope_ids union/club scope, read the viewer's own roles in
 * those clubs, then use authorized roster readers for eligible memberships.
 * Staff oversee their club; agents carry their recursive membership subtree.
 * Plain players never fetch a roster. Request only user IDs, exhaust ordered
 * pages, deduplicate members across clubs, and never publish a partial set.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import {
  normaliseRole,
  isAgentRole,
  isClubStaff,
  ROLE_RANK,
  type ClubRole,
} from '../../../types/clubRoles';
import { reportError } from '../../../utils/errorReporter';

export interface DownlineResult {
  /** User ids beneath the viewer. Never contains the viewer themselves. */
  downlineIds: Set<string>;
  /** True when the viewer carries a downline at all (agent tier or staff). */
  carriesDownline: boolean;
  /** The viewer's resolved club role, for a caller that wants to label it. */
  viewerRole: ClubRole;
  /** True while the first resolution is still in flight. */
  loading: boolean;
}

const EMPTY_IDS: Set<string> = new Set();

/** Stay below PostgREST's row cap; exhaust the authorized result. */
const PAGE_SIZE = 500;

export function useDownlineIds(
  userId: string | undefined | null,
  clubId: string | undefined | null,
  unionId?: string | null
): DownlineResult {
  const [downlineIds, setDownlineIds] = useState<Set<string>>(EMPTY_IDS);
  const [carriesDownline, setCarriesDownline] = useState(false);
  const [viewerRole, setViewerRole] = useState<ClubRole>('player');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    // Nobody signed in, or a tournament with no club: there is no question to
    // ask. Reset rather than leaving a previous viewer's downline on screen.
    if (!userId || !clubId) {
      setDownlineIds(EMPTY_IDS);
      setCarriesDownline(false);
      setViewerRole('player');
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setDownlineIds(EMPTY_IDS);
    setCarriesDownline(false);
    setViewerRole('player');

    (async () => {
      try {
        // Union events have an anchor club plus linked clubs. Resolve that
        // maintained scope, then use only memberships belonging to this viewer.
        const { data: scope, error: scopeError } = await supabase.rpc('fn_club_scope_ids', {
          p_club_id: unionId || clubId,
        });
        if (cancelled) return;
        if (scopeError) throw scopeError;
        if (
          !Array.isArray(scope) ||
          !scope.length ||
          scope.some((id) => typeof id !== 'string' || !id)
        ) {
          throw new Error('The Tournament Club Scope Was Incomplete');
        }
        const scopeIds = [...new Set<string>(scope)];
        const memberships = new Map<string, ClubRole>();
        for (let offset = 0; offset < scopeIds.length; offset += 60) {
          const { data, error } = await supabase
            .from('club_members')
            .select('club_id, role')
            .eq('user_id', userId)
            .in('club_id', scopeIds.slice(offset, offset + 60));
          if (cancelled) return;
          if (error) throw error;
          if (!Array.isArray(data)) throw new Error('The Membership Response Was Incomplete');
          for (const member of data) {
            if (!scopeIds.includes(member.club_id))
              throw new Error('The Membership Scope Was Invalid');
            const role = normaliseRole(member.role);
            const prior = memberships.get(member.club_id) || 'player';
            if (ROLE_RANK[role] >= ROLE_RANK[prior]) memberships.set(member.club_id, role);
          }
        }
        const role = [...memberships.values()].reduce<ClubRole>(
          (best, next) => (ROLE_RANK[next] > ROLE_RANK[best] ? next : best),
          'player'
        );
        setViewerRole(role);
        const eligible = [...memberships].filter(
          ([, memberRole]) => isAgentRole(memberRole) || isClubStaff(memberRole)
        );
        const collected = new Set<string>();
        for (const [memberClubId, memberRole] of eligible) {
          // Staff oversee their club; agents see only their recursive subtree.
          const staff = isClubStaff(memberRole);
          const reader = staff ? 'ca_club_members_overview' : 'ca_club_member_downline';
          const parameters: { p_club_id: string; p_user_id?: string } = staff
            ? { p_club_id: memberClubId }
            : { p_club_id: memberClubId, p_user_id: userId };
          const seen = new Set<string>();
          for (let offset = 0; ; offset += PAGE_SIZE) {
            const { data, error } = await supabase
              .rpc(reader, parameters)
              .select('user_id')
              .order('user_id', { ascending: true })
              .range(offset, offset + PAGE_SIZE - 1);
            if (cancelled) return;
            if (error) throw error;
            if (!Array.isArray(data)) throw new Error('The Downline Response Was Incomplete');
            for (const row of data) {
              if (typeof row.user_id !== 'string' || !row.user_id || seen.has(row.user_id)) {
                throw new Error('The Downline Response Was Incomplete');
              }
              seen.add(row.user_id);
              if (row.user_id !== userId) collected.add(row.user_id);
            }
            if (data.length < PAGE_SIZE) break;
          }
        }

        if (cancelled) return;
        setDownlineIds(collected);
        setCarriesDownline(eligible.length > 0);
      } catch (err) {
        if (cancelled) return;
        reportError(err, 'useDownlineIds.resolve');
        // A downline we could not resolve is not a downline of nobody, but it
        // is the only safe thing to draw: no highlight, no legend, no claim.
        setDownlineIds(EMPTY_IDS);
        setCarriesDownline(false);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, clubId, unionId]);

  return { downlineIds, carriesDownline, viewerRole, loading };
}

export default useDownlineIds;
