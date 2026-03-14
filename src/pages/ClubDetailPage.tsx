/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Club Detail Page
 * Complete club management with tables, members, settings, and finances
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useMemo } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import styles from './ClubDetailPage.module.css';
import { getLocalStorage, setLocalStorage } from '../lib/storage';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import ClubHome from '../components/club/ClubHome';
import ActivityHeatmap from '../components/common/ActivityHeatmap';
import CircularGauge from '../components/common/CircularGauge';
import SecurityDashboard from '../components/admin/SecurityDashboard';
import AdminCommandPalette from '../components/admin/AdminCommandPalette';
import CurrencyStore from '../components/club/CurrencyStore';
import TableOperationsPanel from '../components/club/TableOperationsPanel';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface ClubData {
  id: string;
  clubId: number;
  name: string;
  description: string;
  avatarUrl: string;
  isPublic: boolean;
  requiresApproval: boolean;
  memberCount: number;
  tableCount: number;
  activeTableCount: number;
  createdAt: string;
  settings: ClubSettings;
}

interface ClubSettings {
  defaultRakePercent: number;
  rakeCap: number;
  timeBankSeconds: number;
  allowStraddle: boolean;
  allowRunItTwice: boolean;
  minBuyInBB: number;
  maxBuyInBB: number;
}

interface ClubMember {
  id: string;
  username: string;
  role: 'owner' | 'admin' | 'agent' | 'member';
  chipBalance: number;
  status: 'active' | 'pending' | 'suspended';
  joinedAt: string;
  lastActive?: string;
}

interface ClubTable {
  id: string;
  name: string;
  gameVariant: string;
  stakes: string;
  currentPlayers: number;
  maxPlayers: number;
  status: 'waiting' | 'running' | 'paused';
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

const TabButton = ({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) => (
  <button className={`${styles.tab} ${active ? styles.activeTab : ''}`} onClick={onClick}>
    <span className={styles.tabIcon}>{icon}</span>
    <span>{label}</span>
  </button>
);

/* ── SVG Icon Library ── */
const Icons = {
  online: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="4" fill="#22c55e">
        <animate attributeName="r" values="3;5;3" dur="2s" repeatCount="indefinite" />
        <animate attributeName="opacity" values="1;0.5;1" dur="2s" repeatCount="indefinite" />
      </circle>
      <circle cx="10" cy="10" r="8" stroke="#22c55e" strokeWidth="1.5" fill="none" opacity="0.3">
        <animate attributeName="r" values="6;9;6" dur="2s" repeatCount="indefinite" />
      </circle>
    </svg>
  ),
  members: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="7" cy="7" r="3" stroke="#60a5fa" strokeWidth="1.5" />
      <path
        d="M1 17c0-3 2.5-5.5 6-5.5s6 2.5 6 5.5"
        stroke="#60a5fa"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="14" cy="6" r="2.5" stroke="#60a5fa" strokeWidth="1.2" opacity="0.6" />
      <path
        d="M14 10.5c2.5 0 5 1.8 5 4.5"
        stroke="#60a5fa"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity="0.6"
      />
    </svg>
  ),
  tables: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <rect x="2" y="2" width="7" height="7" rx="2" stroke="#00d4ff" strokeWidth="1.5" />
      <rect x="11" y="2" width="7" height="7" rx="2" stroke="#00d4ff" strokeWidth="1.5" />
      <rect x="2" y="11" width="7" height="7" rx="2" stroke="#00d4ff" strokeWidth="1.5" />
      <rect
        x="11"
        y="11"
        width="7"
        height="7"
        rx="2"
        stroke="#00d4ff"
        strokeWidth="1.5"
        opacity="0.4"
      />
    </svg>
  ),
  rake: (
    <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
      <text
        x="4"
        y="15"
        fontSize="14"
        fontWeight="700"
        fill="#fbbf24"
        fontFamily="Orbitron, monospace"
      >
        %
      </text>
    </svg>
  ),
  overview: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect x="1" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="1" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9" y="9" width="6" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  tableTab: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <ellipse cx="8" cy="8" rx="7" ry="4.5" stroke="currentColor" strokeWidth="1.5" />
      <line x1="1" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1" opacity="0.4" />
    </svg>
  ),
  people: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="6" cy="5" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M1 14c0-2.5 2-4.5 5-4.5s5 2 5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <circle cx="12" cy="5" r="2" stroke="currentColor" strokeWidth="1" opacity="0.5" />
    </svg>
  ),
  shield: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M8 1L2 4v4c0 3.5 2.5 5.8 6 7 3.5-1.2 6-3.5 6-7V4L8 1z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path
        d="M6 8l2 2 3-4"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  ),
  wrench: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M10 2a4 4 0 00-3.5 6L2 12.5 3.5 14l4.5-4.5A4 4 0 0010 2z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  ),
  gear: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="8" cy="8" r="2.5" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.5 1.5M11.5 11.5L13 13M13 3l-1.5 1.5M4.5 11.5L3 13"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  ),
};

const StatCard = ({
  value,
  label,
  icon,
  accent = '#00d4ff',
}: {
  value: string | number;
  label: string;
  icon: React.ReactNode;
  accent?: string;
}) => (
  <div
    className={styles.statCard}
    style={{ borderColor: `color-mix(in srgb, ${accent} 40%, #2a3a4a)` }}
  >
    <div
      className={styles.statIconWrap}
      style={{ background: `color-mix(in srgb, ${accent} 15%, transparent)` }}
    >
      {icon}
    </div>
    <div className={styles.statInfo}>
      <span className={styles.statValue} style={{ color: accent }}>
        {value}
      </span>
      <span className={styles.statLabel}>{label}</span>
    </div>
  </div>
);

