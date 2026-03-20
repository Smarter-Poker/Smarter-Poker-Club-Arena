/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNION DASHBOARD PAGE — Union Operations Center
 *  Ported from World Hub union-dashboard.js → Club Arena TypeScript
 *
 *  8 Tabs: Overview, Clubs, Agents, Wallet, Treasury, Analytics, Applications, Settings
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import './AdminDashboardPage.css';
import { useIsMounted } from '../hooks/useIsMounted';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { fmt, timeAgo } from '../utils/format';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import { getUnionLevel } from '../utils/clubLevels';

// ── Helpers ─────────────────────────────────────────────────
const pct = (n: number | null | undefined) => `${((Number(n) || 0) * 100).toFixed(1)}%`;

type UnionTab =
  | 'overview'
  | 'clubs'
  | 'agents'
  | 'wallet'
  | 'treasury'
  | 'analytics'
  | 'applications'
  | 'settings';

// ── Union Dashboard Types ────────────────────────────────────
interface UnionRow {
  id: string;
  name: string;
  description?: string;
  owner_id: string;
  created_at: string;
  logo_url?: string;
  member_count?: number;
  status?: string;
  code?: string;
  settings?: Record<string, number | string | boolean>;
}
interface UnionClubRow {
  id: string;
  club_id: string;
  clubs: Record<string, unknown>;
  commission_rate?: number;
  [key: string]: unknown;
}
interface EnrichedClub {
  id: string;
  name?: string;
  club_id?: string;
  member_count?: number;
  active_tables?: number;
  total_rake?: number;
  chip_treasury?: number;
  club_commission_rate: number;
  [key: string]: unknown;
}
interface UnionAgent {
  id?: string;
  user_id: string;
  club_id: string;
  role: string;
  status: string;
  commission_rate?: number;
  profiles?: { display_name?: string; username?: string; avatar_url?: string };
}
interface UnionAdmin {
  user_id: string;
  union_id: string;
  role: string;
  created_at: string;
  profile?: { display_name?: string; username?: string; avatar_url?: string };
}
interface UnionWallet {
  id: string;
  union_id: string;
  chip_balance: number;
  rake_wallet: number;
  bbj_wallet: number;
  promo_wallet: number;
  insurance_wallet: number;
  total_rake_collected: number;
  total_settlements: number;
  created_at: string;
}
interface UnionApp {
  id: string;
  union_id: string;
  club_name: string;
  club_id?: string;
  applicant_id: string;
  status: string;
  notes?: string;
  created_at: string;
  applied_at?: string;
}
interface SettlementPeriod {
  id: string;
  period_number: number;
  year: number;
  start_at: string;
  end_at?: string;
  status: string;
  total_rake_collected?: number;
  total_hands_dealt?: number;
  settled_at?: string;
  created_at: string;
  club_id?: string;
}

