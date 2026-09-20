import { getTournamentEntryCapacity } from '../utils/tournamentPresentation';
/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ENGINE — Union Detail Page
 * Complete union management with financials and settlements
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useUnionRouteId } from '../hooks/useUnionRouteId';
import { getLocalStorage, setLocalStorage } from '../lib/storage';
import { unionService, type Union, type UnionClub } from '../services/UnionService';
import { unionApi } from '../services/UnionApiService';
import { tableService } from '../services/TableService';
import { getUserMemberships } from '../services/ClubsService';
import { confirmDialog } from '../components/common/confirmDialog';
import { useAuthUser } from '../hooks/useAuthUser';
import { presenceService } from '../services/PresenceService';
import { supabase, getAuthUser } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import type { PokerTable, Tournament } from '../types/database.types';
import type { Club } from '../types/club.types';
import { useUnionStore } from '../stores/useUnionStore';
import { EmptyState, ErrorState, LoadingState } from '../components/common/EmptyState';
import styles from './UnionDetailPage.module.css';
import { useToast } from '../components/common/Toast';
import ConfirmModal from '../components/common/ConfirmModal';
import CreateTournamentModal from '../components/club/CreateTournamentModal';
import GameCreationActions from '../components/club/GameCreationActions';
import { ensureMidwayUnionSetup } from '../services/HorseOrchestrator';
import { getUnionLevel, getClubLevel } from '../utils/clubLevels';
import { reportError } from '../utils/errorReporter';
import CasinoSurfaceHeader from '../components/rewards/RewardsSurfaceHeader';
// Whole-number tournament money (Dan 2026-08-20).
import { formatBuyInShort } from '../utils/buyIn';
import UnionClubGovernance from '../components/union/UnionClubGovernance';
import {
  tournamentScheduleService,
  type TournamentScheduleRow,
} from '../services/TournamentScheduleService';
import { describeSchedule } from '../components/tournament/WeeklyScheduleEditor';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

interface SettlementRecord {
  id: string;
  periodStart: string | null;
  periodEnd: string | null;
  clubId: string;
  clubName: string;
  rakeGenerated: number | null;
  unionShare: number | null;
  status: 'missing' | 'cancelled' | 'pending' | 'paid' | 'overdue' | 'disputed';
  paidAt?: string;
}

