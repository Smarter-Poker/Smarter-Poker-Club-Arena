/**
 *  CLUB MEMBERS PAGE — Member Management with Live Presence & Role Promotion
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useUserStore } from '../stores/useUserStore';
import { useAuthUser } from '../hooks/useAuthUser';
import { masterBus } from '../core/MasterBus';
import {
  useMasterBusSubscription,
  useMasterBusSubscriptions,
} from '../hooks/useMasterBusSubscription';
import { useMasterBusChannel } from '../hooks/useMasterBusChannel';
import { useToast } from '../components/common/Toast';
import { useVirtualScroll } from '../hooks/useVirtualScroll';
import PageSkeleton from '../components/common/PageSkeleton';
import ClubBottomNav from '../components/club/ClubBottomNav';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import './ClubMembersPage.css';
import { retryAsync } from '../utils/retryAsync';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { WalletService } from '../services/WalletService';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import {
  type ClubRole,
  ROLE_DESCRIPTION,
  normaliseRole,
  roleLabel,
  roleRank,
} from '../types/clubRoles';

import { safeErrorMessage } from '../utils/safeErrorMessage';
/* ═══════════════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════════════ */

// The seven live in src/types/clubRoles.ts and mirror the database exactly.
type MemberRole = ClubRole;

interface ClubMember {
  id: string;
  user_id: string;
  username: string;
  avatar_url?: string;
  role: MemberRole;
  chip_balance: number;
  joined_at: string;
  is_online: boolean;
  last_active?: string;
  parent_agent_id?: string;
}

/**
 * Dan 2026-08-19: horses are players. There is no "horses" filter, no HORSE
 * badge, and nothing anywhere in Club Arena that lets a member tell a horse
 * from a human. Do not reintroduce a horse-only view here.
 */
type MemberFilter = 'all' | 'online' | 'agents' | 'admins';

/* ═══════════════════════════════════════════════════════════════════════════════
   ROLE HIERARCHY & PERMISSIONS
   ═══════════════════════════════════════════════════════════════════════════════ */

/*
 * The vocabulary, the ranks and the grant matrix moved to
 * src/types/clubRoles.ts, which mirrors fn_club_grantable_roles in Postgres.
 * What used to sit here disagreed with the database three ways at once: no
 * co_owner, an admin able to appoint a super agent, and a super agent able to
 * promote ANY member rather than only their own downline. The screen now asks
 * the server what it may offer, so the two cannot drift again.
 */

function getRoleColor(role: ClubRole): string {
  switch (role) {
    case 'owner':
      return '#FFD700';
    case 'co_owner':
      return '#F0B429';
    case 'admin':
      return '#FF6B6B';
    case 'super_agent':
      return '#A855F7';
    case 'agent':
      return '#00d4ff';
    case 'sub_agent':
      return '#38BDF8';
    default:
      return '#6a7a8a';
  }
}

