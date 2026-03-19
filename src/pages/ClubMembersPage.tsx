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

/* ═══════════════════════════════════════════════════════════════════════════════
   TYPES
   ═══════════════════════════════════════════════════════════════════════════════ */

type MemberRole =
  | 'owner'
  | 'super_agent'
  | 'agent'
  | 'sub_agent'
  | 'admin'
  | 'manager'
  | 'member'
  | 'guest';

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

type MemberFilter = 'all' | 'online' | 'agents' | 'admins' | 'horses';

/* ═══════════════════════════════════════════════════════════════════════════════
   ROLE HIERARCHY & PERMISSIONS
   ═══════════════════════════════════════════════════════════════════════════════ */

const ROLE_RANK: Record<MemberRole, number> = {
  owner: 100,
  admin: 80,
  super_agent: 70,
  agent: 60,
  sub_agent: 50,
  manager: 40,
  member: 10,
  guest: 0,
};

/** What roles can the current user promote others TO? */
function getPromotableRoles(myRole: MemberRole, targetRole: MemberRole): MemberRole[] {
  if (myRole === 'owner') {
    // Owner can promote to anything below owner
    if (ROLE_RANK[targetRole] < ROLE_RANK['owner']) {
      return ['admin', 'super_agent', 'agent', 'manager', 'member'].filter(
        (r) => r !== targetRole
      ) as MemberRole[];
    }
  }
  if (myRole === 'admin') {
    // Admin can promote to super_agent, agent, manager, member
    if (ROLE_RANK[targetRole] < ROLE_RANK['admin']) {
      return ['super_agent', 'agent', 'manager', 'member'].filter(
        (r) => r !== targetRole
      ) as MemberRole[];
    }
  }
  if (myRole === 'super_agent') {
    // Super agent can promote players under them to sub_agent or agent
    if (['member', 'sub_agent', 'agent'].includes(targetRole)) {
      return ['agent', 'sub_agent', 'member'].filter((r) => r !== targetRole) as MemberRole[];
    }
  }
  return [];
}

function getRoleLabel(role: MemberRole): string {
  switch (role) {
    case 'owner':
      return 'Owner';
    case 'admin':
      return 'Admin';
    case 'super_agent':
      return 'Super Agent';
    case 'agent':
      return 'Agent';
    case 'sub_agent':
      return 'Sub Agent';
    case 'manager':
      return 'Manager';
    case 'member':
      return 'Member';
    case 'guest':
      return 'Guest';
    default:
      return role;
  }
}

function getRoleColor(role: MemberRole): string {
  switch (role) {
    case 'owner':
      return '#FFD700';
    case 'admin':
      return '#FF6B6B';
    case 'super_agent':
      return '#A855F7';
    case 'agent':
      return '#00d4ff';
    case 'sub_agent':
      return '#38BDF8';
    case 'manager':
      return '#F59E0B';
    case 'member':
      return '#6a7a8a';
    case 'guest':
      return '#4a5a6a';
    default:
      return '#6a7a8a';
  }
}

