/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB MEMBERS PAGE - The Players Tab
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-23, rebuilt against a single server-side roster. What changed and
 * why, point by point against the brief:
 *
 *  1. NO GREEN, NO PURPLE. The summary cards were emerald (#10B981) and violet
 *     (#A855F7), neither of which appears anywhere else in smarter.poker. They
 *     are now arena cyan, club blue and royal blue, and presence is drawn as a
 *     cyan ring on the avatar rather than a green dot.
 *
 *     ONLINE NOW read 1 while hundreds of members were mid-hand. The old effect
 *     asked `tables` for rows with this club_id and a live status; Club JAQK owns
 *     34,138 table rows and every one of them is closed, because the live tables
 *     belong to Midway Union above it. Zero tables came back, the effect returned
 *     before it ever looked at a seat, and the count fell through to browser
 *     presence: one, the person reading the screen. The seat row knows what the
 *     table does not - table_seats.club_id is the player's home club - and
 *     ca_club_members_overview reads it that way round. Anyone at a live table is
 *     online, horses included.
 *
 *  2. AN OVERVIEW OF EVERYTHING. Opening this on a union now lists every player
 *     in every club beneath it, deduplicated, each at their highest role. Player
 *     number sits beside the role; the Club Arena alias leads and the account
 *     username follows it.
 *
 *  3. BADGES, NOT DOTS. All seven roles carry one - see components/club/RoleBadge.
 *     Each row also carries the four numbers the brief asked for: downlines,
 *     agent wallet, player wallet, fees.
 *
 *  4. A ROW IS A LINK, not a modal. Promote and demote, the downline and the
 *     date-ranged stats all live on the Member Management page behind it.
 *
 *  8. TITLE CASE, including the search placeholder, via utils/titleCase - the
 *     acronym-aware one, so a variant never renders as "Nlh".
 *
 *  9. HIERARCHY FIRST by default, then sortable by name, downlines, wallet or
 *     fees. The server returns hierarchy order; every other order is a re-sort
 *     of the same array, so switching is instant and costs no round trip.
 *
 * WHAT THIS PAGE NO LONGER DOES. It no longer joins club_members to profiles in
 * chunks of thirty, polls `tables` and `table_seats` on a 30 second timer, or
 * runs a presence channel to produce a number the database already knows. One
 * RPC, one realtime subscription for invalidation.
 *
 * Horses are players. There is no horse filter, no horse badge and nothing here
 * that lets a member tell a horse from a human. Do not reintroduce one.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { sizedStorageUrl } from '../utils/avatarGenerator';
import { generateAvatarSvg } from '../utils/avatarGenerator';
import { useAuthUser } from '../hooks/useAuthUser';
import { useMasterBusSubscriptions } from '../hooks/useMasterBusSubscription';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useToast } from '../components/common/Toast';
import { useVirtualScroll } from '../hooks/useVirtualScroll';
import PageSkeleton from '../components/common/PageSkeleton';
import ClubBottomNav from '../components/club/ClubBottomNav';
import RoleBadge, { roleColor } from '../components/club/RoleBadge';
import { exportToCSV } from '../lib/export';
import './ClubMembersPage.css';
import { resolveClubUUID, isUUID } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { titleCase } from '../utils/titleCase';
import {
  normaliseRole,
  roleLabel,
  isClubStaff,
  AGENT_ROLES,
  STAFF_ROLES,
  type ClubRole,
} from '../types/clubRoles';
import ClubRosterService, { mapRosterRow, type RosterMember } from '../services/ClubRosterService';

/* ═══════════════════════════════════════════════════════════════════════════════
   FILTERS AND SORTS
   ═══════════════════════════════════════════════════════════════════════════════ */

type MemberFilter = 'all' | 'mine' | 'online' | 'agents' | 'admins';

const FILTER_LABEL: Record<MemberFilter, string> = {
  all: 'All',
  /* Direct downline, deliberately named that way: upline_user_id is one hop,
     so a super agent's full tree is larger than this. Claiming "My Downline"
     for a one-hop filter is how you get a support ticket about missing
     players. The agent's own downline_total is the honest full number. */
  mine: 'Direct',
  online: 'Online',
  agents: 'Agents',
  admins: 'Admins',
};

/**
 * Requirement 9. `hierarchy` is what the server already returned, so choosing it
 * is a no-op rather than a re-sort - which is why it is the default and why
 * every other option is a stable sort layered on top of that order.
 */
type SortKey = 'hierarchy' | 'name' | 'downlines' | 'wallet' | 'fees';

const SORT_LABEL: Record<SortKey, string> = {
  hierarchy: 'Role Hierarchy',
  name: 'Name (A To Z)',
  downlines: 'Downlines',
  wallet: 'Wallet Balance',
  fees: 'Fees',
};

/* AGENT_ROLES / STAFF_ROLES come from types/clubRoles, which exists because
   there were once three MemberRole types and no two agreed. These were a
   fourth copy: add an eighth role and the Agents/Admins filters miss it. */
const AGENT_ROLE_SET: readonly ClubRole[] = AGENT_ROLES;
const STAFF_ROLE_SET: readonly ClubRole[] = STAFF_ROLES;

/** Chips, fees and balances all read the same way. Never padStart. */
function chips(value: number): string {
  return (value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE
   ═══════════════════════════════════════════════════════════════════════════════ */

export default function ClubMembersPage() {
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const { user } = useAuthUser();
  const toast = useToast();
  const navigate = useNavigate();
  const isMountedRef = useIsMounted();

  const [members, setMembers] = useState<RosterMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filter, setFilter] = useState<MemberFilter>('all');
  const [sortKey, setSortKey] = useState<SortKey>('hierarchy');
  const [searchQuery, setSearchQuery] = useState('');
  const [userRole, setUserRole] = useState<ClubRole>('player');
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);

  const canExport = isClubStaff(userRole);

  const loadingRef = useRef(false);
  const [loadError, setLoadError] = useState(false);
  const [notFound, setNotFound] = useState(false);

  // Safety net: never leave a skeleton on screen forever if auth or the network
  // hangs. The empty state is a better answer than a spinner that never stops.
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 8000);
    return () => clearTimeout(timeout);
    // Per club: with [] this protected only the FIRST club viewed in a session.
  }, [clubId]);

  // Navigating between clubs must not show the previous club's filters.
  useEffect(() => {
    setUserRole('player');
    setFilter('all');
    setSortKey('hierarchy');
    setSearchQuery('');
    setIsRefreshing(false);
    setLoadError(false);
    setNotFound(false);
    // Was NOT reset, so navigating A -> B left A's UUID in state for the whole
    // resolve and useMasterBusChannel subscribed with channel B / filter A.
    setResolvedClubId(null);
    loadingRef.current = false;
  }, [clubId]);

  const loadMembers = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!clubId) return;
      const live = () => (getIsMounted ? getIsMounted() : true) && isMountedRef.current;

      // READ the re-entrancy flag. Four independent triggers call this (three
      // bus events, two realtime handlers, the mount effect), and two in-flight
      // getRoster calls resolve in completion order, not request order - so an
      // older response could win and overwrite a newer roster.
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (live()) {
        setLoading(true);
        setLoadError(false);
      }
      try {
        const resolvedId = await resolveClubUUID(clubId);
        if (!live()) return;
        // resolveClubUUID returns the INPUT unchanged when it cannot resolve,
        // so `!resolvedId` was a branch that could never be taken. What actually
        // happened on a bad slug was getRoster('some-slug') -> a uuid cast
        // error -> the generic "Failed To Load Members" toast, with no hint
        // that the club does not exist.
        if (!isUUID(resolvedId)) {
          setMembers([]);
          setNotFound(true);
          return;
        }
        setNotFound(false);
        setResolvedClubId(resolvedId);

        // SWR: paint the previous roster instantly, then replace it. The cache
        // holds the whole row now rather than a trimmed copy, because the row IS
        // the screen - wallets, downlines and fees included.
        // v2: the key is versioned and every cached row goes through
        // mapRosterRow, the same defaulting the network path uses. This was a
        // raw `as RosterMember[]` cast of untrusted JSON - a blob from an older
        // build reached `member.downline_total.toLocaleString()` and threw.
        const swrKey = `roster_cache_v2_${resolvedId}`;
        try {
          const cached = sessionStorage.getItem(swrKey);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0) {
              const rows = parsed
                .filter((r: unknown): r is Record<string, unknown> => !!r && typeof r === 'object')
                .map(mapRosterRow);
              // Liveness BEFORE the write, not after it.
              if (!live()) return;
              if (rows.length > 0) {
                setMembers(rows);
                setLoading(false);
              }
            }
          }
        } catch (e) {
          reportError(e, 'ClubMembersPage.swr_cache_read');
        }

        // One call. Identity, role, player number, wallets, downline counts,
        // fees and live-seat presence, for the club or for every club in the
        // union above it.
        const roster = await ClubRosterService.getRoster(resolvedId);
        if (!live()) return;
        setMembers(roster);

        try {
          sessionStorage.setItem(swrKey, JSON.stringify(roster.slice(0, 300)));
        } catch {
          /* quota; the roster is already on screen */
        }

        // Whoever is reading decides which actions the rows offer. Their row is
        // already in the roster, so this usually costs nothing.
        if (user?.id) {
          const me = roster.find((m) => m.user_id === user.id);
          if (me) {
            setUserRole(me.role);
          } else {
            const { data: memberData } = await supabase
              .from('club_members')
              .select('role')
              .eq('club_id', resolvedId)
              .eq('user_id', user.id)
              .maybeSingle();
            if (live() && memberData) setUserRole(normaliseRole(memberData.role));


          }
        }

        // Fees come from a rollup fed forward from a watermark. Nudge it and
        // move on; the roster is correct either way.
        ClubRosterService.touchFeeRollup();
      } catch (error) {
        reportError(error, 'ClubMembersPage.loadMembers');
        if (live()) {
          // Without this the page said "No Members Found / Invite Players To
          // Grow Your Club" - it stated the club was empty when the request
          // failed, and the toast was gone in four seconds.
          setLoadError(true);
          toast.error('Failed To Load Members');
        }
      } finally {
        loadingRef.current = false;
        if (live()) setLoading(false);
      }
    },
    [clubId, user?.id, isMountedRef, toast]
  );

  /* NO REFRESH ON TAB FOCUS. PR #508 ("ClubMembersPage loads instantly and
     prevents auto-refresh") removed this from the old implementation and it is
     deliberately not reinstated here: coming back to a tab is not news about
     the roster, and the reload made the page visibly rebuild for nothing. */

  useEffect(() => {
    let mounted = true;
    if (clubId) loadMembers(() => mounted);
    return () => {
      mounted = false;
    };
  }, [clubId, loadMembers]);

  const refresh = useCallback(() => {
    setIsRefreshing(true);
    // `() => true` was a getIsMounted that is never false, and the .finally had
    // no guard at all - so an unmount mid-refresh warned and leaked. The
    // optional parameter defaults to isMountedRef, which is the correct one.
    loadMembers().finally(() => {
      if (isMountedRef.current) setIsRefreshing(false);
    });
  }, [loadMembers, isMountedRef]);

  /**
   * STRUCTURAL EVENTS ONLY - who is in the club and what rank they hold.
   *
   * The wallet and chip events (BALANCE_UPDATED, CHIPS_ADDED, CHIPS_WITHDRAWN,
   * CHIPS_DISTRIBUTED, CASHOUT_APPROVED) used to be in this list. They fire
   * continuously at a live club, and PR #508 removed them for exactly that
   * reason. Keeping the roster architecture while quietly putting the churn
   * back would be a silent revert, so they stay out. A stale wallet figure for
   * a few seconds is a far smaller defect than a list that rebuilds under the
   * reader's finger, and pull-to-refresh is right there when it matters.
   */
  useMasterBusSubscriptions(
    ['CLUB_JOINED', 'CLUB_LEFT', 'MEMBER_ROLE_CHANGED'],
    () => {
      if (clubId) refresh();
    },
    { debounce: 500 }
  );

  /**
   * Realtime is an invalidation signal, not a source of truth. Patching a row in
   * place used to leave downlines, wallets and fees stale, because none of those
   * live on club_members - so a change simply re-asks the server.
   */
  useMasterBusChannel({
    // Keyed on the UUID, not the raw route param: /clubs/25450/members and
    // /clubs/<uuid>/members are the same club and used to open two differently
    // named channels that nothing else on the platform would match.
    channelName: resolvedClubId ? `club-members-sync-${resolvedClubId}` : null,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: (payload) => {
      /* INSERT/DELETE only. An UPDATE on club_members is nearly always a
         chip_balance tick, and refetching on those is the auto-refresh PR #508
         removed. A row appearing or leaving genuinely changes the roster. */
      const p = payload as { eventType?: string; new?: { status?: string } } | null;
      const kind = p?.eventType;
      if (kind === 'INSERT' || kind === 'DELETE') {
        refresh();
        return;
      }
      /* Carried over from main: banning or suspending someone is an UPDATE, and
         they must leave the roster at once rather than linger until the next
         structural event. This is the ONLY UPDATE worth a refetch. */
      const status = p?.new?.status;
      if (kind === 'UPDATE' && (status === 'banned' || status === 'suspended')) refresh();
    },
    // A dead socket used to leave the roster frozen with no indication and,
    // since there is no polling fallback here by design, no way back short of
    // a page reload. One recovery fetch on a channel error is the cheapest
    // possible answer to that.
    onSubscriptionError: () => refresh(),
    enabled: !!resolvedClubId,
  });

  /* ── Filter, search, sort ─────────────────────────────────────────────── */

  const filteredMembers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matched = members.filter((m) => {
      if (filter === 'online' && !m.is_online) return false;
      if (filter === 'mine' && m.upline_user_id !== user?.id) return false;
      if (filter === 'agents' && !AGENT_ROLE_SET.includes(m.role)) return false;
      if (filter === 'admins' && !STAFF_ROLE_SET.includes(m.role)) return false;
      if (!q) return true;
      // Searching by player number matters as much as by name: it is what one
      // member gives another, and what an agent is handed in a support ticket.
      return (
        m.alias.toLowerCase().includes(q) ||
        m.username.toLowerCase().includes(q) ||
        (m.player_number ?? '').toLowerCase().includes(q)
      );
    });

    if (sortKey === 'hierarchy') return matched; // already in server order

    const sorted = [...matched];
    switch (sortKey) {
      case 'name':
        sorted.sort((a, b) => a.alias.localeCompare(b.alias, undefined, { sensitivity: 'base' }));
        break;
      case 'downlines':
        sorted.sort((a, b) => b.downline_total - a.downline_total || b.role_rank - a.role_rank);
        break;
      case 'wallet':
        sorted.sort(
          (a, b) =>
            b.player_wallet + b.agent_wallet - (a.player_wallet + a.agent_wallet) ||
            b.role_rank - a.role_rank
        );
        break;
      case 'fees':
        sorted.sort((a, b) => b.total_fees - a.total_fees || b.role_rank - a.role_rank);
        break;
    }
    return sorted;
    // user?.id is read by the `mine` filter above. Without it here this memo
    // and the mineCount memo beside it disagreed: an auth write that changed
    // `user` without changing `members` updated the "Direct (12)" chip while
    // the list it filters stayed stale.
  }, [members, filter, searchQuery, sortKey, user?.id]);

  const virtualScroll = useVirtualScroll(filteredMembers, { initialCount: 30, pageSize: 20 });

  const onlineCount = useMemo(() => members.filter((m) => m.is_online).length, [members]);
  const agentCount = useMemo(
    () => members.filter((m) => AGENT_ROLE_SET.includes(m.role)).length,
    [members]
  );
  /** Players whose upline is the reader. Drives the Direct chip, which is
   *  hidden entirely when it would match nothing. */
  const mineCount = useMemo(
    () => (user?.id ? members.filter((m) => m.upline_user_id === user.id).length : 0),
    [members, user?.id]
  );

  const openMember = useCallback(
    (userId: string) => {
      if (!clubId) return;
      navigate(`/clubs/${clubId}/members/${userId}`);
    },
    [clubId, navigate]
  );

  const handleExport = useCallback(() => {
    try {
      // roleLabel first: exportToCSV stringifies the value as-is, so the Role
      // column read `super_agent` / `sub_agent` while every on-screen surface
      // shows the formatted label.
      exportToCSV(
        filteredMembers.map((m) => ({ ...m, role: roleLabel(m.role) })),
        'club_members.csv',
        [
          { key: 'player_number', label: 'Player Number' },
          { key: 'alias', label: 'Club Arena Name' },
          { key: 'username', label: 'Username' },
          { key: 'role', label: 'Role' },
          { key: 'downline_total', label: 'Downlines' },
          { key: 'agent_wallet', label: 'Agent Wallet' },
          { key: 'player_wallet', label: 'Player Wallet' },
          { key: 'total_fees', label: 'Fees' },
          { key: 'chip_balance', label: 'Club Chips' },
          { key: 'is_online', label: 'Online' },
          { key: 'home_club_name', label: 'Club' },
          { key: 'joined_at', label: 'Joined' },
          { key: 'user_id', label: 'User ID' },
        ]
      );
      toast.success('Roster Exported');
    } catch (e) {
      reportError(e, 'ClubMembersPage.export');
      toast.error('Could Not Export The Roster');
    }
  }, [filteredMembers, toast]);

  /* ── Render ───────────────────────────────────────────────────────────── */

  return (
    <div className="club-members-page">
      <div className="members-summary">
        <div className="summary-stat">
          <span className="stat-value">{members.length.toLocaleString()}</span>
          <span className="stat-label">Total Members</span>
        </div>
        <div className="summary-stat summary-stat--online">
          <span className="stat-value">{onlineCount.toLocaleString()}</span>
          <span className="stat-label">Online Now</span>
        </div>
        {agentCount > 0 && (
          <div className="summary-stat summary-stat--agents">
            <span className="stat-value">{agentCount.toLocaleString()}</span>
            <span className="stat-label">Agents</span>
          </div>
        )}
      </div>

      <div className="members-search">
        <input
          type="text"
          placeholder={titleCase('search name or number')}
          aria-label="Search Club Members"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="members-controls">
        <div className="members-filters">
          {(Object.keys(FILTER_LABEL) as MemberFilter[])
            .filter((f) => f !== 'mine' || mineCount > 0)
            .map((f) => (
              <button
                key={f}
                type="button"
                className={filter === f ? 'active' : ''}
                aria-pressed={filter === f}
                onClick={() => setFilter(f)}
              >
                {FILTER_LABEL[f]}
                {/* Counts are over the WHOLE roster, so with a search active the
                  chip said "Agents (412)" and clicking it showed two. Drop the
                  count while searching rather than print a number that is
                  about to be contradicted. */}
                {!searchQuery && f === 'agents' && agentCount > 0
                  ? ` (${agentCount.toLocaleString()})`
                  : ''}
                {!searchQuery && f === 'mine' && mineCount > 0
                  ? ` (${mineCount.toLocaleString()})`
                  : ''}
                {!searchQuery && f === 'online' && onlineCount > 0
                  ? ` (${onlineCount.toLocaleString()})`
                  : ''}
              </button>
            ))}
        </div>

        <div className="members-toolbar">
          <label className="members-sort">
            <span className="members-sort__label">Sort By</span>
            <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>
              {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
                <option key={k} value={k}>
                  {SORT_LABEL[k]}
                </option>
              ))}
            </select>
          </label>

          {/* THE REFRESH THIS PAGE ALREADY ASSUMED IT HAD (Dan 2026-08-25).
              The comment above loadMembers justifies refusing to refresh on
              wallet events and tab focus with "pull-to-refresh is right there
              when it matters" - and there was no pull-to-refresh and no button.
              `refresh` was reachable only from a bus event or a realtime row
              change, so an owner who had just funded five agents in the Cashier
              switched to Players, saw stale wallets, and had no way to ask for
              current ones short of reloading the page. */}
          <button
            type="button"
            className="members-refresh"
            onClick={refresh}
            disabled={loading || isRefreshing}
          >
            {isRefreshing ? 'Refreshing...' : 'Refresh'}
          </button>

          {/* Export is a CSV of every member's wallets, chip balance and fee
              totals. `userRole` was resolved on every load - including an extra
              club_members round trip in the critical path - and then read
              nowhere at all, so this was offered to ordinary players. */}
          {filteredMembers.length > 0 && canExport && (
            <button
              type="button"
              className="members-export"
              // The SWR cache is a 300-row slice. Exporting while it is still
              // on screen handed someone 300 rows of a 34,000-member union
              // believing it was the whole roster.
              disabled={loading || isRefreshing}
              onClick={handleExport}
            >
              Export CSV
            </button>
          )}
        </div>
      </div>

      <div className="members-refreshing" role="status" aria-live="polite">
        {isRefreshing ? 'Refreshing...' : ''}
      </div>

      {/* NO containerRef here (Dan 2026-08-25). .members-list has no overflow and
          no height - it is not a scroll container - so passing it as the
          IntersectionObserver `root` made the sentinel intersect on the first
          frame and never change. The observer fired exactly once, 30 -> 50, and
          its effect deps do not include visibleCount so it was never rebuilt:
          a 34,000-member union was permanently capped at 50 rows with
          "Showing 50 Of 34,138" glued underneath. Leaving containerRef null
          roots the observer on the viewport, which is what actually scrolls. */}
      <div className="members-list">
        {loading && members.length === 0 ? (
          <PageSkeleton variant="list" />
        ) : notFound ? (
          <div className="members-error" role="alert">
            <span>We Could Not Find That Club.</span>
          </div>
        ) : loadError && members.length === 0 ? (
          <div className="members-error" role="alert">
            <span>Could Not Load The Roster.</span>
            <button type="button" className="members-export" onClick={refresh}>
              Try Again
            </button>
          </div>
        ) : filteredMembers.length === 0 ? (
          <EmptyRoster filter={filter} searchQuery={searchQuery} />
        ) : (
          <>
            {virtualScroll.visibleItems.map((member) => (
              <MemberRow key={member.user_id} member={member} onOpen={openMember} />
            ))}
            {virtualScroll.hasMore && <div ref={virtualScroll.sentinelRef} style={{ height: 1 }} />}
            {virtualScroll.hasMore && (
              <div className="members-count">
                Showing {virtualScroll.visibleCount.toLocaleString()} Of{' '}
                {virtualScroll.totalCount.toLocaleString()}
              </div>
            )}
          </>
        )}
      </div>

      {clubId && <ClubBottomNav clubId={clubId} />}
    </div>
  );
}

