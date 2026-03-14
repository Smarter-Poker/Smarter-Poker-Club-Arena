/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  UNION DASHBOARD PAGE — Union Operations Center
 *  Ported from World Hub union-dashboard.js → Club Arena TypeScript
 *
 *  8 Tabs: Overview, Clubs, Agents, Wallet, Treasury, Analytics, Applications, Settings
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import './AdminDashboardPage.css';

// ── Helpers ─────────────────────────────────────────────────
const fmt = (n: number | null | undefined) => Number(n || 0).toLocaleString();
const pct = (n: number | null | undefined) => `${((Number(n) || 0) * 100).toFixed(1)}%`;
const _fmtChips = (n: number | null | undefined) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return fmt(v);
};
const timeAgo = (ts: string | null | undefined) => {
  if (!ts) return '';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

type UnionTab =
  | 'overview'
  | 'clubs'
  | 'agents'
  | 'wallet'
  | 'treasury'
  | 'analytics'
  | 'applications'
  | 'settings';

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
  const [union, setUnion] = useState<any>(null);
  const [adminRole, setAdminRole] = useState<string | null>(null);
  const [clubs, setClubs] = useState<any[]>([]);
  const [agents, setAgents] = useState<any[]>([]);
  const [admins, setAdmins] = useState<any[]>([]);
  const [wallets, setWallets] = useState<any>(null);
  const [recentPeriods, setRecentPeriods] = useState<any[]>([]);

  // Applications
  const [apps, setApps] = useState<any[]>([]);
  const [appsFilter, setAppsFilter] = useState('pending');
  const [appsLoaded, setAppsLoaded] = useState(false);
  const [_leaveRequests, setLeaveRequests] = useState<any[]>([]);

  // Activity
  const [_recentTx, _setRecentTx] = useState<any[]>([]);
  const [_txPage, _setTxPage] = useState(1);
  const _TX_PER_PAGE = 25;

  // Wallet transfer form
  const [transferForm, setTransferForm] = useState({ clubId: '', amount: '', notes: '' });
  const [_rakeAmount, _setRakeAmount] = useState('');

  // Search / Filter
  const [clubSearch, setClubSearch] = useState('');
  const [agentSearch, setAgentSearch] = useState('');

  // Settings form
  const [settingsForm, setSettingsForm] = useState<Record<string, any>>({});

  // Commission edit modal
  const [editCommClub, setEditCommClub] = useState<any>(null);
  const [editCommRate, setEditCommRate] = useState('');

  // Announcement
  const [annMsg, setAnnMsg] = useState('');
  const [annClub, setAnnClub] = useState('');

  // Admin search
  const [adminSearch, setAdminSearch] = useState('');
  const [adminResults, setAdminResults] = useState<any[]>([]);

  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    []
  );

  // Auto-clear success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  // ── Cache Invalidation on Union Change ─────────────────────
  useEffect(() => {
    setAppsLoaded(false);
    setApps([]);
  }, [unionId]);

  // ── Load Dashboard ─────────────────────────────────────────
  const loadDashboard = useCallback(
    async (uid?: string | null) => {
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
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [unionId, user?.id]
  );

  const loadUnionData = async (uid: string) => {
    // Load union info
    const { data: unionRow } = await supabase
      .from('unions')
      .select('*')
      .eq('id', uid)
      .maybeSingle();
    if (mountedRef.current) setUnion(unionRow);

    // Load clubs in union
    const { data: unionClubs } = await supabase
      .from('union_clubs')
      .select('*, clubs:club_id(*)')
      .eq('union_id', uid);
    const enrichedClubs = (unionClubs || []).map((uc: any) => ({
      id: uc.club_id,
      ...uc.clubs,
      club_commission_rate: uc.commission_rate || 0.9,
    }));
    if (mountedRef.current) setClubs(enrichedClubs);

    // Load agents across clubs
    const clubIds = enrichedClubs.map((c: any) => c.id).filter(Boolean);
    if (clubIds.length > 0) {
      const { data: agentRows } = await supabase
        .from('club_members')
        .select('*, profiles:user_id(display_name, username, avatar_url)')
        .in('club_id', clubIds)
        .in('role', ['agent', 'sub_agent', 'super_agent']);

      if (mountedRef.current) setAgents(agentRows || []);
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
      .select('*')
      .eq('union_id', uid)
      .maybeSingle();
    if (mountedRef.current) setWallets(walletRow);

    // Load settlement periods
    const { data: periods } = await supabase
      .from('settlement_periods')
      .select('*')
      .in('club_id', clubIds.length > 0 ? clubIds : ['__none__'])
      .order('created_at', { ascending: false })
      .limit(30);
    if (mountedRef.current) setRecentPeriods(periods || []);
  };

  // ── Initial Load ───────────────────────────────────────────
  useEffect(() => {
    if (!user?.id) return;
    loadDashboard();
  }, [user?.id, loadDashboard]);

  // ── Load Applications ──────────────────────────────────────
  const loadApps = useCallback(async () => {
    if (!unionId) return;
    try {
      let query = supabase
        .from('union_applications')
        .select('*')
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

  const _loadLeaveRequests = async () => {
    if (!unionId) return;
    try {
      const { data } = await supabase
        .from('union_leave_requests')
        .select('*')
        .eq('union_id', unionId)
        .eq('status', 'pending');
      if (mountedRef.current) setLeaveRequests(data || []);
    } catch (_e) {
      /* silent */
    }
  };

  // ── Bus Listeners ──────────────────────────────────────────
  useEffect(() => {
    if (!unionId) return;
    const refresh = () => loadDashboard(unionId);
    const unsubs = [
      masterBus.subscribe('CLUB_UPDATED', refresh),
      masterBus.subscribe('CHIPS_DISTRIBUTED', refresh),
      masterBus.subscribe('AGENT_UPDATED', refresh),
      masterBus.subscribe('CASHOUT_APPROVED', refresh),
      masterBus.subscribe('CASHOUT_REQUESTED', refresh),
      masterBus.subscribe('TABLE_CREATED', refresh),
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
      .subscribe();
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [unionId, loadDashboard]);

  // ── Visibility Refresh — refresh on tab focus after 30s ──
  useEffect(() => {
    let lastFetch = Date.now();
    const handleVis = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastFetch > 30_000) {
        lastFetch = Date.now();
        loadDashboard(unionId);
      }
    };
    document.addEventListener('visibilitychange', handleVis);
    return () => document.removeEventListener('visibilitychange', handleVis);
  }, [unionId, loadDashboard]);

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
      (a: any) =>
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
    const rows = agents.map((a: any) => {
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
          <div className="admin-modal-overlay" onClick={() => setEditCommClub(null)}>
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
                    if (rate < 0.01 || rate > 1) {
                      setError('Rate must be 1-100%');
                      return;
                    }
                    setProcessing(true);
                    try {
                      await supabase
                        .from('union_clubs')
                        .update({ commission_rate: rate })
                        .eq('union_id', unionId)
                        .eq('club_id', editCommClub.id);
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
          </div>
          <div className="admin-header-actions">
            <button
              onClick={() => navigate('/union-games')}
              className="admin-btn admin-btn-primary"
            >
              🎮 Games
            </button>
            <button onClick={() => navigate('/lobby')} className="admin-btn admin-btn-ghost">
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
                      try {
                        await supabase.from('union_announcements').insert({
                          union_id: unionId,
                          message: annMsg,
                          club_id: annClub || null,
                          created_by: user?.id,
                        });
                        setSuccess('Announcement sent');
                        setAnnMsg('');
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
                          try {
                            await supabase
                              .from('union_clubs')
                              .delete()
                              .eq('union_id', unionId)
                              .eq('club_id', club.id);
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
                  {fmt(agents.filter((a: any) => a.status === 'active').length)}
                </div>
                <div className="admin-stat-label">Active</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                  {fmt(agents.filter((a: any) => a.status === 'suspended').length)}
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
                  {filteredAgents.map((agent: any) => {
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
                      try {
                        await supabase.from('union_transactions').insert({
                          union_id: unionId,
                          club_id: transferForm.clubId,
                          amount: parseInt(transferForm.amount),
                          tx_type: 'send_to_club',
                          wallet: 'chip',
                          direction: 'debit',
                          notes: transferForm.notes || undefined,
                        });
                        setSuccess('Chips sent');
                        setTransferForm({ clubId: '', amount: '', notes: '' });
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
                      const agentCount = agents.filter((a: any) => a.club_id === c.id).length;
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
                {apps.map((app: any) => (
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
                    {app.message && (
                      <div
                        style={{
                          fontSize: '13px',
                          color: 'var(--text-secondary)',
                          fontStyle: 'italic',
                          marginBottom: '6px',
                        }}
                      >
                        "{app.message}"
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
                            try {
                              await supabase
                                .from('union_applications')
                                .update({ status: 'approved' })
                                .eq('id', app.id);
                              setSuccess(`${app.club_name} approved`);
                              setAppsLoaded(false);
                              loadApps();
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
                            try {
                              await supabase
                                .from('union_applications')
                                .update({ status: 'rejected' })
                                .eq('id', app.id);
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
                        (union?.settings?.union_rake_hold || 0.1) * 100
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
                        (union?.settings?.default_agent_commission || 0.5) * 100
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
                        (union?.settings?.default_club_commission_rate || 0.9) * 100
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
                    try {
                      const updates: any = {};
                      if (settingsForm.name) updates.name = settingsForm.name;
                      if (settingsForm.description !== undefined)
                        updates.description = settingsForm.description;
                      const settings: any = {};
                      if (settingsForm.union_rake_hold)
                        settings.union_rake_hold = parseFloat(settingsForm.union_rake_hold) / 100;
                      if (settingsForm.default_agent_commission)
                        settings.default_agent_commission =
                          parseFloat(settingsForm.default_agent_commission) / 100;
                      if (settingsForm.default_club_commission_rate)
                        settings.default_club_commission_rate =
                          parseFloat(settingsForm.default_club_commission_rate) / 100;
                      if (Object.keys(settings).length > 0)
                        updates.settings = { ...(union?.settings || {}), ...settings };
                      await supabase.from('unions').update(updates).eq('id', unionId);
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
                  <div>Rake Hold: {pct(union?.settings?.union_rake_hold)}</div>
                  <div>Agent Commission: {pct(union?.settings?.default_agent_commission)}</div>
                  <div>Club Commission: {pct(union?.settings?.default_club_commission_rate)}</div>
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
                    {admins.map((admin: any) => (
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
                                  try {
                                    await supabase
                                      .from('union_admins')
                                      .delete()
                                      .eq('union_id', unionId)
                                      .eq('user_id', admin.user_id);
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
                              try {
                                await supabase.from('union_admins').insert({
                                  union_id: unionId,
                                  user_id: u.id,
                                  role: 'union_admin',
                                });
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