function getRoleBadgeIcon(role: ClubRole): string {
  switch (role) {
    case 'owner':
      return '\u2605'; // ★
    case 'co_owner':
      return '\u2606'; // ☆
    case 'admin':
      return '\u25B2'; // ▲
    case 'super_agent':
      return '\u25C6'; // ◆
    case 'agent':
      return '\u25CF'; // ●
    case 'sub_agent':
      return '\u25CB'; // ○
    default:
      return '';
  }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   PLAYER ACTION MODAL
   ═══════════════════════════════════════════════════════════════════════════════ */

interface PlayerActionModalProps {
  member: ClubMember;
  myRole: MemberRole;
  clubId: string;
  onClose: () => void;
  onRoleChanged: () => void;
}

function PlayerActionModal({
  member,
  myRole,
  clubId,
  onClose,
  onRoleChanged,
}: PlayerActionModalProps) {
  const safeUsername = member.username || 'Unknown';
  const [promoting, setPromoting] = useState(false);
  const [confirmRole, setConfirmRole] = useState<MemberRole | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // CA-18 BUG FIX: the 1.2s "show success then refresh" timer was fire-and-forget.
  // If the user clicked outside to dismiss the modal before 1.2s, the component
  // unmounted and onRoleChanged()/onClose() fired on a dead component tree.
  const roleChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (roleChangeTimerRef.current) clearTimeout(roleChangeTimerRef.current);
    };
  }, []);

  // Accessibility: close modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // The server decides what may be offered. fn_club_grantable_roles is the
  // rule; this asks it rather than guessing, so the buttons on screen and the
  // write that follows cannot disagree - and "is this player in my downline",
  // which the client has no way to answer, is answered where the tree lives.
  const [promotableRoles, setPromotableRoles] = useState<MemberRole[]>([]);
  const [rolesLoading, setRolesLoading] = useState(true);

  useEffect(() => {
    let live = true;
    (async () => {
      setRolesLoading(true);
      try {
        const resolvedClubId = await resolveClubUUID(clubId);
        if (!resolvedClubId) throw new Error('club not found');
        const { data, error: rolesErr } = await supabase.rpc('ca_club_grantable_roles', {
          p_club_id: resolvedClubId,
          p_target_user_id: member.user_id,
        });
        if (!live) return;
        if (rolesErr) throw rolesErr;
        const roles = (data as { roles?: string[] } | null)?.roles ?? [];
        setPromotableRoles(roles.map(normaliseRole));
      } catch (e) {
        reportError(e, 'ClubMembersPage.grantable_roles');
        // Offering nothing is the safe direction to be wrong in: the user is
        // told, rather than shown a button the server will refuse.
        if (live) setPromotableRoles([]);
      } finally {
        if (live) setRolesLoading(false);
      }
    })();
    return () => {
      live = false;
    };
  }, [clubId, member.user_id]);

  const canManage = promotableRoles.length > 0 && member.role !== 'owner';
  const noRolesReason =
    member.role === 'owner'
      ? 'The club owner cannot be changed from here.'
      : roleRank(myRole) <= roleRank('sub_agent')
        ? 'Your role does not allow changing anyone else\u2019s.'
        : 'You can only change the role of players in your own downline.';

  const handlePromote = async (newRole: MemberRole) => {
    setPromoting(true);
    setError('');
    setSuccess('');

    try {
      const resolvedClubId = await resolveClubUUID(clubId);
      if (!resolvedClubId) throw new Error('Club not found');

      // ONE WRITE PATH. This used to fall back to
      // `.from('club_members').update({ role })` whenever the RPC errored,
      // which skipped every rule the RPC enforces - a club admin could appoint
      // a co-owner, or promote outside their downline, by making one request
      // fail. A trigger on club_members now refuses that update outright, so
      // the fallback could not work even if someone put it back.
      const { data, error: rpcError } = await supabase.rpc('fn_club_set_member_role', {
        p_club_id: resolvedClubId,
        p_user_id: member.user_id,
        p_role: newRole,
      });
      if (rpcError) throw rpcError;

      const result = data as { success?: boolean; error?: string } | null;
      if (!result?.success) throw new Error(result?.error || 'Role change refused');

      setSuccess(`${member.username} is now ${roleLabel(newRole)}`);
      setConfirmRole(null);

      masterBus.emit('CLUB_UPDATED', { clubId });
      const agentRoles = ['super_agent', 'agent', 'sub_agent'];
      if (agentRoles.includes(newRole) || agentRoles.includes(member.role)) {
        masterBus.emit('AGENT_UPDATED', { clubId: clubId || '', agentId: member.user_id });
      }
      masterBus.emit('MEMBER_ROLE_CHANGED', {
        clubId: clubId || '',
        userId: member.user_id,
        newRole,
        previousRole: member.role,
      });

      if (roleChangeTimerRef.current) clearTimeout(roleChangeTimerRef.current);
      roleChangeTimerRef.current = setTimeout(() => {
        roleChangeTimerRef.current = null;
        onRoleChanged();
        onClose();
      }, 1200);
    } catch (err: any) {
      setError(safeErrorMessage(err, 'Failed to update role'));
    } finally {
      setPromoting(false);
    }
  };

  return (
    <div
      className="player-modal-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={`Actions for ${safeUsername}`}
    >
      <div className="player-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="player-modal__header">
          <div className="player-modal__avatar">
            {member.avatar_url ? (
              <img src={member.avatar_url} alt="" loading="lazy" />
            ) : (
              <span>{safeUsername[0]?.toUpperCase()}</span>
            )}
            {member.is_online && <span className="online-dot" />}
          </div>
          <div className="player-modal__info">
            <h3>{member.username}</h3>
            <span className="player-modal__role-badge" style={{ color: getRoleColor(member.role) }}>
              {getRoleBadgeIcon(member.role)} {roleLabel(member.role)}
            </span>
          </div>
          <button className="player-modal__close" onClick={onClose} aria-label="Close modal">
            &times;
          </button>
        </div>

        {/* Stats */}
        <div className="player-modal__stats">
          <div className="player-modal__stat">
            <span className="stat-value">{(member.chip_balance ?? 0).toLocaleString()}</span>
            <span className="stat-label">Chips</span>
          </div>
          <div className="player-modal__stat">
            <span className="stat-value">{member.is_online ? 'Online' : 'Offline'}</span>
            <span className="stat-label">Status</span>
          </div>
          <div className="player-modal__stat">
            <span className="stat-value">
              {new Date(member.joined_at).toLocaleDateString('en-US', {
                month: 'short',
                year: 'numeric',
              })}
            </span>
            <span className="stat-label">Joined</span>
          </div>
        </div>

        {/* Role Management */}
        {canManage && (
          <div className="player-modal__roles">
            <h4>Change Role</h4>

            {error && <div className="player-modal__error">{error}</div>}
            {success && <div className="player-modal__success">{success}</div>}

            {confirmRole ? (
              <div className="player-modal__confirm">
                <p>
                  Promote <strong>{member.username}</strong> to{' '}
                  <strong style={{ color: getRoleColor(confirmRole) }}>
                    {roleLabel(confirmRole)}
                  </strong>
                  ?
                </p>
                <div className="player-modal__confirm-actions">
                  <button
                    className="confirm-btn confirm"
                    onClick={() => handlePromote(confirmRole)}
                    disabled={promoting}
                  >
                    {promoting ? 'Updating...' : 'Confirm'}
                  </button>
                  <button
                    className="confirm-btn cancel"
                    onClick={() => setConfirmRole(null)}
                    disabled={promoting}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <div className="player-modal__role-grid">
                {promotableRoles.map((role) => (
                  <button
                    key={role}
                    className="role-option"
                    style={{ borderColor: getRoleColor(role) }}
                    onClick={() => setConfirmRole(role)}
                  >
                    <span className="role-option__icon" style={{ color: getRoleColor(role) }}>
                      {getRoleBadgeIcon(role)}
                    </span>
                    <span className="role-option__label">{roleLabel(role)}</span>
                    <span className="role-option__desc">{ROLE_DESCRIPTION[role]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Why nothing is on offer. "You don't have permission" was the same
            sentence for four different situations, one of which was simply
            still loading. */}
        {rolesLoading && !canManage && (
          <div className="player-modal__info-section">
            <p>Checking what you can change...</p>
          </div>
        )}
        {!rolesLoading && !canManage && (
          <div className="player-modal__info-section">
            <p>{noRolesReason}</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MAIN PAGE COMPONENT
   ═══════════════════════════════════════════════════════════════════════════════ */

export default function ClubMembersPage() {
  const [searchParams] = useSearchParams();
  const { clubId: routeClubId } = useParams();
  const clubId = routeClubId || searchParams.get('club') || undefined;
  const { user } = useAuthUser();
  const toast = useToast();
  const isMountedRef = useIsMounted();
  useVisibilityRefresh(() => loadMembers());

  const [members, setMembers] = useState<ClubMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [filter, setFilter] = useState<MemberFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());
  const [userRole, setUserRole] = useState<MemberRole>('player');
  const [visibleMembers, setVisibleMembers] = useState<Set<string>>(new Set());
  const [selectedMember, setSelectedMember] = useState<ClubMember | null>(null);
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);

  const loadingRef = useRef(false);
  // Players currently occupying a seat at one of this club's tables. Merged
  // into onlineUserIds so seated players count as online (see effect below).
  const seatedUserIdsRef = useRef<Set<string>>(new Set());

  // Safety timeout: prevent infinite skeleton if auth/Supabase hangs
  useEffect(() => {
    const timeout = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(timeout);
  }, []);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setUserRole('player');
    setFilter('all');
    setSearchQuery('');
    setSelectedMember(null);
    setVisibleMembers(new Set());
    setIsRefreshing(false);
    loadingRef.current = false;
  }, [clubId]);

  const loadMembers = useCallback(
    async (getIsMounted?: () => boolean) => {
      if (!clubId) return;

      loadingRef.current = true;
      if (!getIsMounted || getIsMounted()) setLoading(true);
      try {
        const resolvedId = await resolveClubUUID(clubId);
        // Update resolved ID for realtime subscriptions
        if (getIsMounted && !getIsMounted()) return;
        setResolvedClubId(resolvedId);

        // SWR: Show cached members instantly while loading fresh data
        const swrKey = `members_cache_${resolvedId}`;
        try {
          const cached = sessionStorage.getItem(swrKey);
          if (cached) {
            const cm = JSON.parse(cached);
            if (Array.isArray(cm) && cm.length > 0) {
              setMembers(cm);
              if (getIsMounted && !getIsMounted()) return;
              setLoading(false); // Show cached list instantly
            }
          }
        } catch (e) {
          reportError(e, 'ClubMembersPage.async');
          /* corrupt cache */
        }

        const { data, error } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('user_id, role, chip_balance, joined_at, parent_agent_id')
              .eq('club_id', resolvedId)
              .not('status', 'in', '("banned","suspended")')
              .order('joined_at', { ascending: true })
              .limit(5000)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMountedRef }
        );

        if (getIsMounted && !getIsMounted()) return;
        if (!error && data) {
          // Batch-fetch profiles (no FK between club_members → profiles)
          const userIds = data.map((m: any) => m.user_id);
          const profileMap: Record<string, any> = {};
          if (userIds.length > 0) {
            const chunkSize = 150;
            for (let i = 0; i < userIds.length; i += chunkSize) {
              const chunk = userIds.slice(i, i + chunkSize);
              const { data: profiles } = await supabase
                .from('profiles')
                .select('id, username, display_name, avatar_url')
                .in('id', chunk);
              if (profiles) {
                for (const p of profiles) profileMap[p.id] = p;
              }
            }
          }
          const mapped = data.map((m: any) => ({
            id: m.user_id,
            user_id: m.user_id,
            /**
             * Dan 2026-08-19: `profiles.username` is forced lowercase by the
             * trg_normalize_username trigger, which is why the roster read as a
             * wall of "semibluff sal" / "tulsajeff". display_name is the real
             * display field and carries the intended capitalisation.
             */
            username:
              profileMap[m.user_id]?.display_name || profileMap[m.user_id]?.username || 'Unknown',
            avatar_url: profileMap[m.user_id]?.avatar_url,
            role: normaliseRole(m.role),
            chip_balance: m.chip_balance || 0,
            joined_at: m.joined_at,
            is_online: onlineUserIds.has(m.user_id),
            last_active: undefined,
            parent_agent_id: m.parent_agent_id,
          }));
          setMembers(mapped);

          // Save to SWR cache (lightweight: just top-level fields)
          try {
            sessionStorage.setItem(swrKey, JSON.stringify(mapped.slice(0, 200)));
          } catch {
            /* storage full */
          }

          // Fetch current user's role
          if (user?.id) {
            const { data: memberData } = await retryFetch(
              () =>
                supabase
                  .from('club_members')
                  .select('role')
                  .eq('club_id', resolvedId)
                  .eq('user_id', user.id)
                  .maybeSingle()
                  .then((r) => r),
              { maxRetries: 2, isMountedRef: isMountedRef }
            );

            if (getIsMounted && !getIsMounted()) return;
            if (memberData) {
              setUserRole(normaliseRole(memberData.role));
            }
          }
        }
      } catch (error) {
        reportError(error, 'ClubMembersPage.Failed_to_load_members');
        toast.error('Failed to load members');
      } finally {
        loadingRef.current = false;
        if (!getIsMounted || getIsMounted()) setLoading(false);
      }
    },
    [clubId, user?.id, onlineUserIds]
  );

  useEffect(() => {
    let isMounted = true;
    if (clubId) loadMembers(() => isMounted);

    return () => {
      isMounted = false;
    };
  }, [clubId, loadMembers]);

  // Subscribe to bus-level events for cross-component sync
  useMasterBusSubscriptions(
    [
      'CLUB_JOINED',
      'CLUB_LEFT',
      'BALANCE_UPDATED',
      'CHIPS_ADDED',
      'CHIPS_WITHDRAWN',
      'CHIPS_DISTRIBUTED',
      'CASHOUT_APPROVED',
    ],
    () => {
      if (!clubId) return;
      setIsRefreshing(true);
      loadMembers(() => true).finally(() => {
        setIsRefreshing(false);
      });
    },
    { debounce: 500 }
  );

  useMasterBusSubscription(
    'CLUB_UPDATED',
    (payload: any) => {
      if (!clubId || !payload?.clubId || payload.clubId === clubId) {
        setIsRefreshing(true);
        loadMembers(() => true).finally(() => {
          setIsRefreshing(false);
        });
      }
    },
    { debounce: 500 }
  );

  // Stagger animation for members
  useEffect(() => {
    if (members.length === 0) return;
    setVisibleMembers(new Set());
    const timers = members.map((member, index) =>
      setTimeout(() => {
        setVisibleMembers((prev) => new Set(prev).add(member.id));
      }, index * 60)
    );
    return () => timers.forEach(clearTimeout);
  }, [members]);

  // Real-time club members table updates using hook
  useMasterBusChannel({
    channelName: resolvedClubId ? `club-members-sync-${clubId}` : null,
    table: 'club_members',
    filter: resolvedClubId ? `club_id=eq.${resolvedClubId}` : null,
    event: '*',
    onPayload: (payload) => {
      if (!payload) return;
      const { eventType, new: newRec, old: oldRec } = payload;

      if (eventType === 'DELETE' && oldRec) {
        setMembers((prev) => prev.filter((m) => m.user_id !== oldRec.user_id));
      } else if (eventType === 'UPDATE' && newRec) {
        if (newRec.status === 'banned' || newRec.status === 'suspended') {
          setMembers((prev) => prev.filter((m) => m.user_id !== newRec.user_id));
        } else {
          setMembers((prev) => {
            const idx = prev.findIndex((m) => m.user_id === newRec.user_id);
            if (idx === -1) {
              setTimeout(() => loadMembers(() => true), 100);
              return prev;
            }
            const next = [...prev];
            next[idx] = {
              ...next[idx],
              role: newRec.role,
              chip_balance: newRec.chip_balance,
              parent_agent_id: newRec.parent_agent_id,
            };
            return next;
          });
        }
      } else {
        setTimeout(() => loadMembers(() => true), 100);
      }
    },
    enabled: !!resolvedClubId,
  });

  /**
   * Dan 2026-08-19: "Online" used to come from the Realtime presence channel
   * alone. Presence only tracks connected browser clients, so every
   * server-driven player was invisible and the roster reported 1 online while
   * the club had hundreds of members seated in live hands. Anyone occupying a
   * seat at one of this club's tables is, by any honest definition, online.
   */
  useEffect(() => {
    if (!resolvedClubId) return;
    let cancelled = false;

    const loadSeated = async () => {
      try {
        /**
         * LIVE_TABLE_STATUSES, not a boolean flag: `tables` has no `is_active`
         * column. The first version of this query filtered on `.eq('is_active',
         * true)`, which PostgREST rejected outright — and because supabase-js
         * RETURNS errors rather than throwing, the try/catch never fired, the
         * result was silently null, and "Online" stayed stuck at 1. Any error
         * here is now surfaced instead of swallowed.
         *
         * Seats on `closed` tables are deliberately excluded: stale rows on
         * closed tables would otherwise count long-gone players as online.
         */
        const { data: clubTables, error: tablesErr } = await supabase
          .from('tables')
          .select('id')
          .eq('club_id', resolvedClubId)
          .in('status', ['waiting', 'running']);
        if (tablesErr) {
          reportError(tablesErr.message, 'ClubMembersPage.Seated_online_tables_query');
          return;
        }
        const tableIds = (clubTables || []).map((t: { id: string }) => t.id);
        if (cancelled || tableIds.length === 0) return;

        const seated = new Set<string>();
        const chunkSize = 100;
        for (let i = 0; i < tableIds.length; i += chunkSize) {
          const { data: seats, error: seatsErr } = await supabase
            .from('table_seats')
            .select('user_id')
            .in('table_id', tableIds.slice(i, i + chunkSize))
            .is('left_at', null);
          if (seatsErr) {
            reportError(seatsErr.message, 'ClubMembersPage.Seated_online_seats_query');
            return;
          }
          (seats || []).forEach((s: { user_id: string | null }) => {
            if (s.user_id) seated.add(s.user_id);
          });
          if (cancelled) return;
        }
        if (cancelled) return;

        seatedUserIdsRef.current = seated;
        setOnlineUserIds((prev) => {
          const next = new Set(prev);
          seated.forEach((id) => next.add(id));
          return next.size === prev.size ? prev : next;
        });
      } catch (err) {
        reportError(err, 'ClubMembersPage.Seated_online_sync');
      }
    };

    loadSeated();
    const interval = setInterval(loadSeated, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [resolvedClubId]);

  // Real-time presence tracking for club members
  useEffect(() => {
    if (!clubId || !user?.id) return;

    const presenceKey = `club-members-${clubId}`;
    const channel = masterBus.getOrCreateChannel(presenceKey);

    channel
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState();
        const onlineIds = new Set<string>();
        Object.values(state).forEach((presences) => {
          (presences as any[]).forEach((p) => onlineIds.add(p.user_id));
        });
        // Merge in players we know are seated. Presence only covers browser
        // clients, so a seated horse never appeared — the roster read "1 online"
        // while hundreds of members were mid-hand.
        setOnlineUserIds((prev) => {
          seatedUserIdsRef.current.forEach((id) => onlineIds.add(id));
          return onlineIds.size === prev.size && [...onlineIds].every((id) => prev.has(id))
            ? prev
            : onlineIds;
        });
      })
      .subscribe(async (status: string, err?: Error) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: user.id, club_id: clubId });
        } else if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'ClubMembersPage._Presence_channel_error');
        } else if (status === 'TIMED_OUT') {
          console.warn('[ClubMembersPage] Presence channel timed out');
        }
      });

    return () => {
      masterBus.removeRegisteredChannel(presenceKey);
    };
  }, [clubId, user?.id]);

  // Update member online status when presence changes
  const membersWithStatus = useMemo(
    () =>
      members.map((m) => ({
        ...m,
        is_online: onlineUserIds.has(m.user_id),
      })),
    [members, onlineUserIds]
  );

  const filteredMembers = useMemo(
    () =>
      membersWithStatus.filter((m) => {
        if (filter === 'online' && !m.is_online) return false;
        if (filter === 'agents' && !['super_agent', 'agent', 'sub_agent'].includes(m.role))
          return false;
        if (filter === 'admins' && !['owner', 'co_owner', 'admin'].includes(m.role)) return false;
        if (searchQuery && !(m.username || '').toLowerCase().includes(searchQuery.toLowerCase()))
          return false;
        return true;
      }),
    [membersWithStatus, filter, searchQuery]
  );

  // Virtual scrolling: only render visible members for large clubs
  const virtualScroll = useVirtualScroll(filteredMembers, { initialCount: 30, pageSize: 20 });

  const onlineCount = membersWithStatus.filter((m) => m.is_online).length;
  const agentCount = membersWithStatus.filter((m) =>
    ['super_agent', 'agent', 'sub_agent'].includes(m.role)
  ).length;

  return (
    <div className="club-members-page">
      <div className="members-summary">
        <div className="summary-stat">
          <span className="stat-value">{members.length}</span>
          <span className="stat-label">Total Members</span>
        </div>
        <div className="summary-stat online">
          <span className="stat-value">{onlineCount}</span>
          <span className="stat-label">Online Now</span>
        </div>
        {agentCount > 0 && (
          <div className="summary-stat agents">
            <span className="stat-value">{agentCount}</span>
            <span className="stat-label">Agents</span>
          </div>
        )}
      </div>

      <div className="members-search">
        <input
          type="text"
          placeholder="Search members..."
          aria-label="Search club members"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="members-filters">
        {(['all', 'online', 'agents', 'admins'] as MemberFilter[]).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {f === 'agents' && agentCount > 0 ? ` (${agentCount})` : ''}
          </button>
        ))}
        {filteredMembers.length > 0 && (
          <button
            style={{
              marginLeft: 'auto',
              padding: '6px 14px',
              borderRadius: '8px',
              cursor: 'pointer',
              background: 'rgba(0,200,83,0.12)',
              color: '#00C853',
              border: '1px solid rgba(0,200,83,0.3)',
              fontWeight: 600,
              fontSize: '13px',
            }}
            onClick={() => {
              try {
                exportToCSV(filteredMembers, 'club_members.csv', [
                  { key: 'username', label: 'Username' },
                  { key: 'role', label: 'Role' },
                  { key: 'chip_balance', label: 'Chip Balance' },
                  { key: 'is_online', label: 'Online' },
                  { key: 'joined_at', label: 'Joined' },
                  { key: 'user_id', label: 'User ID' },
                ]);
              } catch (e) {
                reportError(e, 'ClubMembersPage.filter');
                /* silent */
              }
            }}
          >
            ⬇ Export CSV
          </button>
        )}
      </div>

      <div className="members-list" ref={virtualScroll.containerRef}>
        {loading ? (
          <PageSkeleton variant="list" />
        ) : filteredMembers.length === 0 ? (
          <div className="empty-state" style={{ textAlign: 'center', padding: '2.5rem 1.5rem' }}>
            <span
              style={{
                fontSize: '2.5rem',
                display: 'block',
                marginBottom: '0.75rem',
                opacity: 0.5,
              }}
            >
              {filter === 'agents'
                ? '◈'
                : filter === 'admins'
                  ? '◈'
                  : filter === 'online'
                    ? '●'
                    : '◉'}
            </span>
            <p style={{ fontSize: '1.05rem', fontWeight: 600, margin: '0 0 0.5rem' }}>
              {filter === 'agents'
                ? 'No Agents Yet'
                : filter === 'admins'
                  ? 'No Admins Found'
                  : filter === 'online'
                    ? 'No Members Online'
                    : 'No Members Found'}
            </p>
            <p style={{ color: 'var(--soft-white, #B0B3B8)', fontSize: '0.85rem', margin: 0 }}>
              {filter === 'agents'
                ? 'Promote a member to Agent to get started.'
                : filter === 'admins'
                  ? 'No one has admin privileges in this club yet.'
                  : filter === 'online'
                    ? 'No club members are currently online.'
                    : searchQuery
                      ? `No results for "${searchQuery}".`
                      : 'Invite players to grow your club.'}
            </p>
          </div>
        ) : (
          <>
            {virtualScroll.visibleItems.map((member) => (
              <div
                key={member.id}
                className={`member-row ${visibleMembers.has(member.id) ? 'fadeInUp' : 'hidden'}`}
                style={
                  visibleMembers.has(member.id)
                    ? undefined
                    : { opacity: 0, transform: 'translateY(8px)' }
                }
                onClick={() => setSelectedMember(member)}
              >
                <div className="member-avatar">
                  {member.avatar_url ? (
                    <img src={member.avatar_url} alt="" loading="lazy" />
                  ) : (
                    <span>{(member.username || '?')[0]?.toUpperCase()}</span>
                  )}
                  {member.is_online && <span className="online-dot" />}
                </div>
                <div className="member-info">
                  <span className="member-name">
                    <span style={{ color: getRoleColor(member.role) }}>
                      {getRoleBadgeIcon(member.role)}
                    </span>{' '}
                    {member.username}
                  </span>
                  <span className="member-role" style={{ color: getRoleColor(member.role) }}>
                    {roleLabel(member.role)}
                  </span>
                </div>
                <div className="member-balance">{(member.chip_balance ?? 0).toLocaleString()}</div>
              </div>
            ))}
            {virtualScroll.hasMore && <div ref={virtualScroll.sentinelRef} style={{ height: 1 }} />}
            {virtualScroll.hasMore && (
              <div
                style={{
                  textAlign: 'center',
                  padding: '8px',
                  color: '#6b7a8a',
                  fontSize: '0.7rem',
                }}
              >
                Showing {virtualScroll.visibleCount} of {virtualScroll.totalCount}
              </div>
            )}
          </>
        )}
      </div>

      {/* Player Action Modal */}
      {selectedMember && clubId && (
        <PlayerActionModal
          member={selectedMember}
          myRole={userRole}
          clubId={clubId}
          onClose={() => setSelectedMember(null)}
          onRoleChanged={() => loadMembers()}
        />
      )}

      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole as any} />}
    </div>
  );
}