const RoleBadge = ({ role }: { role: string }) => {
  const colors: Record<string, string> = {
    owner: '#f59e0b',
    admin: '#3b82f6',
    agent: '#8b5cf6',
    member: '#6b7280',
  };
  return (
    <span className={styles.roleBadge} style={{ backgroundColor: colors[role] || colors.member }}>
      {role.toUpperCase()}
    </span>
  );
};

const StatusBadge = ({ status }: { status: string }) => {
  const colors: Record<string, string> = {
    active: '#10b981',
    pending: '#f59e0b',
    suspended: '#ef4444',
    running: '#10b981',
    waiting: '#6b7280',
    paused: '#f59e0b',
  };
  return (
    <span className={styles.statusBadge} style={{ backgroundColor: colors[status] || '#6b7280' }}>
      {status}
    </span>
  );
};

// Premium counter hook
function useCountAnimation(target: number, duration: number = 800) {
  const [display, setDisplay] = useState(0);
  useEffect(() => {
    let startTime: number;
    let animationFrame: number;
    const animate = (time: number) => {
      if (!startTime) startTime = time;
      const progress = Math.min((time - startTime) / duration, 1);
      setDisplay(Math.floor(target * progress));
      if (progress < 1) animationFrame = requestAnimationFrame(animate);
    };
    animationFrame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationFrame);
  }, [target, duration]);
  return display;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { presenceService } from '../services/PresenceService';
import ClubActivityFeed from '../components/club/ClubActivityFeed';
// CreateTableModal replaced by full TableConfigPage navigation
import { MembershipService } from '../services/MembershipService';
import { ClubService } from '../services/ClubService';
import ClubAnnouncementBanner from '../components/club/ClubAnnouncementBanner';
import MissionPanel from '../components/club/MissionPanel';
import ClubStatsCards from '../components/club/ClubStatsCards';
import { useClubStore } from '../stores/useClubStore';
import MemberList from '../components/club/MemberList';
import AgentManager from '../components/club/AgentManager';
import { AgentService } from '../services/AgentService';
import type { Agent } from '../services/AgentService';
import { useToast } from '../components/common/Toast';
import { ClubsService } from '../services/ClubsService';
import DailyChallengesWidget from '../components/rewards/DailyChallengesWidget';
import ClubBottomNav from '../components/club/ClubBottomNav';
import ConfirmModal from '../components/common/ConfirmModal';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubIdFilter, resolveClubUUID } from '../utils/clubIdResolver';

