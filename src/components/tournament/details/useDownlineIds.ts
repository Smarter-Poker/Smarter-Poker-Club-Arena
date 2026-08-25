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
 * ── WHERE THE TREE ACTUALLY LIVES ────────────────────────────────────────────
 *
 * Verified against production on 2026-08-25 before a line was written, because
 * this repo has four tables that all look like they might hold the answer:
 *
 *     club_members.agent_id          1,160 rows  <- the live player -> agent link
 *     agents.parent_agent_id           105/113  <- the live agent -> agent link
 *     player_agent_assignments               0  <- EMPTY. Not read.
 *     sub_agents                             0  <- EMPTY. Not read.
 *
 * So the tree is two joins, not four. `club_members.agent_id` stores the
 * agent's USER id (it carries a foreign key to users, and AgentService relies
 * on the same fact in getAgentPlayers) — filter on user ids, never on
 * `agents.id`. `agents.parent_agent_id` is the opposite: it points at
 * `agents.id`. Getting those two the wrong way round returns an empty set that
 * looks like "this agent has nobody in the event", which is a lie a screen
 * cannot recover from.
 *
 * ── WHY NOT AgentService.getAgentHierarchy(clubId) ───────────────────────────
 *
 * It was read first, as instructed, and it does build the same tree — but it
 * builds it out of `getAgents()`, which hydrates every agent in the club into
 * the full `Agent` interface: three wallet balances, credit, commission rates,
 * lifetime earnings, plus a batched `profiles` fetch for display names and
 * avatars. This hook needs two columns and an id graph. Paying for a hundred
 * agents' wallets to colour some rows cyan is the wrong trade on a screen that
 * mounts on every tournament open. The traversal below is the same traversal
 * getAgentHierarchy does (parent_agent_id -> children), performed over the
 * lean projection, and the two cannot disagree because they read the same rows.
 *
 * ── TRANSITIVITY ─────────────────────────────────────────────────────────────
 *
 * A super agent sees their agents, those agents' sub agents, and every player
 * hanging off any of them. That is a breadth-first walk down `parent_agent_id`
 * from the viewer's own `agents` row, with a visited set so a cyclic or
 * self-parented row cannot spin forever. Staff (owner / co_owner / admin) who
 * hold no `agents` row still resolve their OWN directly assigned players, so
 * an owner who carries players sees them and an owner who carries none sees no
 * legend rather than the whole club lit up, which would be noise, not signal.
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

/** `.in()` is a URL filter. Chunk it so a big club cannot blow the query line. */
const IN_CHUNK = 60;

/** A club cannot realistically hold more agents than this; production holds 113. */
const AGENT_SCAN_LIMIT = 2000;

/** Players carried by one agent tree. Bounded so a runaway club cannot stall. */
const MEMBER_SCAN_LIMIT = 5000;

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

        // ── 2. THE AGENT GRAPH ──────────────────────────────────────────────
        // Two columns and a parent pointer. Same edges getAgentHierarchy walks.
        const { data: agentRows, error: agentError } = await supabase
          .from('agents')
          .select('id, user_id, parent_agent_id')
          .eq('club_id', clubId)
          .limit(AGENT_SCAN_LIMIT);

        if (cancelled) return;
        if (agentError) reportError(agentError, 'useDownlineIds.agents');

        const rows = (agentRows || []) as Array<{
          id: string;
          user_id: string;
          parent_agent_id: string | null;
        }>;

        // agents.id -> its direct children, so the walk is O(n) not O(n^2).
        const childrenByParent = new Map<string, string[]>();
        const userIdByAgentId = new Map<string, string>();
        for (const row of rows) {
          if (row.id && row.user_id) userIdByAgentId.set(row.id, row.user_id);
          if (!row.parent_agent_id) continue;
          const bucket = childrenByParent.get(row.parent_agent_id);
          if (bucket) bucket.push(row.id);
          else childrenByParent.set(row.parent_agent_id, [row.id]);
        }

        // The viewer's own agent record(s). Staff often have none — that is
        // fine, they still carry whatever club_members points directly at them.
        const rootAgentIds = rows.filter((r) => r.user_id === userId).map((r) => r.id);

        // Breadth-first down parent_agent_id. `seen` makes a cycle or a
        // self-parented row terminate instead of hanging the lobby.
        const seen = new Set<string>(rootAgentIds);
        const queue = [...rootAgentIds];
        const descendantAgentUserIds = new Set<string>();

        while (queue.length > 0) {
          const current = queue.shift() as string;
          for (const child of childrenByParent.get(current) || []) {
            if (seen.has(child)) continue;
            seen.add(child);
            queue.push(child);
            const childUserId = userIdByAgentId.get(child);
            // A sub agent playing the event IS part of the downline.
            if (childUserId && childUserId !== userId) descendantAgentUserIds.add(childUserId);
          }
        }

        // ── 3. THE PLAYERS ──────────────────────────────────────────────────
        // club_members.agent_id holds the agent's USER id, so the viewer and
        // every agent beneath them are all valid values to filter on.
        const carrierUserIds = [userId, ...descendantAgentUserIds];
        const collected = new Set<string>(descendantAgentUserIds);

        for (let i = 0; i < carrierUserIds.length; i += IN_CHUNK) {
          const slice = carrierUserIds.slice(i, i + IN_CHUNK);
          const { data: members, error: playersError } = await supabase
            .from('club_members')
            .select('user_id')
            .eq('club_id', clubId)
            .in('agent_id', slice)
            .limit(MEMBER_SCAN_LIMIT);

          if (cancelled) return;
          if (playersError) {
            reportError(playersError, 'useDownlineIds.players');
            continue;
          }
          for (const m of members || []) {
            // The viewer's own row is the hero highlight, not a downline one.
            if (m.user_id && m.user_id !== userId) collected.add(m.user_id);
          }
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
