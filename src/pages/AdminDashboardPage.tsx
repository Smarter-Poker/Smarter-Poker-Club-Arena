/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  ADMIN DASHBOARD PAGE — Club Operations Center
 * Ported from World Hub admin.js → Club Arena TypeScript
 *
 * Tabs (12): Health, Hierarchy, Settlements, History, Audit Trail,
 *   Branding, Recommendations, Announcements, Templates, Analytics, Mint, Settings
 *
 * ── #ClubArenaConsole (2026-09-09) ────────────────────────────────────────
 * The page's own frame - a bordered header bar with a gear glyph in the
 * title, a rounded ghost button and a twelve-pill scrolling tab rail - is on
 * Dan's approved spade master now: the title engraved in the header well, the
 * role in the painted pill slot, the twelve views as lit words cut into the
 * glass, and Lobby as a lit word beside them. The three bordered data tables
 * (commissions, audit trail, settlement history) are one row per record with
 * their fields stacked as label/value pairs, because six columns of audit
 * trail on a 393px phone scrolled sideways off the screen.
 *
 * THE `admin-*` VOCABULARY IS SHARED AND IS NOT REWRITTEN. Four other pages
 * import THIS stylesheet - AgentDashboardPage, admin/HouseAdsPage,
 * PlayerSessionsPage and UnionDashboardPage - so `.admin-card`, `.admin-btn`,
 * `.admin-badge`, `.admin-stat-card` and the rest keep their definitions
 * exactly as they were. What this page adds is a SCOPED section under
 * `.admin-console-page`, a root class only this page carries, which flattens
 * that chrome where it sits on the console glass and nowhere else.
 *
 * WHAT DID NOT CHANGE, AND MUST NOT: the club resolve and its "that club could
 * not be found" refusal, the role gate and both ACCESS DENIED messages, every
 * tab's queries and role visibility, the read-only commission ledger (it
 * offers no action claiming to settle a commission, and writes nothing to
 * agent_commissions), the bank-balance read that renders unknown as
 * unknown, and every figure on every tab. This page mints chips and changes
 * club settings; not one of those paths was touched.
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { callClubArenaApi } from '../services/clubArenaApi';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { resolveClubUUID } from '../utils/clubIdResolver';
import ArenaLedger from '../components/admin/ArenaLedger';
import ClubWeeklyAccountingSummary from '../components/accounting/ClubWeeklyAccountingSummary';
import AdminTableHeatmap from '../components/admin/AdminTableHeatmap';
import StandardContentLayout from '../components/layouts/StandardContentLayout';
import { SpadeConsole } from '../components/console/SpadeConsole';
import './AdminDashboardPage.css';

import { useIsMounted } from '../hooks/useIsMounted';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { retryFetch } from '../utils/retryFetch';
import { fmt, fmtChips } from '../utils/format';
import { reportError } from '../utils/errorReporter';
import { clubGamesOrFilter } from '../utils/unionScope';
import { confirmDialog } from '../components/common/confirmDialog';

import { safeErrorMessage } from '../utils/safeErrorMessage';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { resolvePageClubId, pickPreferredClubId } from '../utils/resolvePageClubId';
import { downloadCsv } from '../utils/downloadCsv';
// ── Helpers ─────────────────────────────────────────────────
const formatDate = (ts: string | null | undefined) => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
};
const toTitleCase = (str: string) =>
  str.replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());

type AdminTab =
  | 'dashboard'
  | 'hierarchy'
  | 'settlements'
  | 'history'
  | 'audit'
  | 'branding'
  | 'recommendations'
  | 'announcements'
  | 'templates'
  | 'analytics'
  | 'mint'
  | 'settings';

// ── Admin Dashboard Types ───────────────────────────────────────
interface HealthBreakdown {
  activePlayers?: { score: number; active: number; total: number };
  rakeTrend?: { score: number; thisWeek: number };
  agentEngagement?: { score: number; active: number; total: number };
  playerAcquisition?: { score: number; newThisMonth: number };
  cashoutVelocity?: { score: number; cashouts: number; buyins: number };
}
interface HealthData {
  healthScore: number;
  color: string;
  status: string;
  trend: string;
  breakdown: HealthBreakdown;
}
interface VolumeStats {
  totalVolume: number;
  byActionType: Record<string, { volume: number; count: number }>;
}

