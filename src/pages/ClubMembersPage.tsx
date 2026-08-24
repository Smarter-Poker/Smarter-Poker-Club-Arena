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
import { resolveClubUUID } from '../utils/clubIdResolver';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { titleCase } from '../utils/titleCase';
import { normaliseRole, roleLabel, type ClubRole } from '../types/clubRoles';
import ClubRosterService, { type RosterMember } from '../services/ClubRosterService';

/* ═══════════════════════════════════════════════════════════════════════════════
   FILTERS AND SORTS
   ═══════════════════════════════════════════════════════════════════════════════ */

type MemberFilter = 'all' | 'online' | 'agents' | 'admins';

const FILTER_LABEL: Record<MemberFilter, string> = {
  all: 'All',
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

const AGENT_ROLE_SET: ClubRole[] = ['super_agent', 'agent', 'sub_agent'];
const STAFF_ROLE_SET: ClubRole[] = ['owner', 'co_owner', 'admin'];

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

  const loadingRef = useRef(false);

  // Safety net: never leave a skeleton on screen forever if auth or the network
  // hangs. The empty state is a better answer than a spinner that never stops.
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 8000);
    return () => clearTimeout(timeout);
  }, []);

  // Navigating between clubs must not show the previous club's filters.
  useEffect(() => {
    setUserRole('player');
    setFilter('all');
    setSortKey('hierarchy');
    setSearchQuery('');
    setIsRefreshing(false);
    loadingRef.current = false;
  }, [clubId]);

  const loadMembers = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!clubId) return;
      const live = () => (getIsMounted ? getIsMounted() : true) && isMountedRef.current;

      loadingRef.current = true;
      if (live()) setLoading(true);
      try {
        const resolvedId = await resolveClubUUID(clubId);
        if (!live()) return;
        if (!resolvedId) {
          setMembers([]);
          return;
        }
        setResolvedClubId(resolvedId);

        // SWR: paint the previous roster instantly, then replace it. The cache
        // holds the whole row now rather than a trimmed copy, because the row IS
        // the screen - wallets, downlines and fees included.
        const swrKey = `roster_cache_${resolvedId}`;
        try {
          const cached = sessionStorage.getItem(swrKey);
          if (cached) {
            const parsed = JSON.parse(cached);
            if (Array.isArray(parsed) && parsed.length > 0) {
              setMembers(parsed as RosterMember[]);
              if (!live()) return;
              setLoading(false);
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
        if (live()) toast.error('Failed To Load Members');
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
    loadMembers(() => true).finally(() => setIsRefreshing(false));
  }, [loadMembers]);

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
    channelName: resolvedClubId ? `club-members-sync-${clubId}` : null,
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
    enabled: !!resolvedClubId,
  });

  /* ── Filter, search, sort ─────────────────────────────────────────────── */

  const filteredMembers = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const matched = members.filter((m) => {
      if (filter === 'online' && !m.is_online) return false;
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
  }, [members, filter, searchQuery, sortKey]);

  const virtualScroll = useVirtualScroll(filteredMembers, { initialCount: 30, pageSize: 20 });

  const onlineCount = useMemo(() => members.filter((m) => m.is_online).length, [members]);
  const agentCount = useMemo(
    () => members.filter((m) => AGENT_ROLE_SET.includes(m.role)).length,
    [members]
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
      exportToCSV(filteredMembers, 'club_members.csv', [
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
      ]);
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
          placeholder={titleCase('search by name, username or player number')}
          aria-label="Search Club Members"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="members-controls">
        <div className="members-filters">
          {(Object.keys(FILTER_LABEL) as MemberFilter[]).map((f) => (
            <button
              key={f}
              type="button"
              className={filter === f ? 'active' : ''}
              onClick={() => setFilter(f)}
            >
              {FILTER_LABEL[f]}
              {f === 'agents' && agentCount > 0 ? ` (${agentCount})` : ''}
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

          {filteredMembers.length > 0 && (
            <button type="button" className="members-export" onClick={handleExport}>
              Export CSV
            </button>
          )}
        </div>
      </div>

      {isRefreshing && <div className="members-refreshing">Refreshing...</div>}

      <div className="members-list" ref={virtualScroll.containerRef}>
        {loading && members.length === 0 ? (
          <PageSkeleton variant="list" />
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

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole as any} />}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ONE ROW
   ═══════════════════════════════════════════════════════════════════════════════ */

function MemberRow({ member, onOpen }: { member: RosterMember; onOpen: (userId: string) => void }) {
  const initial = (member.alias || '?')[0]?.toUpperCase() ?? '?';

  return (
    <button
      type="button"
      className={`member-row${member.is_online ? ' member-row--online' : ''}`}
      onClick={() => onOpen(member.user_id)}
      aria-label={`Open Member Management For ${member.alias}`}
    >
      <div className="member-avatar">
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
      </div>

      <div className="member-main">
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
        </span>

        {/* Requirement 3, plus user's requested two columns for fees */}
        <span className="member-metrics">
          <Metric label="Downlines" value={member.downline_total.toLocaleString()} />
          <Metric label="Agent Wallet" value={chips(member.agent_wallet)} />
          <Metric label="Player Wallet" value={chips(member.player_wallet)} />
          <Metric label="Indiv. Fees" value={chips(member.total_fees)} accent />
          <Metric label="Total Fees" value={chips(member.downline_fees)} accent />
        </span>
      </div>

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
  const heading =
    filter === 'agents'
      ? 'No Agents Yet'
      : filter === 'admins'
        ? 'No Admins Found'
        : filter === 'online'
          ? 'No Members Online'
          : 'No Members Found';

  const body =
    filter === 'agents'
      ? 'Promote A Member To Agent To Get Started.'
      : filter === 'admins'
        ? 'No One Has Admin Privileges In This Club Yet.'
        : filter === 'online'
          ? 'No Club Members Are Currently At A Table.'
          : searchQuery
            ? `No Results For "${searchQuery}".`
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