export default function UnionDashboardPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();

  const [tab, setTab] = useState<UnionTab>('overview');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);

  // Union data
  const [unionId, setUnionId] = useState<string | null>(null);
  const [union, setUnion] = useState<UnionRow | null>(null);
  const [adminRole, setAdminRole] = useState<string | null>(null);
  const [clubs, setClubs] = useState<EnrichedClub[]>([]);
  const [agents, setAgents] = useState<UnionAgent[]>([]);
  const [admins, setAdmins] = useState<UnionAdmin[]>([]);
  const [wallets, setWallets] = useState<UnionWallet | null>(null);
  const [recentPeriods, setRecentPeriods] = useState<SettlementPeriod[]>([]);

  // Applications
  const [apps, setApps] = useState<UnionApp[]>([]);
  const [appsFilter, setAppsFilter] = useState('pending');
  const [appsLoaded, setAppsLoaded] = useState(false);

  // Activity

  // Wallet transfer form (Send Chips to Club)
  const [transferForm, setTransferForm] = useState({ clubId: '', amount: '', notes: '' });

  // Wallet deposit form (controlled — no getElementById)
  const [depositForm, setDepositForm] = useState({ amount: '', notes: '' });

  // Clawback form (controlled — no getElementById)
  const [clawbackForm, setClawbackForm] = useState({ target: '', amount: '', reason: '' });

  // Search / Filter
  const [clubSearch, setClubSearch] = useState('');
  const [agentSearch, setAgentSearch] = useState('');

  // Settings form
  const [settingsForm, setSettingsForm] = useState<Record<string, string>>({});

  // Commission edit modal
  const [editCommClub, setEditCommClub] = useState<EnrichedClub | null>(null);
  const [editCommRate, setEditCommRate] = useState('');

  // Announcement
  const [annMsg, setAnnMsg] = useState('');
  const [annClub, setAnnClub] = useState('');

  // Admin search
  const [adminSearch, setAdminSearch] = useState('');
  const [adminResults, setAdminResults] = useState<
    { id: string; display_name?: string; username?: string }[]
  >([]);

  const mountedRef = useIsMounted();
  const SWR_TTL_MS = 5 * 60 * 1000; // 5-minute cache TTL

  // Auto-clear success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  // Auto-clear errors after 6s
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error]);

  // ── Cache Invalidation on Union Change ─────────────────────
  useEffect(() => {
    setAppsLoaded(false);
    setApps([]);
  }, [unionId]);

  // ── Invalidate Apps Cache on Filter Change ─────────────────
  useEffect(() => {
    setAppsLoaded(false);
  }, [appsFilter]);

  const dashLoadingRef = useRef(false);

  // ── Load Dashboard ─────────────────────────────────────────
  const loadDashboard = useCallback(
    async (uid?: string | null) => {
      if (dashLoadingRef.current) return;
      dashLoadingRef.current = true;
      try {
        setLoading(true);
        setError(null);
        const id = uid || unionId;

        if (!id && user?.id) {
          // Discover union
          const { data: adminRow } = await supabase
            .from('union_admins')
            .select('union_id, role')
            .eq('user_id', user.id)
            .limit(1)
            .maybeSingle();
          let discoveredId = adminRow?.union_id || null;
          let role = adminRow?.role || null;

          if (!discoveredId) {
            const { data: ownerRow } = await supabase
              .from('unions')
              .select('id')
              .eq('owner_id', user.id)
              .limit(1)
              .maybeSingle();
            discoveredId = ownerRow?.id || null;
            if (discoveredId) role = 'union_lead';
          }

          if (!discoveredId) {
            setError('You are not a union admin or owner.');
            setLoading(false);
            return;
          }
          setUnionId(discoveredId);
          setAdminRole(role);
          await loadUnionData(discoveredId);
        } else if (id) {
          await loadUnionData(id);
        }
      } catch (err: any) {
        if (mountedRef.current) setError(err.message);
        // Clear stale SWR cache on error to prevent ghost data
        try {
          sessionStorage.removeItem(`union_dashboard_swr_${user?.id}`);
        } catch {
          /* ignore */
        }
      } finally {
        dashLoadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [unionId, user?.id]
  );

  const loadUnionData = async (uid: string) => {
    // Load union info
    const { data: unionRow } = await supabase
      .from('unions')
      .select(
        'id, name, description, owner_id, created_at, member_count, level, player_level, hierarchy_level, total_players, hierarchy_units, hierarchy_units_rounded_up, player_threshold_current, player_threshold_next, hierarchy_threshold_current, hierarchy_threshold_next'
      )
      .eq('id', uid)
      .maybeSingle();
    if (mountedRef.current) setUnion(unionRow);

    // Load clubs in union
    const { data: unionClubs } = await supabase
      .from('union_clubs')
      .select('*, clubs:club_id(*)')
      .eq('union_id', uid);
    const enrichedClubs = (unionClubs || []).map((uc: UnionClubRow) => ({
      id: uc.club_id,
      ...uc.clubs,
      club_commission_rate: uc.commission_rate || 0.9,
    }));
    if (mountedRef.current) setClubs(enrichedClubs);

    // Load agents across clubs
    let loadedAgents: UnionAgent[] = []; // Hoisted for SWR cache write
    const clubIds = enrichedClubs.map((c) => c.id).filter(Boolean);
    if (clubIds.length > 0) {
      const { data: agentRows } = await supabase
        .from('club_members')
        .select('*')
        .in('club_id', clubIds)
        .in('role', ['agent', 'sub_agent', 'super_agent']);

      // Batch-fetch profiles (no FK between club_members and profiles)
      if (agentRows && agentRows.length > 0) {
        const agentUserIds = [...new Set(agentRows.map((a: any) => a.user_id))];
        const { data: agentProfiles } = await supabase
          .from('profiles')
          .select('id, display_name, username, avatar_url')
          .in('id', agentUserIds);
        const agentProfileMap: Record<string, any> = {};
        if (agentProfiles) {
          for (const p of agentProfiles) agentProfileMap[p.id] = p;
        }
        // Attach profiles to agent rows
        for (const agent of agentRows) {
          (agent as any).profiles = agentProfileMap[agent.user_id] || null;
        }
      }

      if (mountedRef.current) {
        loadedAgents = agentRows || [];
        setAgents(loadedAgents);
      }
    }

    // Load admins
    const { data: adminRows } = await supabase
      .from('union_admins')
      .select('*, profile:user_id(display_name, username, avatar_url)')
      .eq('union_id', uid);
    if (mountedRef.current) setAdmins(adminRows || []);

    // Load wallets
    const { data: walletRow } = await supabase
      .from('union_wallets')
      // union_wallets schema: chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet, total_rake_collected, total_settlements
      .select(
        'id, union_id, chip_balance, rake_wallet, bbj_wallet, promo_wallet, insurance_wallet, total_rake_collected, total_settlements, created_at'
      )
      .eq('union_id', uid)
      .maybeSingle();
    if (mountedRef.current) setWallets(walletRow);

    // settlement_periods is a global table (no club_id column) — query by status/date instead
    const { data: periods } = await supabase
      .from('settlement_periods')
      .select(
        'id, period_number, year, start_at, end_at, status, total_rake_collected, total_hands_dealt, settled_at, created_at'
      )
      .order('created_at', { ascending: false })
      .limit(30);
    if (mountedRef.current) setRecentPeriods(periods || []);

    // SWR: cache successful load for instant display on revisit
    if (mountedRef.current) {
      try {
        sessionStorage.setItem(
          `union_dashboard_swr_${user?.id}`,
          JSON.stringify({
            union: unionRow,
            unionId: uid,
            adminRole,
            clubs: enrichedClubs.slice(0, 30),
            agents: loadedAgents.slice(0, 30),
            wallets: walletRow,
            cachedAt: Date.now(),
          })
        );
      } catch {
        /* storage full */
      }
    }
  };

  // ── Initial Load + SWR Cache ──────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    // SWR: show cached data instantly while fresh data loads
    try {
      const cached = sessionStorage.getItem(`union_dashboard_swr_${user.id}`);
      if (cached) {
        const parsed = JSON.parse(cached);
        const age = parsed.cachedAt ? Date.now() - parsed.cachedAt : Infinity;
        if (age < SWR_TTL_MS && parsed.union) {
          setUnion(parsed.union);
          if (parsed.unionId) setUnionId(parsed.unionId);
          if (parsed.adminRole) setAdminRole(parsed.adminRole);
          if (parsed.clubs) setClubs(parsed.clubs);
          if (parsed.agents) setAgents(parsed.agents);
          if (parsed.wallets) setWallets(parsed.wallets);
          setLoading(false); // Show cached data instantly
        }
      }
    } catch {
      /* corrupt cache */
    }
    loadDashboard();
  }, [user?.id, loadDashboard]);

  // ── Load Applications ──────────────────────────────────────
  const loadApps = useCallback(async () => {
    if (!unionId) return;
    try {
      let query = supabase
        .from('union_applications')
        // union_applications schema: notes (not message)
        .select('id, union_id, club_name, club_id, applicant_id, status, notes, created_at')
        .eq('union_id', unionId)
        .order('created_at', { ascending: false });
      if (appsFilter !== 'all') {
        query = query.eq('status', appsFilter);
      }
      const { data } = await query;
      if (mountedRef.current) {
        setApps(data || []);
        setAppsLoaded(true);
      }
    } catch (_e) {
      /* silent */
    }
  }, [unionId, appsFilter]);

  // ── Tab-based lazy loading ─────────────────────────────────
  useEffect(() => {
    if (!unionId) return;
    if (tab === 'applications' && !appsLoaded) loadApps();
  }, [tab, unionId, appsLoaded, loadApps]);

  // ── Bus Listeners ──────────────────────────────────────────
  useEffect(() => {
    if (!unionId) return;
    const refresh = () => loadDashboard(unionId);
    const unsubs = [
      masterBus.subscribeDebounced('CLUB_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', refresh, 300),
      masterBus.subscribeDebounced('AGENT_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('CASHOUT_APPROVED', refresh, 300),
      masterBus.subscribeDebounced('CASHOUT_REQUESTED', refresh, 300),
      masterBus.subscribeDebounced('TABLE_CREATED', refresh, 300),
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('CREDIT_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', refresh, 300),
      // Level recompute: union level updates when member roles change
      masterBus.subscribeDebounced('MEMBER_ROLE_CHANGED', refresh, 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, [unionId, loadDashboard]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    if (!unionId) return;
    const channelKey = `union-dashboard-${unionId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'union_clubs', filter: `union_id=eq.${unionId}` },
        () => loadDashboard(unionId)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'union_applications',
          filter: `union_id=eq.${unionId}`,
        },
        () => loadDashboard(unionId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'union_admins', filter: `union_id=eq.${unionId}` },
        () => loadDashboard(unionId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'union_wallets', filter: `union_id=eq.${unionId}` },
        () => loadDashboard(unionId)
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'unions', filter: `id=eq.${unionId}` },
        () => loadDashboard(unionId)
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('[UnionDashboardPage] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[UnionDashboardPage] ⏱️ Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [unionId, loadDashboard]);

  // ── Visibility Refresh — refresh on tab focus after 30s ──
  useVisibilityRefresh(() => loadDashboard(unionId));

  // ── Computed ───────────────────────────────────────────────
  const isLead = adminRole === 'union_lead';

  const filteredClubs = useMemo(() => {
    if (!clubSearch.trim()) return clubs;
    const q = clubSearch.toLowerCase();
    return clubs.filter((c) => c.name?.toLowerCase().includes(q) || String(c.club_id).includes(q));
  }, [clubs, clubSearch]);

  const filteredAgents = useMemo(() => {
    if (!agentSearch.trim()) return agents;
    const q = agentSearch.toLowerCase();
    return agents.filter(
      (a: UnionAgent) =>
        a.profiles?.display_name?.toLowerCase().includes(q) ||
        a.profiles?.username?.toLowerCase().includes(q) ||
        a.role?.toLowerCase().includes(q)
    );
  }, [agents, agentSearch]);

  // ── CSV Export ─────────────────────────────────────────────
  const downloadCSV = (filename: string, headers: string[], rows: (string | number)[][]) => {
    const csv = [
      headers.join(','),
      ...rows.map((r) => r.map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportAgents = () => {
    const headers = ['Agent', 'Club', 'Role', 'Commission', 'Status'];
    const rows = agents.map((a: UnionAgent) => {
      const club = clubs.find((c) => c.id === a.club_id);
      return [
        a.profiles?.display_name || a.profiles?.username || a.user_id,
        club?.name || 'Unknown',
        a.role,
        pct(a.commission_rate),
        a.status,
      ];
    });
    downloadCSV(`union_agents_${new Date().toISOString().slice(0, 10)}.csv`, headers, rows);
  };

  // ── Loading State ──────────────────────────────────────────
  if (loading) {
    return (
      <div className="admin-page">
        <div className="admin-container">
          <div className="admin-skeleton" style={{ height: '48px', marginBottom: '16px' }} />
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '12px',
            }}
          >
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="admin-skeleton" style={{ height: '80px' }} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error && !union) {
    return (
      <div className="admin-page">
        <div className="admin-container">
          <div className="admin-error-banner">{error}</div>
        </div>
      </div>
    );
  }

  const pendingAppsCount = apps.filter((a) => a.status === 'pending').length;

  return (
    <div className="admin-page">
      <div className="admin-container">
        {error && <div className="admin-error-banner">{error}</div>}
        {success && <div className="admin-success-banner">{success}</div>}

        {/* Edit Commission Modal */}
        {editCommClub && (
          <div
            className="admin-modal-overlay"
            onClick={() => setEditCommClub(null)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setEditCommClub(null);
            }}
          >
            <div
              className="admin-card"
              style={{ maxWidth: '380px', margin: '60px auto', padding: '20px' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3 className="admin-card-title">Edit Commission — {editCommClub.name}</h3>
              <div style={{ marginBottom: '12px' }}>
                <label className="admin-label">Commission Rate (%)</label>
                <input
                  className="admin-input"
                  type="number"
                  min="1"
                  max="100"
                  value={editCommRate}
                  onChange={(e) => setEditCommRate(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  className="admin-btn admin-btn-primary"
                  disabled={processing}
                  onClick={async () => {
                    const rate = parseFloat(editCommRate) / 100;
                    if (isNaN(rate) || rate < 0.01 || rate > 1) {
                      setError('Rate must be 1-100%');
                      return;
                    }
                    setProcessing(true);
                    setError(null);
                    try {
                      const { error: commErr } = await supabase
                        .from('union_clubs')
                        .update({ commission_rate: rate })
                        .eq('union_id', unionId)
                        .eq('club_id', editCommClub.id);
                      if (commErr) throw commErr;
                      masterBus.emit('CLUB_UPDATED', { clubId: editCommClub.id });
                      setSuccess('Commission updated');
                      setEditCommClub(null);
                      loadDashboard(unionId);
                    } catch (err: any) {
                      setError(err.message);
                    } finally {
                      setProcessing(false);
                    }
                  }}
                >
                  Save
                </button>
                <button className="admin-btn admin-btn-ghost" onClick={() => setEditCommClub(null)}>
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="admin-page-header">
          <div className="admin-page-title">
            🏛️ {union?.name || 'Union Dashboard'}
            {union?.code && (
              <span className="admin-badge" style={{ marginLeft: '12px' }}>
                {union.code}
              </span>
            )}
            {(() => {
              const uLevel = getUnionLevel({
                level: (union as any)?.level || 1,
                playerLevel: (union as any)?.player_level,
                hierarchyLevel: (union as any)?.hierarchy_level,
                totalPlayers: (union as any)?.total_players || 0,
                hierarchyUnitsRoundedUp: (union as any)?.hierarchy_units_rounded_up || 0,
                playerThresholdCurrent: (union as any)?.player_threshold_current || 0,
                playerThresholdNext: (union as any)?.player_threshold_next || 0,
                hierarchyThresholdCurrent: (union as any)?.hierarchy_threshold_current || 0,
                hierarchyThresholdNext: (union as any)?.hierarchy_threshold_next || 0,
              });
              return (
                <span
                  style={{
                    marginLeft: '12px',
                    fontSize: '0.65rem',
                    padding: '3px 10px',
                    borderRadius: '12px',
                    background: uLevel.gradient,
                    color: '#fff',
                    fontWeight: 700,
                    letterSpacing: '0.5px',
                    textShadow: '0 1px 2px rgba(0,0,0,0.5)',
                    verticalAlign: 'middle',
                  }}
                >
                  Lv.{uLevel.level} — {uLevel.tierLabel}
                </span>
              );
            })()}
          </div>
          <div className="admin-header-actions">
            <button
              onClick={() => navigate('/union-games')}
              className="admin-btn admin-btn-primary"
            >
              🎮 Games
            </button>
            <button onClick={() => navigate('/')} className="admin-btn admin-btn-ghost">
              🏠 Lobby
            </button>
            <button
              onClick={() => loadDashboard(unionId)}
              className="admin-btn admin-btn-ghost"
              disabled={processing}
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="admin-tabs">
          {(
            [
              { id: 'overview' as UnionTab, label: 'Overview' },
              { id: 'clubs' as UnionTab, label: `Clubs (${clubs.length})` },
              { id: 'agents' as UnionTab, label: `Agents (${agents.length})` },
              { id: 'wallet' as UnionTab, label: 'Wallet' },
              { id: 'treasury' as UnionTab, label: '🏦 Treasury' },
              { id: 'analytics' as UnionTab, label: '📊 Analytics' },
              {
                id: 'applications' as UnionTab,
                label: 'Applications',
                badge: pendingAppsCount || undefined,
              },
              { id: 'settings' as UnionTab, label: 'Settings' },
            ] as { id: UnionTab; label: string; badge?: number }[]
          ).map((t) => (
            <button
              key={t.id}
              className={`admin-tab ${tab === t.id ? 'active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
              {t.badge ? (
                <span
                  style={{
                    marginLeft: '6px',
                    background: 'rgba(250,56,62,0.15)',
                    padding: '2px 6px',
                    borderRadius: '8px',
                    fontSize: '11px',
                    color: '#FA383E',
                  }}
                >
                  {t.badge}
                </span>
              ) : null}
            </button>
          ))}
        </div>

        {/* ══════ TAB: OVERVIEW ══════ */}
        {tab === 'overview' && (
          <div className="admin-tab-content">
            <div className="admin-stats-grid">
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {fmt(clubs.length)}
                </div>
                <div className="admin-stat-label">Clubs</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">
                  {fmt(clubs.reduce((s, c) => s + (c.member_count || 0), 0))}
                </div>
                <div className="admin-stat-label">Total Members</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {fmt(agents.length)}
                </div>
                <div className="admin-stat-label">Active Agents</div>
              </div>
            </div>

            {/* Wallet Summary */}
            {wallets && (
              <div className="admin-stats-grid" style={{ marginTop: '16px' }}>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                    {fmt(wallets.chip_balance)}
                  </div>
                  <div className="admin-stat-label">Chip Balance</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                    {fmt(wallets.rake_wallet)}
                  </div>
                  <div className="admin-stat-label">Rake Wallet</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                    {fmt(wallets.bbj_wallet)}
                  </div>
                  <div className="admin-stat-label">BBJ Pool</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#C084FC' }}>
                    {fmt(wallets.promo_wallet)}
                  </div>
                  <div className="admin-stat-label">Promo Wallet</div>
                </div>
              </div>
            )}

            {/* Broadcast (Lead only) */}
            {isLead && (
              <div className="admin-card" style={{ marginTop: '16px', padding: '16px' }}>
                <h3 className="admin-card-title">📢 Broadcast Announcement</h3>
                <textarea
                  className="admin-input"
                  value={annMsg}
                  onChange={(e) => setAnnMsg(e.target.value)}
                  maxLength={500}
                  placeholder="Announcement to all clubs..."
                  rows={3}
                  style={{ resize: 'vertical' }}
                />
                <div
                  style={{ display: 'flex', gap: '8px', marginTop: '12px', alignItems: 'center' }}
                >
                  <select
                    className="admin-input"
                    style={{ maxWidth: '200px' }}
                    value={annClub}
                    onChange={(e) => setAnnClub(e.target.value)}
                  >
                    <option value="">All Clubs</option>
                    {clubs.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className="admin-btn admin-btn-primary"
                    disabled={processing || !annMsg.trim()}
                    onClick={async () => {
                      setProcessing(true);
                      setError(null);
                      try {
                        const { error: annErr } = await supabase
                          .from('union_announcements')
                          .insert({
                            union_id: unionId,
                            message: annMsg,
                            club_id: annClub || null,
                            created_by: user?.id,
                          });
                        if (annErr) throw annErr;
                        masterBus.emit('ANNOUNCEMENT_CHANGED', {
                          clubId: annClub || unionId || '',
                          action: 'created',
                        });
                        setSuccess('Announcement sent');
                        setAnnMsg('');
                        loadDashboard(unionId);
                      } catch (err: any) {
                        setError(err.message);
                      } finally {
                        setProcessing(false);
                      }
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: CLUBS ══════ */}
        {tab === 'clubs' && (
          <div className="admin-tab-content">
            <input
              className="admin-input"
              value={clubSearch}
              onChange={(e) => setClubSearch(e.target.value)}
              placeholder="Search clubs..."
              style={{ marginBottom: '16px', maxWidth: '300px' }}
            />
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '12px',
              }}
            >
              {filteredClubs.map((club) => (
                <div key={club.id} className="admin-card" style={{ padding: '14px 16px' }}>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      marginBottom: '8px',
                    }}
                  >
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '14px' }}>{club.name}</div>
                      <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        ID: {club.club_id}
                      </div>
                    </div>
                    <span className="admin-badge">{pct(club.club_commission_rate)} comm</span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: '12px',
                      fontSize: '12px',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <span>{fmt(club.member_count)} members</span>
                    <span>{fmt(club.active_tables)} tables</span>
                    <span>{fmt(club.total_rake)} rake</span>
                  </div>
                  {isLead && (
                    <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                      <button
                        className="admin-btn admin-btn-ghost admin-btn-sm"
                        onClick={() => {
                          setEditCommClub(club);
                          setEditCommRate(String((club.club_commission_rate || 0.9) * 100));
                        }}
                      >
                        Edit Rate
                      </button>
                      <button
                        className="admin-btn admin-btn-danger admin-btn-sm"
                        disabled={processing}
                        onClick={async () => {
                          if (!confirm(`Remove ${club.name} from the union?`)) return;
                          setProcessing(true);
                          setError(null);
                          try {
                            const { error: rmErr } = await supabase
                              .from('union_clubs')
                              .delete()
                              .eq('union_id', unionId)
                              .eq('club_id', club.id);
                            if (rmErr) throw rmErr;
                            masterBus.emit('CLUB_UPDATED', { clubId: club.id });
                            setSuccess(`${club.name} removed`);
                            loadDashboard(unionId);
                          } catch (err: any) {
                            setError(err.message);
                          } finally {
                            setProcessing(false);
                          }
                        }}
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
            {filteredClubs.length === 0 && (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">🏢</span>
                <span>{clubSearch ? 'No clubs match' : 'No clubs yet'}</span>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: AGENTS ══════ */}
        {tab === 'agents' && (
          <div className="admin-tab-content">
            <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {fmt(agents.filter((a) => a.status === 'active').length)}
                </div>
                <div className="admin-stat-label">Active</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                  {fmt(agents.filter((a) => a.status === 'suspended').length)}
                </div>
                <div className="admin-stat-label">Suspended</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmt(agents.length)}</div>
                <div className="admin-stat-label">Total Agents</div>
              </div>
            </div>

            <div
              style={{ display: 'flex', gap: '8px', marginBottom: '12px', alignItems: 'center' }}
            >
              <input
                className="admin-input"
                value={agentSearch}
                onChange={(e) => setAgentSearch(e.target.value)}
                placeholder="Search agents..."
                style={{ maxWidth: '300px' }}
              />
              <button className="admin-btn admin-btn-ghost admin-btn-sm" onClick={exportAgents}>
                📥 Export CSV
              </button>
            </div>

            <div className="admin-table-scroll">
              <table className="admin-data-table">
                <thead>
                  <tr>
                    <th>Agent</th>
                    <th>Club</th>
                    <th>Role</th>
                    <th>Commission</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredAgents.map((agent) => {
                    const club = clubs.find((c) => c.id === agent.club_id);
                    return (
                      <tr key={agent.id || agent.user_id}>
                        <td>
                          {agent.profiles?.display_name ||
                            agent.profiles?.username ||
                            agent.user_id?.slice(0, 8)}
                        </td>
                        <td>{club?.name || 'Unknown'}</td>
                        <td>{agent.role}</td>
                        <td>{pct(agent.commission_rate)}</td>
                        <td>
                          <span
                            className="admin-badge"
                            style={
                              agent.status === 'active'
                                ? { background: 'rgba(49,162,76,0.15)', color: '#31A24C' }
                                : { background: 'rgba(250,56,62,0.15)', color: '#FA383E' }
                            }
                          >
                            {agent.status}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filteredAgents.length === 0 && (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">👤</span>
                <span>{agentSearch ? 'No agents match' : 'No agents found'}</span>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: WALLET ══════ */}
        {tab === 'wallet' && (
          <div className="admin-tab-content">
            {wallets && (
              <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                    {fmt(wallets.chip_balance)}
                  </div>
                  <div className="admin-stat-label">Chip Balance</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                    {fmt(wallets.rake_wallet)}
                  </div>
                  <div className="admin-stat-label">Rake</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                    {fmt(wallets.bbj_wallet)}
                  </div>
                  <div className="admin-stat-label">BBJ</div>
                </div>
                <div className="admin-stat-card">
                  <div className="admin-stat-value" style={{ color: '#C084FC' }}>
                    {fmt(wallets.promo_wallet)}
                  </div>
                  <div className="admin-stat-label">Promo</div>
                </div>
              </div>
            )}

            {/* DEPOSIT TO UNION BANK — Move chips from owner's player wallet to union bank */}
            {isLead && (
              <div
                className="admin-card"
                style={{ padding: '16px', marginBottom: '16px', borderLeft: '3px solid #22c55e' }}
              >
                <h3 className="admin-card-title" style={{ color: '#22c55e' }}>
                  Deposit to Union Bank
                </h3>
                <p style={{ fontSize: '12px', color: '#888', margin: '0 0 8px' }}>
                  Move chips from your player wallet into the Union Main Bank
                </p>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <input
                    className="admin-input"
                    style={{ flex: '0 0 150px' }}
                    type="number"
                    min="1"
                    placeholder="Amount"
                    value={depositForm.amount}
                    onChange={(e) => setDepositForm((f) => ({ ...f, amount: e.target.value }))}
                  />
                  <input
                    className="admin-input"
                    style={{ flex: '1 1 150px' }}
                    placeholder="Notes (optional)"
                    value={depositForm.notes}
                    onChange={(e) => setDepositForm((f) => ({ ...f, notes: e.target.value }))}
                  />
                  <button
                    className="admin-btn admin-btn-primary"
                    style={{ background: '#22c55e' }}
                    disabled={processing}
                    onClick={async () => {
                      setProcessing(true);
                      setError(null);
                      try {
                        const amt = parseInt(depositForm.amount || '0', 10);
                        if (isNaN(amt) || amt <= 0) {
                          setError('Enter a valid amount');
                          setProcessing(false);
                          return;
                        }

                        // 1. Deduct from owner's player wallet
                        const { data: deductResult, error: deductErr } = await supabase.rpc(
                          'atomic_deduct_wallet_and_log',
                          {
                            p_user_id: user!.id,
                            p_amount: amt,
                            p_category: 'deposit_to_union',
                            p_description: `Deposit to Union Bank: ${depositForm.notes || 'Union funding'}`,
                            p_table_id: null,
                            p_hand_id: null,
                            p_related_entity_id: unionId,
                          }
                        );
                        if (deductErr)
                          throw new Error(
                            deductErr.message || 'Failed to deduct from player wallet'
                          );

                        // 2. Atomic credit to union chip_balance — single SQL UPDATE prevents TOCTOU race
                        const { error: uwErr } = await supabase.rpc(
                          'increment_union_chip_balance',
                          {
                            p_union_id: unionId,
                            p_amount: amt,
                          }
                        );
                        if (uwErr) throw new Error('Failed to credit union bank: ' + uwErr.message);

                        setSuccess(`Deposited ${amt.toLocaleString()} chips to Union Bank`);
                        masterBus.emit('BALANCE_UPDATED', {
                          source: 'union_deposit',
                          userId: user!.id,
                        });
                        setDepositForm({ amount: '', notes: '' });
                        loadDashboard(unionId);
                      } catch (err: any) {
                        setError(err.message || 'Deposit failed');
                      } finally {
                        setProcessing(false);
                      }
                    }}
                  >
                    Deposit
                  </button>
                </div>
              </div>
            )}

            {/* CLAWBACK — Recall chips from any wallet (club, agent, player) back to union */}
            {isLead && (
              <div
                className="admin-card"
                style={{ padding: '16px', marginBottom: '16px', borderLeft: '3px solid #ef4444' }}
              >
                <h3 className="admin-card-title" style={{ color: '#ef4444' }}>
                  Clawback Chips
                </h3>
                <p style={{ fontSize: '12px', color: '#888', margin: '0 0 8px' }}>
                  Recall chips from any club treasury, agent wallet, or player wallet back to Union
                  Bank
                </p>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <select
                    className="admin-input"
                    style={{ flex: '1 1 200px' }}
                    value={clawbackForm.target}
                    onChange={(e) => setClawbackForm((f) => ({ ...f, target: e.target.value }))}
                  >
                    <option value="">Select target...</option>
                    <optgroup label="Club Treasuries">
                      {clubs.map((c) => (
                        <option key={`club-${c.id}`} value={`club:${c.id}`}>
                          {c.name} (Treasury)
                        </option>
                      ))}
                    </optgroup>
                  </select>
                  <input
                    className="admin-input"
                    style={{ flex: '0 0 120px' }}
                    type="number"
                    min="1"
                    placeholder="Amount"
                    value={clawbackForm.amount}
                    onChange={(e) => setClawbackForm((f) => ({ ...f, amount: e.target.value }))}
                  />
                  <input
                    className="admin-input"
                    style={{ flex: '1 1 150px' }}
                    placeholder="Reason"
                    value={clawbackForm.reason}
                    onChange={(e) => setClawbackForm((f) => ({ ...f, reason: e.target.value }))}
                  />
                  <button
                    className="admin-btn"
                    style={{ background: '#ef4444', color: '#fff' }}
                    disabled={processing}
                    onClick={async () => {
                      setProcessing(true);
                      setError(null);
                      try {
                        const target = clawbackForm.target;
                        const amt = parseInt(clawbackForm.amount || '0', 10);
                        const reason = clawbackForm.reason || 'Union clawback';

                        if (!target) {
                          setError('Select a target');
                          setProcessing(false);
                          return;
                        }
                        if (isNaN(amt) || amt <= 0) {
                          setError('Enter a valid amount');
                          setProcessing(false);
                          return;
                        }

                        const [targetType, targetId] = target.split(':');

                        if (targetType === 'club') {
                          // Atomic clawback from club treasury — prevents negative balance + TOCTOU race
                          const { data: clubName } = await supabase
                            .from('clubs')
                            .select('name')
                            .eq('id', targetId)
                            .maybeSingle();
                          const { error: decrErr } = await supabase.rpc('decrement_club_treasury', {
                            p_club_id: targetId,
                            p_amount: amt,
                          });
                          if (decrErr) {
                            setError(
                              decrErr.message?.includes('insufficient')
                                ? 'Club has insufficient treasury balance'
                                : 'Failed to deduct from club: ' + decrErr.message
                            );
                            setProcessing(false);
                            return;
                          }

                          // Atomic credit to union bank
                          const { error: uwErr2 } = await supabase.rpc(
                            'increment_union_chip_balance',
                            {
                              p_union_id: unionId,
                              p_amount: amt,
                            }
                          );
                          if (uwErr2)
                            throw new Error('Failed to credit union bank: ' + uwErr2.message);

                          setSuccess(
                            `Clawed back ${amt.toLocaleString()} chips from ${clubName?.name || 'club'}`
                          );
                        }

                        masterBus.emit('BALANCE_UPDATED', { source: 'clawback' });
                        masterBus.emit('CLUB_UPDATED', { clubId: targetId });
                        setClawbackForm({ target: '', amount: '', reason: '' });
                        loadDashboard(unionId);
                      } catch (err: any) {
                        setError(err.message || 'Clawback failed');
                      } finally {
                        setProcessing(false);
                      }
                    }}
                  >
                    Clawback
                  </button>
                </div>
              </div>
            )}

            {isLead && (
              <div className="admin-card" style={{ padding: '16px', marginBottom: '16px' }}>
                <h3 className="admin-card-title">Send Chips to Club</h3>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <select
                    className="admin-input"
                    style={{ flex: '1 1 200px' }}
                    value={transferForm.clubId}
                    onChange={(e) => setTransferForm((f) => ({ ...f, clubId: e.target.value }))}
                  >
                    <option value="">Select club...</option>
                    {clubs.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="admin-input"
                    style={{ flex: '0 0 120px' }}
                    type="number"
                    min="1"
                    value={transferForm.amount}
                    onChange={(e) => setTransferForm((f) => ({ ...f, amount: e.target.value }))}
                    placeholder="Amount"
                  />
                  <input
                    className="admin-input"
                    style={{ flex: '1 1 150px' }}
                    value={transferForm.notes}
                    onChange={(e) => setTransferForm((f) => ({ ...f, notes: e.target.value }))}
                    placeholder="Notes"
                  />
                  <button
                    className="admin-btn admin-btn-primary"
                    disabled={processing || !transferForm.clubId || !transferForm.amount}
                    onClick={async () => {
                      setProcessing(true);
                      setError(null);
                      try {
                        const chipAmount = parseInt(transferForm.amount, 10);
                        if (isNaN(chipAmount) || chipAmount <= 0) {
                          setError('Enter a valid chip amount');
                          setProcessing(false);
                          return;
                        }
                        // Atomic RPC: debits union_wallets, credits club wallet, logs to union_transactions
                        const { data: result, error: rpcErr } = await supabase.rpc(
                          'fn_union_send_chips_to_club',
                          {
                            p_union_id: unionId,
                            p_club_id: transferForm.clubId,
                            p_amount: chipAmount,
                            p_notes: transferForm.notes || null,
                          }
                        );
                        if (rpcErr) throw rpcErr;
                        setSuccess(`Sent ${chipAmount.toLocaleString()} chips to club`);
                        masterBus.emit('BALANCE_UPDATED', { source: 'union_transfer' });
                        setTransferForm({ clubId: '', amount: '', notes: '' });
                        loadDashboard(unionId);
                      } catch (err: any) {
                        setError(err.message);
                      } finally {
                        setProcessing(false);
                      }
                    }}
                  >
                    Send
                  </button>
                </div>
              </div>
            )}

            {/* TRANSACTION HISTORY from chip_ledger */}
            <TransactionLedgerView unionId={unionId || undefined} userId={user?.id || ''} />
          </div>
        )}

        {/* ══════ TAB: TREASURY ══════ */}
        {tab === 'treasury' && (
          <div className="admin-tab-content">
            <h3 className="admin-section-title">🏦 Club Treasury Breakdown</h3>
            {clubs.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">🏦</span>
                <span>No clubs yet</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Club</th>
                      <th>Treasury</th>
                      <th>Agents</th>
                      <th>Members</th>
                      <th>Health</th>
                    </tr>
                  </thead>
                  <tbody>
                    {clubs.map((c) => {
                      const treasury = c.chip_treasury || 0;
                      const agentCount = agents.filter((a) => a.club_id === c.id).length;
                      const health =
                        treasury > 100000
                          ? 'Excellent'
                          : treasury > 10000
                            ? 'Good'
                            : treasury > 0
                              ? 'Low'
                              : 'Empty';
                      const healthColor =
                        treasury > 100000
                          ? '#31A24C'
                          : treasury > 10000
                            ? '#4599FF'
                            : treasury > 0
                              ? '#F7C52A'
                              : '#FA383E';
                      return (
                        <tr key={c.id}>
                          <td style={{ fontWeight: 600 }}>{c.name}</td>
                          <td style={{ fontWeight: 700, color: '#31A24C' }}>{fmt(treasury)}</td>
                          <td>{agentCount}</td>
                          <td>{fmt(c.member_count)}</td>
                          <td>
                            <span style={{ color: healthColor, fontWeight: 600 }}>{health}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="admin-stats-grid" style={{ marginTop: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {fmt(clubs.reduce((s, c) => s + (c.chip_treasury || 0), 0))}
                </div>
                <div className="admin-stat-label">Total Treasury</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {fmt(agents.length)}
                </div>
                <div className="admin-stat-label">Total Agents</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">
                  {fmt(clubs.reduce((s, c) => s + (c.member_count || 0), 0))}
                </div>
                <div className="admin-stat-label">Total Members</div>
              </div>
            </div>
          </div>
        )}

        {/* ══════ TAB: ANALYTICS ══════ */}
        {tab === 'analytics' && (
          <div className="admin-tab-content">
            <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {fmt(clubs.length)}
                </div>
                <div className="admin-stat-label">Total Clubs</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {fmt(agents.length)}
                </div>
                <div className="admin-stat-label">Active Agents</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">
                  {fmt(clubs.reduce((s, c) => s + (c.member_count || 0), 0))}
                </div>
                <div className="admin-stat-label">Total Members</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                  {fmt(recentPeriods.filter((p) => p.status === 'open').length)}
                </div>
                <div className="admin-stat-label">Open Periods</div>
              </div>
            </div>

            {/* Settlement Periods */}
            <h3 className="admin-section-title">Recent Settlement Periods</h3>
            {recentPeriods.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">📊</span>
                <span>No settlement data yet</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Club</th>
                      <th>Period</th>
                      <th>Rake</th>
                      <th>Hands</th>
                      <th>Status</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recentPeriods.slice(0, 20).map((p) => {
                      const club = clubs.find((c) => c.id === p.club_id);
                      return (
                        <tr key={p.id}>
                          <td>{club?.name || 'Unknown'}</td>
                          <td>#{p.period_number}</td>
                          <td style={{ color: '#31A24C' }}>{fmt(p.total_rake_collected)}</td>
                          <td>{fmt(p.total_hands_dealt)}</td>
                          <td>
                            <span className="admin-badge">{p.status}</span>
                          </td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {timeAgo(p.created_at)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: APPLICATIONS ══════ */}
        {tab === 'applications' && (
          <div className="admin-tab-content">
            {!appsLoaded && (
              <div style={{ textAlign: 'center', padding: '24px', color: 'var(--text-secondary)' }}>
                Loading applications...
              </div>
            )}
            <div
              style={{ display: 'flex', gap: '8px', marginBottom: '16px', alignItems: 'center' }}
            >
              <select
                className="admin-input"
                style={{ maxWidth: '200px' }}
                value={appsFilter}
                onChange={(e) => {
                  setAppsFilter(e.target.value);
                  setAppsLoaded(false);
                }}
              >
                <option value="pending">Pending</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
                <option value="all">All</option>
              </select>
              <button
                className="admin-btn admin-btn-ghost"
                onClick={() => {
                  setAppsLoaded(false);
                  loadApps();
                }}
              >
                Refresh
              </button>
            </div>

            {apps.length > 0 ? (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: '12px',
                }}
              >
                {apps.map((app) => (
                  <div key={app.id} className="admin-card" style={{ padding: '14px 16px' }}>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginBottom: '8px',
                      }}
                    >
                      <div style={{ fontWeight: 600 }}>{app.club_name}</div>
                      <span className="admin-badge">{app.status}</span>
                    </div>
                    {app.notes && (
                      <div
                        style={{
                          fontSize: '13px',
                          color: 'var(--text-secondary)',
                          fontStyle: 'italic',
                          marginBottom: '6px',
                        }}
                      >
                        "{app.notes}"
                      </div>
                    )}
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                      Applied {timeAgo(app.applied_at || app.created_at)}
                    </div>
                    {app.status === 'pending' && isLead && (
                      <div style={{ display: 'flex', gap: '6px', marginTop: '10px' }}>
                        <button
                          className="admin-btn admin-btn-success admin-btn-sm"
                          disabled={processing}
                          onClick={async () => {
                            setProcessing(true);
                            setError(null);
                            try {
                              // 1. Join club to union FIRST (if join fails, app stays pending → recoverable)
                              if (app.club_id) {
                                const defaultCommRate =
                                  Number(union?.settings?.default_club_commission_rate) || 0.9;
                                const { error: joinErr } = await supabase
                                  .from('union_clubs')
                                  .upsert(
                                    {
                                      union_id: unionId,
                                      club_id: app.club_id,
                                      commission_rate: defaultCommRate,
                                    },
                                    { onConflict: 'union_id,club_id' }
                                  );
                                if (joinErr)
                                  throw new Error(
                                    'Failed to join club to union: ' + joinErr.message
                                  );

                                // 2. Update clubs.union_id so the club is associated
                                const { error: clubErr } = await supabase
                                  .from('clubs')
                                  .update({ union_id: unionId })
                                  .eq('id', app.club_id);
                                if (clubErr)
                                  throw new Error('Failed to associate club: ' + clubErr.message);

                                masterBus.emit('CLUB_UPDATED', { clubId: app.club_id });
                              }

                              // 3. Mark application as approved LAST (only after join succeeded)
                              const { error: appErr } = await supabase
                                .from('union_applications')
                                .update({ status: 'approved' })
                                .eq('id', app.id);
                              if (appErr) throw appErr;

                              setSuccess(`${app.club_name} approved and joined the union`);
                              setAppsLoaded(false);
                              loadApps();
                              loadDashboard(unionId);
                            } catch (err: any) {
                              setError(err.message);
                            } finally {
                              setProcessing(false);
                            }
                          }}
                        >
                          Approve
                        </button>
                        <button
                          className="admin-btn admin-btn-danger admin-btn-sm"
                          disabled={processing}
                          onClick={async () => {
                            if (!confirm(`Reject ${app.club_name}?`)) return;
                            setProcessing(true);
                            setError(null);
                            try {
                              const { error: rejErr } = await supabase
                                .from('union_applications')
                                .update({ status: 'rejected' })
                                .eq('id', app.id);
                              if (rejErr) throw rejErr;
                              setSuccess(`${app.club_name} rejected`);
                              setAppsLoaded(false);
                              loadApps();
                            } catch (err: any) {
                              setError(err.message);
                            } finally {
                              setProcessing(false);
                            }
                          }}
                        >
                          Reject
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">📝</span>
                <span>No {appsFilter} applications</span>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: SETTINGS ══════ */}
        {tab === 'settings' && (
          <div className="admin-tab-content">
            {isLead ? (
              <div className="admin-card" style={{ padding: '20px' }}>
                <h3 className="admin-card-title">Union Settings</h3>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))',
                    gap: '12px',
                    marginBottom: '16px',
                  }}
                >
                  <div>
                    <label className="admin-label">Union Name</label>
                    <input
                      className="admin-input"
                      value={settingsForm.name ?? union?.name ?? ''}
                      onChange={(e) => setSettingsForm((f) => ({ ...f, name: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="admin-label">Rake Hold (%)</label>
                    <input
                      className="admin-input"
                      type="number"
                      min="0"
                      max="50"
                      step="0.1"
                      value={
                        settingsForm.union_rake_hold ??
                        (Number(union?.settings?.union_rake_hold) || 0.1) * 100
                      }
                      onChange={(e) =>
                        setSettingsForm((f) => ({ ...f, union_rake_hold: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="admin-label">Default Agent Comm (%)</label>
                    <input
                      className="admin-input"
                      type="number"
                      min="0"
                      max="100"
                      step="0.1"
                      value={
                        settingsForm.default_agent_commission ??
                        (Number(union?.settings?.default_agent_commission) || 0.5) * 100
                      }
                      onChange={(e) =>
                        setSettingsForm((f) => ({ ...f, default_agent_commission: e.target.value }))
                      }
                    />
                  </div>
                  <div>
                    <label className="admin-label">Default Club Comm (%)</label>
                    <input
                      className="admin-input"
                      type="number"
                      min="1"
                      max="100"
                      step="0.1"
                      value={
                        settingsForm.default_club_commission_rate ??
                        (Number(union?.settings?.default_club_commission_rate) || 0.9) * 100
                      }
                      onChange={(e) =>
                        setSettingsForm((f) => ({
                          ...f,
                          default_club_commission_rate: e.target.value,
                        }))
                      }
                    />
                  </div>
                </div>
                <textarea
                  className="admin-input"
                  value={settingsForm.description ?? union?.description ?? ''}
                  onChange={(e) => setSettingsForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="Description..."
                  rows={3}
                  style={{ marginBottom: '12px', resize: 'vertical' }}
                />
                <button
                  className="admin-btn admin-btn-primary"
                  disabled={processing}
                  onClick={async () => {
                    setProcessing(true);
                    setError(null);
                    try {
                      const updates: Record<
                        string,
                        string | Record<string, number | string | boolean>
                      > = {};
                      if (settingsForm.name) updates.name = settingsForm.name;
                      if (settingsForm.description !== undefined)
                        updates.description = settingsForm.description;
                      const settings: Record<string, number | string | boolean> = {};
                      if (settingsForm.union_rake_hold) {
                        const v = parseFloat(settingsForm.union_rake_hold) / 100;
                        if (isNaN(v)) {
                          setError('Invalid rake hold value');
                          setProcessing(false);
                          return;
                        }
                        settings.union_rake_hold = v;
                      }
                      if (settingsForm.default_agent_commission) {
                        const v = parseFloat(settingsForm.default_agent_commission) / 100;
                        if (isNaN(v)) {
                          setError('Invalid agent commission value');
                          setProcessing(false);
                          return;
                        }
                        settings.default_agent_commission = v;
                      }
                      if (settingsForm.default_club_commission_rate) {
                        const v = parseFloat(settingsForm.default_club_commission_rate) / 100;
                        if (isNaN(v)) {
                          setError('Invalid club commission value');
                          setProcessing(false);
                          return;
                        }
                        settings.default_club_commission_rate = v;
                      }
                      if (Object.keys(settings).length > 0)
                        updates.settings = { ...(union?.settings || {}), ...settings };
                      const { error: setErr } = await supabase
                        .from('unions')
                        .update(updates)
                        .eq('id', unionId);
                      if (setErr) throw setErr;
                      masterBus.emit('CLUB_UPDATED', { clubId: unionId || '' });
                      setSuccess('Settings saved');
                      loadDashboard(unionId);
                    } catch (err: any) {
                      setError(err.message);
                    } finally {
                      setProcessing(false);
                    }
                  }}
                >
                  Save Settings
                </button>
              </div>
            ) : (
              <div className="admin-card" style={{ padding: '20px' }}>
                <h3 className="admin-card-title">Union Settings (Read Only)</h3>
                <div className="admin-text-secondary">
                  <div>Rake Hold: {pct(Number(union?.settings?.union_rake_hold))}</div>
                  <div>
                    Agent Commission: {pct(Number(union?.settings?.default_agent_commission))}
                  </div>
                  <div>
                    Club Commission: {pct(Number(union?.settings?.default_club_commission_rate))}
                  </div>
                </div>
              </div>
            )}

            {/* Admin Management */}
            <div className="admin-card" style={{ padding: '20px', marginTop: '16px' }}>
              <h3 className="admin-card-title">Union Admins</h3>
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Admin</th>
                      <th>Role</th>
                      <th>Since</th>
                      {isLead && <th>Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {admins.map((admin) => (
                      <tr key={admin.user_id}>
                        <td style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          {admin.profile?.avatar_url && (
                            <img
                              src={admin.profile.avatar_url}
                              alt=""
                              style={{ width: 28, height: 28, borderRadius: '50%' }}
                            />
                          )}
                          {admin.profile?.display_name ||
                            admin.profile?.username ||
                            admin.user_id?.slice(0, 8)}
                        </td>
                        <td>
                          <span
                            className="admin-badge"
                            style={
                              admin.role === 'union_lead'
                                ? { background: 'rgba(245,166,35,0.15)', color: '#F5A623' }
                                : undefined
                            }
                          >
                            {admin.role}
                          </span>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {timeAgo(admin.created_at)}
                        </td>
                        {isLead && (
                          <td>
                            {admin.role !== 'union_lead' && (
                              <button
                                className="admin-btn admin-btn-danger admin-btn-sm"
                                disabled={processing}
                                onClick={async () => {
                                  if (!confirm('Remove this admin?')) return;
                                  setProcessing(true);
                                  setError(null);
                                  try {
                                    const { error: delErr } = await supabase
                                      .from('union_admins')
                                      .delete()
                                      .eq('union_id', unionId)
                                      .eq('user_id', admin.user_id);
                                    if (delErr) throw delErr;
                                    masterBus.emit('CLUB_UPDATED', { clubId: unionId || '' });
                                    setSuccess('Admin removed');
                                    loadDashboard(unionId);
                                  } catch (err: any) {
                                    setError(err.message);
                                  } finally {
                                    setProcessing(false);
                                  }
                                }}
                              >
                                Remove
                              </button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Add Admin */}
              {isLead && (
                <div style={{ marginTop: '16px' }}>
                  <label className="admin-label">Add Admin</label>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input
                      className="admin-input"
                      value={adminSearch}
                      onChange={(e) => setAdminSearch(e.target.value)}
                      placeholder="Search by username..."
                    />
                    <button
                      className="admin-btn admin-btn-ghost"
                      disabled={processing || adminSearch.length < 2}
                      onClick={async () => {
                        setProcessing(true);
                        setError(null);
                        try {
                          const { data: users } = await supabase
                            .from('profiles')
                            .select('id, display_name, username')
                            .ilike('username', `%${adminSearch}%`)
                            .limit(5);
                          setAdminResults(users || []);
                        } catch (err: any) {
                          setError(err.message);
                        } finally {
                          setProcessing(false);
                        }
                      }}
                    >
                      Search
                    </button>
                  </div>
                  {adminResults.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '6px',
                        marginTop: '8px',
                      }}
                    >
                      {adminResults.map((u) => (
                        <div
                          key={u.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            padding: '8px 12px',
                            background: 'var(--bg-secondary)',
                            borderRadius: '8px',
                          }}
                        >
                          <span>{u.display_name || u.username || u.id.slice(0, 8)}</span>
                          <button
                            className="admin-btn admin-btn-success admin-btn-sm"
                            disabled={processing}
                            onClick={async () => {
                              setProcessing(true);
                              setError(null);
                              try {
                                const { error: addErr } = await supabase
                                  .from('union_admins')
                                  .insert({
                                    union_id: unionId,
                                    user_id: u.id,
                                    role: 'union_admin',
                                  });
                                if (addErr) throw addErr;
                                masterBus.emit('CLUB_UPDATED', { clubId: unionId || '' });
                                setSuccess(`${u.display_name || u.username} added as admin`);
                                setAdminResults([]);
                                setAdminSearch('');
                                loadDashboard(unionId);
                              } catch (err: any) {
                                setError(err.message);
                              } finally {
                                setProcessing(false);
                              }
                            }}
                          >
                            Add
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