interface AuditLogRow {
  id: string;
  action: string;
  actor_id: string | null;
  target_type: string | null;
  target_id: string | null;
  details: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: string;
  // Enriched client-side
  userName?: string;
  targetUserName?: string;
}
interface HierarchyMember {
  user_id: string;
  role: string;
  profiles?: { display_name?: string; username?: string } | null;
}
interface Recommendation {
  /* No `icon` field. It carried a dingbat printed in front of the title -
     an emblem stuck on top rather than painted in the master. The severity
     is a lit word now, which is the same information said in the master's
     own ink. */
  severity: 'info' | 'warning' | 'critical' | 'success';
  title: string;
  desc: string;
}
interface TableRow {
  id: string;
  current_players: number;
  status: string;
  total_hands_dealt?: number;
}
interface SessionRow {
  total_hands: number;
  net_result: number;
  duration_minutes: number;
}
interface ClubMemberRow {
  user_id: string;
  is_active?: boolean;
  role: string;
  last_active_at?: string | null;
}
interface ProfileRow {
  id: string;
  username: string;
  display_name?: string | null;
}
interface SettlementPeriod {
  id: string;
  period_number?: number | string;
  status: string;
  start_at: string;
  end_at?: string | null;
  total_volume?: number;
}
interface TableTemplate {
  id: string;
  name?: string;
  game_type?: string;
  small_blind?: number;
  big_blind?: number;
  max_players?: number;
  schedule_enabled?: boolean;
  min_buy_in?: number;
  max_buy_in?: number;
}
interface HierarchyNode {
  user_id: string;
}
interface Announcement {
  id: string;
  pinned?: boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHARED UI: Meter
// ═══════════════════════════════════════════════════════════════════════════════
function Meter({
  label,
  score,
  color,
  detail,
}: {
  label: string;
  score: number;
  color: string;
  detail: string;
}) {
  return (
    <div style={{ marginBottom: '16px' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          fontSize: '13px',
          marginBottom: '8px',
        }}
      >
        <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{label}</span>
        <span style={{ color: 'var(--text-secondary)' }}>
          {detail} (Score: {score})
        </span>
      </div>
      <div className="admin-meter-track">
        <div
          className="admin-meter-fill"
          style={{ width: `${Math.max(0, Math.min(100, score))}%`, background: color }}
        />
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 1: DASHBOARD (Health Score)
// ═══════════════════════════════════════════════════════════════════════════════
function DashboardTab({ clubId }: { clubId: string }) {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [stats, setStats] = useState<VolumeStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isMounted = useIsMounted();
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    try {
      setLoading(true);
      setLoadError(null);
      const uuid = await resolveClubUUID(clubId);
      // P2-1: union games carry the union container as club_id
      const gamesScope = await clubGamesOrFilter(uuid);

      // Parallel: club health metrics + audit stats + acquisition + cashout velocity
      const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const [membersRes, tablesRes, rakeRes, newMembersRes, cashoutsRes] = await Promise.all([
        retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('user_id, role, is_active', { count: 'exact' })
              .eq('club_id', uuid)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        retryFetch(
          () =>
            supabase
              .from('tables')
              .select('id, current_players, status')
              .or(gamesScope)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        retryFetch(
          () =>
            supabase
              .from('player_stats')
              .select('total_rake')
              .eq('club_id', uuid)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        // New members in last 30 days (for Player Acquisition metric)
        retryFetch(
          () =>
            supabase
              .from('club_members')
              .select('user_id', { count: 'exact' })
              .eq('club_id', uuid)
              .gte('created_at', thirtyDaysAgo)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
        // Cashout requests (for Cashout Velocity metric)
        retryFetch(
          () =>
            supabase
              .from('cashout_requests')
              .select('id, status', { count: 'exact' })
              .eq('club_id', uuid)
              .gte('created_at', thirtyDaysAgo)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: isMounted }
        ),
      ]);

      if (!isMounted.current) return;

      const members = membersRes.data || [];
      const tables = tablesRes.data || [];
      const rakeData = rakeRes.data || [];

      const totalMembers = members.length;
      const activeMembers = members.filter(
        (m: { is_active?: boolean }) => m.is_active !== false
      ).length;
      const activeTables = tables.filter((t: { status?: string }) => t.status === 'active').length;
      const agents = members.filter((m: { role?: string }) =>
        ['agent', 'super_agent', 'sub_agent'].includes(m.role || '')
      );
      const totalRake = rakeData.reduce(
        (sum: number, r: { total_rake?: number }) => sum + (r.total_rake || 0),
        0
      );

      // Player Acquisition (new members in last 30 days)
      const newThisMonth = newMembersRes.count ?? (newMembersRes.data || []).length;
      const acquisitionScore = Math.min(100, newThisMonth * 10); // 10 new = 100%

      // Cashout Velocity (ratio of cashouts to total members — healthy clubs have moderate cashouts)
      const cashoutData = cashoutsRes.data || [];
      const totalCashouts = cashoutData.length;
      const approvedCashouts = cashoutData.filter(
        (c: { status?: string }) => c.status === 'approved' || c.status === 'completed'
      ).length;
      // Healthy velocity: some cashouts relative to member count (too many = bleeding, zero = stagnant)
      const cashoutRatio = totalMembers > 0 ? totalCashouts / totalMembers : 0;
      const cashoutScore =
        cashoutRatio > 0.5
          ? Math.max(20, 100 - cashoutRatio * 100)
          : cashoutRatio > 0
            ? Math.min(100, cashoutRatio * 200)
            : totalMembers > 0
              ? 30
              : 50; // No cashouts with members = growing phase

      // Calculate health score
      const playerScore =
        totalMembers > 0 ? Math.min(100, (activeMembers / totalMembers) * 100) : 0;
      const agentScore = agents.length > 0 ? Math.min(100, agents.length * 20) : 0;
      const tableScore = activeTables > 0 ? Math.min(100, activeTables * 25) : 0;
      const rakeScore = totalRake > 0 ? Math.min(100, (totalRake / 1000) * 100) : 0;
      const healthScore = Math.round(
        playerScore * 0.4 +
          rakeScore * 0.2 +
          agentScore * 0.15 +
          tableScore * 0.15 +
          acquisitionScore * 0.05 +
          cashoutScore * 0.05
      );

      const color = healthScore >= 70 ? 'green' : healthScore >= 40 ? 'yellow' : 'red';
      const status =
        healthScore >= 70 ? 'Healthy' : healthScore >= 40 ? 'Needs Attention' : 'Critical';

      setHealth({
        healthScore: Math.min(100, healthScore),
        color,
        status,
        trend: 'stable',
        breakdown: {
          activePlayers: {
            score: Math.round(playerScore),
            active: activeMembers,
            total: totalMembers,
          },
          rakeTrend: { score: Math.round(rakeScore), thisWeek: totalRake },
          agentEngagement: {
            score: Math.round(agentScore),
            active: agents.length,
            total: agents.length,
          },
          playerAcquisition: { score: Math.round(acquisitionScore), newThisMonth },
          cashoutVelocity: {
            score: Math.round(cashoutScore),
            cashouts: totalCashouts,
            buyins: approvedCashouts,
          },
        },
      });

      setStats({
        totalVolume: totalRake,
        byActionType: {
          rake: { volume: totalRake, count: rakeData.length },
          tables: { volume: activeTables, count: tables.length },
        },
      });
    } catch (err: unknown) {
      if (isMounted.current)
        setLoadError(
          err instanceof Error
            ? safeErrorMessage(err, 'Failed to load dashboard')
            : 'Failed to load dashboard'
        );
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    load();
  }, [load]);

  // Bus listener for cross-page sync (ported from World Hub admin.js)
  useEffect(() => {
    const unsubs = [
      // User-initiated: fast response (500ms)
      masterBus.subscribeDebounced('TABLE_CREATED', load, 500),
      masterBus.subscribeDebounced('TABLE_UPDATED', load, 500),
      masterBus.subscribeDebounced('TABLE_CLOSED', load, 500),
      masterBus.subscribeDebounced('ADMIN_ACTION', load, 500),
      masterBus.subscribeDebounced('ANNOUNCEMENT_CHANGED', load, 500),
      masterBus.subscribeDebounced('AGENT_UPDATED', load, 500),
      masterBus.subscribeDebounced('CLUB_UPDATED', load, 500),
      masterBus.subscribeDebounced('SETTINGS_CHANGED', load, 500),
      masterBus.subscribeDebounced('CLUB_SETTINGS_UPDATED', load, 500),
      // COLLUSION_DETECTED removed 2026-08-28: nothing emits it on the client
      // bus (detection is server-side), so the refresh could never fire.
      // Financial events: medium debounce (1500ms)
      masterBus.subscribeDebounced('CASHOUT_REQUESTED', load, 1500),
      masterBus.subscribeDebounced('CASHOUT_APPROVED', load, 1500),
      masterBus.subscribeDebounced('TOURNAMENT_REGISTERED', load, 1500),
      // High-frequency: longer debounce (2000ms) — fires on every hand
      masterBus.subscribeDebounced('BALANCE_UPDATED', load, 2000),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', load, 2000),
      masterBus.subscribeDebounced('CREDIT_UPDATED', load, 2000),
      // RAKEBACK_CLAIMED removed 2026-09-20: rakeback is settled by the
      // automatic Monday run, so nothing emits it on the client bus. The
      // wallet movement still arrives here as BALANCE_UPDATED above.
    ];
    return () => unsubs.forEach((u) => u());
  }, [load]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    if (!clubId) return;
    let isMounted = true;

    const setupRealtime = async () => {
      const resolvedId = await resolveClubUUID(clubId);
      if (!isMounted) return;

      const channelKey = `admin-dashboard-${clubId}`;
      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'tables', filter: `club_id=eq.${resolvedId}` },
          () => load()
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'club_members',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => load()
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'cashout_requests',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => load()
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'tournaments',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => load()
        )
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'settlement_periods',
            filter: `club_id=eq.${resolvedId}`,
          },
          () => load()
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'AdminDashboardPage._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[AdminDashboardPage] Realtime channel timed out');
          }
        });
    };

    setupRealtime().catch((e) => console.warn('[AdminDashboardPage] Realtime setup failed:', e));

    return () => {
      isMounted = false;
      masterBus.removeRegisteredChannel(`admin-dashboard-${clubId}`);
    };
  }, [clubId, load]);

  // ── Visibility Refresh — refresh on tab focus after 30s ──
  useVisibilityRefresh(load);

  if (loading)
    return (
      <div className="admin-tab-content">
        <div className="admin-skeleton-row">
          <div className="admin-skeleton" style={{ height: '240px', flex: '1 1 300px' }} />
          <div style={{ flex: '2 1 400px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="admin-skeleton" style={{ height: '40px' }} />
            ))}
          </div>
        </div>
      </div>
    );

  if (loadError || !health)
    return (
      <div className="admin-error-state">
        <div className="admin-error-icon">⚠</div>
        <div className="admin-error-msg">{loadError || 'Failed To Load Health Metrics'}</div>
        <button onClick={load} className="admin-btn admin-btn-primary">
          ↻ Retry
        </button>
      </div>
    );

  const colorMap: Record<string, string> = { green: '#31A24C', yellow: '#F5A623', red: '#FA383E' };
  const hColor = colorMap[health.color] || '#31A24C';
  const bd = health.breakdown || {};

  return (
    <div className="admin-tab-content">
      <div className="admin-dashboard-grid">
        {/* Health Score Ring */}
        <div className="admin-health-card" style={{ borderColor: `${hColor}44` }}>
          <h3 className="admin-card-subtitle">Overall Club Health</h3>
          <div
            className="admin-health-ring"
            style={{ borderColor: hColor, boxShadow: `0 0 30px ${hColor}33` }}
          >
            <span className="admin-health-score" style={{ color: hColor }}>
              {health.healthScore}
            </span>
          </div>
          <div className="admin-health-status" style={{ color: hColor }}>
            {health.status}{' '}
            {health.trend === 'improving' ? '↗' : health.trend === 'declining' ? '↘' : '➡'}
          </div>
        </div>

        {/* Breakdown Meters */}
        <div className="admin-card">
          <h3 className="admin-card-title">Health Metrics Breakdown</h3>
          {bd.activePlayers && (
            <Meter
              label="Active Players (40%)"
              score={bd.activePlayers.score}
              color="#31A24C"
              detail={`${bd.activePlayers.active} / ${bd.activePlayers.total}`}
            />
          )}
          {bd.rakeTrend && (
            <Meter
              label="Rake Trend (20%)"
              score={bd.rakeTrend.score}
              color="#F5A623"
              detail={`This week: ${fmtChips(bd.rakeTrend.thisWeek)}`}
            />
          )}
          {bd.agentEngagement && (
            <Meter
              label="Agent Engagement (15%)"
              score={bd.agentEngagement.score}
              color="#4599FF"
              detail={`${bd.agentEngagement.active} / ${bd.agentEngagement.total} active`}
            />
          )}
          {bd.playerAcquisition && (
            <Meter
              label="Player Acquisition (15%)"
              score={bd.playerAcquisition.score}
              color="#a855f7"
              detail={`${bd.playerAcquisition.newThisMonth} new this month`}
            />
          )}
          {bd.cashoutVelocity && (
            <Meter
              label="Cashout Velocity (10%)"
              score={bd.cashoutVelocity.score}
              color="var(--text-primary)"
              detail={`${bd.cashoutVelocity.cashouts} outs vs ${bd.cashoutVelocity.buyins} ins`}
            />
          )}
        </div>
      </div>

      {/* Volume Stats */}
      {stats && (
        <div className="admin-card" style={{ marginTop: '24px' }}>
          <h3 className="admin-card-title">
            <span>Recent Activity Volume</span>
            <span style={{ color: '#31A24C', fontSize: '18px' }}>
              Total Vol: {fmtChips(stats.totalVolume)}
            </span>
          </h3>
          <div className="admin-stats-grid">
            {Object.entries(stats.byActionType || {}).map(([type, data]) => (
              <div key={type} className="admin-stat-card">
                <div className="admin-stat-label">{toTitleCase(type)}</div>
                <div className="admin-stat-value">{fmtChips(data.volume)}</div>
                <div className="admin-stat-detail">{fmt(data.count)} Transactions</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 2: SETTLEMENTS
// ═══════════════════════════════════════════════════════════════════════════════
function SettlementsTab({ clubId }: { clubId: string }) {
  return (
    <div className="admin-tab-content">
      <ClubWeeklyAccountingSummary clubId={clubId} />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 3: AUDIT LOG
// ═══════════════════════════════════════════════════════════════════════════════
function AuditLogTab({ clubId }: { clubId: string }) {
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const PAGE_SIZE = 50;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(
    async (p: number) => {
      try {
        setLoading(true);
        setLoadError(null);
        const uuid = await resolveClubUUID(clubId);
        const from = (p - 1) * PAGE_SIZE;
        const to = from + PAGE_SIZE - 1;

        const { data, error, count } = await supabase
          .from('audit_trail')
          .select(
            'id, action, actor_id, target_type, target_id, details:after_state, ip_address, created_at',
            {
              count: 'exact',
            }
          )
          .eq('club_id', uuid)
          .order('created_at', { ascending: false })
          .range(from, to);

        if (error) {
          // Gracefully handle missing table or column
          if (error.code === 'PGRST205' || error.code === '42P01' || error.code === '42703') {
            if (isMounted.current) {
              setLogs([]);
              setTotal(0);
              setLoading(false);
            }
            return;
          }
          throw error;
        }
        if (!isMounted.current) return;

        // Get user profiles for display names
        const userIds = [
          ...new Set((data || []).map((l: AuditLogRow) => l.actor_id).filter(Boolean)),
        ];
        const targetIds = [
          ...new Set((data || []).map((l: AuditLogRow) => l.target_id).filter(Boolean)),
        ];
        const allIds = [...new Set([...userIds, ...targetIds])];

        const profileMap: Record<string, string> = {};
        if (allIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}`)
            .in('id', allIds);
          if (profiles) {
            profiles.forEach((p: ProfileRow) => {
              profileMap[p.id] = playerDisplayName(p);
            });
          }
        }

        if (!isMounted.current) return;
        setLogs(
          (data || []).map((l: AuditLogRow) => ({
            ...l,
            userName:
              (l.actor_id ? profileMap[l.actor_id] : null) ||
              l.actor_id?.substring(0, 8) ||
              'System',
            targetUserName: l.target_id
              ? profileMap[l.target_id] || l.target_id?.substring(0, 8)
              : undefined,
          }))
        );
        setTotal(count || 0);
      } catch (err: unknown) {
        if (isMounted.current) setLoadError(safeErrorMessage(err));
      } finally {
        if (isMounted.current) setLoading(false);
      }
    },
    [clubId]
  );

  useEffect(() => {
    load(page);
  }, [page, load]);

  // ── Realtime: auto-refresh when new audit entries are inserted ──
  useEffect(() => {
    let cancelled = false;
    const setupChannel = async () => {
      const uuid = await resolveClubUUID(clubId);
      if (cancelled) return;
      const channelKey = `audit-log-tab-${clubId}`;
      const channel = masterBus.getOrCreateChannel(channelKey);
      channel
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'audit_trail',
            filter: `club_id=eq.${uuid}`,
          },
          () => {
            // Reload current page to pick up the new entry
            load(page);
          }
        )
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'AdminDashboardPage._Realtime_channel_error');
          }
        });
    };
    setupChannel().catch((e) => console.warn('[AuditLogTab] Realtime setup failed:', e));
    return () => {
      cancelled = true;
      masterBus.removeRegisteredChannel(`audit-log-tab-${clubId}`);
    };
  }, [clubId, page, load]);

  const typeColor = (t: string) => {
    if (t.includes('buyin') || t.includes('distribution')) return '#31A24C';
    if (t.includes('cashout') || t.includes('withdraw')) return '#FA383E';
    if (t.includes('fee') || t.includes('rake')) return '#F7C52A';
    return 'var(--text-primary)';
  };

  if (loading && logs.length === 0)
    return (
      <div className="admin-tab-content">
        {[1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="admin-skeleton" style={{ height: '40px', marginBottom: '8px' }} />
        ))}
      </div>
    );
  if (loadError)
    return (
      <div className="admin-error-state">
        <div className="admin-error-msg">{loadError}</div>
        <button onClick={() => load(page)} className="admin-btn admin-btn-primary">
          ↻ Retry
        </button>
      </div>
    );

  return (
    <div className="admin-tab-content">
      <div className="admin-section-title">
        <h3>Security Audit Trail</h3>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <button
            onClick={async () => {
              try {
                const uuid = await resolveClubUUID(clubId);
                const { data, error } = await supabase
                  .from('audit_trail')
                  .select(
                    'id, action, actor_id, target_type, target_id, details:after_state, ip_address, created_at'
                  )
                  .eq('club_id', uuid)
                  .order('created_at', { ascending: false })
                  .limit(5000);
                if (error) throw error;
                if (!data || data.length === 0) return;
                const headers = Object.keys(data[0]);
                const csv = [
                  headers.join(','),
                  ...data.map((r: Record<string, unknown>) =>
                    headers.map((h) => JSON.stringify(r[h] ?? '')).join(',')
                  ),
                ].join('\n');
                downloadCsv(`audit-log-${clubId.substring(0, 8)}.csv`, csv);
              } catch (e: unknown) {
                reportError(
                  e instanceof Error ? e.message : String(e),
                  'AdminDashboardPage.CSV_export_failed'
                );
              }
            }}
            className="admin-btn admin-btn-ghost admin-btn-sm"
            title="Export Audit Log As CSV"
          >
            Export
          </button>
          <span className="admin-text-secondary" style={{ fontSize: '13px' }}>
            Total: {fmt(total)}
          </span>
          <button
            onClick={() => setPage(Math.max(1, page - 1))}
            disabled={page === 1}
            className="admin-btn admin-btn-ghost admin-btn-sm"
          >
            Prev
          </button>
          <span style={{ fontSize: '14px', fontWeight: 600 }}>
            {page} / {totalPages}
          </span>
          <button
            onClick={() => setPage(Math.min(totalPages, page + 1))}
            disabled={page >= totalPages}
            className="admin-btn admin-btn-ghost admin-btn-sm"
          >
            Next
          </button>
        </div>
      </div>

      {/* SIX COLUMNS OF AUDIT TRAIL ON A 393px PHONE, GONE. One row per entry
          with its fields stacked. `typeColor` still decides the action's
          colour, so a mint still reads as a mint. */}
      <ol className="ac-list">
        {logs.map((l) => (
          <li key={l.id} className="ac-row">
            <span className="ac-row__name" style={{ color: typeColor(l.action || '') }}>
              {toTitleCase(l.action || '')}
            </span>
            <span className="ac-row__meta sc-ink--muted">{formatDate(l.created_at)}</span>
            <dl className="ac-facts">
              <div className="ac-fact">
                <dt className="ac-fact__label sc-label sc-ink--blue">User</dt>
                <dd className="ac-fact__value sc-ink--silver">{l.userName}</dd>
              </div>
              <div className="ac-fact">
                <dt className="ac-fact__label sc-label sc-ink--blue">Target</dt>
                <dd className="ac-fact__value sc-ink--silver">{l.targetUserName || '-'}</dd>
              </div>
              <div className="ac-fact">
                <dt className="ac-fact__label sc-label sc-ink--blue">Amount</dt>
                <dd className="ac-fact__value sc-ink--gold">
                  {(l.details as any)?.amount != null ? fmtChips((l.details as any).amount) : '-'}
                </dd>
              </div>
              <div className="ac-fact">
                <dt className="ac-fact__label sc-label sc-ink--blue">IP Address</dt>
                <dd className="ac-fact__value ac-mono sc-ink--muted">{l.ip_address || '-'}</dd>
              </div>
            </dl>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 4: ANNOUNCEMENTS
// ═══════════════════════════════════════════════════════════════════════════════
function AnnouncementsTab({ clubId }: { clubId: string }) {
  // club_announcements.author_id is NOT NULL with no default and has a foreign
  // key to profiles(id). The insert below never supplied it, so creating an
  // announcement has always been rejected: Save cleared the form, closed the
  // editor and reloaded a list that had not changed. Editing an existing one
  // worked, which is why it read as a save that "sometimes" did nothing.
  const { user } = useAuthUser();
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<any>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const uuid = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('club_announcements')
        .select('id, title, content, pinned:is_pinned, is_active, created_at')
        .eq('club_id', uuid)
        .order('is_pinned', { ascending: false })
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (isMounted.current) setItems(data || []);
    } catch (err: unknown) {
      console.warn('[Announcements]', err instanceof Error ? err.message : String(err));
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    if (!title.trim()) return;
    // An author is required by the table, so refuse with a readable message
    // rather than sending a statement the database will refuse silently.
    if (!editing && !user?.id) {
      setActionError('Your session could not be identified, so this announcement was not saved.');
      return;
    }
    setSaving(true);
    setActionError(null);
    try {
      const uuid = await resolveClubUUID(clubId);
      if (editing) {
        const { error: updErr } = await supabase
          .from('club_announcements')
          .update({ title, content })
          .eq('id', editing.id);
        if (updErr) throw updErr;
      } else {
        const { error: insErr } = await supabase
          .from('club_announcements')
          .insert({ club_id: uuid, title, content, author_id: user!.id });
        if (insErr) throw insErr;
      }
      setTitle('');
      setContent('');
      setEditing(null);
      load();
      masterBus.emit('ANNOUNCEMENT_CHANGED', { clubId, action: 'created' });
    } catch (err: unknown) {
      if (isMounted.current) setActionError(safeErrorMessage(err));
    } finally {
      if (isMounted.current) setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (
      !(await confirmDialog({
        title: 'Delete Announcement',
        message: 'Delete this announcement?',
        confirmText: 'Delete',
        variant: 'danger',
      }))
    )
      return;
    setActionError(null);
    try {
      // SECURITY: Scope to club to prevent cross-club deletion
      let delQuery = supabase.from('club_announcements').delete().eq('id', id);
      if (clubId) delQuery = delQuery.eq('club_id', clubId);
      const { error: delErr } = await delQuery;
      if (delErr) throw delErr;
      load();
      masterBus.emit('ANNOUNCEMENT_CHANGED', { clubId, action: 'deleted' });
    } catch (err: unknown) {
      if (isMounted.current) setActionError(safeErrorMessage(err));
    }
  };

  const handlePin = async (item: Announcement) => {
    try {
      setActionError(null);
      const { error: pinErr } = await supabase
        .from('club_announcements')
        // `pinned` is a SELECT alias for `is_pinned` (see the query above). An
        // alias is a read-side name: writing through it made every Pin and
        // Unpin a rejected statement, so the button did nothing and said nothing.
        .update({ is_pinned: !item.pinned })
        .eq('id', item.id);
      if (pinErr) throw pinErr;
      load();
      masterBus.emit('ANNOUNCEMENT_CHANGED', { clubId, action: 'created' });
    } catch (err: unknown) {
      if (isMounted.current) setActionError(safeErrorMessage(err));
    }
  };

  if (loading)
    return (
      <div className="admin-tab-content">
        {[1, 2, 3].map((i) => (
          <div key={i} className="admin-skeleton" style={{ height: '60px', marginBottom: '8px' }} />
        ))}
      </div>
    );

  return (
    <div className="admin-tab-content">
      <h3 className="admin-card-title">Announcements</h3>
      {actionError && <div className="admin-error-banner">{actionError}</div>}

      {/* Create/Edit Form */}
      <div className="admin-card" style={{ marginBottom: '16px' }}>
        <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '8px' }}>
          {editing ? '✏ Edit Announcement' : 'New Announcement'}
        </div>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="admin-input"
          style={{ marginBottom: '8px' }}
        />
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="Content (Optional)"
          rows={3}
          className="admin-input admin-textarea"
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', justifyContent: 'flex-end' }}>
          {editing && (
            <button
              onClick={() => {
                setEditing(null);
                setTitle('');
                setContent('');
              }}
              className="admin-btn admin-btn-ghost"
            >
              Cancel
            </button>
          )}
          <button
            onClick={handleSave}
            className="admin-btn admin-btn-primary"
            disabled={saving || !title.trim()}
          >
            {saving ? 'Saving...' : editing ? 'Update' : 'Publish'}
          </button>
        </div>
      </div>

      {/* List */}
      {items.length === 0 ? (
        <div className="admin-empty-state">
          <span className="sc-label sc-ink--muted">Nothing Posted</span>
          <span>No Announcements Yet. Create One Above.</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {items.map((a) => (
            <div
              key={a.id}
              className={`admin-card admin-announcement-card ${a.pinned ? 'admin-pinned' : ''}`}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                }}
              >
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>
                    {a.pinned ? '▸ ' : ''}
                    {a.title}
                  </div>
                  {a.content && (
                    <div
                      className="admin-text-secondary"
                      style={{ marginTop: '4px', lineHeight: 1.4, fontSize: '13px' }}
                    >
                      {a.content.substring(0, 300)}
                    </div>
                  )}
                  <div
                    style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '6px' }}
                  >
                    {new Date(a.created_at).toLocaleDateString()}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '4px', flexShrink: 0, marginLeft: '12px' }}>
                  <button
                    onClick={() => handlePin(a)}
                    className="admin-icon-btn"
                    title={a.pinned ? 'Unpin' : 'Pin'}
                  >
                    ▸
                  </button>
                  <button
                    onClick={() => {
                      setEditing(a);
                      setTitle(a.title);
                      setContent(a.content || '');
                    }}
                    className="admin-icon-btn"
                    title="Edit"
                  >
                    ✏
                  </button>
                  <button
                    onClick={() => handleDelete(a.id)}
                    className="admin-icon-btn"
                    title="Delete"
                  >
                    ⊘
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 5: CLUB SETTINGS
// ═══════════════════════════════════════════════════════════════════════════════
function SettingsTab({ clubId }: { clubId: string }) {
  const [settings, setSettings] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    (async () => {
      try {
        const uuid = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('clubs')
          .select('settings')
          .eq('id', uuid)
          .maybeSingle();
        if (isMounted.current) {
          setSettings(data?.settings || {});
          setLoading(false);
        }
      } catch (err) {
        console.warn('[AdminDash/Settings] Load failed:', err);
        if (isMounted.current) setLoading(false);
      }
    })();
  }, [clubId]);

  const save = async () => {
    setProcessing(true);
    setErr(null);
    setMsg(null);
    try {
      const uuid = await resolveClubUUID(clubId);
      const { error } = await supabase.from('clubs').update({ settings }).eq('id', uuid);
      if (error) throw error;
      masterBus.emit('CLUB_UPDATED', { clubId: uuid });
      if (isMounted.current) setMsg('Settings saved!');
    } catch (e: unknown) {
      if (isMounted.current) setErr(safeErrorMessage(e));
    } finally {
      if (isMounted.current) setProcessing(false);
    }
  };

  const toggleField = (key: string) => setSettings((prev) => ({ ...prev, [key]: !prev[key] }));
  const setField = (key: string, val: string | number | boolean) =>
    setSettings((prev) => ({ ...prev, [key]: val }));

  if (loading)
    return (
      <div className="admin-tab-content">
        <div className="admin-skeleton" style={{ height: '300px' }} />
      </div>
    );

  const TOGGLES = [
    { key: 'allow_observer', label: 'Allow Observers' },
    { key: 'show_hand_history', label: 'Show Hand History' },
    { key: 'auto_cashout', label: 'Auto Cashout On Leave' },
    { key: 'require_kyc', label: 'Require KYC For Cashouts' },
    { key: 'gps_verification', label: 'GPS Verification' },
    { key: 'ip_restriction', label: 'IP Restriction' },
    { key: 'emulator_detection', label: 'Emulator Detection' },
  ];

  return (
    <div className="admin-tab-content">
      <h3 className="admin-card-title">Club Settings</h3>
      {msg && <div className="admin-success-banner">{msg}</div>}
      {err && <div className="admin-error-banner">{err}</div>}
      <div className="admin-card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          {TOGGLES.map((t) => (
            <label key={t.key} className="admin-toggle-row">
              <input
                type="checkbox"
                checked={!!settings[t.key]}
                onChange={() => toggleField(t.key)}
                className="admin-checkbox"
              />
              <span>{t.label}</span>
            </label>
          ))}
          <div style={{ marginTop: '8px' }}>
            <label className="admin-label">Default Action Time (Seconds)</label>
            <input
              type="number"
              value={settings.default_action_time || 30}
              onChange={(e) => setField('default_action_time', Number(e.target.value))}
              min={10}
              max={120}
              className="admin-input"
              style={{ width: '120px' }}
            />
          </div>
          <button
            className="admin-btn admin-btn-primary"
            disabled={processing}
            onClick={save}
            style={{ marginTop: '8px' }}
          >
            {processing ? 'Saving...' : 'Save Settings'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 6: HIERARCHY TREE
// ═══════════════════════════════════════════════════════════════════════════════
function HierarchyTab({ clubId }: { clubId: string }) {
  const [tree, setTree] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const uuid = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('club_members')
        .select('user_id, role, parent_agent_id')
        .eq('club_id', uuid)
        .in('role', ['owner', 'co_owner', 'admin', 'super_agent', 'agent', 'sub_agent']);
      if (error) throw error;
      // Batch-fetch profiles (no FK between club_members → profiles)
      const treeData = data || [];
      if (treeData.length > 0) {
        const treeUserIds = treeData.map((m: HierarchyNode) => m.user_id);
        const { data: treeProfiles } = await supabase
          .from('profiles')
          .select(`id, ${PLAYER_NAME_COLUMNS}`)
          .in('id', treeUserIds);
        const treeProfileMap: Record<string, any> = {};
        if (treeProfiles) {
          for (const p of treeProfiles) treeProfileMap[p.id] = p;
        }
        for (const m of treeData) {
          (m as any).profiles = treeProfileMap[(m as any).user_id] || null;
        }
      }
      if (isMounted.current) setTree(treeData);
    } catch (err: unknown) {
      if (isMounted.current) setLoadError(safeErrorMessage(err));
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading)
    return (
      <div className="admin-tab-content">
        <div className="admin-skeleton" style={{ height: '300px' }} />
      </div>
    );
  if (loadError)
    return (
      <div className="admin-error-state">
        <div className="admin-error-msg">{loadError}</div>
        <button onClick={load} className="admin-btn admin-btn-primary">
          ↻ Retry
        </button>
      </div>
    );

  const owners = tree.filter((m: HierarchyMember) => m.role === 'owner');
  const superAgents = tree.filter((m: HierarchyMember) => m.role === 'super_agent');
  const agents = tree.filter((m: HierarchyMember) => m.role === 'agent');
  const subAgents = tree.filter((m: HierarchyMember) => m.role === 'sub_agent');

  const getName = (m: HierarchyMember) =>
    m.profiles ? playerDisplayName(m.profiles) : m.user_id?.substring(0, 8);

  return (
    <div className="admin-tab-content">
      <h3 className="admin-card-title">Agent Hierarchy Tree</h3>
      <div className="admin-card">
        <div style={{ fontSize: '13px', color: 'var(--text-secondary)', marginBottom: '16px' }}>
          {tree.length} Members In Hierarchy
        </div>
        {tree.length === 0 ? (
          <div className="admin-empty-state">
            <span className="sc-label sc-ink--muted">No Hierarchy</span>
            <span>No Agents In Hierarchy Yet.</span>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {owners.map((m) => (
              <div
                key={m.user_id}
                className="admin-hierarchy-node"
                style={{ borderLeft: '3px solid #F7C52A' }}
              >
                <span className="admin-badge admin-badge-yellow">Owner</span> {getName(m)}
              </div>
            ))}
            {superAgents.map((m) => (
              <div
                key={m.user_id}
                className="admin-hierarchy-node"
                style={{ borderLeft: '3px solid #A855F7', marginLeft: '20px' }}
              >
                <span className="admin-badge" style={{ background: '#A855F722', color: '#A855F7' }}>
                  Super
                </span>{' '}
                {getName(m)}
              </div>
            ))}
            {agents.map((m) => (
              <div
                key={m.user_id}
                className="admin-hierarchy-node"
                style={{ borderLeft: '3px solid #4599FF', marginLeft: '40px' }}
              >
                <span className="admin-badge" style={{ background: '#4599FF22', color: '#4599FF' }}>
                  Agent
                </span>{' '}
                {getName(m)}
              </div>
            ))}
            {subAgents.map((m) => (
              <div
                key={m.user_id}
                className="admin-hierarchy-node"
                style={{ borderLeft: '3px solid #65676B', marginLeft: '60px' }}
              >
                <span className="admin-badge">Sub</span> {getName(m)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 7: SETTLEMENT HISTORY
// ═══════════════════════════════════════════════════════════════════════════════
function SettlementHistoryTab({ clubId }: { clubId: string }) {
  const [periods, setPeriods] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const uuid = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('settlement_periods')
        .select('id, club_id, status, start_at, end_at, period_number, year, created_at')
        .eq('club_id', uuid)
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;
      if (isMounted.current) setPeriods(data || []);
    } catch (err) {
      console.warn('[AdminDash/Settlement] Periods load failed:', err);
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading)
    return (
      <div className="admin-tab-content">
        {[1, 2, 3].map((i) => (
          <div key={i} className="admin-skeleton" style={{ height: '60px', marginBottom: '8px' }} />
        ))}
      </div>
    );

  return (
    <div className="admin-tab-content">
      <h3 className="admin-card-title">Settlement History</h3>
      {periods.length === 0 ? (
        <div className="admin-empty-state">
          <span className="sc-label sc-ink--muted">Nothing Settled</span>
          <span>No Settlement Periods Yet.</span>
        </div>
      ) : (
        /* One period per row, fields stacked. Same status words, same three
           colours (open green, closed gold, anything else muted). */
        <ol className="ac-list">
          {periods.map((p: SettlementPeriod) => (
            <li key={p.id} className="ac-row">
              <span className="ac-row__name sc-ink--silver">Period {p.period_number || '-'}</span>
              <span className="ac-row__flags">
                <span
                  className={`sc-label ${
                    p.status === 'open'
                      ? 'sc-ink--green'
                      : p.status === 'closed'
                        ? 'sc-ink--gold'
                        : 'sc-ink--muted'
                  }`}
                >
                  {p.status?.toUpperCase()}
                </span>
              </span>
              <dl className="ac-facts">
                <div className="ac-fact">
                  <dt className="ac-fact__label sc-label sc-ink--blue">Started</dt>
                  <dd className="ac-fact__value sc-ink--silver">{formatDate(p.start_at)}</dd>
                </div>
                <div className="ac-fact">
                  <dt className="ac-fact__label sc-label sc-ink--blue">Ended</dt>
                  <dd className="ac-fact__value sc-ink--silver">
                    {p.end_at ? formatDate(p.end_at) : 'Active'}
                  </dd>
                </div>
                <div className="ac-fact">
                  <dt className="ac-fact__label sc-label sc-ink--blue">Volume</dt>
                  <dd className="ac-fact__value sc-ink--gold">{fmtChips(p.total_volume || 0)}</dd>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 8: BRANDING
// ═══════════════════════════════════════════════════════════════════════════════
function BrandingTab({ clubId }: { clubId: string }) {
  const [theme, setTheme] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    (async () => {
      try {
        const uuid = await resolveClubUUID(clubId);
        const { data } = await supabase
          .from('clubs')
          .select('color_theme')
          .eq('id', uuid)
          .maybeSingle();
        if (isMounted.current) {
          setTheme(data?.color_theme || {});
          setLoading(false);
        }
      } catch (err) {
        console.warn('[AdminDash/Theme] Load failed:', err);
        if (isMounted.current) setLoading(false);
      }
    })();
  }, [clubId]);

  const save = async () => {
    setSaving(true);
    setErr(null);
    setMsg(null);
    try {
      const uuid = await resolveClubUUID(clubId);
      const { error } = await supabase.from('clubs').update({ color_theme: theme }).eq('id', uuid);
      if (error) throw error;
      masterBus.emit('CLUB_UPDATED', { clubId: uuid });
      if (isMounted.current) setMsg('Branding saved!');
    } catch (e: unknown) {
      if (isMounted.current) setErr(safeErrorMessage(e));
    } finally {
      if (isMounted.current) setSaving(false);
    }
  };

  if (loading)
    return (
      <div className="admin-tab-content">
        <div className="admin-skeleton" style={{ height: '300px' }} />
      </div>
    );

  return (
    <div className="admin-tab-content">
      <h3 className="admin-card-title">Club Branding</h3>
      {msg && <div className="admin-success-banner">{msg}</div>}
      {err && <div className="admin-error-banner">{err}</div>}
      <div className="admin-card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
          <div>
            <label className="admin-label">Primary Color</label>
            <input
              type="color"
              value={theme.primaryColor || '#4599FF'}
              onChange={(e) => setTheme((prev) => ({ ...prev, primaryColor: e.target.value }))}
              className="admin-input"
              style={{ width: '60px', height: '40px', padding: '4px' }}
            />
          </div>
          <div>
            <label className="admin-label">Club Banner URL</label>
            <input
              value={theme.bannerUrl || ''}
              onChange={(e) => setTheme((prev) => ({ ...prev, bannerUrl: e.target.value }))}
              placeholder="https://example.com/banner.png"
              className="admin-input"
            />
          </div>
          <div>
            <label className="admin-label">Welcome Message</label>
            <input
              value={theme.welcomeMessage || ''}
              onChange={(e) => setTheme((prev) => ({ ...prev, welcomeMessage: e.target.value }))}
              placeholder="Welcome To Our Club!"
              className="admin-input"
            />
          </div>
          <button
            onClick={save}
            disabled={saving}
            className="admin-btn admin-btn-primary"
            style={{ marginTop: '8px' }}
          >
            {saving ? 'Saving...' : 'Save Branding'}
          </button>
        </div>
      </div>

      {/* Ownership Transfer — Danger Zone */}
      <div
        className="admin-card"
        style={{
          marginTop: '24px',
          borderColor: 'rgba(250,56,62,0.3)',
          background: 'rgba(250,56,62,0.04)',
        }}
      >
        <h4
          style={{
            margin: '0 0 12px',
            fontSize: '15px',
            color: '#FA383E',
          }}
        >
          ⚠ Danger Zone - Transfer Ownership
        </h4>
        <p
          className="admin-text-secondary"
          style={{ fontSize: '12px', marginBottom: '12px', lineHeight: 1.6 }}
        >
          Transfer Complete Ownership Of This Club To Another Member. This Action Is Irreversible -
          You Will Be Demoted To Admin.
        </p>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            id="ownership-target"
            placeholder="New Owner's User ID (UUID)"
            className="admin-input"
            style={{ flex: 1 }}
          />
          <button
            className="admin-btn admin-btn-ghost"
            style={{ color: '#FA383E', borderColor: '#FA383E' }}
            onClick={async () => {
              const target = (document.getElementById('ownership-target') as HTMLInputElement)
                ?.value;
              if (!target) return;
              if (
                !(await confirmDialog({
                  message: `⚠ IRREVERSIBLE: Transfer ownership to ${target.substring(0, 8)}...? You will be demoted to admin.`,
                  variant: 'danger',
                }))
              )
                return;
              if (
                !(await confirmDialog({
                  message: 'Are you absolutely sure? This cannot be undone.',
                  variant: 'danger',
                }))
              )
                return;
              try {
                setErr(null);
                const uuid = await resolveClubUUID(clubId);
                const { error } = await supabase.rpc('transfer_club_ownership', {
                  p_club_id: uuid,
                  p_new_owner_id: target,
                });
                if (error) throw error;
                setMsg('Ownership transferred! Reloading...');
                setTimeout(() => window.location.reload(), 1500);
              } catch (e: unknown) {
                setErr(safeErrorMessage(e, 'Transfer failed. Please try again.'));
              }
            }}
          >
            Transfer
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 9: RECOMMENDATIONS
// ═══════════════════════════════════════════════════════════════════════════════
function RecommendationsTab({ clubId }: { clubId: string }) {
  const [recs, setRecs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();

  useEffect(() => {
    (async () => {
      try {
        const uuid = await resolveClubUUID(clubId);
        // P2-1: union games carry the union container as club_id
        const gamesScope = await clubGamesOrFilter(uuid);
        // Generate recommendations based on club state
        /* `count: 'exact'` removed from both queries 2026-08-26. Neither count was
           ever destructured - only `data` is - and the code below works off
           `mems.length` and `anns.length`. An exact count is not free: PostgREST
           runs a SECOND full scan of the same predicate to produce it, and on
           club_members that scan goes through four RLS policies. It was paying
           twice for a number nothing read. */
        const [{ data: members }, { data: tables }, { data: anns }] = await Promise.all([
          supabase
            .from('club_members')
            .select('user_id, is_active, role, last_active_at')
            .eq('club_id', uuid),
          supabase.from('tables').select('id, current_players, status').or(gamesScope),
          supabase.from('club_announcements').select('id').eq('club_id', uuid),
        ]);
        const mems = members || [];
        const tbls = tables || [];
        const recommendations: Recommendation[] = [];

        // Check player engagement
        const inactive = mems.filter((m: ClubMemberRow) => {
          if (!m.last_active_at) return true;
          return Date.now() - new Date(m.last_active_at).getTime() > 7 * 86400000;
        });
        if (inactive.length > mems.length * 0.3) {
          recommendations.push({
            severity: 'warning',
            title: 'High Inactivity',
            desc: `${inactive.length} of ${mems.length} members inactive for 7+ days. Consider a re-engagement campaign.`,
          });
        }

        // Check table activity
        const activeTbls = tbls.filter(
          (t: TableRow) => t.status === 'active' && (t.current_players || 0) > 0
        );
        if (tbls.length > 0 && activeTbls.length === 0) {
          recommendations.push({
            severity: 'critical',
            title: 'No Active Tables',
            desc: 'All tables are empty. Consider scheduling a game or sending notifications to your players.',
          });
        }

        // Check announcements
        /* Was `annCount === 0 || !annCount?.length`. The first clause was dead:
           the variable holds `data`, which is an array or null, never the number
           0. The length check is the one that was doing the work. */
        if (!anns || anns.length === 0) {
          recommendations.push({
            severity: 'info',
            title: 'No Announcements',
            desc: 'Keep your club engaged with regular announcements about upcoming games and events.',
          });
        }

        // Check agent coverage
        const agentCount = mems.filter((m: ClubMemberRow) =>
          ['agent', 'super_agent', 'sub_agent'].includes(m.role)
        ).length;
        if (mems.length > 20 && agentCount === 0) {
          recommendations.push({
            severity: 'warning',
            title: 'No Agents',
            desc: 'Your club has 20+ members but no agents. Appoint agents to help manage and grow your club.',
          });
        }

        if (recommendations.length === 0) {
          recommendations.push({
            severity: 'success',
            title: 'Looking Good!',
            desc: 'No critical recommendations at this time. Keep up the good work!',
          });
        }

        if (isMounted.current) setRecs(recommendations);
      } catch (err) {
        console.warn('[AdminDash/Recommendations] Load failed:', err);
      } finally {
        if (isMounted.current) setLoading(false);
      }
    })();
  }, [clubId]);

  if (loading)
    return (
      <div className="admin-tab-content">
        <div className="admin-skeleton" style={{ height: '200px' }} />
      </div>
    );

  /* The same four severities, in the master's own inks rather than four hex
     literals: critical red, warning gold, info blue, success green. */
  const sevInk: Record<string, string> = {
    critical: 'sc-ink--red',
    warning: 'sc-ink--gold',
    info: 'sc-ink--blue',
    success: 'sc-ink--green',
  };

  return (
    <div className="admin-tab-content">
      <h3 className="admin-card-title">Smart Recommendations</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {recs.map((r, i) => (
          <div key={i} className="admin-card">
            <div className={`sc-label ${sevInk[r.severity] || 'sc-ink--blue'}`}>{r.severity}</div>
            <div style={{ fontSize: '14px', fontWeight: 700, margin: '4px 0' }}>{r.title}</div>
            <div className="admin-text-secondary" style={{ lineHeight: 1.5 }}>
              {r.desc}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 10: TABLE TEMPLATES
// ═══════════════════════════════════════════════════════════════════════════════
function TemplatesTab({ clubId }: { clubId: string }) {
  const [templates, setTemplates] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const isMounted = useIsMounted();

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setLoadError(null);
      const uuid = await resolveClubUUID(clubId);
      const { data, error } = await supabase
        .from('table_templates')
        .select('id, name, game_type, game_mode, config, club_id, created_at')
        .eq('club_id', uuid)
        .order('created_at', { ascending: false });
      if (error) throw error;
      if (isMounted.current) setTemplates(data || []);
    } catch (err: unknown) {
      if (isMounted.current) setLoadError(safeErrorMessage(err));
    } finally {
      if (isMounted.current) setLoading(false);
    }
  }, [clubId]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading)
    return (
      <div className="admin-tab-content">
        {[1, 2, 3].map((i) => (
          <div key={i} className="admin-skeleton" style={{ height: '60px', marginBottom: '8px' }} />
        ))}
      </div>
    );
  if (loadError)
    return (
      <div className="admin-error-state">
        <div className="admin-error-msg">{loadError}</div>
        <button onClick={load} className="admin-btn admin-btn-primary">
          ↻ Retry
        </button>
      </div>
    );

  return (
    <div className="admin-tab-content">
      <h3 className="admin-card-title">Table Templates</h3>
      {actionError && (
        <div className="admin-error-banner" style={{ marginBottom: '12px' }}>
          {actionError}
          <button
            onClick={() => setActionError(null)}
            style={{
              marginLeft: 8,
              background: 'none',
              border: 'none',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            ✕
          </button>
        </div>
      )}
      {templates.length === 0 ? (
        <div className="admin-empty-state">
          <span className="sc-label sc-ink--muted">No Templates</span>
          <span>No Table Templates Yet. Create Tables From The Lobby To Save Templates.</span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {templates.map((tmpl: TableTemplate) => (
            <div key={tmpl.id} className="admin-card">
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: '14px' }}>{tmpl.name || 'Template'}</div>
                  <div className="admin-text-secondary" style={{ fontSize: '12px' }}>
                    {tmpl.game_type || 'NLH'} • {tmpl.small_blind}/{tmpl.big_blind} •{' '}
                    {tmpl.max_players || 9} Seats
                    {tmpl.schedule_enabled && ' • Scheduled'}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  <button
                    onClick={async () => {
                      setActionError(null);
                      try {
                        /**
                         * LAUNCH COPIES THE WHOLE ROW (2026-08-25).
                         *
                         * This used to hand-copy EIGHT fields out of a row with
                         * over a hundred columns, so every rule the host had
                         * configured on the template - straddle, bomb pots,
                         * ante, insurance, run it twice, cap, no-rathole,
                         * VIP-only, all of it - was silently discarded. A
                         * launched template was a plain table wearing the
                         * template's name.
                         *
                         * fn_launch_table_from_template copies the row and
                         * overrides only identity and live state, so a column
                         * added tomorrow is carried without anyone remembering
                         * to add it here. It also checks club staff itself,
                         * which the client-side insert never could.
                         */
                        const { data: newId, error: insErr } = await supabase.rpc(
                          'fn_launch_table_from_template',
                          { p_template_id: tmpl.id }
                        );
                        if (insErr) throw insErr;
                        masterBus.emit('TABLE_CREATED', {
                          tableId: (newId as string) || '',
                          clubId,
                        });
                      } catch (e: unknown) {
                        setActionError(`Launch failed: ${safeErrorMessage(e)}`);
                      }
                    }}
                    className="admin-btn admin-btn-success admin-btn-sm"
                  >
                    Launch
                  </button>
                  <button
                    onClick={async () => {
                      if (
                        !(await confirmDialog({
                          title: 'Delete Template',
                          message: `Delete template "${tmpl.name}"?`,
                          confirmText: 'Delete',
                          variant: 'danger',
                        }))
                      )
                        return;
                      setActionError(null);
                      try {
                        const { error: delErr } = await supabase
                          .from('table_templates')
                          .delete()
                          .eq('id', tmpl.id);
                        if (delErr) throw delErr;
                        load();
                      } catch (e: unknown) {
                        setActionError(`Delete failed: ${safeErrorMessage(e)}`);
                      }
                    }}
                    className="admin-btn admin-btn-danger admin-btn-sm"
                  >
                    ⊘
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 11: ANALYTICS
// ═══════════════════════════════════════════════════════════════════════════════
function AnalyticsTab({ clubId }: { clubId: string }) {
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const isMounted = useIsMounted();

  useEffect(() => {
    (async () => {
      try {
        const uuid = await resolveClubUUID(clubId);
        // P2-1: union games carry the union container as club_id
        const gamesScope = await clubGamesOrFilter(uuid);
        const [{ data: _members, count: memberCount }, { data: tables }, { data: sessions }] =
          await Promise.all([
            supabase
              .from('club_members')
              .select('user_id, created_at, role', { count: 'exact' })
              .eq('club_id', uuid),
            supabase
              .from('tables')
              .select('id, current_players, status, total_hands_dealt:hands_dealt')
              .or(gamesScope),
            supabase
              .from('player_sessions')
              .select('total_hands, net_result, duration_minutes')
              .eq('club_id', uuid)
              .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString()),
          ]);

        const tbls = tables || [];
        const sess = sessions || [];
        const totalHands = tbls.reduce(
          (s: number, t: TableRow) => s + (t.total_hands_dealt || 0),
          0
        );
        const totalSessionHands = sess.reduce(
          (s: number, se: SessionRow) => s + (se.total_hands || 0),
          0
        );
        const avgDuration =
          sess.length > 0
            ? Math.round(
                sess.reduce((s: number, se: SessionRow) => s + (se.duration_minutes || 0), 0) /
                  sess.length
              )
            : 0;

        if (isMounted.current)
          setData({
            totalMembers: memberCount || 0,
            totalTables: tbls.length,
            activeTables: tbls.filter((t: TableRow) => t.status === 'active').length,
            totalHandsDealt: totalHands,
            weeklyHands: totalSessionHands,
            weeklySessions: sess.length,
            avgSessionMinutes: avgDuration,
          });
      } catch (err) {
        console.warn('[AdminDash/Analytics] Load failed:', err);
      } finally {
        if (isMounted.current) setLoading(false);
      }
    })();
  }, [clubId]);

  if (loading)
    return (
      <div className="admin-tab-content">
        <div className="admin-skeleton" style={{ height: '300px' }} />
      </div>
    );
  if (!data) return null;

  return (
    <div className="admin-tab-content">
      <h3 className="admin-card-title">Club Analytics</h3>
      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <div className="admin-stat-label">Total Members</div>
          <div className="admin-stat-value" style={{ color: '#4599FF' }}>
            {fmt(data.totalMembers)}
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Total Tables</div>
          <div className="admin-stat-value">{fmt(data.totalTables)}</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Active Tables</div>
          <div className="admin-stat-value" style={{ color: '#31A24C' }}>
            {fmt(data.activeTables)}
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Total Hands Dealt</div>
          <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
            {fmt(data.totalHandsDealt)}
          </div>
        </div>
      </div>
      <h4 className="admin-card-title" style={{ marginTop: '24px' }}>
        Last 7 Days
      </h4>
      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <div className="admin-stat-label">Weekly Hands</div>
          <div className="admin-stat-value" style={{ color: '#4599FF' }}>
            {fmt(data.weeklyHands)}
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Sessions</div>
          <div className="admin-stat-value">{fmt(data.weeklySessions)}</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Avg Duration</div>
          <div className="admin-stat-value">{data.avgSessionMinutes}m</div>
        </div>
      </div>
      <CardSlideAdoption />
    </div>
  );
}

/**
 * CARD SLIDE ADOPTION — the corner peel, measured (Dan 2026-09-05).
 *
 * Two questions and no more: do players turn it on, and once on do they
 * finish the gesture. The commit threshold was chosen by feel, so the ABANDON
 * share is the one number that can say the feel was wrong.
 *
 * PLATFORM-WIDE, not club-scoped, because a table setting is: the same player
 * carries it into every club they sit in. Aggregates only - fn_card_slide_
 * adoption cannot return a per-user row, so this panel can say whether the
 * feature works and can never say what one player did with their cards.
 */
function CardSlideAdoption() {
  const [row, setRow] = useState<{
    users_with_setting_on: number;
    users_with_setting_off: number;
    active_users: number;
    peels_started: number;
    peels_committed: number;
    peels_abandoned: number;
    keyboard_opens: number;
    commit_rate: number | null;
  } | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error' | 'not-entitled'>('loading');
  const isMounted = useIsMounted();

  useEffect(() => {
    (async () => {
      try {
        const { data, error } = await supabase.rpc('fn_card_slide_adoption', { p_days: 7 });
        if (!isMounted.current) return;
        if (error) throw error;
        const first = Array.isArray(data) ? data[0] : data;
        /*
         * NO ROW IS NOT AN ERROR. fn_card_slide_adoption returns an empty set
         * to anyone who is not a PLATFORM admin, and this tab belongs to CLUB
         * admins - 3 of 1310 profiles carry the platform role, so the other
         * 1307 were being shown "Usage Could Not Be Read" for a panel that was
         * simply not theirs. A club owner reading that reasonably files a bug.
         * Say nothing instead.
         */
        if (!first) {
          setState('not-entitled');
          return;
        }
        setRow(first);
        setState('ready');
      } catch {
        if (isMounted.current) setState('error');
      }
    })();
  }, [isMounted]);

  // Nothing to say while loading, and nothing to say to someone the readout
  // is not for.
  if (state === 'loading' || state === 'not-entitled') return null;
  if (state === 'error' || !row) {
    return (
      <>
        <h4 className="admin-card-title" style={{ marginTop: '24px' }}>
          Card Slide
        </h4>
        <div className="admin-stat-label">Usage Could Not Be Read.</div>
      </>
    );
  }

  const on = Number(row.users_with_setting_on) || 0;
  const off = Number(row.users_with_setting_off) || 0;
  const started = Number(row.peels_started) || 0;
  const adoption = on + off > 0 ? Math.round((on / (on + off)) * 100) : 0;
  const rate = row.commit_rate == null ? null : Number(row.commit_rate);

  return (
    <>
      <h4 className="admin-card-title" style={{ marginTop: '24px' }}>
        Card Slide - Last 7 Days
      </h4>
      <div className="admin-stats-grid">
        <div className="admin-stat-card">
          <div className="admin-stat-label">Players With It On</div>
          <div className="admin-stat-value" style={{ color: '#4599FF' }}>
            {fmt(on)}
          </div>
          <div className="admin-stat-label">{adoption}% Of Players</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Players Peeling</div>
          <div className="admin-stat-value">{fmt(Number(row.active_users) || 0)}</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Peels Started</div>
          <div className="admin-stat-value">{fmt(started)}</div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Completed</div>
          {/* Under half of peels finishing means the threshold is too far. */}
          <div
            className="admin-stat-value"
            style={{ color: rate == null ? undefined : rate >= 50 ? '#31A24C' : '#F7C52A' }}
          >
            {rate == null ? '-' : `${rate}%`}
          </div>
          <div className="admin-stat-label">
            {fmt(Number(row.peels_abandoned) || 0)} Dropped Early
          </div>
        </div>
        <div className="admin-stat-card">
          <div className="admin-stat-label">Opened By Keyboard</div>
          <div className="admin-stat-value">{fmt(Number(row.keyboard_opens) || 0)}</div>
        </div>
      </div>
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// TAB 12: MINT CHIPS
// ═══════════════════════════════════════════════════════════════════════════════
function MintChipsTab({ clubId }: { clubId: string }) {
  const { user } = useAuthUser();
  const [amount, setAmount] = useState('');
  const [notes, setNotes] = useState('');
  const [processing, setProcessing] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="admin-tab-content">
      <div className="admin-card">
        <div style={{ fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
          Mint Chips To Treasury
        </div>
        <div className="admin-text-secondary" style={{ marginBottom: '16px', lineHeight: 1.5 }}>
          Create New Chips And Add Them To The Club Treasury. Subject To Daily Limits.
        </div>
        {msg && (
          <div className="admin-success-banner" style={{ marginBottom: '12px' }}>
            {msg}
          </div>
        )}
        {err && (
          <div className="admin-error-banner" style={{ marginBottom: '12px' }}>
            {err}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div>
            <label className="admin-label">Amount</label>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0"
              min={1}
              className="admin-input"
            />
          </div>
          <div>
            <label className="admin-label">Notes (Optional)</label>
            <input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Reason For Minting..."
              className="admin-input"
            />
          </div>
          <button
            className="admin-btn admin-btn-primary"
            disabled={processing || !amount}
            style={{ marginTop: '4px' }}
            onClick={async () => {
              setProcessing(true);
              setErr(null);
              setMsg(null);
              try {
                const uuid = await resolveClubUUID(clubId);
                const mintAmount = Number(amount);
                if (isNaN(mintAmount) || mintAmount <= 0) {
                  setErr('Enter a valid chip amount');
                  setProcessing(false);
                  return;
                }
                // Mint SERVER-SIDE. `mint_club_chips` is service_role-only, so this
                // direct browser rpc() returned 42501 and the admin Mint button
                // could never work. The route derives the minter from the JWT and
                // enforces authorization, economy caps, settlement lock and audit.
                await callClubArenaApi('mint-chips', {
                  clubId: uuid,
                  amount: mintAmount,
                  notes: notes || undefined,
                });
                setMsg(`Minted ${fmtChips(mintAmount)} chips to treasury!`);
                masterBus.emit('CHIPS_DISTRIBUTED', { clubId });
                setAmount('');
                setNotes('');
              } catch (e: unknown) {
                setErr(safeErrorMessage(e));
              } finally {
                setProcessing(false);
              }
            }}
          >
            {processing ? 'Minting...' : `Mint ${amount ? fmtChips(Number(amount)) : '0'} Chips`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function AdminDashboardPage() {
  useEffect(() => {
    document.title = 'Admin Dashboard | Smarter Poker';
  }, []);

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();

  const [clubId, setClubId] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<AdminTab>('dashboard');
  const isMounted = useIsMounted();

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      if (!user?.id) return;

      try {
        /* The param is RESOLVED now (slug or 6-digit code both work, and the
           result is the UUID the role check below compares against) — it used
           to be used raw, so a slug reached `.eq('club_id', <slug>)` and
           raised 22P02 rather than denying access cleanly.

           The auto-discovery keeps its role filter, because picking a club
           where this operator is an ordinary member would hand them a page
           their own role check then refuses. Only the CHOICE changed: it was
           `mems[0]` on a query with no ORDER BY, so an operator working two
           clubs got whichever row Postgres returned first and that could
           change under them. Now the club they were last in wins. */
        const qClub = searchParams.get('club') || searchParams.get('clubId');
        let targetClub = qClub
          ? await resolvePageClubId({ routeClubId: qClub, allowFallback: false })
          : null;

        /* A club that was NAMED and could not be resolved is a bad link, not
           an invitation to pick a different club. Falling into the discovery
           below would render another club's operations centre under the URL
           of the one that was asked for - the substitution the resolver
           exists to end. */
        if (qClub && !targetClub) {
          if (!cancelled) setError('That Club Could Not Be Found.');
          return;
        }

        if (!targetClub) {
          const { data: mems } = await supabase
            .from('club_members')
            .select('club_id, role')
            .eq('user_id', user.id)
            .in('role', ['owner', 'co_owner', 'admin', 'manager'])
            .order('joined_at', { ascending: true });
          targetClub = pickPreferredClubId((mems || []).map((m) => m.club_id));
        }

        if (targetClub && !cancelled) {
          setClubId(targetClub);
          // Verify role
          const { data: memRole } = await supabase
            .from('club_members')
            .select('role')
            .eq('club_id', targetClub)
            .eq('user_id', user.id)
            .maybeSingle();

          if (memRole) {
            setRole(memRole.role);
            if (!['owner', 'co_owner', 'admin', 'manager'].includes(memRole.role)) {
              setError(
                'ACCESS DENIED: Operations center requires Club Owner, Admin, or Manager privileges.'
              );
            }
          } else {
            setError('ACCESS DENIED: Not a member of this club.');
          }
        } else if (!cancelled) {
          setError('No club found or selected.');
        }
      } catch (err: unknown) {
        if (!cancelled) setError(safeErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    init();
    return () => {
      cancelled = true;
    };
  }, [user?.id, searchParams]);

  if (loading) {
    return (
      <StandardContentLayout className="admin-console-page">
        <SpadeConsole
          className="admin-console"
          aria-busy
          eyebrow="Club Arena"
          title="Admin And Operations"
          pill="Loading"
          pillInk="muted"
          foot="foot"
        >
          <div className="admin-skeleton" style={{ height: '48px', marginBottom: '16px' }} />
          <div className="admin-skeleton" style={{ height: '220px' }} />
        </SpadeConsole>
      </StandardContentLayout>
    );
  }

  if (error) {
    return (
      <StandardContentLayout className="admin-console-page">
        <SpadeConsole
          className="admin-console"
          eyebrow="Club Arena"
          title="Admin And Operations"
          pill="Denied"
          pillInk="red"
          foot="foot"
        >
          <div className="ac-empty">
            <span className="sc-label sc-ink--red">Access</span>
            <p className="sc-copy sc-copy--center">{error}</p>
            <button type="button" className="ac-word sc-ink--blue" onClick={() => navigate('/')}>
              Back To Lobby
            </button>
          </div>
        </SpadeConsole>
      </StandardContentLayout>
    );
  }

  if (!clubId) return null;

  const isOwner = role === 'owner';
  const isAdmin = ['owner', 'co_owner', 'admin'].includes(role || '');

  /* THE TWELVE TABS, IN THE SAME ORDER, BEHIND THE SAME ROLE GATES. They were
     a scrolling rail of filled pills; they are lit words cut into the glass
     now. The gear glyphs on the title and the Settings tab are gone: an
     emblem is painted in the master or it is not there. */
  const tabs: { key: AdminTab; label: string; show: boolean }[] = [
    { key: 'dashboard', label: 'Health', show: true },
    { key: 'hierarchy', label: 'Hierarchy', show: true },
    { key: 'settlements', label: 'Settlements', show: isAdmin },
    { key: 'history', label: 'History', show: isAdmin },
    { key: 'audit', label: 'Audit', show: isAdmin },
    { key: 'branding', label: 'Branding', show: isAdmin },
    { key: 'recommendations', label: 'Recs', show: isAdmin },
    { key: 'announcements', label: 'Announce', show: isAdmin },
    { key: 'templates', label: 'Templates', show: isAdmin },
    { key: 'analytics', label: 'Analytics', show: isAdmin },
    { key: 'mint', label: 'Mint', show: isOwner },
    { key: 'settings', label: 'Settings', show: isOwner },
  ];

  return (
    <StandardContentLayout className="admin-console-page">
      {/* ── The head: the operations centre's own frame ───────────────── */}
      <SpadeConsole
        className="admin-console"
        eyebrow="Club Arena"
        title="Admin And Operations"
        pill={role ? toTitleCase(role) : undefined}
        pillInk="blue"
        foot="foot"
      >
        <nav className="ac-rail" role="tablist" aria-label="Operations Views">
          {tabs
            .filter((t) => t.show)
            .map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={activeTab === t.key}
                className={`ac-rail__word ${
                  activeTab === t.key ? 'sc-ink--silver' : 'sc-ink--muted'
                }`}
                onClick={() => setActiveTab(t.key)}
              >
                {t.label}
              </button>
            ))}
        </nav>
        {/* ONE ACTION, SO NO PLATES: the foot paints both or neither. */}
        <button type="button" className="ac-word sc-ink--blue" onClick={() => navigate('/')}>
          Lobby
        </button>
      </SpadeConsole>

      <div className="admin-container">
        {/* Tab Content */}
        {activeTab === 'dashboard' && <DashboardTab clubId={clubId} />}
        {activeTab === 'hierarchy' && <HierarchyTab clubId={clubId} />}
        {activeTab === 'settlements' && <SettlementsTab clubId={clubId} />}
        {activeTab === 'history' && <SettlementHistoryTab clubId={clubId} />}
        {activeTab === 'audit' && (
          <>
            <AuditLogTab clubId={clubId} />
            <div style={{ marginTop: '24px' }}>
              <h3 style={{ color: 'var(--text-primary)', marginBottom: '12px' }}>
                Live Activity Stream
              </h3>
              <ArenaLedger clubId={clubId} maxEntries={100} />
            </div>
          </>
        )}
        {activeTab === 'branding' && <BrandingTab clubId={clubId} />}
        {activeTab === 'recommendations' && <RecommendationsTab clubId={clubId} />}
        {activeTab === 'announcements' && <AnnouncementsTab clubId={clubId} />}
        {activeTab === 'templates' && <TemplatesTab clubId={clubId} />}
        {activeTab === 'analytics' && (
          <>
            <AnalyticsTab clubId={clubId} />
            <div style={{ marginTop: '24px' }}>
              <h3 style={{ color: 'var(--text-primary)', marginBottom: '12px' }}>
                Table Heatmap - God View
              </h3>
              <AdminTableHeatmap
                clubId={clubId}
                onAction={(payload) => {
                  if (payload.action === 'manage' && payload.table.id) {
                    navigate(`/table/${payload.table.id}`);
                  }
                }}
              />
            </div>
          </>
        )}
        {activeTab === 'mint' && <MintChipsTab clubId={clubId} />}
        {activeTab === 'settings' && <SettingsTab clubId={clubId} />}
      </div>
    </StandardContentLayout>
  );
}
