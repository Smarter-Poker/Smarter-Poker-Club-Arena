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
 * ── THE ROLE GATE, AND WHY IT IS THE FIRST QUERY ─────────────────────────────
 *
 * A plain player must never see downline UI and must never pay for the query
 * that builds it. Most viewers of a tournament lobby ARE plain players, so the
 * hook reads one row first — the viewer's own `club_members` row — and stops
 * dead unless `normaliseRole()` (src/types/clubRoles.ts, the authoritative
 * model) says they are one of:
 *
 *     owner | co_owner | admin | super_agent | agent | sub_agent
 *
 * Everyone else costs one indexed single-row read and gets an empty set.
 *
 * The roster owns the hierarchy: ca_club_member_downline follows every
 * club_members.agent_id edge under ca_club_roster_access. The separate agents
 * parent graph can disagree with that live assignment tree, so do not rebuild
 * it here. Read only user ids, page past the API row cap, and never publish a
 * partial set after an error. Ranking and Entries share this same result.
 */

import { useEffect, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { normaliseRole, isAgentRole, isClubStaff, type ClubRole } from '../../../types/clubRoles';
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
  clubId: string | undefined | null
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
        // ── 1. THE ROLE GATE ────────────────────────────────────────────────
        const { data: membership, error: memberError } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', clubId)
          .eq('user_id', userId)
          .maybeSingle();

        if (cancelled) return;

        if (memberError) {
          // Not a member, or the read was refused. Either way we cannot claim
          // a downline, and a tournament lobby is not the place to say so.
          reportError(memberError, 'useDownlineIds.membership');
          setDownlineIds(EMPTY_IDS);
          setCarriesDownline(false);
          setViewerRole('player');
          return;
        }

        const role = normaliseRole(membership?.role);
        if (cancelled) return;
        setViewerRole(role);

        const eligible = isAgentRole(role) || isClubStaff(role);
        if (!eligible) {
          // A plain player. One row read, and we stop. No agent query, no
          // member scan, no legend, no highlight.
          setDownlineIds(EMPTY_IDS);
          setCarriesDownline(false);
          return;
        }

        const collected = new Set<string>();
        const seen = new Set<string>();
        for (let offset = 0; ; offset += PAGE_SIZE) {
          const { data, error } = await supabase
            .rpc('ca_club_member_downline', { p_club_id: clubId, p_user_id: userId })
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

        if (cancelled) return;
        setDownlineIds(collected);
        setCarriesDownline(true);
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
  }, [userId, clubId]);

  return { downlineIds, carriesDownline, viewerRole, loading };
}

export default useDownlineIds;