export default function ClubDetailPage() {
  const { clubId } = useParams();
  useVisibilityRefresh(() => loadClubData());
  const navigate = useNavigate();
  const toast = useToast();
  const [activeTab, setActiveTabRaw] = useState<
    'overview' | 'tables' | 'members' | 'agents' | 'operations' | 'settings'
  >(() => getLocalStorage('ca_club_detail_tab', 'overview'));
  const setActiveTab = (t: typeof activeTab) => {
    setActiveTabRaw(t);
    setLocalStorage('ca_club_detail_tab', t);
  };

  // Swipe gesture support for tab navigation
  const swipeHandlers = useSwipeTabs({
    tabs: ['overview', 'tables', 'members', 'agents', 'operations', 'settings'] as const,
    activeTab,
    onTabChange: setActiveTab,
  });
  const [club, setClub] = useState<ClubData | null>(null);
  const [members, setMembers] = useState<ClubMember[]>([]);
  const [filteredMembers, setFilteredMembers] = useState<ClubMember[]>([]);
  const [memberSearch, setMemberSearch] = useState('');
  const [tables, setTables] = useState<ClubTable[]>([]);
  const [loading, setLoading] = useState(true);
  const [onlineCount, setOnlineCount] = useState(0);
  const [deletingTableId, setDeletingTableId] = useState<string | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [showAgentManager, setShowAgentManager] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [editedSettings, setEditedSettings] = useState<Partial<ClubSettings>>({});
  const [showMemberMenu, setShowMemberMenu] = useState<string | null>(null);
  const [userRole, setUserRole] = useState<'owner' | 'admin' | 'agent' | 'member'>('member');

  // Controlled settings form state (replaces document.getElementById)
  const [settingsForm, setSettingsForm] = useState({
    name: '',
    description: '',
    isPublic: false,
    requiresApproval: false,
    defaultRakePercent: 5,
    rakeCap: 3,
    minBuyInBB: 40,
    maxBuyInBB: 200,
    timeBankSeconds: 30,
    allowStraddle: false,
    allowRunItTwice: true,
  });

  // Confirm modal state for table deletion
  const [deleteTableConfirm, setDeleteTableConfirm] = useState<{
    show: boolean;
    tableId: string | null;
    tableName: string | null;
  }>({ show: false, tableId: null, tableName: null });

  // Animated stats
  const animatedOnlineCount = useCountAnimation(onlineCount, 800);
  const animatedMemberCount = useCountAnimation(club?.memberCount || 0, 800);
  const animatedTableCount = useCountAnimation(club?.activeTableCount || 0, 800);

  useEffect(() => {
    let isMounted = true;
    loadClubData(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, [clubId]);

  // Sync settings form with loaded club data
  useEffect(() => {
    if (club) {
      setSettingsForm({
        name: club.name,
        description: club.description,
        isPublic: club.isPublic,
        requiresApproval: club.requiresApproval,
        defaultRakePercent: club.settings.defaultRakePercent,
        rakeCap: club.settings.rakeCap,
        minBuyInBB: club.settings.minBuyInBB,
        maxBuyInBB: club.settings.maxBuyInBB,
        timeBankSeconds: club.settings.timeBankSeconds,
        allowStraddle: club.settings.allowStraddle,
        allowRunItTwice: club.settings.allowRunItTwice,
      });
    }
  }, [club?.name, club?.settings]);

  // Filter members when search changes
  useEffect(() => {
    if (!memberSearch.trim()) {
      setFilteredMembers(members);
    } else {
      const search = memberSearch.toLowerCase();
      setFilteredMembers(members.filter((m) => m.username.toLowerCase().includes(search)));
    }
  }, [memberSearch, members]);

  // Load agents when agents tab is selected
  useEffect(() => {
    if (activeTab === 'agents' && clubId && agents.length === 0 && !agentsLoading) {
      setAgentsLoading(true);
      AgentService.getAgents(clubId)
        .then(setAgents)
        .catch((err) => console.error('Failed to load agents:', err))
        .finally(() => setAgentsLoading(false));
    }
  }, [activeTab, clubId]);

  // Real-time presence tracking
  useEffect(() => {
    if (!clubId) return;

    // Get current user ID from supabase auth
    const setupPresence = async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user) return;

        await presenceService.joinClub(clubId, user.id, {
          onSync: (state) => {
            setOnlineCount(Object.keys(state).length);
          },
        });

        // Set initial count
        setOnlineCount(presenceService.getClubOnlineCount(clubId));
      } catch (e) {
        console.error('[ClubDetailPage] setupPresence error:', e);
      }
    };

    setupPresence();

    return () => {
      presenceService.leave(`club:${clubId}`);
    };
  }, [clubId]);

  // Supabase Realtime subscriptions for auto-updates
  useEffect(() => {
    if (!clubId) return;

    const channelKey = `club-detail-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'clubs',
          filter: `id=eq.${clubId}`,
        },
        () => {
          loadClubData();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'club_members',
          filter: `club_id=eq.${clubId}`,
        },
        () => {
          loadClubData();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tables',
          filter: `club_id=eq.${clubId}`,
        },
        () => {
          loadClubData();
        }
      )
      .subscribe();

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId]);

  // ── Bus Listeners: cross-page event reactivity (debounced) ──
  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', () => loadClubData(), 300),
      masterBus.subscribeDebounced('CLUB_LEFT', () => loadClubData(), 300),
      masterBus.subscribeDebounced('TABLE_SEATED', () => loadClubData(), 300),
      masterBus.subscribeDebounced('TABLE_LEFT', () => loadClubData(), 300),
      masterBus.subscribeDebounced('CLUB_UPDATED', () => loadClubData(), 300),
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', () => loadClubData(), 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, []);

  const loadClubData = async (getIsMounted?: () => boolean) => {
    if (!clubId) {
      if (!getIsMounted || getIsMounted()) setLoading(false);
      return;
    }

    if (!getIsMounted || getIsMounted()) setLoading(true);

    try {
      // Load club from Supabase
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: clubData, error: clubError } = await supabase
        .from('clubs')
        .select(
          'id, club_id, name, description, avatar_url, is_public, requires_approval, member_count, table_count, created_at, default_rake_percent, rake_cap, time_bank_seconds, allow_straddle, allow_run_it_twice, min_buyin_bb, max_buyin_bb, owner_id'
        )
        .eq(clubCol, clubVal)
        .maybeSingle();

      if (clubError || !clubData) {
        console.error('[ClubDetailPage] Failed to load club:', clubError);
        if (!getIsMounted || getIsMounted()) {
          setLoading(false);
          setLastRefreshed(new Date());
        }
        return;
      }

      // Use resolved UUID for all downstream FK queries — clubId from URL may be integer
      const resolvedId = clubData.id;

      // Map to our internal format
      const mappedClub: ClubData = {
        id: clubData.id,
        clubId: clubData.club_id || 0,
        name: clubData.name,
        description: clubData.description || '',
        avatarUrl: clubData.avatar_url || '',
        isPublic: clubData.is_public ?? true,
        requiresApproval: clubData.requires_approval ?? false,
        memberCount: clubData.member_count || 0,
        tableCount: clubData.table_count || 0,
        activeTableCount: 0,
        createdAt: clubData.created_at,
        settings: {
          defaultRakePercent: clubData.default_rake_percent || 5,
          rakeCap: clubData.rake_cap || 3,
          timeBankSeconds: clubData.time_bank_seconds || 30,
          allowStraddle: clubData.allow_straddle ?? true,
          allowRunItTwice: clubData.allow_run_it_twice ?? true,
          minBuyInBB: clubData.min_buyin_bb || 40,
          maxBuyInBB: clubData.max_buyin_bb || 200,
        },
      };
      if (getIsMounted && !getIsMounted()) return;
      setClub(mappedClub);

      // Load members
      const { data: memberData } = await supabase
        .from('club_members')
        .select('*, profiles(username, display_name)')
        .eq('club_id', resolvedId)
        .limit(50);

      if (memberData) {
        const mappedMembers: ClubMember[] = memberData.map((m: any) => ({
          id: m.user_id,
          username: m.profiles?.display_name || m.profiles?.username || 'Unknown',
          role: m.role || 'member',
          chipBalance: m.chip_balance || 0,
          status: m.status || 'active',
          joinedAt: m.created_at,
          lastActive: m.last_active,
        }));
        if (getIsMounted && !getIsMounted()) return;
        setMembers(mappedMembers);

        // Update member count to reflect actual data (clubs.member_count may be stale)
        setClub((prev) => (prev ? { ...prev, memberCount: mappedMembers.length } : null));

        // Determine current user's role in this club
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (user && (!getIsMounted || getIsMounted())) {
          const currentUserMember = memberData.find((m: any) => m.user_id === user.id);
          if (currentUserMember) {
            setUserRole(currentUserMember.role || 'member');
          }
        }
      }

      // Load tables
      const { data: tableData } = await supabase
        .from('tables')
        .select('id, name, game_type, stakes, current_players, max_players, status, created_at')
        .eq('club_id', resolvedId)
        .eq('is_deleted', false);

      if (tableData) {
        const mappedTables: ClubTable[] = tableData.map((t: any) => ({
          id: t.id,
          name: t.name || 'Table',
          gameVariant: t.game_type || 'NLH',
          stakes: t.stakes || '1/2',
          currentPlayers: t.current_players || 0,
          maxPlayers: t.max_players || 6,
          status: t.status || 'waiting',
        }));
        if (getIsMounted && !getIsMounted()) return;
        setTables(mappedTables);

        // Count active tables
        const activeCount = mappedTables.filter((t) => t.status === 'running').length;
        setClub((prev) => (prev ? { ...prev, activeTableCount: activeCount } : null));
      }
    } catch (error) {
      console.error('[ClubDetailPage] Error loading data:', error);
    } finally {
      if (!getIsMounted || getIsMounted()) setLoading(false);
    }
  };

  // Save settings handler (uses controlled state instead of document.getElementById)
  const handleSaveSettings = async () => {
    if (!clubId || !club) return;
    setSavingSettings(true);
    try {
      const safeNum = (val: number, fallback: number) => (isNaN(val) ? fallback : val);
      const updates = {
        name: settingsForm.name || club.name,
        description: settingsForm.description || club.description,
        is_public: settingsForm.isPublic,
        requires_approval: settingsForm.requiresApproval,
        default_rake_percent: safeNum(
          settingsForm.defaultRakePercent,
          club.settings.defaultRakePercent
        ),
        rake_cap: safeNum(settingsForm.rakeCap, club.settings.rakeCap),
        min_buyin_bb: safeNum(settingsForm.minBuyInBB, club.settings.minBuyInBB),
        max_buyin_bb: safeNum(settingsForm.maxBuyInBB, club.settings.maxBuyInBB),
        time_bank_seconds: safeNum(settingsForm.timeBankSeconds, club.settings.timeBankSeconds),
        allow_straddle: settingsForm.allowStraddle,
        allow_run_it_twice: settingsForm.allowRunItTwice,
      };
      await ClubsService.updateClub(clubId, updates);
      toast.success('Settings saved successfully!');
      masterBus.emit('CLUB_UPDATED', { clubId });
      loadClubData(); // Reload to get fresh data
    } catch (error) {
      console.error('Failed to save settings:', error);
      toast.error('Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  // Member action handlers
  const handleMemberAction = async (
    memberId: string,
    action: 'promote' | 'demote' | 'suspend' | 'remove'
  ) => {
    if (!clubId) return;
    setShowMemberMenu(null);
    try {
      switch (action) {
        case 'promote':
          await MembershipService.updateRole(memberId, 'admin' as any);
          toast.success('Member promoted to admin');
          break;
        case 'demote':
          await MembershipService.updateRole(memberId, 'member' as any);
          toast.success('Member demoted');
          break;
        case 'suspend':
          await MembershipService.updateStatus(memberId, 'suspended' as any);
          toast.success('Member suspended');
          break;
        case 'remove':
          await MembershipService.removeMember(memberId);
          toast.success('Member removed');
          break;
      }
      loadClubData();
    } catch (error) {
      toast.error(`Failed to ${action} member`);
    }
  };

  if (loading) {
    return (
      <div className={styles.loading}>
        <PageSkeleton variant="dashboard" />
      </div>
    );
  }

  if (!club) {
    return (
      <div className={styles.error}>
        <h2>Club Not Found</h2>
        <p>The club you're looking for doesn't exist.</p>
        <Link to="/clubs" className={styles.backLink}>
          ← Back to Clubs
        </Link>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <style>{`
                @keyframes slideInUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
                .club-detail-stats { animation: slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1); }
                .member-row-animated { animation: slideInUp 0.5s ease-out forwards; opacity: 0; }
                .table-row-animated { animation: slideInUp 0.5s ease-out forwards; opacity: 0; }
                @keyframes shimmer { 0% { background-position: -1000px 0; } 100% { background-position: 1000px 0; } }
                .club-detail-skeleton { background: linear-gradient(90deg, rgba(255,255,255,0.1) 25%, rgba(255,255,255,0.2) 50%, rgba(255,255,255,0.1)); background-size: 1000px 100%; animation: shimmer 2s infinite; }
                @keyframes heroPulse { 0%, 100% { opacity: 0.6; } 50% { opacity: 1; } }
                @keyframes heroGlow { 0%, 100% { box-shadow: 0 0 20px rgba(0,212,255,0.2); } 50% { box-shadow: 0 0 40px rgba(0,212,255,0.4); } }
            `}</style>

      {/* ── Hero Banner ── */}
      <section className={styles.heroBanner}>
        <div className={styles.heroGradient} />
        <div className={styles.heroContent}>
          <div className={styles.heroAvatar}>
            {club.avatarUrl ? (
              <img src={club.avatarUrl} alt={club.name} />
            ) : (
              <span>{club.name.charAt(0).toUpperCase()}</span>
            )}
          </div>
          <div className={styles.heroInfo}>
            <h1 className={styles.heroTitle}>{club.name}</h1>
            <p className={styles.heroClubId}>ID: {club.clubId}</p>
            {club.description && <p className={styles.heroDesc}>{club.description}</p>}
          </div>
          <div className={styles.heroBadges}>
            <span className={styles.heroBadge} style={{ borderColor: '#22c55e' }}>
              <span className={styles.heroBadgeDot} style={{ background: '#22c55e' }} />
              {onlineCount} Online
            </span>
            <span className={styles.heroBadge} style={{ borderColor: '#6a7a8a', fontSize: '11px' }}>
              Updated {lastRefreshed.toLocaleTimeString()}
            </span>
            <span className={styles.heroBadge} style={{ borderColor: '#60a5fa' }}>
              {club.memberCount} Members
            </span>
            <span className={styles.heroBadge} style={{ borderColor: '#00d4ff' }}>
              {tables.filter((t) => t.status === 'running').length} Live
            </span>
          </div>
        </div>
        <div className={styles.heroActions}>
          <button
            className={styles.heroActionBtn}
            onClick={() => navigate(`/clubs/${clubId}/invite`)}
            title="Invite"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M9 3v12M3 9h12"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            className={styles.heroActionBtn}
            onClick={() => navigate(`/clubs/${clubId}/financials`)}
            title="Financials"
            style={{ color: '#22c55e' }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M9 2v14M5 6h8M6 10h6M7 14h4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
          <button
            className={styles.heroActionBtn}
            onClick={() => navigate(`/clubs/${clubId}/announcements`)}
            title="Announcements"
            style={{ color: '#fbbf24' }}
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
              <path
                d="M3 7l6-4 6 4v5l-6 4-6-4V7z"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
              <circle cx="9" cy="9" r="2" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      </section>

      {/* Quick Stats */}
      <section
        className={styles.statsRow}
        style={{ animation: `slideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)` }}
      >
        <StatCard
          value={animatedOnlineCount}
          label="Online Now"
          icon={Icons.online}
          accent="#22c55e"
        />
        <StatCard
          value={animatedMemberCount}
          label="Members"
          icon={Icons.members}
          accent="#60a5fa"
        />
        <StatCard
          value={animatedTableCount}
          label="Active Tables"
          icon={Icons.tables}
          accent="#00d4ff"
        />
        <StatCard
          value={`${club.settings.defaultRakePercent}%`}
          label="Rake"
          icon={Icons.rake}
          accent="#fbbf24"
        />
      </section>

      {/* Tab Navigation */}
      <nav className={styles.tabNav}>
        <TabButton
          active={activeTab === 'overview'}
          onClick={() => setActiveTab('overview')}
          icon={Icons.overview}
          label="Overview"
        />
        <TabButton
          active={activeTab === 'tables'}
          onClick={() => setActiveTab('tables')}
          icon={Icons.tableTab}
          label="Tables"
        />
        <TabButton
          active={activeTab === 'members'}
          onClick={() => setActiveTab('members')}
          icon={Icons.people}
          label="Members"
        />
        <TabButton
          active={activeTab === 'agents'}
          onClick={() => setActiveTab('agents')}
          icon={Icons.shield}
          label="Agents"
        />
        {(userRole === 'owner' || userRole === 'admin') && (
          <TabButton
            active={activeTab === 'operations'}
            onClick={() => setActiveTab('operations')}
            icon={Icons.wrench}
            label="Ops"
          />
        )}
        <TabButton
          active={activeTab === 'settings'}
          onClick={() => setActiveTab('settings')}
          icon={Icons.gear}
          label="Settings"
        />
      </nav>

      {/* Smart Context Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.75rem',
          padding: '0.75rem 1rem',
          margin: '0 0 0.5rem',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
        }}
      >
        <span style={{ fontSize: '1.1rem' }}>
          {activeTab === 'overview'
            ? '📊'
            : activeTab === 'tables'
              ? '🃏'
              : activeTab === 'members'
                ? '👥'
                : activeTab === 'agents'
                  ? '🛡️'
                  : activeTab === 'operations'
                    ? '⚙️'
                    : '🔧'}
        </span>
        <div>
          <span style={{ color: '#fff', fontSize: '0.85rem', fontWeight: 600, display: 'block' }}>
            {activeTab === 'overview'
              ? 'Club Overview'
              : activeTab === 'tables'
                ? 'Table Management'
                : activeTab === 'members'
                  ? 'Member Directory'
                  : activeTab === 'agents'
                    ? 'Agent Hierarchy'
                    : activeTab === 'operations'
                      ? 'Operations'
                      : 'Club Settings'}
          </span>
          <span style={{ color: '#6a7a8a', fontSize: '0.7rem' }}>
            {activeTab === 'overview'
              ? 'Activity feed, stats & quick actions'
              : activeTab === 'tables'
                ? 'Create, configure & monitor tables'
                : activeTab === 'members'
                  ? 'View, manage & search members'
                  : activeTab === 'agents'
                    ? 'Agent tree, commissions & transfers'
                    : activeTab === 'operations'
                      ? 'Announcements, reports & audits'
                      : 'Club configuration & danger zone'}
          </span>
        </div>
      </div>

      {/* Tab Content — Swipeable */}
      <section className={styles.tabContent} {...swipeHandlers}>
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className={styles.overviewGrid}>
            {/* Active Tables */}
            <div className={styles.card}>
              <h3> Active Tables</h3>
              {tables.filter((t) => t.status === 'running').length === 0 ? (
                <p className={styles.emptyText}>No active tables</p>
              ) : (
                <div className={styles.tableList}>
                  {tables
                    .filter((t) => t.status === 'running')
                    .map((table) => (
                      <Link key={table.id} to={`/table/${table.id}`} className={styles.tableRow}>
                        <span className={styles.tableName}>{table.name}</span>
                        <span className={styles.tableVariant}>{table.gameVariant}</span>
                        <span className={styles.tableStakes}>{table.stakes}</span>
                        <span className={styles.tablePlayers}>
                          {table.currentPlayers}/{table.maxPlayers}
                        </span>
                      </Link>
                    ))}
                </div>
              )}
            </div>

            {/* Recent Members */}
            <div className={styles.card}>
              <h3> Recent Members</h3>
              <div className={styles.memberList}>
                {members.slice(0, 5).map((member) => (
                  <div key={member.id} className={styles.memberRow}>
                    <div className={styles.memberAvatar}>{member.username.charAt(0)}</div>
                    <span className={styles.memberName}>{member.username}</span>
                    <RoleBadge role={member.role} />
                  </div>
                ))}
              </div>
            </div>

            {/* Club Rules */}
            <div className={styles.card}>
              <h3> Club Rules</h3>
              <ul className={styles.rulesList}>
                <li>Minimum buy-in: {club.settings.minBuyInBB} BB</li>
                <li>Maximum buy-in: {club.settings.maxBuyInBB} BB</li>
                <li>
                  Rake: {club.settings.defaultRakePercent}% (capped at {club.settings.rakeCap} BB)
                </li>
                <li>Straddle: {club.settings.allowStraddle ? 'Allowed' : 'Not allowed'}</li>
                <li>Run it twice: {club.settings.allowRunItTwice ? 'Allowed' : 'Not allowed'}</li>
              </ul>
            </div>

            {/* Daily Challenges */}
            <div className={styles.card}>
              <DailyChallengesWidget />
            </div>

            {/* Club Activity Heatmap */}
            <div className={styles.card} style={{ gridColumn: '1 / -1' }}>
              <ActivityHeatmap data={[]} label="Club Activity" colorScheme="cyan" weeks={12} />
            </div>

            {/* Performance Gauges */}
            <div className={styles.card} style={{ gridColumn: '1 / -1' }}>
              <h3
                style={{
                  color: '#00d4ff',
                  fontSize: '0.8rem',
                  textTransform: 'uppercase',
                  letterSpacing: '1px',
                  marginBottom: '1rem',
                  fontFamily: "'Orbitron', monospace",
                }}
              >
                Performance
              </h3>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-around',
                  flexWrap: 'wrap',
                  gap: '1rem',
                }}
              >
                <CircularGauge
                  value={
                    members.length > 0
                      ? Math.min(100, Math.round((onlineCount / members.length) * 100))
                      : 0
                  }
                  label="Activity Rate"
                  sublabel={`${onlineCount} of ${members.length} online`}
                  accent="#22c55e"
                  size={100}
                />
                <CircularGauge
                  value={
                    tables.length > 0
                      ? Math.round(
                          (tables.filter((t) => t.status === 'running').length / tables.length) *
                            100
                        )
                      : 0
                  }
                  label="Table Fill"
                  sublabel={`${tables.filter((t) => t.status === 'running').length} of ${tables.length} active`}
                  accent="#00d4ff"
                  size={100}
                />
                <CircularGauge
                  value={Math.min(100, members.length)}
                  label="Growth"
                  sublabel={`${members.length} total members`}
                  accent="#8b5cf6"
                  size={100}
                />
              </div>
            </div>

            {/* Club Activity Feed */}
            <div className={styles.card} style={{ gridColumn: '1 / -1' }}>
              <h3> Recent Activity</h3>
              {clubId && <ClubActivityFeed clubId={clubId} limit={10} />}
            </div>
          </div>
        )}

        {/* Tables Tab */}
        {activeTab === 'tables' && (
          <div className={styles.tablesContainer}>
            <div className={styles.tablesHeader}>
              <h3>All Tables ({tables.length})</h3>
              <button
                className={styles.createButton}
                onClick={() => navigate(`/clubs/${clubId}/create-table`)}
              >
                + Create Table
              </button>
            </div>
            <div className={styles.tablesGrid}>
              {tables.map((table, idx) => (
                <div
                  key={table.id}
                  className={styles.tableCard}
                  style={{ animation: `slideInUp 0.5s ease-out ${idx * 0.06}s both` }}
                >
                  <div className={styles.tableCardHeader}>
                    <h4>{table.name}</h4>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <StatusBadge status={table.status} />
                      {(userRole === 'owner' || userRole === 'admin') && (
                        <button
                          className={styles.deleteTableBtn}
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTableConfirm({
                              show: true,
                              tableId: table.id,
                              tableName: table.name,
                            });
                          }}
                          disabled={deletingTableId === table.id}
                          title="Delete table"
                        >
                          {deletingTableId === table.id ? '...' : '✕'}
                        </button>
                      )}
                    </div>
                  </div>
                  <div className={styles.tableCardBody}>
                    <div className={styles.tableInfo}>
                      <span>{table.gameVariant}</span>
                      <span>{table.stakes}</span>
                    </div>
                    <div className={styles.tableSeats}>
                      {table.currentPlayers}/{table.maxPlayers} players
                    </div>
                  </div>
                  <Link to={`/table/${table.id}`} className={styles.joinButton}>
                    {table.currentPlayers < table.maxPlayers ? 'Join' : 'Watch'}
                  </Link>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Members Tab */}
        {activeTab === 'members' && (
          <div className={styles.membersContainer}>
            <div className={styles.membersHeader}>
              <h3>All Members ({filteredMembers.length})</h3>
              <input
                type="search"
                placeholder="Search members..."
                className={styles.searchInput}
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
              />
            </div>
            <table className={styles.membersTable}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Role</th>
                  <th>Balance</th>
                  <th>Status</th>
                  <th>Joined</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map((member, idx) => (
                  <tr
                    key={member.id}
                    style={{ animation: `slideInUp 0.5s ease-out ${idx * 0.05}s both` }}
                  >
                    <td>
                      <div className={styles.memberCell}>
                        <div className={styles.memberAvatarSmall}>{member.username.charAt(0)}</div>
                        {member.username}
                      </div>
                    </td>
                    <td>
                      <RoleBadge role={member.role} />
                    </td>
                    <td className={styles.balanceCell}>{member.chipBalance.toLocaleString()}</td>
                    <td>
                      <StatusBadge status={member.status} />
                    </td>
                    <td className={styles.dateCell}>
                      {new Date(member.joinedAt).toLocaleDateString()}
                    </td>
                    <td style={{ position: 'relative' }}>
                      <button
                        className={styles.actionBtn}
                        onClick={() =>
                          setShowMemberMenu(showMemberMenu === member.id ? null : member.id)
                        }
                      >
                        ⋮
                      </button>
                      {showMemberMenu === member.id && (
                        <div className={styles.memberMenu}>
                          {member.role !== 'admin' && member.role !== 'owner' && (
                            <button onClick={() => handleMemberAction(member.id, 'promote')}>
                              {' '}
                              Promote
                            </button>
                          )}
                          {member.role === 'admin' && (
                            <button onClick={() => handleMemberAction(member.id, 'demote')}>
                              {' '}
                              Demote
                            </button>
                          )}
                          {member.status === 'active' && member.role !== 'owner' && (
                            <button onClick={() => handleMemberAction(member.id, 'suspend')}>
                              Suspend
                            </button>
                          )}
                          {member.role !== 'owner' && (
                            <button onClick={() => handleMemberAction(member.id, 'remove')}>
                              Remove
                            </button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Agents Tab */}
        {activeTab === 'agents' && (
          <div className={styles.agentsContainer}>
            <div className={styles.agentsHeader}>
              <h3>Club Agents</h3>
              <button className={styles.createButton} onClick={() => setShowAgentManager(true)}>
                + Manage Agents
              </button>
            </div>
            {agentsLoading ? (
              <div className={styles.emptyState}>
                <div className={styles.spinner} />
                <p>Loading agents...</p>
              </div>
            ) : agents.length === 0 ? (
              <div className={styles.emptyState}>
                <p>No agents assigned to this club yet.</p>
                <p className={styles.emptyHint}>
                  Agents help recruit players and earn commission on rake.
                </p>
                <button className={styles.createButton} onClick={() => setShowAgentManager(true)}>
                  + Add First Agent
                </button>
              </div>
            ) : (
              <div className={styles.agentsList}>
                {agents.map((agent, idx) => (
                  <div
                    key={agent.id}
                    className={styles.agentCard}
                    style={{ animation: `slideInUp 0.5s ease-out ${idx * 0.06}s both` }}
                  >
                    <div className={styles.agentAvatar}>{agent.displayName?.charAt(0) || '?'}</div>
                    <div className={styles.agentInfo}>
                      <span className={styles.agentName}>{agent.displayName || 'Unknown'}</span>
                      <span className={styles.agentRole}>{agent.role}</span>
                    </div>
                    <div className={styles.agentStats}>
                      <div className={styles.agentStat}>
                        <span className={styles.statLabel}>Players</span>
                        <span className={styles.statValue}>{agent.totalPlayers}</span>
                      </div>
                      <div className={styles.agentStat}>
                        <span className={styles.statLabel}>Commission</span>
                        <span className={styles.statValue}>{agent.commissionRate}%</span>
                      </div>
                      <div className={styles.agentStat}>
                        <span className={styles.statLabel}>Lifetime</span>
                        <span className={styles.statValue}>
                          {agent.lifetimeEarnings.toLocaleString()}
                        </span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Operations Tab — Admin Table Controls + Security */}
        {activeTab === 'operations' && clubId && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
            <SecurityDashboard
              memberCount={members.length}
              onlineCount={onlineCount}
              agentCount={agents.length}
              isPublic={club?.isPublic ?? true}
              requiresApproval={club?.requiresApproval ?? false}
            />
            <TableOperationsPanel clubId={clubId} />
          </div>
        )}

        {/* Settings Tab */}
        {activeTab === 'settings' && (
          <div className={styles.settingsContainer}>
            <div className={styles.settingsSection}>
              <h3> General</h3>
              <div className={styles.settingRow}>
                <label>Club Name</label>
                <input
                  type="text"
                  value={settingsForm.name}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))}
                  className={styles.textInput}
                />
              </div>
              <div className={styles.settingRow}>
                <label>Description</label>
                <textarea
                  value={settingsForm.description}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, description: e.target.value }))}
                  className={styles.textArea}
                  rows={3}
                />
              </div>
              <div className={styles.settingRow}>
                <label>Public Club</label>
                <input
                  type="checkbox"
                  checked={settingsForm.isPublic}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, isPublic: e.target.checked }))}
                />
              </div>
              <div className={styles.settingRow}>
                <label>Require Approval</label>
                <input
                  type="checkbox"
                  checked={settingsForm.requiresApproval}
                  onChange={(e) =>
                    setSettingsForm((f) => ({ ...f, requiresApproval: e.target.checked }))
                  }
                />
              </div>
            </div>

            <div className={styles.settingsSection}>
              <h3> Rake Settings</h3>
              <div className={styles.settingRow}>
                <label>Default Rake %</label>
                <input
                  type="number"
                  value={settingsForm.defaultRakePercent}
                  onChange={(e) =>
                    setSettingsForm((f) => ({
                      ...f,
                      defaultRakePercent: Number(e.target.value) || 0,
                    }))
                  }
                  min={0}
                  max={10}
                  className={styles.numberInput}
                />
              </div>
              <div className={styles.settingRow}>
                <label>Rake Cap (BB)</label>
                <input
                  type="number"
                  value={settingsForm.rakeCap}
                  onChange={(e) =>
                    setSettingsForm((f) => ({ ...f, rakeCap: Number(e.target.value) || 0 }))
                  }
                  min={0}
                  max={10}
                  className={styles.numberInput}
                />
              </div>
            </div>

            <div className={styles.settingsSection}>
              <h3> Table Defaults</h3>
              <div className={styles.settingRow}>
                <label>Min Buy-in (BB)</label>
                <input
                  type="number"
                  value={settingsForm.minBuyInBB}
                  onChange={(e) =>
                    setSettingsForm((f) => ({ ...f, minBuyInBB: Number(e.target.value) || 0 }))
                  }
                  className={styles.numberInput}
                />
              </div>
              <div className={styles.settingRow}>
                <label>Max Buy-in (BB)</label>
                <input
                  type="number"
                  value={settingsForm.maxBuyInBB}
                  onChange={(e) =>
                    setSettingsForm((f) => ({ ...f, maxBuyInBB: Number(e.target.value) || 0 }))
                  }
                  className={styles.numberInput}
                />
              </div>
              <div className={styles.settingRow}>
                <label>Time Bank (seconds)</label>
                <input
                  type="number"
                  value={settingsForm.timeBankSeconds}
                  onChange={(e) =>
                    setSettingsForm((f) => ({ ...f, timeBankSeconds: Number(e.target.value) || 0 }))
                  }
                  className={styles.numberInput}
                />
              </div>
              <div className={styles.settingRow}>
                <label>Allow Straddle</label>
                <input
                  type="checkbox"
                  checked={settingsForm.allowStraddle}
                  onChange={(e) =>
                    setSettingsForm((f) => ({ ...f, allowStraddle: e.target.checked }))
                  }
                />
              </div>
              <div className={styles.settingRow}>
                <label>Allow Run It Twice</label>
                <input
                  type="checkbox"
                  checked={settingsForm.allowRunItTwice}
                  onChange={(e) =>
                    setSettingsForm((f) => ({ ...f, allowRunItTwice: e.target.checked }))
                  }
                />
              </div>
            </div>

            <button
              className={styles.saveButton}
              onClick={handleSaveSettings}
              disabled={savingSettings}
            >
              {savingSettings ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        )}
      </section>

      {/* Agent Manager - Navigate to dedicated page */}
      {showAgentManager && clubId && (
        <div className={styles.modalOverlay} onClick={() => setShowAgentManager(false)}>
          <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3>Agent Management</h3>
              <button onClick={() => setShowAgentManager(false)}>×</button>
            </div>
            <div className={styles.modalContent}>
              <p>
                Manage your club's agent hierarchy, create new agents, and configure commission
                rates.
              </p>
              <Link
                to={`/clubs/${clubId}/agents`}
                className={styles.primaryButton}
                onClick={() => setShowAgentManager(false)}
              >
                Open Agent Management
              </Link>
            </div>
          </div>
        </div>
      )}

      {/* Fixed Bottom Navigation Bar */}
      {clubId && <ClubBottomNav clubId={clubId} userRole={userRole} clubName={club?.name} />}

      {/* Confirm Modal for Table Deletion */}
      <ConfirmModal
        isOpen={deleteTableConfirm.show}
        title="Delete Table"
        message={`Delete table "${deleteTableConfirm.tableName || ''}"? This cannot be undone.`}
        variant="danger"
        confirmText="Delete"
        onConfirm={async () => {
          if (deleteTableConfirm.tableId) {
            const id = deleteTableConfirm.tableId;
            setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
            setDeletingTableId(id);
            try {
              // Phase 13: Optimistic delete — instantly remove from UI, then confirm with server
              const deletedTable = tables.find((t) => t.id === id);
              await masterBus.executeOptimistic(
                'TABLE_UPDATED',
                { tableId: id, status: 'deleted' },
                async () => {
                  setTables((prev) => prev.filter((t) => t.id !== id));
                  const { error } = await supabase
                    .from('tables')
                    .update({ status: 'deleted', is_active: false })
                    .eq('id', id);
                  if (error) throw error;
                },
                // Rollback payload: restore the table on failure
                deletedTable ? { tableId: id, status: deletedTable.status || 'active' } : undefined
              );
              toast.success('Table deleted');
            } catch (err) {
              // Rollback: re-add the table to the list
              console.error('Failed to delete table:', err);
              toast.error('Failed to delete table');
              // Force reload to restore accurate state
              if (clubId) {
                const resolvedId = await resolveClubUUID(clubId);
                const { data } = await supabase
                  .from('tables')
                  .select(
                    'id, name, game_type, stakes, current_players, max_players, status, created_at'
                  )
                  .eq('club_id', resolvedId)
                  .eq('is_deleted', false)
                  .order('created_at', { ascending: false });
                if (data)
                  setTables(
                    data.map((t: any) => ({
                      id: t.id,
                      name: t.name || 'Table',
                      gameVariant: t.game_type || 'NLH',
                      stakes: t.stakes || '1/2',
                      currentPlayers: t.current_players || 0,
                      maxPlayers: t.max_players || 6,
                      status: t.status || 'waiting',
                    }))
                  );
              }
            } finally {
              setDeletingTableId(null);
            }
          }
        }}
        onCancel={() => setDeleteTableConfirm({ show: false, tableId: null, tableName: null })}
      />

      {/* Admin Command Palette (Cmd+K) */}
      <AdminCommandPalette clubId={clubId} isOwner={userRole === 'owner'} />
    </div>
  );
}
