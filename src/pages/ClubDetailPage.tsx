/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Club Detail Page
 * Complete club management with tables, members, settings, and finances
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useRef, Component, type ReactNode, type ErrorInfo } from 'react';
import { isClubStaff, roleLabel, type ClubRole } from '../types/clubRoles';
import { roleColor } from '../components/club/RoleBadge';
import { useParams, Link, useNavigate } from 'react-router-dom';
import styles from './ClubDetailPage.module.css';
import { formatGameTitle } from '../utils/formatGameTitle';
import { getLocalStorage, setLocalStorage } from '../lib/storage';
import { useSwipeTabs } from '../hooks/useSwipeTabs';
import ActivityHeatmap from '../components/common/ActivityHeatmap';
import CircularGauge from '../components/common/CircularGauge';
import SecurityDashboard from '../components/admin/SecurityDashboard';
import AdminCommandPalette from '../components/admin/AdminCommandPalette';
import TableOperationsPanel from '../components/club/TableOperationsPanel';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { presenceService } from '../services/PresenceService';
import ClubActivityFeed from '../components/club/ClubActivityFeed';
import { MembershipService } from '../services/MembershipService';
import { AgentService, type Agent } from '../services/AgentService';
import { useToast } from '../components/common/Toast';
import { ClubsService } from '../services/ClubsService';
import ConfirmModal from '../components/common/ConfirmModal';
import PageSkeleton from '../components/common/PageSkeleton';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { resolveClubIdFilter, resolveClubUUID } from '../utils/clubIdResolver';
import { withClubContext } from '../utils/clubScopedPath';
import GlobalUXIndicators from '../components/common/GlobalUXIndicators';
import { retryFetch } from '../utils/retryFetch';
import { sanitizeInput } from '../utils/sanitizeInput';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import { fetchAllRows } from '../utils/fetchAllRows';
import { gameManagementService } from '../services/GameManagementService';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { operatingAccessRefusal } from '../services/CommerceDeskService';

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
  allowStraddle: boolean;
  allowRunItTwice: boolean;
  allowRabbitHunt: boolean;
  minBuyInBB: number;
  maxBuyInBB: number;
}