interface FinancialSummary {
  totalRakeThisPeriod: number | null;
  unionRevenue: number | null;
  periodLabel: string;
  coverageLabel: string;
  pendingSettlements: number;
  overdueAmount: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

function statementMoney(value: number | null): string {
  return value === null
    ? 'Unavailable'
    : value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function UnionDetailPage() {
  /* /unions/<slug> in the URL, a UUID in every query (useUnionRouteId). */
  const { unionId, unionRef } = useUnionRouteId();
  const { user } = useAuthUser();
  const toast = useToast();
  useVisibilityRefresh(async () => {
    if (!unionId) return;
    try {
      const [unionData, tablesData] = await Promise.all([
        unionService.getUnion(unionId),
        tableService.getUnionTables(unionId),
      ]);
      if (unionData) setUnion(unionData);
      if (tablesData) setTables(tablesData);
    } catch (error) {
      reportError(error, 'UnionDetailPage.Visibility_refresh_failed');
    }
  });

  const navigate = useNavigate();
  const [union, setUnion] = useState<Union | null>(null);
  const [clubs, setClubs] = useState<UnionClub[]>([]);
  const [tables, setTables] = useState<PokerTable[]>([]);
  const [unionTournaments, setUnionTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRevision, setLoadRevision] = useState(0);

  // UNION LAW (2026-08-19, Dan): the union surface is the owner's operations
  // page. Players never see a union card, and a deep link must not leak the
  // surface either — non-owners bounce back to their clubs, where union games
  // already appear inside their own club lobby.
  useEffect(() => {
    if (!union || !user?.id) return;
    if (union.ownerId !== user.id) {
      navigate('/clubs', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [union?.id, union?.ownerId, user?.id]);

  const [activeTab, setActiveTabRaw] = useState<
    'overview' | 'clubs' | 'tables' | 'tournaments' | 'financials' | 'settings'
  >(() => getLocalStorage('ca_union_detail_tab', 'overview'));
  const setActiveTab = (t: typeof activeTab) => {
    setActiveTabRaw(t);
    setLocalStorage('ca_union_detail_tab', t);
  };

  // Financial state - starts empty, no demo data
  const [settlements, setSettlements] = useState<SettlementRecord[]>([]);
  const [financialSummary, setFinancialSummary] = useState<FinancialSummary | null>(null);

  const [financialError, setFinancialError] = useState<string | null>(null);

  const [ownedClubs, setOwnedClubs] = useState<Club[]>([]);
  const [showClubSelector, setShowClubSelector] = useState(false);
  const [applying, setApplying] = useState(false);
  const [visibleClubs, setVisibleClubs] = useState<Set<string>>(new Set());
  const [confirmJoin, setConfirmJoin] = useState<{ show: boolean; club: Club | null }>({
    show: false,
    club: null,
  });
  const [isUpdatingSettings, setIsUpdatingSettings] = useState(false);
  const [showXmttModal, setShowXmttModal] = useState(false);
  const [settingsForm, setSettingsForm] = useState({
    revenueSharePercent: 10,
    sharedPlayerPool: true,
    crossClubTournaments: false,
  });
  const [onlineCount, setOnlineCount] = useState(0);

  // ── Recurring tournament schedules (2026-08-22): the union owner's compact
  // manager over tournament_schedules. Loaded when the Tournaments tab opens. ──
  const [schedules, setSchedules] = useState<TournamentScheduleRow[]>([]);
  const [scheduleBusyId, setScheduleBusyId] = useState<string | null>(null);

  useEffect(() => {
    if (activeTab !== 'tournaments' || !unionId) return;
    let alive = true;
    tournamentScheduleService.listForUnion(unionId).then((rows) => {
      if (alive) setSchedules(rows);
    });
    return () => {
      alive = false;
    };
  }, [activeTab, unionId]);

  const handleScheduleActiveToggle = async (row: TournamentScheduleRow, nextActive: boolean) => {
    if (scheduleBusyId) return;
    setScheduleBusyId(row.id);
    try {
      await tournamentScheduleService.setActive(row.id, nextActive);
      setSchedules((prev) => prev.map((s) => (s.id === row.id ? { ...s, active: nextActive } : s)));
      toast.success(nextActive ? 'Schedule activated.' : 'Schedule deactivated.');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the schedule.');
    } finally {
      setScheduleBusyId(null);
    }
  };

  // Level-change detection — toast when union level goes up or down
  const prevLevelRef = useRef<number | null>(null);
  useEffect(() => {
    if (!union) return;
    const currentLevel = union.level || 1;
    if (prevLevelRef.current !== null && prevLevelRef.current !== currentLevel) {
      const uLevel = getUnionLevel({
        level: currentLevel,
        totalPlayers: union.totalPlayers || union.memberCount,
      });
      if (currentLevel > prevLevelRef.current) {
        toast.success(`Union leveled up to Lv.${currentLevel} - ${uLevel.tierLabel}!`);
      } else {
        toast.info(`Union level changed to Lv.${currentLevel} - ${uLevel.tierLabel}`);
      }
    }
    prevLevelRef.current = currentLevel;
  }, [union?.level]);

  // Real-time presence tracking (non-blocking)
  useEffect(() => {
    if (!unionId) return;

    const setupPresence = async () => {
      try {
        // Use getAuthUser() which has built-in 6s timeout + getSession() fallback
        const {
          data: { user: authUser },
        } = await getAuthUser();
        if (!authUser) return;

        await presenceService.joinUnion(unionId, authUser.id, {
          onSync: (state) => {
            setOnlineCount(Object.keys(state).length);
          },
        });

        setOnlineCount(presenceService.getUnionOnlineCount(unionId));
      } catch (err) {
        // Non-critical: presence setup failed
      }
    };

    setupPresence();

    return () => {
      presenceService.leave(`union:${unionId}`);
    };
  }, [unionId]);

  const loadingRef = useRef(false);

  // ── CRITICAL: Reset per-union state when navigating between unions ──
  useEffect(() => {
    setShowClubSelector(false);
    setApplying(false);
    setVisibleClubs(new Set());
    setConfirmJoin({ show: false, club: null });
    setIsUpdatingSettings(false);
    setShowXmttModal(false);
    setOnlineCount(0);
    setLoadError(null);
    loadingRef.current = false;
  }, [unionId]);

  useEffect(() => {
    if (!unionId) return;
    let isMounted = true;

    const loadData = async () => {
      if (loadingRef.current) return;
      loadingRef.current = true;
      if (isMounted) {
        setLoading(true);
        setFinancialSummary(null);
        setFinancialError(null);
        setSettlements([]);
        setLoadError(null);
      }
      try {
        let unionData = await unionService.getUnion(unionId);

        // Self-healing: if Midway Union is missing, auto-create it
        if (!unionData && unionId === 'fade0000-0000-0000-0000-000000000001') {
          console.warn('[UnionDetailPage] Midway Union missing - auto-creating...');
          const ok = await ensureMidwayUnionSetup();
          if (ok) {
            unionData = await unionService.getUnion(unionId);
          }
        }

        const clubsData = await unionService.getUnionClubs(unionId);
        const tablesData = await tableService.getUnionTables(unionId);

        if (!isMounted) return;

        // Prefer authoritative total_players from the unions table; fall back to client-side sum
        if (unionData) {
          if (!unionData.totalPlayers && !unionData.memberCount) {
            const computedMemberCount = (clubsData || []).reduce(
              (sum, c) => sum + (c.memberCount || 0),
              0
            );
            unionData.memberCount = computedMemberCount;
          } else if (unionData.totalPlayers > unionData.memberCount) {
            unionData.memberCount = unionData.totalPlayers;
          }
        }
        setUnion(unionData);
        setClubs(clubsData || []);
        const sortedTables = (tablesData || []).sort((a: PokerTable, b: PokerTable) => {
          const aPlayers = a.current_players || 0;
          const bPlayers = b.current_players || 0;
          if (aPlayers > 0 && bPlayers === 0) return -1;
          if (aPlayers === 0 && bPlayers > 0) return 1;
          return bPlayers - aPlayers;
        });
        setTables(sortedTables);

        if (unionData?.settings?.crossClubTournaments && clubsData && clubsData.length > 0) {
          const clubIds = clubsData.map((c) => c.clubId);
          const [{ data: clubTournaments }, { data: xmttTournaments }] = await Promise.all([
            // PRIVACY + COMPLETENESS FIX 2026-08-19: the first query listed by
            // member club id, exposing every club's PRIVATE tournaments
            // union-wide; the second required is_xmtt, hiding union-owned
            // non-XMTT games. Both are replaced by one union-scoped query:
            // union-OWNED tournaments only (private games carry union_id NULL).
            supabase
              .from('tournaments')
              .select('*, clubs(name)')
              .eq('union_id', unionId)
              .order('start_time', { ascending: true }),
            supabase
              .from('tournaments')
              .select('*, clubs(name)')
              .eq('union_id', unionId)
              .eq('is_xmtt', true)
              .limit(0),
          ]);
          if (!isMounted) return;
          const allTournaments = [...(clubTournaments || []), ...(xmttTournaments || [])];
          const seen = new Set<string>();
          const tournaments = allTournaments.filter((t) => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
          });
          const statusOrder: Record<string, number> = {
            REGISTERING: 0,
            ANNOUNCED: 1,
            RUNNING: 2,
            COMPLETED: 3,
            CANCELLED: 4,
          };
          const sorted = (tournaments || []).sort((a: Tournament, b: Tournament) => {
            const aOrder = statusOrder[a.status] ?? 5;
            const bOrder = statusOrder[b.status] ?? 5;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return new Date(b.start_time).getTime() - new Date(a.start_time).getTime();
          });
          setUnionTournaments(sorted);
        }

        if (!isMounted) return;
        try {
          const settlementReport = await unionService.getSettlementReport(unionId);

          if (!isMounted) return;
          setFinancialError(null);
          setFinancialSummary({
            totalRakeThisPeriod: settlementReport.totalRakeCollected,
            unionRevenue: settlementReport.netUnionRevenue,
            pendingSettlements: settlementReport.pendingSettlements,
            overdueAmount: settlementReport.overdueAmount,
            periodLabel:
              settlementReport.periodStart && settlementReport.periodEnd
                ? `${settlementReport.periodStart} To ${settlementReport.periodEnd}`
                : 'No Issued Statement Period',
            coverageLabel: `${settlementReport.issuedClubs} Of ${settlementReport.totalClubs} Clubs Have Active Statements. Totals Cover Issued Statements Only.`,
          });
          setSettlements(
            settlementReport.clubBreakdowns.map((cb) => ({
              id: cb.invoiceId ?? `missing-${cb.clubId}`,
              periodStart: settlementReport.periodStart,
              periodEnd: settlementReport.periodEnd,
              clubId: cb.clubId,
              clubName: cb.clubName,
              rakeGenerated: cb.rakeCollected,
              unionShare: cb.unionShare,
              status: cb.status,
            }))
          );
        } catch (e) {
          reportError(e, 'UnionDetailPage.map');
          if (isMounted) {
            setFinancialSummary(null);
            setSettlements([]);
            setFinancialError(
              'Statement Data Is Unavailable. Open Weekly Statements To Check Access Or Try Again.'
            );
          }
        }
      } catch (err) {
        reportError(err, 'UnionDetailPage.Error_loading_data');
        toast.error('Failed to load union data');
        if (isMounted) setLoadError('Club Arena could not load this union workspace.');
      } finally {
        loadingRef.current = false;
        if (isMounted) setLoading(false);
      }
    };

    loadData();
    return () => {
      isMounted = false;
    };
  }, [unionId, loadRevision]);

  // Sync settings form when union data loads or tab switches to settings
  useEffect(() => {
    if (activeTab === 'settings' && union?.settings) {
      setSettingsForm({
        revenueSharePercent: union.settings.revenueSharePercent,
        sharedPlayerPool: union.settings.sharedPlayerPool,
        crossClubTournaments: union.settings.crossClubTournaments,
      });
    }
  }, [activeTab, union]);

  // Stagger animation for clubs
  useEffect(() => {
    if (clubs.length === 0) return;
    setVisibleClubs(new Set());
    const timers = clubs.map((club, index) =>
      setTimeout(() => {
        setVisibleClubs((prev) => new Set(prev).add(club.clubId));
      }, index * 60)
    );
    return () => timers.forEach(clearTimeout);
  }, [clubs]);

  // ── Realtime: live union data updates ──
  useEffect(() => {
    if (!unionId) return;

    // Helper functions to reload data
    const reloadUnionClubs = async () => {
      try {
        const clubsData = await unionService.getUnionClubs(unionId);
        setClubs(clubsData || []);
      } catch (err) {
        // Non-critical: clubs reload failed
      }
    };

    const reloadUnionTournaments = async () => {
      try {
        if (union?.settings?.crossClubTournaments) {
          const clubIds = clubs.map((c) => c.clubId);
          if (clubIds.length === 0) {
            setUnionTournaments([]);
            return;
          }
          // Fetch both club-hosted and XMTT tournaments (same as initial load)
          const [{ data: clubTournaments }, { data: xmttTournaments }] = await Promise.all([
            // PRIVACY + COMPLETENESS FIX 2026-08-19: the first query listed by
            // member club id, exposing every club's PRIVATE tournaments
            // union-wide; the second required is_xmtt, hiding union-owned
            // non-XMTT games. Both are replaced by one union-scoped query:
            // union-OWNED tournaments only (private games carry union_id NULL).
            supabase
              .from('tournaments')
              .select('*, clubs(name)')
              .eq('union_id', unionId)
              .order('start_time', { ascending: true }),
            supabase
              .from('tournaments')
              .select('*, clubs(name)')
              .eq('union_id', unionId)
              .eq('is_xmtt', true)
              .limit(0),
          ]);
          const allT = [...(clubTournaments || []), ...(xmttTournaments || [])];
          const seen = new Set<string>();
          const tournaments = allT.filter((t) => {
            if (seen.has(t.id)) return false;
            seen.add(t.id);
            return true;
          });

          // Sort: REGISTERING/ANNOUNCED first, then RUNNING, then by start_time desc
          const statusOrder: Record<string, number> = {
            REGISTERING: 0,
            ANNOUNCED: 1,
            RUNNING: 2,
            COMPLETED: 3,
            CANCELLED: 4,
          };
          const sorted = (tournaments || []).sort((a: Tournament, b: Tournament) => {
            const aOrder = statusOrder[a.status] ?? 5;
            const bOrder = statusOrder[b.status] ?? 5;
            if (aOrder !== bOrder) return aOrder - bOrder;
            return new Date(b.start_time).getTime() - new Date(a.start_time).getTime();
          });
          setUnionTournaments(sorted);
        }
      } catch (err) {
        // Non-critical: tournaments reload failed
      }
    };

    const reloadUnion = async () => {
      try {
        const unionData = await unionService.getUnion(unionId);
        // Apply same totalPlayers→memberCount sync as initial load
        if (unionData) {
          if (!unionData.totalPlayers && !unionData.memberCount) {
            const computedMemberCount = (clubs || []).reduce(
              (sum, c) => sum + (c.memberCount || 0),
              0
            );
            unionData.memberCount = computedMemberCount;
          } else if (unionData.totalPlayers > unionData.memberCount) {
            unionData.memberCount = unionData.totalPlayers;
          }
        }
        setUnion(unionData);
      } catch (err) {
        // Non-critical: union reload failed
      }
    };

    const channelKey = `union-detail-${unionId}`;

    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'union_clubs',
          filter: `union_id=eq.${unionId}`,
        },
        (payload) => {
          // Reload clubs on INSERT/UPDATE/DELETE
          void reloadUnionClubs();
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'unions',
          filter: `id=eq.${unionId}`,
        },
        (payload) => {
          // Reload union data on UPDATE
          void reloadUnion();
        }
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'tournaments',
          /* DB LOAD PASS 2026-08-24: unfiltered, every tournament write on the
             platform woke this page, which then threw almost all of them away
             with the clubIds check below. `tournaments.union_id` is the exact
             scope this page cares about and it is evaluated server-side. The
             clubIds check stays as a second, narrower gate. */
          filter: `union_id=eq.${unionId}`,
        },
        (payload) => {
          // Reload tournaments on INSERT/UPDATE events
          const newRecord = payload.new as { club_id?: string; [key: string]: unknown } | null;
          const oldRecord = payload.old as { club_id?: string; [key: string]: unknown } | null;

          // Check if this tournament belongs to any of our union clubs
          const clubIds = clubs.map((c) => c.clubId);
          const relevantRecord = newRecord || oldRecord;

          if (
            relevantRecord &&
            relevantRecord.club_id &&
            clubIds.includes(relevantRecord.club_id)
          ) {
            void reloadUnionTournaments();
          }
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'UnionDetailPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[UnionDetailPage] Realtime channel timed out');
        }
      });

    // Subscribe to bus-level UNION_UPDATED events from service layer
    const unsubUnion = masterBus.subscribeDebounced(
      'UNION_UPDATED',
      (event) => {
        if (event.payload?.unionId === unionId) {
          void reloadUnion();
          void reloadUnionClubs();
        }
      },
      500
    );

    // Refresh online count + tables when a table changes across union clubs
    const unsubTable = masterBus.subscribeDebounced(
      'TABLE_UPDATED',
      () => {
        void reloadUnionClubs();
      },
      1000
    );

    return () => {
      masterBus.removeRegisteredChannel(channelKey);
      unsubUnion();
      unsubTable();
    };
  }, [unionId, union?.settings?.crossClubTournaments, clubs]);

  const handleApplyClick = async () => {
    if (!user) return;

    try {
      const memberships = await getUserMemberships();
      const myClubs = memberships
        .map((m: { club?: Club; clubs?: Club }) => m.club || m.clubs)
        .filter(Boolean) as Club[];
      const owned = myClubs.filter((c) => c?.owner_id === user.id);

      if (owned.length === 0) {
        toast.error('You must own a club to join a union.');
        return;
      }

      // IMPROVE 2026-07-21: if one of the caller's clubs is ALREADY in this
      // union, the action is a LEAVE REQUEST, not an application.
      const memberClub = owned.find((c: any) => c.union_id === unionId);
      if (memberClub) {
        if (
          !(await confirmDialog({
            message: `Request to remove ${memberClub.name} from this union? The union lead must approve.`,
            variant: 'danger',
          }))
        ) {
          return;
        }
        setApplying(true);
        try {
          await unionApi.requestLeave(unionId!, memberClub.id);
          toast.success('Leave request submitted - the union lead will review it.');
        } catch (leaveErr: any) {
          toast.error(leaveErr.message || 'Failed to submit leave request.');
        } finally {
          setApplying(false);
        }
        return;
      }

      if (owned.length === 1) {
        // Show confirmation modal instead of window.confirm
        setConfirmJoin({ show: true, club: owned[0] });
      } else {
        setOwnedClubs(owned);
        setShowClubSelector(true);
      }
    } catch (error) {
      reportError(error, 'UnionDetailPage.error');
      toast.error('Failed to load your clubs.');
    }
  };

  const applyWithClub = async (clubId: string) => {
    if (!unionId) return;
    setApplying(true);
    try {
      const success = await unionService.addClub(unionId, clubId);
      if (success) {
        toast.success('Application sent successfully!');
        setShowClubSelector(false);
      }
    } catch (error) {
      reportError(error, 'UnionDetailPage.error');
      toast.error('Failed to send application.');
    } finally {
      setApplying(false);
    }
  };

  // Memoize filtered table arrays BEFORE early returns (React hooks rule)
  const activeTables = useMemo(() => tables.filter((t) => (t.current_players || 0) > 0), [tables]);
  const emptyTables = useMemo(() => tables.filter((t) => (t.current_players || 0) === 0), [tables]);

  if (loading) {
    return (
      <div className={styles.loading}>
        <LoadingState message="Opening Union Command" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className={styles.error}>
        <ErrorState message={loadError} onRetry={() => setLoadRevision((value) => value + 1)} />
      </div>
    );
  }

  if (!union) {
    return (
      <div className={styles.error}>
        <EmptyState
          icon="UNION"
          eyebrow="Network Unavailable"
          title="Union Not Found"
          description="This Union May Have Been Removed, Or The Link May Use An Outdated Identifier."
          /* Not /unions - see UnionDashboardPage: a person refused here would
             be refused there too since the directory became allowlisted. */
          action={{
            label: 'Back To Community',
            onClick: () => navigate('/community', { replace: true }),
          }}
          secondaryAction={{ label: 'Return To Arena', onClick: () => navigate('/') }}
        />
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <CasinoSurfaceHeader
        crest="club"
        eyebrow="Union Network / Overview"
        title={union.name}
        description={
          union.description ||
          'Inspect This Connected Club Network, Its Live Games, Player Scale, And Governed Operations.'
        }
        artPath="assets/club-buttons/wallets/desktop/wallet-union-bank-v1.webp"
        status="UNION NETWORK // LIVE"
        metrics={[
          { label: 'Clubs', value: union.clubCount },
          { label: 'Players', value: union.memberCount.toLocaleString(), tone: 'live' },
          { label: 'Online', value: union.onlineCount.toLocaleString(), tone: 'attention' },
        ]}
      />
      <div className={styles.header}>
        <div className={styles.unionAvatar}>
          {union.avatarUrl ? <img src={union.avatarUrl} alt="" /> : union.name.charAt(0)}
        </div>
        <div className={styles.unionInfo}>
          <h2>{union.name}</h2>
          <p>{union.description}</p>
        </div>
        <div className={styles.headerActions}>
          {union.ownerId === user?.id ? (
            <>
              <Link className={styles.managementButton} to={`/unions/${unionRef}/table-management`}>
                Table Management
              </Link>
              <GameCreationActions
                managementPath={`/unions/${unionRef}/table-management`}
                compact
              />
            </>
          ) : (
            <button className={styles.applyButton} onClick={handleApplyClick} disabled={applying}>
              {applying ? 'Applying...' : 'Apply To Join'}
            </button>
          )}
        </div>
      </div>

      {/* Club Selector Modal */}
      {showClubSelector && (
        <div
          className={styles.modalOverlay}
          onClick={(e) => e.target === e.currentTarget && setShowClubSelector(false)}
        >
          <div className={styles.modal}>
            <h2>Select Club</h2>
            <p>Which Club Would You Like To Apply With?</p>
            <div className={styles.clubList}>
              {ownedClubs.map((c) => (
                <button
                  key={c.id}
                  className={styles.clubOption}
                  onClick={() => applyWithClub(c.id)}
                >
                  <strong>{c.name}</strong>
                  <span>ID: {c.club_id}</span>
                </button>
              ))}
            </div>
            <button className={styles.cancelButton} onClick={() => setShowClubSelector(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Stats Row */}
      {(() => {
        const uLevel = getUnionLevel({
          level: union.level,
          playerLevel: union.playerLevel,
          hierarchyLevel: union.hierarchyLevel,
          totalPlayers: union.totalPlayers || union.memberCount,
          hierarchyUnitsRoundedUp: union.hierarchyUnitsRoundedUp,
          playerThresholdCurrent: union.playerThresholdCurrent,
          playerThresholdNext: union.playerThresholdNext,
          hierarchyThresholdCurrent: union.hierarchyThresholdCurrent,
          hierarchyThresholdNext: union.hierarchyThresholdNext,
        });
        return (
          <>
            <div className={styles.statsRow}>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{union.clubCount}</span>
                <span className={styles.statLabel}>Member Clubs</span>
              </div>
              <div className={styles.statCard}>
                <span
                  className={styles.statValue}
                  style={{
                    background: uLevel.gradient,
                    WebkitBackgroundClip: 'text',
                    WebkitTextFillColor: 'transparent',
                    fontWeight: 800,
                  }}
                >
                  Lv.{uLevel.level}
                </span>
                <span className={styles.statLabel} style={{ color: uLevel.color, fontWeight: 600 }}>
                  {uLevel.tierLabel}
                </span>
              </div>
              <div className={styles.statCard}>
                <span className={styles.statValue}>{union.memberCount.toLocaleString()}</span>
                <span className={styles.statLabel}>Total Players</span>
              </div>
              <div className={styles.statCard}>
                <span className={`${styles.statValue} ${styles.online}`}>
                  {onlineCount.toLocaleString()}
                </span>
                <span className={styles.statLabel}>Online Now</span>
              </div>
              {financialSummary && (
                <div className={styles.statCard}>
                  <span className={styles.statValue}>
                    {statementMoney(financialSummary.unionRevenue)}
                  </span>
                  <span className={styles.statLabel}>Latest Statement Share</span>
                </div>
              )}
            </div>
            {/* Level Progress Bar */}
            <div
              style={{
                width: '100%',
                height: '4px',
                background: 'rgba(255,255,255,0.08)',
                borderRadius: '2px',
                margin: '12px 0 4px',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${uLevel.progressPercent}%`,
                  height: '100%',
                  background: uLevel.gradient,
                  borderRadius: '2px',
                  transition: 'width 0.8s ease-out',
                }}
              />
            </div>
            <div
              style={{
                textAlign: 'right',
                fontSize: '0.6rem',
                color: 'rgba(255,255,255,0.4)',
                marginBottom: '8px',
              }}
            >
              {uLevel.progressPercent}% To Lv.{Math.min(uLevel.level + 1, 50)}
            </div>
          </>
        );
      })()}

      {/* Tab Navigation */}
      <nav className={styles.tabNav}>
        <button
          className={`${styles.tab} ${activeTab === 'overview' ? styles.active : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          Overview
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'clubs' ? styles.active : ''}`}
          onClick={() => setActiveTab('clubs')}
        >
          Clubs
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'tables' ? styles.active : ''}`}
          onClick={() => setActiveTab('tables')}
        >
          Tables
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'financials' ? styles.active : ''}`}
          onClick={() => setActiveTab('financials')}
        >
          Financials
        </button>
        {union?.settings?.crossClubTournaments && (
          <button
            className={`${styles.tab} ${activeTab === 'tournaments' ? styles.active : ''}`}
            onClick={() => setActiveTab('tournaments')}
          >
            Tournaments
          </button>
        )}
        {union?.ownerId === user?.id && (
          <button
            className={`${styles.tab} ${activeTab === 'settings' ? styles.active : ''}`}
            onClick={() => {
              setActiveTab('settings');
              // Load current settings
              if (union?.settings) {
                setSettingsForm({
                  revenueSharePercent: union.settings.revenueSharePercent,
                  sharedPlayerPool: union.settings.sharedPlayerPool,
                  crossClubTournaments: union.settings.crossClubTournaments,
                });
              }
            }}
          >
            Settings
          </button>
        )}
      </nav>

      {/* Tab Content */}
      <section className={styles.tabContent}>
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className={styles.overviewGrid}>
            {/* Union Activity Summary */}
            <div
              className={styles.card}
              style={{
                background: 'linear-gradient(135deg, rgba(99,102,241,0.15), rgba(139,92,246,0.10))',
                border: '1px solid rgba(139,92,246,0.25)',
              }}
            >
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>Union Activity</h3>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(3, 1fr)',
                  gap: '12px',
                  marginTop: '8px',
                }}
              >
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#6ee7b7' }}>
                    {tables.filter((t) => (t.current_players || 0) > 0).length}
                  </div>
                  <div
                    style={{
                      fontSize: '0.6rem',
                      color: 'rgba(255,255,255,0.5)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}
                  >
                    Active Tables
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#60a5fa' }}>
                    {tables.reduce((sum, t) => sum + (t.current_players || 0), 0)}
                  </div>
                  <div
                    style={{
                      fontSize: '0.6rem',
                      color: 'rgba(255,255,255,0.5)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}
                  >
                    Seated Players
                  </div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#c084fc' }}>
                    {
                      unionTournaments.filter(
                        (t: any) => t.status === 'RUNNING' || t.status === 'REGISTERING'
                      ).length
                    }
                  </div>
                  <div
                    style={{
                      fontSize: '0.6rem',
                      color: 'rgba(255,255,255,0.5)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                    }}
                  >
                    Tournaments
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.card}>
              <h3>
                {' '}
                Live Tables ({tables.filter((t) => (t.current_players || 0) > 0).length} Active)
              </h3>
              {tables.filter((t) => (t.current_players || 0) > 0).length === 0 ? (
                <div
                  style={{ textAlign: 'center', padding: '20px 0', color: 'rgba(255,255,255,0.4)' }}
                >
                  <div style={{ fontSize: '1.5rem', marginBottom: '6px' }}>◆</div>
                  <p style={{ margin: 0, fontSize: '0.75rem' }}>
                    No Active Tables - Games Will Appear Here When Clubs Start Playing
                  </p>
                </div>
              ) : (
                <div className={styles.tableList}>
                  {tables
                    .filter((t) => (t.current_players || 0) > 0)
                    .slice(0, 8)
                    .map((table) => (
                      <Link key={table.id} to={`/table/${table.id}`} className={styles.tableRow}>
                        <span>{table.name}</span>
                        <span className={styles.stakes}>
                          {table.small_blind}/{table.big_blind}
                        </span>
                        <span>
                          {table.current_players}/{table.max_players}
                        </span>
                      </Link>
                    ))}
                  {tables.filter((t) => (t.current_players || 0) > 0).length > 8 && (
                    <button className={styles.viewAllBtn} onClick={() => setActiveTab('tables')}>
                      View All {tables.length} Tables →
                    </button>
                  )}
                </div>
              )}
            </div>

            <div className={styles.card}>
              <h3> Top Clubs</h3>
              <div className={styles.clubList}>
                {clubs.slice(0, 5).map((club) => {
                  const cLevel = getClubLevel({ playerCount: club.memberCount });
                  return (
                    <Link
                      key={club.clubId}
                      to={`/clubs/${club.clubId}`}
                      className={styles.clubRow}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <div
                        className={styles.clubAvatar}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 700,
                          fontSize: '0.9rem',
                          color: '#fff',
                          textTransform: 'uppercase',
                        }}
                      >
                        {club.clubName?.charAt(0) || '?'}
                      </div>
                      <div className={styles.clubInfo}>
                        <strong>{club.clubName}</strong>
                        <span style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                          <span
                            style={{
                              fontSize: '0.6rem',
                              padding: '1px 5px',
                              borderRadius: '6px',
                              background: cLevel.gradient,
                              color: '#fff',
                              fontWeight: 700,
                              letterSpacing: '0.3px',
                              textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                            }}
                          >
                            Lv.{cLevel.level}
                          </span>
                          {club.memberCount} {club.memberCount === 1 ? 'Member' : 'Members'}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </div>

            {financialSummary && (
              <div className={styles.card}>
                <h3> Latest Issued Statements</h3>
                <p>{financialSummary.periodLabel}</p>
                <p>{financialSummary.coverageLabel}</p>
                <div className={styles.financialQuick}>
                  <div>
                    <span>Recorded Rake</span>
                    <strong>{statementMoney(financialSummary.totalRakeThisPeriod)}</strong>
                  </div>
                  <div>
                    <span>Recorded Union Share</span>
                    <strong className={styles.positive}>
                      {statementMoney(financialSummary.unionRevenue)}
                    </strong>
                  </div>
                  <div>
                    <span>Pending</span>
                    <strong>
                      {financialSummary.pendingSettlements} Settlement
                      {financialSummary.pendingSettlements !== 1 ? 's' : ''}
                    </strong>
                  </div>
                  {financialSummary.overdueAmount > 0 && (
                    <div>
                      <span>Overdue</span>
                      <strong className={styles.negative}>
                        {financialSummary.overdueAmount.toLocaleString()}
                      </strong>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Clubs Tab */}
        {activeTab === 'clubs' && (
          <div className={styles.clubsGrid}>
            {clubs.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '40px 20px',
                  color: 'rgba(255,255,255,0.4)',
                }}
              >
                <div style={{ fontSize: '2rem', marginBottom: '8px' }}>⌂</div>
                <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 500 }}>No Clubs Yet</p>
                <p style={{ margin: '4px 0 0', fontSize: '0.7rem' }}>
                  Invite Clubs To Join Your Union To Get Started
                </p>
              </div>
            ) : (
              clubs.map((club) => {
                const cLevel = getClubLevel({ playerCount: club.memberCount });
                const clubTables = tables.filter((t: any) => t.club_id === club.clubId);
                const activeTableCount = clubTables.filter(
                  (t) => (t.current_players || 0) > 0
                ).length;
                return (
                  <Link
                    key={club.clubId}
                    to={`/clubs/${club.clubId}`}
                    className={`${styles.clubCard} ${visibleClubs.has(club.clubId) ? styles.fadeInUp : styles.hidden}`}
                    style={{
                      ...(visibleClubs.has(club.clubId)
                        ? {}
                        : { opacity: 0, transform: 'translateY(8px)' }),
                      textDecoration: 'none',
                      color: 'inherit',
                    }}
                  >
                    <div
                      className={styles.clubCardAvatar}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontWeight: 800,
                        fontSize: '1.2rem',
                        color: '#fff',
                        textTransform: 'uppercase',
                      }}
                    >
                      {club.clubName?.charAt(0) || '?'}
                    </div>
                    <div className={styles.clubCardInfo}>
                      <h4 style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        {club.clubName}
                        <span
                          style={{
                            fontSize: '0.55rem',
                            padding: '1px 5px',
                            borderRadius: '6px',
                            background: cLevel.gradient,
                            color: '#fff',
                            fontWeight: 700,
                            letterSpacing: '0.3px',
                            textShadow: '0 1px 2px rgba(0,0,0,0.3)',
                          }}
                        >
                          Lv.{cLevel.level}
                        </span>
                      </h4>
                      <p>Owner: {club.ownerName || 'Unknown'}</p>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        {club.memberCount} {club.memberCount === 1 ? 'Member' : 'Members'}
                        {activeTableCount > 0 && (
                          <span style={{ color: '#6ee7b7', fontSize: '0.7rem', fontWeight: 600 }}>
                            {activeTableCount} {activeTableCount === 1 ? 'Table' : 'Tables'}
                          </span>
                        )}
                      </span>
                    </div>
                    {union?.ownerId === user?.id && unionId && (
                      // Governance, not a delete: exit blockers are read first so the
                      // owner sees live seats, open entries, unsettled rake and agent
                      // credit before anything is unwound.
                      <span
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                      >
                        <UnionClubGovernance
                          unionId={unionId}
                          clubId={club.clubId}
                          clubName={club.clubName}
                          onExpelled={(id) =>
                            setClubs((prev) => prev.filter((c) => c.clubId !== id))
                          }
                        />
                      </span>
                    )}
                  </Link>
                );
              })
            )}
          </div>
        )}

        {/* Tables Tab */}
        {activeTab === 'tables' && (
          <div>
            {tables.length === 0 ? (
              <div
                style={{
                  textAlign: 'center',
                  padding: '40px 20px',
                  color: 'rgba(255,255,255,0.4)',
                }}
              >
                <div style={{ fontSize: '2rem', marginBottom: '8px' }}>▦</div>
                <p style={{ margin: 0, fontSize: '0.85rem', fontWeight: 500 }}>No Tables Active</p>
                <p style={{ margin: '4px 0 0', fontSize: '0.7rem' }}>
                  Your Clubs&apos; Tables Will Appear Here When Games Start
                </p>
              </div>
            ) : (
              <>
                {activeTables.length > 0 && (
                  <>
                    <h3 style={{ color: '#fff', margin: '0 0 1rem' }}>
                      Active Tables ({activeTables.length})
                    </h3>
                    <div className={styles.tablesGrid}>
                      {activeTables.map((table) => (
                        <div key={table.id} className={styles.tableCard}>
                          <div className={styles.tableCardHeader}>
                            <h4>{table.name}</h4>
                            <span className={`${styles.statusDot} ${styles[table.status]}`} />
                          </div>
                          <div className={styles.tableCardDetails}>
                            <span>
                              {table.small_blind}/{table.big_blind}
                            </span>
                            <span className={styles.variant}>
                              {(table as any).game_variant || 'NLH'}
                            </span>
                            <span>
                              {table.current_players}/{table.max_players}
                            </span>
                          </div>
                          <Link to={`/table/${table.id}`} className={styles.joinButton}>
                            View Table
                          </Link>
                        </div>
                      ))}
                    </div>
                  </>
                )}
                {emptyTables.length > 0 && (
                  <>
                    <h3 style={{ color: 'rgba(255,255,255,0.5)', margin: '2rem 0 1rem' }}>
                      Empty Tables ({emptyTables.length})
                    </h3>
                    <div className={styles.tablesGrid}>
                      {emptyTables.map((table) => (
                        <div key={table.id} className={styles.tableCard} style={{ opacity: 0.6 }}>
                          <div className={styles.tableCardHeader}>
                            <h4>{table.name}</h4>
                          </div>
                          <div className={styles.tableCardDetails}>
                            <span>
                              {table.small_blind}/{table.big_blind}
                            </span>
                            <span className={styles.variant}>
                              {(table as any).game_variant || 'NLH'}
                            </span>
                            <span>0/{table.max_players}</span>
                          </div>
                          <Link to={`/table/${table.id}`} className={styles.joinButton}>
                            View Table
                          </Link>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {/* Tournaments Tab */}
        {activeTab === 'tournaments' && union?.settings?.crossClubTournaments && (
          <div className={styles.tournamentsContainer}>
            <div className={styles.sectionHeader}>
              <div>
                <h3>Union Tournaments (XMTT)</h3>
                <p>Tournaments Open To All Member Clubs</p>
              </div>
              {union?.ownerId === user?.id && clubs.length > 0 && (
                <button
                  className={styles.joinButton}
                  style={{
                    background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
                    border: 'none',
                    fontWeight: 700,
                  }}
                  onClick={() => setShowXmttModal(true)}
                >
                  + Create XMTT
                </button>
              )}
            </div>
            {unionTournaments.length === 0 ? (
              <div className={styles.emptyState}>
                <p>No Union Wide Tournaments Scheduled</p>
                {union?.ownerId === user?.id && (
                  <button
                    className={styles.joinButton}
                    style={{
                      marginTop: '1rem',
                      background: 'linear-gradient(135deg, #8b5cf6, #6366f1)',
                      border: 'none',
                    }}
                    onClick={() => setShowXmttModal(true)}
                  >
                    + Create First XMTT
                  </button>
                )}
              </div>
            ) : (
              <div className={styles.tablesGrid}>
                {unionTournaments.map((t) => (
                  <div key={t.id} className={styles.tableCard}>
                    <div className={styles.tableCardHeader}>
                      <h4>{t.name}</h4>
                      <span className={`${styles.statusBadge} ${styles[t.status]}`}>
                        {t.status}
                      </span>
                    </div>
                    <div className={styles.tableCardDetails}>
                      {/* hide_club_name (2026-08-22): never leak the hosting
                          club's name when the owner chose to hide it. */}
                      <span>
                        {' '}
                        {union?.name || (t.hide_club_name ? 'Union' : t.clubs?.name) || 'Union'}
                      </span>
                      {/* The advertised buy-in is the TOTAL (prize + fee), in
                          whole chips - never the prize half on its own. */}
                      <span> {formatBuyInShort(t.buy_in_amount || 0, t.buy_in_fee)}</span>
                      <span>
                        {' '}
                        {t.current_players || 0}
                        {getTournamentEntryCapacity(t) !== null ? `/${t.max_players}` : ''}
                      </span>
                      <span> {new Date(t.start_time).toLocaleDateString()}</span>
                    </div>
                    <Link to={`/tournaments/${t.id}`} className={styles.joinButton}>
                      View Details
                    </Link>
                  </div>
                ))}
              </div>
            )}

            {/* ── Recurring Schedules (2026-08-22, owner only): the union's
                tournament_schedules rows. Active toggle goes through
                fn_upsert_tournament_schedule; Remove is the soft delete
                (fn_delete_tournament_schedule, active=false). ── */}
            {union?.ownerId === user?.id && schedules.length > 0 && (
              <>
                <h3 style={{ margin: '2rem 0 1rem' }}>Recurring Schedules</h3>
                <div className={styles.tablesGrid}>
                  {schedules.map((s) => (
                    <div
                      key={s.id}
                      className={styles.tableCard}
                      style={!s.active ? { opacity: 0.55 } : undefined}
                    >
                      <div className={styles.tableCardHeader}>
                        <h4>{s.name}</h4>
                        <span
                          className={`${styles.statusBadge} ${s.active ? styles.paid : styles.overdue}`}
                        >
                          {s.active ? 'ACTIVE' : 'OFF'}
                        </span>
                      </div>
                      <div className={styles.tableCardDetails}>
                        <span>
                          {describeSchedule(s.days_of_week, s.start_times_utc, s.interval_minutes)}
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          className={styles.joinButton}
                          disabled={scheduleBusyId === s.id}
                          onClick={() => handleScheduleActiveToggle(s, !s.active)}
                        >
                          {scheduleBusyId === s.id
                            ? 'Working...'
                            : s.active
                              ? 'Deactivate'
                              : 'Reactivate'}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* Financials Tab */}
        {activeTab === 'financials' && (
          <div className={styles.financialsContainer}>
            {/*
              The weekly square-up board. It lives on its own page because it
              is per-period and per-club, and because the one thing it has to
              show - a club that was never billed - needs the whole club list
              beside the invoice list to be visible at all.
            */}
            <button
              type="button"
              className={styles.statementsLink}
              onClick={() => navigate(`/unions/${unionRef}/statements`)}
            >
              Weekly Statements And Square-Up
            </button>

            {/*
              What the union PRODUCED, as against what it billed. Until this
              existed the rake snapshot could only be reached from inside a
              member club, so a union lead who owns no club had no door to
              their own union's figures. A route with nothing linking to it is
              a route nobody finds - /union-dashboard sat unlinked for months,
              two comments below this one.
            */}
            <button
              type="button"
              className={styles.statementsLink}
              onClick={() => navigate(`/unions/${unionRef}/data`)}
            >
              Union Rake And Production Data
            </button>

            {financialError && <p role="alert">{financialError}</p>}
            {financialSummary && (
              <>
                <p>{financialSummary.periodLabel}</p>
                <p>{financialSummary.coverageLabel}</p>
                {/* Summary Cards */}
                <div className={styles.financialCards}>
                  <div className={styles.financialCard}>
                    <span className={styles.financialIcon}>%</span>
                    <div>
                      <span className={styles.financialValue}>
                        {statementMoney(financialSummary.totalRakeThisPeriod)}
                      </span>
                      <span className={styles.financialLabel}>Recorded Statement Rake</span>
                    </div>
                  </div>
                  <div className={styles.financialCard}>
                    <span className={styles.financialIcon}>◉</span>
                    <div>
                      <span className={`${styles.financialValue} ${styles.positive}`}>
                        {statementMoney(financialSummary.unionRevenue)}
                      </span>
                      <span className={styles.financialLabel}>Recorded Union Share</span>
                    </div>
                  </div>
                  <div className={styles.financialCard}>
                    <span className={styles.financialIcon}>◷</span>
                    <div>
                      <span className={styles.financialValue}>
                        {financialSummary.pendingSettlements}
                      </span>
                      <span className={styles.financialLabel}>Pending Settlements</span>
                    </div>
                  </div>
                  {financialSummary.overdueAmount > 0 && (
                    <div className={`${styles.financialCard} ${styles.overdue}`}>
                      <span className={styles.financialIcon}>!</span>
                      <div>
                        <span className={`${styles.financialValue} ${styles.negative}`}>
                          {financialSummary.overdueAmount.toLocaleString()}
                        </span>
                        <span className={styles.financialLabel}>Overdue</span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Settlement History */}
                <div className={styles.settlementSection}>
                  <h3> Statements For Selected Period</h3>
                  {/* 2026-08-19: /union-dashboard had NO link anywhere in the app —
                  it was reachable only by typing the URL. That is where the
                  union wallet, the treasury and the weekly player win/loss
                  settlement live, so in practice none of it was visible to the
                  people who own it. */}
                  <p style={{ margin: '0 0 12px', fontSize: 13, opacity: 0.75 }}>
                    Weekly Player Win/Loss Settlement, Wallet And Treasury Live On The{' '}
                    <Link
                      to={`/unions/${unionRef}/operations`}
                      style={{ color: '#1877F2', fontWeight: 600 }}
                    >
                      Union Dashboard
                    </Link>
                    .
                  </p>
                  <table className={styles.settlementTable}>
                    <thead>
                      <tr>
                        <th>Period</th>
                        <th>Club</th>
                        <th>Rake</th>
                        <th>Union Share</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {settlements.map((s) => (
                        <tr key={s.id}>
                          <td>
                            {s.periodStart && s.periodEnd
                              ? `${s.periodStart} To ${s.periodEnd}`
                              : 'No Issued Period'}
                          </td>
                          <td>{s.clubName}</td>
                          <td>{statementMoney(s.rakeGenerated)}</td>
                          <td className={styles.positive}>{statementMoney(s.unionShare)}</td>
                          <td>
                            <span className={`${styles.statusBadge} ${styles[s.status]}`}>
                              {s.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        )}

        {/* Settings Tab - Owner Only */}
        {activeTab === 'settings' && union?.ownerId === user?.id && (
          <div className={styles.settingsContainer}>
            <div className={styles.settingsCard}>
              <h3> Revenue Configuration</h3>
              <p className={styles.settingsDesc}>
                Configure How Revenue Is Split Between The Union And Clubs
              </p>

              <div className={styles.settingRow}>
                <label>Revenue Share %</label>
                <div className={styles.sliderRow}>
                  <input
                    type="range"
                    min="0"
                    max="30"
                    value={settingsForm.revenueSharePercent}
                    onChange={(e) =>
                      setSettingsForm((prev) => ({
                        ...prev,
                        revenueSharePercent: Number(e.target.value),
                      }))
                    }
                    className={styles.slider}
                  />
                  <span className={styles.sliderValue}>{settingsForm.revenueSharePercent}%</span>
                </div>
                <p className={styles.settingHint}>Percentage Of Club Rake That Goes To The Union</p>
              </div>

              <div className={styles.settingRow}>
                <label className={styles.toggleLabel}>
                  <input
                    type="checkbox"
                    checked={settingsForm.sharedPlayerPool}
                    onChange={(e) =>
                      setSettingsForm((prev) => ({ ...prev, sharedPlayerPool: e.target.checked }))
                    }
                  />
                  Shared Player Pool
                </label>
                <p className={styles.settingHint}>Allow Players To Sit At Any Club’s Tables</p>
              </div>

              <div className={styles.settingRow}>
                <label className={styles.toggleLabel}>
                  <input
                    type="checkbox"
                    checked={settingsForm.crossClubTournaments}
                    onChange={(e) =>
                      setSettingsForm((prev) => ({
                        ...prev,
                        crossClubTournaments: e.target.checked,
                      }))
                    }
                  />
                  Cross-Club Tournaments
                </label>
                <p className={styles.settingHint}>Enable Union-Wide Tournament Scheduling</p>
              </div>

              <button
                className={styles.saveButton}
                onClick={async () => {
                  if (!unionId || isUpdatingSettings) return;
                  setIsUpdatingSettings(true);
                  const updated = await unionService.updateUnion(unionId, {
                    settings: settingsForm,
                  });
                  if (updated) {
                    setUnion(updated);
                    toast.success('Settings saved successfully!');
                  }
                  setIsUpdatingSettings(false);
                }}
                disabled={isUpdatingSettings}
              >
                {isUpdatingSettings ? 'Saving...' : 'Save Settings'}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* XMTT Creation Modal */}
      {showXmttModal && clubs.length > 0 && unionId && (
        <CreateTournamentModal
          clubId={clubs[0].clubId}
          unionId={unionId}
          onClose={() => setShowXmttModal(false)}
          onSuccess={() => {
            setShowXmttModal(false);
            // Reload union tournaments (club-hosted + XMTT, same as initial load)
            if (union?.settings?.crossClubTournaments && clubs.length > 0) {
              const clubIds = clubs.map((c) => c.clubId);
              Promise.all([
                // PRIVACY + COMPLETENESS FIX 2026-08-19 — see note above.
                supabase
                  .from('tournaments')
                  .select('*, clubs(name)')
                  .eq('union_id', unionId)
                  .order('start_time', { ascending: true }),
                supabase
                  .from('tournaments')
                  .select('*, clubs(name)')
                  .eq('union_id', unionId)
                  .eq('is_xmtt', true)
                  .limit(0),
              ]).then(([{ data: clubT }, { data: xmttT }]) => {
                const allT = [...(clubT || []), ...(xmttT || [])];
                const seen = new Set<string>();
                const deduped = allT.filter((t) => {
                  if (seen.has(t.id)) return false;
                  seen.add(t.id);
                  return true;
                });
                const statusOrder: Record<string, number> = {
                  REGISTERING: 0,
                  ANNOUNCED: 1,
                  RUNNING: 2,
                  COMPLETED: 3,
                  CANCELLED: 4,
                };
                deduped.sort((a: any, b: any) => {
                  const aO = statusOrder[a.status] ?? 5;
                  const bO = statusOrder[b.status] ?? 5;
                  if (aO !== bO) return aO - bO;
                  return new Date(b.start_time).getTime() - new Date(a.start_time).getTime();
                });
                setUnionTournaments(deduped);
              });
            }
          }}
        />
      )}

      {/* Join Confirmation Modal */}
      <ConfirmModal
        isOpen={confirmJoin.show}
        title="Join Union"
        message={`Apply to join ${union?.name} with your club "${confirmJoin.club?.name}"?`}
        confirmText="Apply"
        cancelText="Cancel"
        onConfirm={async () => {
          if (confirmJoin.club) {
            await applyWithClub(confirmJoin.club.id);
          }
          setConfirmJoin({ show: false, club: null });
        }}
        onCancel={() => setConfirmJoin({ show: false, club: null })}
        loading={applying}
      />
    </div>
  );
}