function getRoleBadgeIcon(role: MemberRole): string {
  switch (role) {
    case 'owner':
      return '\u2605'; // ★
    case 'admin':
      return '\u25B2'; // ▲
    case 'super_agent':
      return '\u25C6'; // ◆
    case 'agent':
      return '\u25CF'; // ●
    case 'sub_agent':
      return '\u25CB'; // ○
    case 'manager':
      return '\u25A0'; // ■
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

  // Accessibility: close modal on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const promotableRoles = getPromotableRoles(myRole, member.role);
  const canManage = promotableRoles.length > 0 && member.role !== 'owner';

  const handlePromote = async (newRole: MemberRole) => {
    setPromoting(true);
    setError('');
    setSuccess('');

    try {
      const currentUser = useUserStore.getState().user;
      if (!currentUser?.id) throw new Error('Not authenticated');

      const resolvedClubId = await resolveClubUUID(clubId);

      // Try RPC first (atomic with audit logging), fall back to direct updates
      const { data: rpcResult, error: rpcError } = await retryAsync(
        () =>
          supabase.rpc('promote_member', {
            p_club_id: resolvedClubId,
            p_target_user_id: member.user_id,
            p_new_role: newRole,
            p_promoted_by: currentUser.id,
          }),
        3
      );

      if (rpcError) {
        // RPC not available yet — fall back to direct table update
        // RPC not available yet — fall back to direct table update (expected during rollout)

        const { error: updateError } = await supabase
          .from('club_members')
          .update({ role: newRole })
          .eq('club_id', await resolveClubUUID(clubId))
          .eq('user_id', member.user_id);

        if (updateError) throw updateError;

        // Handle agents table for agent-type roles
        const isAgentRole = ['super_agent', 'agent', 'sub_agent'].includes(newRole);
        const wasAgentRole = ['super_agent', 'agent', 'sub_agent'].includes(member.role);

        if (isAgentRole) {
          const { data: existingAgent } = await supabase
            .from('agents')
            .select('id')
            .eq('club_id', resolvedClubId)
            .eq('user_id', member.user_id)
            .maybeSingle();

          if (existingAgent) {
            const { error: agentUpdateErr } = await supabase
              .from('agents')
              .update({ role: newRole, status: 'active' })
              .eq('id', existingAgent.id);
            if (agentUpdateErr) throw agentUpdateErr;
          } else {
            const { error: agentInsertErr } = await supabase.from('agents').insert({
              club_id: resolvedClubId,
              user_id: member.user_id,
              role: newRole,
              status: 'active',
              commission_rate: newRole === 'super_agent' ? 0.6 : 0.5,
              player_rakeback_rate: newRole === 'super_agent' ? 0.15 : 0.1,
              credit_limit: 100000,
              is_prepaid: false,
              parent_agent_id: null,
            });
            if (agentInsertErr) throw agentInsertErr;

            // Create BUSINESS and PROMO wallets (required for agents to receive commissions)
            await WalletService.ensureWalletsExist(member.user_id, ['BUSINESS', 'PROMO']);
          }
        } else if (wasAgentRole && !isAgentRole) {
          const { error: suspendErr } = await supabase
            .from('agents')
            .update({ status: 'suspended' })
            .eq('club_id', resolvedClubId)
            .eq('user_id', member.user_id);
          if (suspendErr) throw suspendErr;
        }
      } else if (rpcResult && !rpcResult.success) {
        throw new Error(rpcResult.error || 'Promotion failed');
      }

      setSuccess(`${member.username} is now ${getRoleLabel(newRole)}`);
      setConfirmRole(null);

      // Emit bus event so AgentManagement, ClubDetail, and other pages refresh
      masterBus.emit('CLUB_UPDATED', { clubId });
      // Emit AGENT_UPDATED so agent-focused pages (AgentDashboard, SuperAgentDashboard,
      // AgentManagementPage, UnionDashboard, AdminDashboard) auto-refresh
      const agentRoles = ['super_agent', 'agent', 'sub_agent'];
      if (agentRoles.includes(newRole) || agentRoles.includes(member.role)) {
        masterBus.emit('AGENT_UPDATED', { clubId: clubId || '', agentId: member.user_id });
      }

      // Brief delay to show success, then refresh
      setTimeout(() => {
        onRoleChanged();
        onClose();
      }, 1200);
    } catch (err: any) {
      setError(err.message || 'Failed to update role');
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
              {getRoleBadgeIcon(member.role)} {getRoleLabel(member.role)}
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
                    {getRoleLabel(confirmRole)}
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
                    <span className="role-option__label">{getRoleLabel(role)}</span>
                    <span className="role-option__desc">
                      {role === 'admin' && 'Full club management'}
                      {role === 'super_agent' && 'Manage agents & players'}
                      {role === 'agent' && 'Recruit & manage players'}
                      {role === 'sub_agent' && 'Recruit players under agent'}
                      {role === 'manager' && 'Limited management'}
                      {role === 'member' && 'Regular member'}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Not promotable info */}
        {!canManage && member.role === 'owner' && (
          <div className="player-modal__info-section">
            <p>Club Owner cannot be modified.</p>
          </div>
        )}
        {!canManage && member.role !== 'owner' && (
          <div className="player-modal__info-section">
            <p>You don't have permission to manage this member's role.</p>
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
  const [userRole, setUserRole] = useState<MemberRole>('member');
  const [visibleMembers, setVisibleMembers] = useState<Set<string>>(new Set());
  const [selectedMember, setSelectedMember] = useState<ClubMember | null>(null);
  const [resolvedClubId, setResolvedClubId] = useState<string | null>(null);

  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  useEffect(() => {
    setUserRole('member');
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
      if (loadingRef.current) return;
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
        } catch {
          /* corrupt cache */
        }

        const { data, error } = await retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('user_id, role, chip_balance, joined_at, parent_agent_id')
              .eq('club_id', resolvedId)
              .not('status', 'in', '("banned","suspended")')
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
                .select('id, username, avatar_url, is_horse')
                .in('id', chunk);
              if (profiles) {
                for (const p of profiles) profileMap[p.id] = p;
              }
            }
          }
          const mapped = data.map((m: any) => ({
            id: m.user_id,
            user_id: m.user_id,
            username: profileMap[m.user_id]?.username || 'Unknown',
            avatar_url: profileMap[m.user_id]?.avatar_url,
            is_horse: profileMap[m.user_id]?.is_horse || false,
            role: m.role || 'member',
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
              setUserRole(memberData.role || 'member');
            }
          }
        }
      } catch (error) {
        console.error('Failed to load members:', error);
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
    onPayload: () => {
      loadMembers(() => true);
    },
    enabled: !!resolvedClubId,
  });

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
        setOnlineUserIds(onlineIds);
      })
      .subscribe(async (status: string, err?: Error) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: user.id, club_id: clubId });
        } else if (status === 'CHANNEL_ERROR') {
          console.error('[ClubMembersPage] ❌ Presence channel error:', err?.message || err);
        } else if (status === 'TIMED_OUT') {
          console.warn('[ClubMembersPage] ⏱️ Presence channel timed out');
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
        if (filter === 'admins' && !['owner', 'admin'].includes(m.role)) return false;
        if (filter === 'horses' && !(m as any).is_horse) return false;
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
        {(['all', 'online', 'agents', 'admins', 'horses'] as MemberFilter[]).map((f) => (
          <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
            {f === 'agents' && agentCount > 0 ? ` (${agentCount})` : ''}
            {f === 'horses'
              ? ` (${membersWithStatus.filter((m) => (m as any).is_horse).length})`
              : ''}
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
              } catch {
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
          <div className="empty-state">
            <p>
              {filter === 'agents'
                ? 'No agents yet — promote a member to Agent'
                : filter === 'admins'
                  ? 'No admins found'
                  : filter === 'online'
                    ? 'No members online'
                    : filter === 'horses'
                      ? 'No horse (bot) players in this club'
                      : 'No members found'}
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
                    {(member as any).is_horse && (
                      <span
                        title="Horse (Bot Player)"
                        style={{
                          marginLeft: 4,
                          fontSize: '0.7em',
                          padding: '1px 4px',
                          borderRadius: 4,
                          background: 'rgba(139, 92, 246, 0.15)',
                          color: '#a78bfa',
                          fontWeight: 600,
                          letterSpacing: '0.02em',
                        }}
                      >
                        HORSE
                      </span>
                    )}
                  </span>
                  <span className="member-role" style={{ color: getRoleColor(member.role) }}>
                    {getRoleLabel(member.role)}
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