/** "12d" / "3mo" since a member was last seen, or '' when unreadable. */
function dormancy(iso: string): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const days = Math.floor((Date.now() - t) / 86_400_000);
  if (days < 1) return 'Today';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.floor(days / 30)}mo`;
  return `${Math.floor(days / 365)}y`;
}

/** The full timestamp for the title attribute, or '' when unreadable. */
function fullDate(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '';
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ONE ROW
   ═══════════════════════════════════════════════════════════════════════════════ */

function MemberRow({ member, onOpen }: { member: RosterMember; onOpen: (userId: string) => void }) {
  const initial = (member.alias || '?')[0]?.toUpperCase() ?? '?';

  return (
    <button
      type="button"
      /* SEATED and ONLINE are different facts with different consequences, and
         the row collapsed them into one cyan ring. is_seated is already on
         every row: an owner deciding whether to claim chips back, or an agent
         deciding whether to message someone, needs to know if they are mid-hand.
         Dan 2026-08-25. */
      className={`member-row${
        member.is_seated ? ' member-row--seated' : member.is_online ? ' member-row--online' : ''
      }`}
      onClick={() => onOpen(member.user_id)}
      /* aria-label on a button overrides its whole subtree, so the role badge,
         player number, club and all five metrics were unreachable by screen
         reader - a list of names and nothing else. Fold the essentials in. */
      aria-label={`${member.alias}, ${roleLabel(member.role)}${
        member.is_seated ? ', At A Table' : member.is_online ? ', Online' : ''
      }${member.upline_name ? `, Under ${member.upline_name}` : ''}, ${chips(
        member.downline_total
      )} Downlines. Open Member Management`}
    >
      <span className="member-avatar">
        {member.avatar_url ? (
          <img
            /* Storage objects go through the image-transform endpoint: the
               raw object URL was observed intermittently failing (HTTP 544)
               while /render/image/ stayed up, and a 44px box does not need a
               1MB original. Non-storage URLs pass through unchanged. */
            src={sizedStorageUrl(member.avatar_url, 44)}
            alt=""
            loading="lazy"
            /* A dead avatar URL (revoked storage object, offline fetch) left a
               blank circle on mobile. Swap to the deterministic monogram —
               a data URI cannot fail, and no DOM surgery under React. */
            onError={(e) => {
              const img = e.currentTarget;
              img.onerror = null;
              img.src = generateAvatarSvg(member.user_id, member.alias || '?');
            }}
          />
        ) : (
          <span>{initial}</span>
        )}
      </span>

      <span className="member-main">
        <span className="member-identity">
          <RoleBadge role={member.role} size="sm" />
          {/* The Club Arena name leads; the account username follows it. */}
          <span className="member-alias">{member.alias}</span>
          {member.username && member.username.toLowerCase() !== member.alias.toLowerCase() && (
            <span className="member-username">{member.username}</span>
          )}
        </span>

        <span className="member-subline">
          <span className="member-role" style={{ color: roleColor(member.role) }}>
            {roleLabel(member.role)}
          </span>
          {/* Requirement 2: the player number sits next to the role. */}
          {member.player_number && (
            <span className="member-number">No. {member.player_number}</span>
          )}
          {member.home_club_name && <span className="member-club">{member.home_club_name}</span>}
          {/* upline_name is fetched by the roster RPC, which walks the agent
              tree to produce it, and was rendered nowhere. "Who does this
              player sit under" is the first question an owner asks about any
              name on this list. */}
          {member.upline_name && <span className="member-upline">Under {member.upline_name}</span>}
          {member.is_seated && <span className="member-seated">At Table</span>}
          {/* last_login was also fetched and dropped. An owner pruning a
              roster, or an agent finding who has gone quiet, had no dormancy
              signal anywhere in the product. */}
          {!member.is_online && member.last_login && (
            <span className="member-seen" title={fullDate(member.last_login)}>
              {dormancy(member.last_login)}
            </span>
          )}
        </span>

        {/* Requirement 3, plus user's requested two columns for fees */}
        <span className="member-metrics">
          {/* chips(), like its four siblings: this direct dereference was the
              first thing to throw on a stale cached row. */}
          <Metric label="Downlines" value={chips(member.downline_total)} />
          <Metric label="Agent Wallet" value={chips(member.agent_wallet)} />
          <Metric label="Player Wallet" value={chips(member.player_wallet)} />
          <Metric label="Indiv. Fees" value={chips(member.total_fees)} accent />
          <Metric label="Total Fees" value={chips(member.downline_fees)} accent />
        </span>
      </span>

      <span className="member-chevron" aria-hidden="true">
        &rsaquo;
      </span>
    </button>
  );
}

function Metric({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <span className={`member-metric${accent ? ' member-metric--accent' : ''}`}>
      <span className="member-metric__value">{value}</span>
      <span className="member-metric__label">{label}</span>
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   EMPTY STATE
   ═══════════════════════════════════════════════════════════════════════════════ */

function EmptyRoster({ filter, searchQuery }: { filter: MemberFilter; searchQuery: string }) {
  /**
   * The search test comes FIRST. Only the `all` branch used to mention the
   * query, so with the Agents filter active and "zzz" typed, a club full of
   * agents reported "Promote A Member To Agent To Get Started."
   */
  const searching = searchQuery.trim().length > 0;

  const heading = searching
    ? 'No Results Found'
    : filter === 'agents'
      ? 'No Agents Yet'
      : filter === 'admins'
        ? 'No Admins Found'
        : filter === 'online'
          ? 'No Members Online'
          : 'No Members Found';

  const body = searching
    ? `No Results For "${searchQuery}".`
    : filter === 'agents'
      ? 'Promote A Member To Agent To Get Started.'
      : filter === 'admins'
        ? 'No One Has Admin Privileges In This Club Yet.'
        : filter === 'online'
          ? 'No Club Members Are Currently At A Table.'
          : 'Invite Players To Grow Your Club.';

  return (
    <div className="members-empty">
      <span className="members-empty__mark" aria-hidden="true">
        {filter === 'online' ? '●' : '◉'}
      </span>
      <p className="members-empty__heading">{heading}</p>
      <p className="members-empty__body">{body}</p>
    </div>
  );
}