interface ClubMember {
  id: string;
  username: string;
  role: ClubRole;
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
        fontFamily="Rajdhani, monospace"
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

// Four names, one of which ('member') is not a role, so a co-owner, super
// agent or sub agent fell through to the grey default and rendered as MEMBER.
// The canonical colour and label for all seven live in clubRoles/RoleBadge.
const RoleBadge = ({ role }: { role: string }) => (
  <span className={styles.roleBadge} style={{ backgroundColor: roleColor(role) }}>
    {roleLabel(role).toUpperCase()}
  </span>
);

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

// #12: Lightweight error boundary for individual cards (isolates failures)
class CardErrorBoundary extends Component<
  { children: ReactNode; label?: string },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; label?: string }) {
    super(props);
    this.state = { hasError: false };
  }
  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError(error, `ClubDetailPage.CardErrorBoundary.${this.props.label || 'unknown'}`, {
      componentStack: info.componentStack,
    });
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className={styles.cardErrorFallback}>
          <span style={{ fontSize: '1.5rem' }}>⚠</span>
          <span style={{ fontSize: '0.8rem' }}>
            Failed To Load {this.props.label || 'Component'}
          </span>
          <button onClick={() => this.setState({ hasError: false })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

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
    // Reset member search when leaving members tab
    if (t !== 'members' && memberSearch) setMemberSearch('');
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
  const [pendingMembers, setPendingMembers] = useState<
    { userId: string; username: string; role: string; joinedAt: string }[]
  >([]);
  // Bumped after an approve/deny to re-fetch the pending-members list.
  const [pendingRefresh, setPendingRefresh] = useState(0);
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
  const [showMemberMenu, setShowMemberMenu] = useState<string | null>(null);
  // #3: Member pagination — start at 50, expand on demand
  const [memberLimit, setMemberLimit] = useState(50);
  const [userRole, setUserRole] = useState<ClubRole>('player');
  const [isInUnion, setIsInUnion] = useState(false);
  const [wsConnected, setWsConnected] = useState(true);

  // Request deduplication — prevent concurrent loadClubData from realtime events
  const loadingRef = useRef(false);
  // Differentiate initial load (skeleton) from background refresh (silent)
  const initialLoadDone = useRef(false);

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
    allowStraddle: false,
    allowRunItTwice: true,
    allowRabbitHunt: true,
  });
  // #4: Track which member action is in-flight to prevent double-clicks
  const [memberActionLoading, setMemberActionLoading] = useState<string | null>(null);

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

  // ── CRITICAL: Reset per-club state when navigating between clubs ──
  // React Router reuses the same component instance on param change (`/clubs/A` → `/clubs/B`),
  // so state from club A leaks into club B without this explicit reset.
  useEffect(() => {
    setIsInUnion(false);
    setUserRole('player');
    setAgents([]);
    setAgentsLoading(false);
    setMemberLimit(50);
    setMemberSearch('');
    setShowMemberMenu(null);
    setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
    setDeletingTableId(null);
    setSavingSettings(false);
    setShowAgentManager(false);
    initialLoadDone.current = false;
    // CRITICAL: reset loadingRef so the new club's loadClubData isn't blocked
    // by an in-flight request from the PREVIOUS club
    loadingRef.current = false;
  }, [clubId]);

  // SWR: show cached club data instantly on mount while fresh data loads
  // TTL: skip caches older than 5 minutes to prevent very stale flash
  const SWR_TTL_MS = 5 * 60 * 1000;
  useEffect(() => {
    let isMounted = true;
    if (clubId) {
      try {
        const cached = sessionStorage.getItem(`club_detail_cache_${clubId}`);
        if (cached) {
          const parsed = JSON.parse(cached);
          const age = parsed.cachedAt ? Date.now() - parsed.cachedAt : Infinity;
          if (parsed.club && age < SWR_TTL_MS) {
            setClub(parsed.club);
            if (parsed.members) setMembers(parsed.members);
            if (parsed.tables) setTables(parsed.tables);
            setLoading(false); // Show cached data instantly
            // Mark initial load done so loadClubData() won't re-show skeleton
            initialLoadDone.current = true;
          }
        }
      } catch (e) {
        reportError(e, 'ClubDetailPage.useEffect');
        /* corrupt cache */
      }
    }
    loadClubData(() => isMounted);
    return () => {
      isMounted = false;
    };
  }, [clubId]);

  // Check if club is in a union
  // FIX: Must resolve clubId to UUID first — union_clubs stores UUIDs, not integer club_ids
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;
    (async () => {
      try {
        const resolvedId = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('union_clubs')
          .select('union_id')
          .eq('club_id', resolvedId)
          .limit(1)
          .maybeSingle();
        if (!isMounted) return;
        if (data) setIsInUnion(true);
      } catch (e) {
        reportError(e, 'ClubDetailPage.async');
        /* fail-open */
      }
    })();
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
        allowStraddle: club.settings.allowStraddle,
        allowRunItTwice: club.settings.allowRunItTwice,
        allowRabbitHunt: club.settings.allowRabbitHunt,
      });
    }
  }, [club?.name, club?.settings]);

  // Filter members when search changes (debounced 200ms to reduce re-renders)
  useEffect(() => {
    const timerId = setTimeout(() => {
      if (!memberSearch.trim()) {
        setFilteredMembers(members);
      } else {
        const search = memberSearch.toLowerCase();
        setFilteredMembers(
          members.filter((m) => (m.username || '').toLowerCase().includes(search))
        );
      }
    }, 200);
    return () => clearTimeout(timerId);
  }, [memberSearch, members]);

  // Load agents when agents tab is selected
  useEffect(() => {
    let isMounted = true;
    if (activeTab === 'agents' && clubId && agents.length === 0 && !agentsLoading) {
      setAgentsLoading(true);
      AgentService.getAgents(clubId)
        .then((data) => {
          if (isMounted) setAgents(data);
        })
        .catch((err) => reportError(err, 'ClubDetailPage.Failed_to_load_agents'))
        .finally(() => {
          if (isMounted) setAgentsLoading(false);
        });
    }
    return () => {
      isMounted = false;
    };
  }, [activeTab, clubId]);

  // Load pending join requests when the members tab is open (owner/admin only).
  // SELECT RLS on club_members restricts non-service callers to their own row,
  // so pending members of a club can only be listed via the SECURITY DEFINER
  // fn_list_pending_members RPC (itself gated on is_club_admin).
  useEffect(() => {
    let isMounted = true;
    const canManage = isClubStaff(userRole);
    if (activeTab === 'members' && clubId && canManage) {
      (async () => {
        try {
          const resolvedId = await resolveClubUUID(clubId);
          const { data, error } = await supabase.rpc('fn_list_pending_members', {
            p_club_id: resolvedId,
          });
          if (error) throw error;
          if (!isMounted) return;
          setPendingMembers(
            (data || []).map((m: any) => ({
              userId: m.user_id,
              /* fn_list_pending_members resolves the arena name server-side
                 now, so display_name here is already the alias. */
              username: m.display_name || m.username || 'Unknown',
              role: m.role || 'member',
              joinedAt: m.created_at,
            }))
          );
        } catch (e) {
          reportError(e, 'ClubDetailPage.Failed_to_load_pending_members');
        }
      })();
    } else if (isMounted) {
      setPendingMembers([]);
    }
    return () => {
      isMounted = false;
    };
  }, [activeTab, clubId, userRole, pendingRefresh]);

  // Real-time presence tracking
  useEffect(() => {
    if (!clubId) return;

    // Get current user ID from supabase auth
    const setupPresence = async () => {
      try {
        const {
          data: { user },
        } = await getAuthUser();
        if (!user) return;

        await presenceService.joinClub(clubId, user.id, {
          onSync: (state) => {
            setOnlineCount(Object.keys(state).length);
          },
        });

        // Set initial count
        setOnlineCount(presenceService.getClubOnlineCount(clubId));
      } catch (e) {
        reportError(e, 'ClubDetailPage.setupPresence_error');
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
    let isMounted = true;

    // Resolve UUID for realtime filters (integer club IDs need translation)
    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channelKey = `club-detail-${clubId}`;
      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'clubs',
            filter: `id=eq.${resolvedId}`,
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
            filter: `club_id=eq.${resolvedId}`,
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
            filter: `club_id=eq.${resolvedId}`,
          },
          () => {
            loadClubData();
          }
        )
        .subscribe((status: string, err?: Error) => {
          setWsConnected(status === 'SUBSCRIBED');
          if (status === 'CHANNEL_ERROR') {
            if (err)
              reportError(err?.message || err, 'ClubDetailPage._Club_detail_RT_channel_error');
          } else if (status === 'TIMED_OUT') {
            console.warn('[ClubDetailPage] Club detail RT channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[ClubDetailPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(`club-detail-${clubId}`);
    };
  }, [clubId]);

  // ── Bus Listeners: cross-page event reactivity (debounced) ──
  useEffect(() => {
    let isMounted = true;
    const handler = () => {
      if (isMounted) loadClubData(() => isMounted);
    };
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_JOINED', handler, 300),
      masterBus.subscribeDebounced('CLUB_LEFT', handler, 300),
      masterBus.subscribeDebounced('TABLE_SEATED', handler, 300),
      masterBus.subscribeDebounced('TABLE_LEFT', handler, 300),
      masterBus.subscribeDebounced('CLUB_UPDATED', handler, 300),
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', handler, 300),
      masterBus.subscribeDebounced('CLUB_SETTINGS_UPDATED', handler, 300),
      masterBus.subscribeDebounced('AGENT_UPDATED', handler, 500),
      masterBus.subscribeDebounced('TABLE_CREATED', handler, 300),
      masterBus.subscribeDebounced('TABLE_CLOSED', handler, 300),
    ];
    return () => {
      isMounted = false;
      unsubs.forEach((u) => u());
    };
  }, []);

  const loadClubData = async (getIsMounted?: () => boolean) => {
    if (!clubId) {
      if (!getIsMounted || getIsMounted()) setLoading(false);
      return;
    }

    // Request deduplication — skip if already loading
    if (loadingRef.current) return;
    loadingRef.current = true;

    // Only show skeleton on initial load, not background refreshes
    if (!initialLoadDone.current) {
      if (!getIsMounted || getIsMounted()) setLoading(true);
    }

    try {
      // Hoisted for SWR cache write at the end
      let mappedMembers: ClubMember[] = [];
      let mappedTables: ClubTable[] = [];

      // Load club from Supabase
      const { column: clubCol, value: clubVal } = resolveClubIdFilter(clubId);
      const { data: clubData, error: clubError } = await supabase
        .from('clubs')
        .select(
          'id, club_id, name, description, avatar_url, is_public, requires_approval, member_count, table_count, created_at, default_rake_percent, rake_cap, allow_straddle, allow_run_it_twice, allow_rabbit_hunt, min_buyin_bb, max_buyin_bb, owner_id'
        )
        .eq(clubCol, clubVal)
        .maybeSingle();

      if (clubError || !clubData) {
        reportError(clubError, 'ClubDetailPage.Failed_to_load_club');
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
          allowStraddle: clubData.allow_straddle ?? true,
          allowRunItTwice: clubData.allow_run_it_twice ?? true,
          allowRabbitHunt: clubData.allow_rabbit_hunt ?? true,
          minBuyInBB: clubData.min_buyin_bb || 40,
          maxBuyInBB: clubData.max_buyin_bb || 200,
        },
      };
      if (getIsMounted && !getIsMounted()) return;
      setClub(mappedClub);

      // Load members (no FK between club_members → profiles; batch-fetch)
      /* ═══ THE CAP WAS TRUNCATING TWO REAL CLUBS (fixed 2026-08-27) ═══
         The note that used to sit here already knew the shape of this - "500
         with no order is an arbitrary slice of a 588-member club" - and
         answered it by ADDING AN ORDER, which makes the missing members
         predictable rather than random. It does not make them visible.

         Measured the day this was fixed: SHARK CLUB has 590 members and Club
         JAQK 584, so 90 and 84 members respectively were simply absent from
         the club's own member list, with nothing on screen to say the list
         was short. Ordering by created_at meant the invisible ones were
         always the newest joiners - the members most likely to be looked for.

         Pages now. The ordering stays, because paging over an unordered query
         can serve a row twice or skip it. retryFetch still wraps the whole
         read so a transient blip retries the way it always did. */
      const memberData = await retryFetch(
        () =>
          fetchAllRows<any>(
            (from, to) =>
              supabase
                .from('club_members')
                .select('user_id, role, chip_balance, status, created_at, last_active')
                .eq('club_id', resolvedId)
                .order('created_at', { ascending: true })
                .range(from, to),
            { label: 'ClubDetailPage.members' }
          ),
        { maxRetries: 2 }
      );

      if (memberData) {
        const mUserIds = memberData.map((m: any) => m.user_id);
        const memberProfileMap: Record<string, any> = {};
        if (mUserIds.length > 0) {
          const { data: mProfiles } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}`)
            .in('id', mUserIds);
          if (mProfiles) {
            for (const p of mProfiles) memberProfileMap[p.id] = p;
          }
        }
        const mappedMembersResult: ClubMember[] = memberData.map((m: any) => ({
          id: m.user_id,
          username: playerDisplayName(memberProfileMap[m.user_id]),
          role: m.role || 'member',
          chipBalance: m.chip_balance || 0,
          status: m.status || 'active',
          joinedAt: m.created_at,
          lastActive: m.last_active,
        }));
        mappedMembers = mappedMembersResult;
        if (getIsMounted && !getIsMounted()) return;
        setMembers(mappedMembersResult);

        // Update member count with LIVE RPC count (not members.length which is capped at .limit(500))
        try {
          const { data: counts } = await supabase.rpc('fn_batch_club_member_counts', {
            p_club_ids: [resolvedId],
          });
          if (counts && counts.length > 0) {
            setClub((prev) =>
              prev ? { ...prev, memberCount: Number(counts[0].member_count) } : null
            );
          }
        } catch (e) {
          reportError(e, 'ClubDetailPage.setClub');
          // Fall back to denormalized member_count from initial club query
        }

        // Determine current user's role in this club
        const {
          data: { user },
        } = await getAuthUser();
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
        .select('id, name, game_variant, stakes, current_players, max_players, status, created_at')
        .eq('club_id', resolvedId)
        .eq('is_deleted', false);

      if (tableData) {
        const mappedTablesResult: ClubTable[] = tableData.map((t: any) => ({
          id: t.id,
          name: formatGameTitle(t.name) || 'Table',
          gameVariant: t.game_variant || 'NLH',
          stakes: t.stakes || '1/2',
          currentPlayers: t.current_players || 0,
          maxPlayers: t.max_players || 6,
          status: t.status || 'waiting',
        }));
        mappedTables = mappedTablesResult;
        if (getIsMounted && !getIsMounted()) return;
        setTables(mappedTablesResult);

        // Count active tables
        const activeCount = mappedTablesResult.filter((t) => t.status === 'running').length;
        setClub((prev) => (prev ? { ...prev, activeTableCount: activeCount } : null));
      }
      // SWR: cache the loaded data for instant display on revisit
      // IMPORTANT: use local vars (mappedMembers, mappedTables), NOT React state
      // (members, tables) which hold stale closure values from the previous render
      if (clubId) {
        try {
          const cachePayload = {
            club: mappedClub,
            members: mappedMembers.slice(0, 100),
            tables: mappedTables.map((t: ClubTable) => ({ ...t })),
            cachedAt: Date.now(),
          };
          sessionStorage.setItem(`club_detail_cache_${clubId}`, JSON.stringify(cachePayload));
        } catch {
          /* storage full */
        }
      }
    } catch (error) {
      reportError(error, 'ClubDetailPage.Error_loading_data');
      // Clear stale session cache on error to prevent ghost data on next visit
      try {
        sessionStorage.removeItem(`club_detail_cache_${clubId}`);
      } catch {
        /* ignore */
      }
    } finally {
      loadingRef.current = false;
      initialLoadDone.current = true;
      if (!getIsMounted || getIsMounted()) {
        setLoading(false);
        setLastRefreshed(new Date());
      }
    }
  };

  // Save settings handler (uses controlled state instead of document.getElementById)
  const handleSaveSettings = async () => {
    if (!clubId || !club) return;
    setSavingSettings(true);
    try {
      const safeNum = (val: number, fallback: number) => (isNaN(val) ? fallback : val);
      const updates = {
        name: sanitizeInput(settingsForm.name || club.name),
        description: sanitizeInput(settingsForm.description || club.description),
        is_public: settingsForm.isPublic,
        requires_approval: settingsForm.requiresApproval,
        default_rake_percent: safeNum(
          settingsForm.defaultRakePercent,
          club.settings.defaultRakePercent
        ),
        rake_cap: safeNum(settingsForm.rakeCap, club.settings.rakeCap),
        min_buyin_bb: safeNum(settingsForm.minBuyInBB, club.settings.minBuyInBB),
        max_buyin_bb: safeNum(settingsForm.maxBuyInBB, club.settings.maxBuyInBB),
        allow_straddle: settingsForm.allowStraddle,
        allow_run_it_twice: settingsForm.allowRunItTwice,
        allow_rabbit_hunt: settingsForm.allowRabbitHunt,
      };
      await ClubsService.updateClub(clubId, updates);
      toast.success('Settings saved successfully!');
      masterBus.emit('CLUB_UPDATED', { clubId });
      masterBus.emit('CLUB_SETTINGS_UPDATED', { clubId });
      loadClubData(); // Reload to get fresh data
    } catch (error) {
      reportError(error, 'ClubDetailPage.Failed_to_save_settings');
      toast.error('Failed to save settings');
    } finally {
      setSavingSettings(false);
    }
  };

  // Member action handlers
  const handleMemberAction = async (
    memberUserId: string,
    action: 'promote' | 'demote' | 'suspend' | 'remove' | 'approve' | 'deny'
  ) => {
    if (!clubId || memberActionLoading) return;
    setShowMemberMenu(null);
    setMemberActionLoading(memberUserId);
    try {
      switch (action) {
        case 'approve':
        case 'deny': {
          const resolvedId = await resolveClubUUID(clubId);
          const { data: res, error } = await supabase.rpc('fn_review_join_request', {
            p_club_id: resolvedId,
            p_user_id: memberUserId,
            p_approve: action === 'approve',
          });
          if (error || !res?.success) {
            // 20260924102056: an enforced commerce admission refuses a NEW
            // member with the server's own sentence (code
            // operating_access_required). Show it as written; the generic
            // toast below would hide why the approval did not happen.
            const admission = error ? null : operatingAccessRefusal(res);
            if (admission) {
              toast.error(admission);
              break;
            }
            throw new Error(res?.error || `Failed to ${action} request`);
          }
          // Drop from the pending list; approved members show up as active on reload.
          setPendingMembers((prev) => prev.filter((m) => m.userId !== memberUserId));
          setPendingRefresh((n) => n + 1);
          toast.success(action === 'approve' ? 'Member approved' : 'Request denied');
          break;
        }
        // 'admin' and 'player' are the real club_members.role values. This used
        // to promote to 'admin' as any and demote to 'member' as any, and
        // 'member' is not a role this database has, so every demotion from this
        // menu failed club_members_role_check and toasted "Failed to demote
        // member" with no further explanation. updateRole now throws the
        // server's own reason, which the catch below surfaces.
        case 'promote': {
          await MembershipService.updateRole(clubId, memberUserId, 'admin');
          toast.success('Member Promoted To Admin');
          break;
        }
        case 'demote': {
          await MembershipService.updateRole(clubId, memberUserId, 'player');
          toast.success('Member Demoted To Player');
          break;
        }
        // fn_club_set_member_status decides who may suspend whom and records
        // it; updateStatus throws the server's refusal text, shown below.
        case 'suspend': {
          await MembershipService.updateStatus(clubId, memberUserId, 'suspended');
          toast.success('Member Suspended');
          break;
        }
        case 'remove': {
          const ok = await MembershipService.removeMember(clubId, memberUserId);
          if (!ok) throw new Error('Failed to remove member');
          // Optimistic UI — only after server confirms success
          setClub((prev) =>
            prev ? { ...prev, memberCount: Math.max(0, prev.memberCount - 1) } : null
          );
          setMembers((prev) => prev.filter((m) => m.id !== memberUserId));
          toast.success('Member removed');
          break;
        }
      }
      loadClubData();
    } catch (error) {
      toast.error(
        action === 'suspend'
          ? safeErrorMessage(error, 'Could Not Suspend This Member')
          : `Failed to ${action} member`
      );
    } finally {
      setMemberActionLoading(null);
    }
  };

  // #6: Keyboard shortcut: Ctrl+S to save settings
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (activeTab === 'settings' && !savingSettings) handleSaveSettings();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab, savingSettings]);

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
        <p>The Club You're Looking For Doesn't Exist.</p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <GlobalUXIndicators wsConnected={wsConnected} />
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
            onClick={() => navigate(`/invite/${clubId}`)}
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
        style={{ animation: `animationsSlideInUp 0.6s cubic-bezier(0.34, 1.56, 0.64, 1)` }}
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
        {isClubStaff(userRole) && (
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
            ? '▦'
            : activeTab === 'tables'
              ? '♠'
              : activeTab === 'members'
                ? '◉'
                : activeTab === 'agents'
                  ? '◈'
                  : activeTab === 'operations'
                    ? '⚙'
                    : '◇'}
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
              ? 'Activity Feed, Stats & Quick Actions'
              : activeTab === 'tables'
                ? 'Create, Configure & Monitor Tables'
                : activeTab === 'members'
                  ? 'View, Manage & Search Members'
                  : activeTab === 'agents'
                    ? 'Agent Tree, Commissions & Transfers'
                    : activeTab === 'operations'
                      ? 'Announcements, Reports & Audits'
                      : 'Club Configuration & Danger Zone'}
          </span>
        </div>
      </div>

      {/* Tab Content — Swipeable (with #15 slide-in transition) */}
      <section className={styles.tabContent} key={activeTab} {...swipeHandlers}>
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className={styles.overviewGrid}>
            {/* Active Tables */}
            <div className={styles.card}>
              <h3> Active Tables</h3>
              {tables.filter((t) => t.status === 'running').length === 0 ? (
                <p className={styles.emptyText}>No Active Tables</p>
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
                <li>Minimum Buy-In: {club.settings.minBuyInBB} BB</li>
                <li>Maximum Buy-In: {club.settings.maxBuyInBB} BB</li>
                <li>
                  Rake: {club.settings.defaultRakePercent}% (Capped At {club.settings.rakeCap} BB)
                </li>
                <li>Straddle: {club.settings.allowStraddle ? 'Allowed' : 'Not Allowed'}</li>
                <li>Run It Twice: {club.settings.allowRunItTwice ? 'Allowed' : 'Not Allowed'}</li>
              </ul>
            </div>

            {/* Daily Challenges — link, not a second copy of the feature.
                This card used to embed DailyChallengesWidget, which loaded all
                three challenge tiers and carried its own claim guard, duplicating
                both the dedicated /challenges page and the panel that used to sit
                on ProfilePage. One surface owns claiming now; this is a way in. */}
            <div className={styles.card}>
              <h3 style={{ margin: '0 0 8px', fontSize: '0.95rem' }}>Daily Challenges</h3>
              <p style={{ margin: '0 0 12px', fontSize: '0.8rem', color: '#9aa5b3' }}>
                A Fresh Set Of Challenges Every Day, Plus Weekly And Monthly Goals.
              </p>
              <button
                onClick={() => navigate(withClubContext('/challenges', clubId))}
                style={{
                  padding: '8px 16px',
                  borderRadius: 8,
                  border: '1px solid rgba(0,212,255,0.35)',
                  background: 'rgba(0,212,255,0.1)',
                  color: '#00d4ff',
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                View Challenges
              </button>
            </div>

            {/* Club Activity Heatmap */}
            <div className={styles.card} style={{ gridColumn: '1 / -1' }}>
              <CardErrorBoundary label="Activity Heatmap">
                <ActivityHeatmap data={[]} label="Club Activity" colorScheme="cyan" weeks={12} />
              </CardErrorBoundary>
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
                  fontFamily: "'Rajdhani', monospace",
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
                    (club?.memberCount || 0) > 0
                      ? Math.min(100, Math.round((onlineCount / (club?.memberCount || 1)) * 100))
                      : 0
                  }
                  label="Activity Rate"
                  sublabel={`${onlineCount} of ${club?.memberCount || 0} online`}
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
                  value={Math.min(100, club?.memberCount || members.length)}
                  label="Growth"
                  sublabel={`${club?.memberCount || members.length} total members`}
                  accent="#8b5cf6"
                  size={100}
                />
              </div>
            </div>

            {/* Club Activity Feed */}
            <div className={styles.card} style={{ gridColumn: '1 / -1' }}>
              <h3> Recent Activity</h3>
              <CardErrorBoundary label="Activity Feed">
                {clubId && <ClubActivityFeed clubId={clubId} limit={10} />}
              </CardErrorBoundary>
            </div>
          </div>
        )}

        {/* Tables Tab */}
        {activeTab === 'tables' && (
          <div className={styles.tablesContainer}>
            <div className={styles.tablesHeader}>
              <h3>All Tables ({tables.length})</h3>
              {!isInUnion && (
                <button
                  className={styles.createButton}
                  onClick={() => navigate(`/clubs/${clubId}/create-table`)}
                >
                  + Create Table
                </button>
              )}
            </div>
            <div className={styles.tablesGrid}>
              {tables.length === 0 ? (
                <div className={styles.emptyState}>
                  <p>No Tables Yet</p>
                  <p className={styles.emptyHint}>
                    Create A Table To Start Hosting Games For Your Club Members.
                  </p>
                </div>
              ) : (
                tables.map((table, idx) => (
                  <div
                    key={table.id}
                    className={styles.tableCard}
                    style={{ animation: `animationsSlideInUp 0.5s ease-out ${idx * 0.06}s both` }}
                  >
                    <div className={styles.tableCardHeader}>
                      <h4>{table.name}</h4>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <StatusBadge status={table.status} />
                        {isClubStaff(userRole) && table.currentPlayers === 0 && (
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
                            title="Close Table"
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
                        {table.currentPlayers}/{table.maxPlayers} Players
                      </div>
                    </div>
                    <Link to={`/table/${table.id}`} className={styles.joinButton}>
                      {table.currentPlayers < table.maxPlayers ? 'Join' : 'Watch'}
                    </Link>
                  </div>
                ))
              )}
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
                placeholder="Search Members..."
                className={styles.searchInput}
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
              />
            </div>

            {/* Pending join requests — owner/admin approval queue */}
            {isClubStaff(userRole) && pendingMembers.length > 0 && (
              <div
                style={{
                  marginBottom: 16,
                  padding: 12,
                  border: '1px solid rgba(245,158,11,0.4)',
                  borderRadius: 10,
                  background: 'rgba(245,158,11,0.06)',
                }}
              >
                <h4 style={{ margin: '0 0 10px', color: '#f59e0b', fontSize: '0.9rem' }}>
                  Pending Requests ({pendingMembers.length})
                </h4>
                {pendingMembers.map((pm) => (
                  <div
                    key={pm.userId}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 8,
                      padding: '6px 0',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div className={styles.memberAvatarSmall}>{pm.username.charAt(0)}</div>
                      <span>{pm.username}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        onClick={() => handleMemberAction(pm.userId, 'approve')}
                        disabled={memberActionLoading === pm.userId}
                        aria-label={`Approve ${pm.username}`}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 6,
                          border: 'none',
                          background: '#22c55e',
                          color: '#fff',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        {memberActionLoading === pm.userId ? '…' : 'Approve'}
                      </button>
                      <button
                        onClick={() => handleMemberAction(pm.userId, 'deny')}
                        disabled={memberActionLoading === pm.userId}
                        aria-label={`Deny ${pm.username}`}
                        style={{
                          padding: '4px 12px',
                          borderRadius: 6,
                          border: '1px solid rgba(239,68,68,0.5)',
                          background: 'transparent',
                          color: '#ef4444',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        Deny
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {filteredMembers.length === 0 && memberSearch ? (
              <div className={styles.emptyState}>
                <p>No Members Found For "{memberSearch}"</p>
                <p className={styles.emptyHint}>Try A Different Search Term.</p>
              </div>
            ) : filteredMembers.length === 0 && !memberSearch ? (
              <div className={styles.emptyState}>
                <p>No Members Yet</p>
                <p className={styles.emptyHint}>
                  Members Will Appear Here Once They Join The Club.
                </p>
              </div>
            ) : (
              <>
                <div className={styles.membersTableScroll}>
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
                      {filteredMembers.slice(0, memberLimit).map((member, idx) => (
                        <tr
                          key={member.id}
                          style={{
                            animation: `animationsSlideInUp 0.5s ease-out ${idx * 0.05}s both`,
                          }}
                        >
                          <td>
                            <div className={styles.memberCell}>
                              <div className={styles.memberAvatarSmall}>
                                {member.username.charAt(0)}
                              </div>
                              {member.username}
                            </div>
                          </td>
                          <td>
                            <RoleBadge role={member.role} />
                          </td>
                          <td className={styles.balanceCell}>
                            {member.chipBalance.toLocaleString()}
                          </td>
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
                              aria-label={`Actions For ${member.username}`}
                              disabled={memberActionLoading === member.id}
                            >
                              {memberActionLoading === member.id ? '◷' : '⋮'}
                            </button>
                            {showMemberMenu === member.id && (
                              <div className={styles.memberMenu}>
                                {member.role !== 'admin' && member.role !== 'owner' && (
                                  <button
                                    onClick={() => handleMemberAction(member.id, 'promote')}
                                    aria-label="Promote Member To Admin"
                                  >
                                    {' '}
                                    Promote
                                  </button>
                                )}
                                {member.role === 'admin' && (
                                  <button
                                    onClick={() => handleMemberAction(member.id, 'demote')}
                                    aria-label="Demote Admin To Member"
                                  >
                                    {' '}
                                    Demote
                                  </button>
                                )}
                                {member.status === 'active' && member.role !== 'owner' && (
                                  <button
                                    onClick={() => handleMemberAction(member.id, 'suspend')}
                                    aria-label="Suspend Member"
                                  >
                                    Suspend
                                  </button>
                                )}
                                {member.role !== 'owner' && (
                                  <button
                                    onClick={() => handleMemberAction(member.id, 'remove')}
                                    aria-label="Remove Member From Club"
                                  >
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
                {/* #3: Load More button when members exceed limit */}
                {filteredMembers.length > memberLimit && (
                  <button
                    className={styles.loadMoreBtn}
                    onClick={() => setMemberLimit((prev) => Math.min(prev + 50, 500))}
                  >
                    Show More ({filteredMembers.length - memberLimit} Remaining)
                  </button>
                )}
              </>
            )}
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
                <p>Loading Agents...</p>
              </div>
            ) : agents.length === 0 ? (
              <div className={styles.emptyState}>
                <p>No Agents Assigned To This Club Yet.</p>
                <p className={styles.emptyHint}>
                  Agents Help Recruit Players And Earn Commission On Rake.
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
                    style={{ animation: `animationsSlideInUp 0.5s ease-out ${idx * 0.06}s both` }}
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
                <label>Min Buy-In (BB)</label>
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
                <label>Max Buy-In (BB)</label>
                <input
                  type="number"
                  value={settingsForm.maxBuyInBB}
                  onChange={(e) =>
                    setSettingsForm((f) => ({ ...f, maxBuyInBB: Number(e.target.value) || 0 }))
                  }
                  className={styles.numberInput}
                />
              </div>
              {/* 2026-08-18: removed. clubs.time_bank_seconds was never read
                  by the engine — see ClubSettingsPage for the full note. */}
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
              <button onClick={() => setShowAgentManager(false)} aria-label="Close Agent Manager">
                ×
              </button>
            </div>
            <div className={styles.modalContent}>
              <p>
                Manage Your Club's Agent Hierarchy, Create New Agents, And Configure Commission
                Rates.
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

      {/* Confirm Modal for Table Closure */}
      <ConfirmModal
        isOpen={deleteTableConfirm.show}
        title="Close Table"
        message={`Close table "${deleteTableConfirm.tableName || ''}"? It can only close after every player has left.`}
        variant="danger"
        confirmText="Close Table"
        onConfirm={async () => {
          if (deleteTableConfirm.tableId) {
            const id = deleteTableConfirm.tableId;
            setDeleteTableConfirm({ show: false, tableId: null, tableName: null });
            setDeletingTableId(id);
            try {
              await gameManagementService.close('table', id);
              setTables((prev) => prev.filter((table) => table.id !== id));
              setClub((prev) =>
                prev ? { ...prev, tableCount: Math.max(0, prev.tableCount - 1) } : null
              );
              toast.success('Table Closed');
            } catch (err) {
              reportError(err, 'ClubDetailPage.Failed_to_close_table');
              toast.error(err instanceof Error ? err.message : 'Failed To Close Table');
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
