/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINANCIAL ADMIN HUB — Single-Pane-of-Glass Financial Operations
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Central admin page consolidating all financial management tools.
 *  Quick links to: Alerts, Health, Disputes, Rate Audit, Settlements, Financials.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { useToast } from '../components/common/Toast';
import { ResponsiveContainer, AreaChart, Area, XAxis } from 'recharts';
import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import UnionOpsPanel from '../components/union/UnionOpsPanel';
import { unionService } from '../services/UnionService';
import { clubScoped, useFinancialAdminScope } from '../hooks/useFinancialAdminScope';
import { SpadeConsole } from '../components/console/SpadeConsole';
import { compactChips } from '../utils/format';
import { titleCase } from '../utils/titleCase';
import './AdminDashboardPage.css';
import styles from './FinancialAdminHub.module.css';

interface HubStats {
  totalAlerts: number;
  openIncidents: number;
  openDisputes: number;
  rateChanges: number;
  healthChecks: number;
  lastCheckPassed: boolean | null;
}

interface HubReading {
  stats: HubStats;
  revenue: { day: string; amount: number }[];
  windowStart: string;
  windowEnd: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/* staffOnly: shown to platform staff only (scope.isPlatformStaff); the route
   behind it is closed by PlatformStaffGuard and every door checks again. */
const NAV_ITEMS: Array<{
  label: string;
  description: string;
  path: string;
  tone: 'blue' | 'red' | 'gold' | 'silver';
  staffOnly?: boolean;
}> = [
  {
    label: 'Diamond Staff Desk',
    description: 'Diamond Games, Incidents, Books And Adjustments',
    path: '/diamond-staff-desk',
    tone: 'blue',
    staffOnly: true,
  },
  {
    label: 'Financial Alerts',
    description: 'Critical Warnings And System Notifications',
    path: '/financial-alerts',
    tone: 'red',
  },
  {
    label: 'Drift Incidents',
    description: 'Ledger Drift Detection And 20-Minute Reconciliation Queue',
    path: '/financial-incidents',
    tone: 'red',
  },
  {
    label: 'System Health',
    description: 'Ledger Reconciliation & Cron Status',
    path: '/financial-health',
    tone: 'blue',
  },
  {
    label: 'Disputes',
    description: 'Open Disputes Needing Resolution',
    path: '/disputes',
    tone: 'gold',
  },
  {
    label: 'Rate Audit Trail',
    description: 'Commission & Rake Rate Change History',
    path: '/rate-audit',
    tone: 'silver',
  },
  {
    label: 'Agent Portal',
    description: 'Triple Wallet, Credit Lines, Commissions',
    path: '/agent-portal',
    tone: 'blue',
  },
  {
    label: 'Rakeback Dashboard',
    description: 'Player Rakeback Tiers & Pending Payouts',
    path: '/rakeback',
    tone: 'silver',
  },
  {
    label: 'Credit Admin',
    description: 'Set & Adjust Agent Credit Limits',
    path: '/credit-admin',
    tone: 'gold',
  },
  {
    label: 'Settlement History',
    description: 'Weekly Settlement Cycles & Revenue Trends',
    path: '/settlement-history',
    tone: 'blue',
  },
  {
    label: 'Settlement Center',
    description: 'Canary Checks, Payout Execution & Monitoring',
    path: '/settlement-dashboard',
    tone: 'silver',
  },
  {
    label: 'Settlements',
    description: 'Club & Agent Settlement Management',
    path: '/wallet',
    tone: 'blue',
  },
  {
    label: 'CSV Exports',
    description: 'Financial Reports & Data Exports',
    path: '/wallet',
    tone: 'silver',
  },
];

export default function FinancialAdminHub() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const isMounted = useIsMounted();

  const [reading, setReading] = useState<HubReading | null>(null);
  const [loadedStatsScope, setLoadedStatsScope] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [visibleCards, setVisibleCards] = useState<Set<number>>(new Set());
  const [visibleNavs, setVisibleNavs] = useState<Set<number>>(new Set());
  const statsRequest = useRef(0);
  /* WHOSE MONEY (2026-09-10). rake_records was read with a 7-day filter and
     no club, so the revenue chart summed every club's rake RLS let the viewer
     see into one operator's dashboard; disputes and the two rate-audit counts
     had the same shape. The scope names the club (or the platform, for
     platform staff) and every club-keyed read below is filtered to it. */
  const scope = useFinancialAdminScope();
  const scopeStatus = scope.status;
  const scopeClubId = scope.clubId;
  const scopePlatformWide = scope.platformWide;
  const statsScope = `${user?.id || ''}:${scopeStatus}:${scopeClubId || ''}:${scopePlatformWide}`;
  const statsScopeRef = useRef(statsScope);
  statsScopeRef.current = statsScope;
  const ownsStats = loadedStatsScope === statsScope;
  const stats = ownsStats ? (reading?.stats ?? null) : null;
  const revenueData = ownsStats ? (reading?.revenue ?? []) : [];

  /* WHICH UNION (2026-09-24). The union operations panel below was rendered
     with no union and fell back to one hardcoded union (Midway), so this hub
     previewed, settled and swept that union's books whatever the staff member
     meant. The union is now chosen here, from the unions this viewer can
     read, and until one is chosen no panel exists to run anything. */
  const [unionOptions, setUnionOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [unionOptionsStatus, setUnionOptionsStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading'
  );
  const [selectedUnionId, setSelectedUnionId] = useState('');
  const selectedUnion = unionOptions.find((u) => u.id === selectedUnionId) ?? null;
  const unionRequest = useRef(0);

  const loadUnionOptions = useCallback(async () => {
    const viewerId = user?.id;
    const requestScope = statsScope;
    const request = ++unionRequest.current;
    const isCurrent = () =>
      isMounted.current &&
      request === unionRequest.current &&
      statsScopeRef.current === requestScope;
    if (!viewerId || scopeStatus !== 'ready' || scope.userId !== viewerId) return;
    setUnionOptionsStatus('loading');
    setUnionOptions([]);
    setSelectedUnionId('');
    try {
      const unions = await unionService.getUnions();
      if (!isCurrent()) return;
      setUnionOptions(
        unions.map((u) => ({ id: u.id, name: u.name })).sort((a, b) => a.name.localeCompare(b.name))
      );
      setUnionOptionsStatus('ready');
    } catch (e) {
      reportError(e, 'FinancialAdminHub.loadUnionOptions');
      if (isCurrent()) setUnionOptionsStatus('error');
    }
  }, [isMounted, scope.userId, scopeStatus, statsScope, user?.id]);

  useEffect(() => {
    unionRequest.current += 1;
    setUnionOptions([]);
    setSelectedUnionId('');
    setUnionOptionsStatus(scopeStatus === 'ready' ? 'loading' : 'error');
  }, [statsScope, scopeStatus]);

  useEffect(() => {
    if (scopeStatus === 'ready') void loadUnionOptions();
  }, [scopeStatus, loadUnionOptions]);

  // Every result belongs to one signed-in viewer, one club scope and one
  // captured seven-day window. A failed source fails the reading; it never
  // becomes a plausible zero or a false all-clear.
  const loadStats = useCallback(async () => {
    const viewerId = user?.id;
    if (!viewerId || scopeStatus !== 'ready' || scope.userId !== viewerId) return;
    const requestScope = statsScope;
    const request = ++statsRequest.current;
    const isCurrent = () =>
      isMounted.current &&
      request === statsRequest.current &&
      statsScopeRef.current === requestScope;
    const windowEnd = new Date();
    const windowStart = new Date(windowEnd.getTime() - 7 * 86400000);
    setLoading(true);
    setStatsError(null);
    setReading(null);
    setLoadedStatsScope(null);
    const scopeKey = { status: scopeStatus, clubId: scopeClubId, platformWide: scopePlatformWide };
    try {
      const [
        disputeResult,
        commResult,
        rakeResult,
        healthCountResult,
        alertResult,
        incidentResult,
        lastCheckResult,
        rakeDataResult,
      ] = await Promise.all([
        clubScoped(
          supabase
            .from('disputes')
            .select('*', { count: 'exact', head: true })
            .in('status', ['open', 'under_review', 'escalated']),
          /* error bound by disputeResult below */
          scopeKey
        ),
        clubScoped(
          supabase.from('commission_rate_audit').select('*', { count: 'exact', head: true }),
          /* error bound by commResult below */
          scopeKey
        ),
        clubScoped(
          supabase.from('rake_rate_audit').select('*', { count: 'exact', head: true }),
          /* error bound by rakeResult below */
          scopeKey
        ),
        supabase.from('financial_health_checks').select('*', { count: 'exact', head: true }),
        supabase
          .from('financial_alerts')
          .select('*', { count: 'exact', head: true })
          .eq('resolved', false),
        supabase.rpc('fn_ca_incident_dashboard', { p_status: null, p_limit: 500 }),
        supabase
          .from('financial_health_checks')
          .select('passed')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        clubScoped(
          supabase
            .from('rake_records')
            .select('rake_amount, created_at')
            .gte('created_at', windowStart.toISOString())
            .lte('created_at', windowEnd.toISOString()),
          /* error bound by rakeDataResult below */
          scopeKey
        )
          .order('created_at', { ascending: true })
          .limit(5000),
      ]);
      const named = [
        ['Disputes', disputeResult],
        ['Commission Rates', commResult],
        ['Rake Rates', rakeResult],
        ['Health Checks', healthCountResult],
        ['Financial Alerts', alertResult],
        ['Drift Incidents', incidentResult],
        ['Latest Health Check', lastCheckResult],
        ['Revenue', rakeDataResult],
      ] as const;
      for (const [name, result] of named) {
        if (result.error) throw new Error(`${name} Could Not Be Read`);
      }
      for (const [name, result] of [
        ['Disputes', disputeResult],
        ['Commission Rates', commResult],
        ['Rake Rates', rakeResult],
        ['Health Checks', healthCountResult],
        ['Financial Alerts', alertResult],
      ] as const) {
        if (
          typeof result.count !== 'number' ||
          !Number.isInteger(result.count) ||
          result.count < 0
        ) {
          throw new Error(`${name} Count Was Not Returned`);
        }
      }
      if (!Array.isArray(incidentResult.data)) throw new Error('Drift Incidents Were Not Returned');
      if (!Array.isArray(rakeDataResult.data)) throw new Error('Revenue Rows Were Not Returned');
      const incidents = incidentResult.data;
      if (
        incidents.some(
          (incident) =>
            !isRecord(incident) ||
            typeof incident.status !== 'string' ||
            (incident.club_id != null && typeof incident.club_id !== 'string')
        )
      ) {
        throw new Error('Drift Incidents Could Not Be Verified');
      }
      const verifiedIncidents = incidents as Array<{ status: string; club_id: string | null }>;
      const latestHealth = lastCheckResult.data;
      if (
        latestHealth != null &&
        (!isRecord(latestHealth) || typeof latestHealth.passed !== 'boolean')
      ) {
        throw new Error('Latest Health Check Could Not Be Verified');
      }
      const latestHealthPassed = latestHealth == null ? null : (latestHealth.passed as boolean);
      if (!isCurrent()) return;

      // Process revenue sparkline
      const revenue: { day: string; amount: number }[] = [];
      const rakeRows = rakeDataResult.data;
      if (rakeRows.length > 0) {
        const dayLabels = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
        const grouped: Record<string, number> = {};
        rakeRows.forEach((row) => {
          if (!isRecord(row)) throw new Error('Revenue Row Could Not Be Verified');
          const createdAt = typeof row.created_at === 'string' ? Date.parse(row.created_at) : NaN;
          const d = new Date(createdAt);
          const rakeAmount = Number(row.rake_amount);
          if (
            row.rake_amount === null ||
            row.rake_amount === undefined ||
            !Number.isFinite(rakeAmount) ||
            !Number.isFinite(createdAt)
          )
            throw new Error('Revenue Amount Could Not Be Verified');
          const label = `${dayLabels[d.getDay()]} ${d.getDate()}`;
          grouped[label] = (grouped[label] || 0) + rakeAmount;
        });
        for (let i = 6; i >= 0; i--) {
          const d = new Date(windowEnd.getTime() - i * 86400000);
          const label = `${dayLabels[d.getDay()]} ${d.getDate()}`;
          revenue.push({ day: label, amount: grouped[label] || 0 });
        }
      }
      setReading({
        stats: {
          totalAlerts: alertResult.count!,
          openIncidents: verifiedIncidents.filter(
            (incident) =>
              incident?.status !== 'resolved' &&
              (scopePlatformWide || incident?.club_id === scopeClubId)
          ).length,
          openDisputes: disputeResult.count!,
          rateChanges: commResult.count! + rakeResult.count!,
          healthChecks: healthCountResult.count!,
          lastCheckPassed: latestHealthPassed,
        },
        revenue,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
      });
      setLoadedStatsScope(requestScope);
      setStatsError(null);
    } catch (err) {
      reportError(err, 'FinancialAdminHub.Stats_load_failed');
      if (isCurrent()) {
        setStatsError('Financial Status Could Not Be Verified. No All Clear Is Being Shown.');
        setReading(null);
        setLoadedStatsScope(requestScope);
        toast.error('Failed to load financial stats');
      }
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [
    isMounted,
    scope.userId,
    scopeStatus,
    scopeClubId,
    scopePlatformWide,
    statsScope,
    toast,
    user?.id,
  ]);

  useVisibilityRefresh(loadStats);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  // Bus listeners: refresh stats when financial events fire
  useEffect(() => {
    const unsubBalance = masterBus.subscribeDebounced('BALANCE_UPDATED', loadStats, 1000);
    const unsubAlert = masterBus.subscribeDebounced('FINANCIAL_ALERT', loadStats, 500);
    return () => {
      unsubBalance();
      unsubAlert();
    };
  }, [loadStats]);

  // Real-time subscription: disputes table changes
  useEffect(() => {
    const channelKey = 'financial-admin-hub-disputes';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('postgres_changes', { event: '*', schema: 'public', table: 'disputes' }, loadStats)
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'FinancialAdminHub._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[FinancialAdminHub] Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [loadStats]);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    setVisibleCards(new Set());
    [0, 1, 2, 3, 4].forEach((i) => {
      timers.push(setTimeout(() => setVisibleCards((prev) => new Set(prev).add(i)), i * 80));
    });
    setVisibleNavs(new Set());
    NAV_ITEMS.forEach((_, i) => {
      timers.push(setTimeout(() => setVisibleNavs((prev) => new Set(prev).add(i)), 300 + i * 60));
    });
    return () => timers.forEach(clearTimeout);
  }, []);

  const kpiRows = stats
    ? [
        { label: 'Drift Incidents', value: stats.openIncidents, alert: stats.openIncidents > 0 },
        { label: 'Open Disputes', value: stats.openDisputes, alert: stats.openDisputes > 0 },
        { label: 'Rate Changes', value: stats.rateChanges, alert: false },
        {
          label: 'Health Checks',
          value: stats.healthChecks,
          alert: stats.lastCheckPassed === false,
        },
        { label: 'Active Alerts', value: stats.totalAlerts, alert: stats.totalAlerts > 0 },
      ]
    : [];

  const systemStatus = statsError
    ? 'System Status Unverified'
    : !stats
      ? 'Reading Financial Status'
      : stats.lastCheckPassed === false ||
          stats.totalAlerts > 0 ||
          stats.openIncidents > 0 ||
          stats.openDisputes > 0
        ? 'Attention Required'
        : stats.lastCheckPassed === true
          ? 'Checks Passing'
          : 'Awaiting Verification';

  if (scope.status !== 'ready' || scope.userId !== user?.id) {
    return (
      <div className={styles.page}>
        <SpadeConsole
          family="spade"
          crest="flat"
          eyebrow="Club Arena Data"
          title="Financial Admin Hub"
          pill="Access"
          pillInk="gold"
          plates={{
            secondary: { label: 'Back', onClick: () => navigate(-1) },
            primary: {
              label: scope.status === 'loading' ? 'Checking' : 'Retry Access',
              onClick: scope.reload,
              disabled: scope.status === 'loading',
            },
          }}
        >
          <p className="sc-copy sc-copy--center" role="status">
            {scope.message || 'Verifying Your Financial Access'}
          </p>
        </SpadeConsole>
      </div>
    );
  }

  return (
    <main className={styles.page}>
      <h1 className={styles.srOnly}>Financial Admin Hub</h1>
      <SpadeConsole
        family="spade"
        crest="flat"
        eyebrow="Club Arena Data"
        title="Financial Admin Hub"
        subtitle="Central Command For Financial Operations"
        pill={statsError ? 'Unverified' : loading ? 'Reading' : 'Live'}
        pillInk={statsError ? 'red' : loading ? 'gold' : 'blue'}
        plates={{
          secondary: { label: 'Back', onClick: () => navigate(-1) },
          primary: {
            label: loading ? 'Reading' : 'Refresh',
            onClick: loadStats,
            disabled: loading,
          },
        }}
      >
        {statsError ? (
          <div className={styles.statusBlock} role="alert">
            <p className="sc-copy sc-copy--center">{statsError}</p>
            <button type="button" className={styles.litAction} onClick={loadStats}>
              Retry Financial Reading
            </button>
          </div>
        ) : loading || !stats ? (
          <p className="sc-copy sc-copy--center" role="status">
            Reading The Authorized Financial Scope
          </p>
        ) : (
          <>
            <section className={styles.metrics} aria-label="Financial Status">
              {kpiRows.map((row, idx) => (
                <div
                  className={styles.metricRow}
                  data-visible={visibleCards.has(idx)}
                  key={row.label}
                >
                  <span className="sc-label sc-ink--blue">{row.label}</span>
                  <strong className={row.alert ? 'sc-ink--red' : 'sc-ink--silver'}>
                    {compactChips(row.value)}
                  </strong>
                </div>
              ))}
            </section>

            {revenueData.length > 0 && (
              <section className={styles.revenue} aria-label="Seven Day Revenue">
                <div className={styles.sectionHeading}>
                  <span className="sc-label sc-ink--blue">Seven Day Revenue</span>
                  <strong className="sc-ink--silver">
                    {compactChips(revenueData.reduce((sum, day) => sum + day.amount, 0))} Chips
                  </strong>
                </div>
                <div className={styles.chart} aria-label="Seven Day Revenue Chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={revenueData} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                      <XAxis
                        dataKey="day"
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#9aa5b3', fontSize: 10 }}
                      />
                      <Area
                        type="monotone"
                        dataKey="amount"
                        stroke="#45adff"
                        strokeWidth={3}
                        fill="#1877f2"
                        fillOpacity={0.22}
                        isAnimationActive
                        animationDuration={1500}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              </section>
            )}

            <section aria-labelledby="financial-tools-heading">
              <h2 id="financial-tools-heading" className={styles.glassHeading}>
                Financial Tools
              </h2>
              <nav className={styles.toolRows} aria-label="Financial Tools">
                {NAV_ITEMS.map((item, idx) =>
                  item.staffOnly && !scope.isPlatformStaff ? null : (
                    <Link
                      key={item.label}
                      to={item.path}
                      className={`${styles.toolRow} ${styles[`tone${titleCase(item.tone)}`]}`}
                      data-visible={visibleNavs.has(idx)}
                    >
                      <span className={styles.toolCopy}>
                        <strong>{item.label}</strong>
                        <small>{item.description}</small>
                      </span>
                      <span className={styles.openWord}>Open</span>
                    </Link>
                  )
                )}
              </nav>
            </section>

            <div className={styles.statusRows}>
              <div className={styles.statusRow}>
                <span>Financial Engine</span>
                <strong>Version Three</strong>
              </div>
              <div className={styles.statusRow}>
                <span>System Status</span>
                <strong
                  className={systemStatus === 'Checks Passing' ? 'sc-ink--green' : 'sc-ink--gold'}
                >
                  {systemStatus}
                </strong>
              </div>
              {reading && (
                <div className={styles.statusRow}>
                  <span>Reading Window</span>
                  <strong className="sc-ink--muted">
                    Through {new Date(reading.windowEnd).toLocaleDateString()}
                  </strong>
                </div>
              )}
            </div>
          </>
        )}
      </SpadeConsole>

      <SpadeConsole
        family="shark"
        crest="flat"
        eyebrow="Authorized Union"
        title="Union Operations"
        pill={selectedUnion ? 'Selected' : 'Choose'}
        pillInk={unionOptionsStatus === 'error' ? 'red' : 'blue'}
        foot="foot"
      >
        <label className={styles.selectLabel} htmlFor="financial-admin-union">
          Union
        </label>
        <select
          id="financial-admin-union"
          className={styles.select}
          value={selectedUnion ? selectedUnion.id : ''}
          disabled={unionOptionsStatus !== 'ready'}
          onChange={(event) => setSelectedUnionId(event.target.value)}
        >
          <option value="">
            {unionOptionsStatus === 'loading' ? 'Loading Unions' : 'Choose A Union'}
          </option>
          {unionOptions.map((union) => (
            <option key={union.id} value={union.id}>
              {titleCase(union.name)}
            </option>
          ))}
        </select>
        {unionOptionsStatus === 'error' ? (
          <div className={styles.statusBlock} role="alert">
            <p className="sc-copy sc-copy--center">Unions Could Not Be Loaded</p>
            <button type="button" className={styles.litAction} onClick={loadUnionOptions}>
              Retry Union List
            </button>
          </div>
        ) : unionOptionsStatus === 'ready' && unionOptions.length === 0 ? (
          <p className="sc-copy sc-copy--center">No Unions Available</p>
        ) : !selectedUnion ? (
          <p className="sc-copy sc-copy--center">Choose A Union To See Its Operations</p>
        ) : (
          <p className="sc-copy sc-copy--center">{titleCase(selectedUnion.name)} Is Ready Below</p>
        )}
      </SpadeConsole>

      {selectedUnion && <UnionOpsPanel key={selectedUnion.id} unionId={selectedUnion.id} canRun />}
    </main>
  );
}
