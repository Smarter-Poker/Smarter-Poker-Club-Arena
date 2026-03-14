/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT DASHBOARD PAGE — Agent Operations Center
 * Ported from World Hub agent-dashboard.js → Club Arena TypeScript
 *
 * Tabs (8): Overview, Players, Cashouts, Commissions, Score, Analytics, Promo, Credit
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { resolveClubUUID } from '../utils/clubIdResolver';
import { cashoutService } from '../services/CashoutService';
import { WalletService } from '../services/WalletService';
import { CreditService } from '../services/CreditService';
import './AdminDashboardPage.css';

import { useIsMounted } from '../hooks/useIsMounted';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';

// ── Helpers ─────────────────────────────────────────────────
const fmt = (n: number | null | undefined) => Number(n || 0).toLocaleString();
const fmtChips = (n: number | null | undefined) => {
  const v = Number(n || 0);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return fmt(v);
};
const timeAgo = (ts: string | null | undefined) => {
  if (!ts) return 'Never';
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
};

type AgentTab =
  | 'overview'
  | 'players'
  | 'cashouts'
  | 'commissions'
  | 'score'
  | 'analytics'
  | 'promo'
  | 'credit';

export default function AgentDashboardPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuthUser();

  const [tab, setTab] = useState<AgentTab>('overview');
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [clubId, setClubId] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [role, setRole] = useState('agent');

  // Overview data
  const [players, setPlayers] = useState<any[]>([]);
  const [pendingCashouts, setPendingCashouts] = useState<any[]>([]);
  const [commissions, setCommissions] = useState<any[]>([]);
  const [recentTx, setRecentTx] = useState<any[]>([]);

  // Search / Filter
  const [playerSearch, setPlayerSearch] = useState('');
  const [txPage, setTxPage] = useState(1);
  const TX_PER_PAGE = 20;

  // Transfer modal
  const [showTransfer, setShowTransfer] = useState(false);
  const [transferTarget, setTransferTarget] = useState('');
  const [transferAmount, setTransferAmount] = useState('');
  const [transferNotes, setTransferNotes] = useState('');

  // Credit management (owner-only)
  const [creditTarget, setCreditTarget] = useState('');
  const [creditAction, setCreditAction] = useState('issue_credit');
  const [creditAmount, setCreditAmount] = useState('');
  const [creditNotes, setCreditNotes] = useState('');

  // Agents list (for promo/credit selectors)
  const [agents, setAgents] = useState<any[]>([]);

  const mountedRef = useIsMounted();

  // Auto-clear success
  useEffect(() => {
    if (!success) return;
    const t = setTimeout(() => setSuccess(null), 4000);
    return () => clearTimeout(t);
  }, [success]);

  // ── Load Dashboard Data ───────────────────────────────────
  const loadDashboard = useCallback(
    async (cId: string | null) => {
      try {
        setLoading(true);
        setError(null);
        const targetClubId = cId || clubId;
        if (!targetClubId || !user?.id) {
          setError('No club selected.');
          setLoading(false);
          return;
        }

        const uuid = await resolveClubUUID(targetClubId);

        // Get current user's role
        const { data: membership } = await supabase
          .from('club_members')
          .select('role')
          .eq('club_id', uuid)
          .eq('user_id', user.id)
          .maybeSingle();
        if (mountedRef.current) setRole(membership?.role || 'agent');

        // Get agent's players (downline)
        const { data: downline } = await supabase
          .from('club_members')
          .select('user_id, role, chip_balance, status, created_at, referred_by')
          .eq('club_id', uuid);

        // Filter to downline for non-owners
        const myDownline = (downline || []).filter(
          (m: any) =>
            membership?.role === 'owner' ||
            membership?.role === 'admin' ||
            m.referred_by === user.id
        );

        // Get profiles for all relevant users
        const allUserIds = (downline || []).map((m: any) => m.user_id).filter(Boolean);
        const profileMap: Record<string, any> = {};
        if (allUserIds.length > 0) {
          const { data: profiles } = await supabase
            .from('profiles')
            .select('id, display_name, username, avatar_url, last_seen_at')
            .in('id', allUserIds);
          if (profiles)
            profiles.forEach((p: any) => {
              profileMap[p.id] = p;
            });
        }

        // Enrich players with profiles
        const enrichedPlayers = myDownline.map((m: any) => ({
          ...m,
          profile: profileMap[m.user_id] || {},
        }));

        // Get pending cashouts
        const { data: cashouts } = await supabase
          .from('cashout_requests')
          .select(
            'id, user_id, club_id, amount, status, notes, payment_method, created_at, updated_at'
          )
          .eq('club_id', uuid)
          .eq('status', 'pending')
          .order('created_at', { ascending: false });

        // Get commission history
        const { data: comms } = await supabase
          .from('agent_commissions')
          .select('id, user_id, club_id, amount, commission_type, source_player_id, created_at')
          .eq('club_id', uuid)
          .eq('user_id', user.id)
          .order('created_at', { ascending: false })
          .limit(50);

        // Get recent transactions
        const { data: txns } = await supabase
          .from('chip_transactions')
          .select('id, user_id, club_id, amount, type, description, reference_id, created_at')
          .eq('club_id', uuid)
          .order('created_at', { ascending: false })
          .limit(100);

        // Get agents list
        const agentList = (downline || [])
          .filter((m: any) => ['agent', 'sub_agent', 'super_agent'].includes(m.role))
          .map((m: any) => ({
            ...m,
            profile: profileMap[m.user_id] || {},
          }));

        if (!mountedRef.current) return;
        setPlayers(enrichedPlayers);
        setPendingCashouts(cashouts || []);
        setCommissions(comms || []);
        setRecentTx(txns || []);
        setAgents(agentList);
      } catch (err: any) {
        if (mountedRef.current) setError(err.message);
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [clubId, user?.id]
  );

  // ── Initial Load ──────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const init = async () => {
      if (!user?.id) return;
      const qClub = searchParams.get('club') || searchParams.get('clubId');
      let targetClub = qClub;

      if (!targetClub) {
        const { data: mems } = await supabase
          .from('club_members')
          .select('club_id')
          .eq('user_id', user.id)
          .in('role', ['agent', 'sub_agent', 'super_agent', 'owner', 'admin']);
        if (mems && mems.length > 0) targetClub = mems[0].club_id;
      }

      if (targetClub && !cancelled) {
        setClubId(targetClub);
        loadDashboard(targetClub);
      } else if (!cancelled) {
        setError('No club found or selected.');
        setLoading(false);
      }
    };
    init();
    return () => {
      cancelled = true;
    };
  }, [user?.id, searchParams, loadDashboard]);

  // ── Bus Listeners (debounced + clubId-filtered) ──────────
  // Use non-blocking refresh for bus events (doesn't show full loading skeleton)
  const refreshDashboard = useCallback(
    async (cId: string | null) => {
      setIsRefreshing(true);
      try {
        await loadDashboard(cId);
      } finally {
        if (mountedRef.current) setIsRefreshing(false);
      }
    },
    [loadDashboard]
  );

  useEffect(() => {
    if (!clubId) return;
    const refresh = () => refreshDashboard(clubId);
    // Filtered refresh: only reload if the event is for this club (or has no clubId)
    const filteredRefresh = (event?: any) => {
      if (!event?.payload?.clubId || event.payload.clubId === clubId) {
        refresh();
      }
    };
    const unsubs = [
      masterBus.subscribeDebounced('CASHOUT_APPROVED', filteredRefresh, 300),
      masterBus.subscribeDebounced('CASHOUT_CANCELLED', filteredRefresh, 300),
      masterBus.subscribeDebounced('CASHOUT_REQUESTED', filteredRefresh, 300),
      masterBus.subscribeDebounced('CHIPS_DISTRIBUTED', filteredRefresh, 300),
      masterBus.subscribeDebounced('AGENT_UPDATED', filteredRefresh, 300),
      masterBus.subscribeDebounced('BALANCE_UPDATED', refresh, 300),
      masterBus.subscribeDebounced('CREDIT_UPDATED', filteredRefresh, 300),
      masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', filteredRefresh, 300),
    ];
    return () => unsubs.forEach((u) => u());
  }, [clubId, refreshDashboard]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    if (!clubId) return;
    const channelKey = `agent-dashboard-${clubId}`;
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'cashout_requests', filter: `club_id=eq.${clubId}` },
        () => loadDashboard(clubId)
      )
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'chip_transactions',
          filter: `club_id=eq.${clubId}`,
        },
        () => loadDashboard(clubId)
      )
      .subscribe();
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [clubId, loadDashboard]);

  // ── Visibility Refresh — refresh on tab focus after 30s ──
  useVisibilityRefresh(() => loadDashboard(clubId));

  // ── Cashout Actions ────────────────────────────────────────
  const approveCashout = async (cashoutId: string) => {
    if (!confirm('Approve this cashout request?')) return;
    setProcessing(true);
    setError(null);
    try {
      await cashoutService.approveCashout(cashoutId, user?.id || '');
      setSuccess('Cashout approved successfully.');
      loadDashboard(clubId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProcessing(false);
    }
  };

  const denyCashout = async (cashoutId: string) => {
    if (!confirm('Deny and refund this cashout request?')) return;
    setProcessing(true);
    setError(null);
    try {
      await cashoutService.rejectCashout(cashoutId, user?.id || '', 'Denied by agent');
      setSuccess('Cashout denied and chips refunded to player.');
      loadDashboard(clubId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProcessing(false);
    }
  };

  // ── Transfer ───────────────────────────────────────────────
  const executeTransfer = async () => {
    if (!transferTarget || !transferAmount || !clubId) return;
    setProcessing(true);
    setError(null);
    try {
      const uuid = await resolveClubUUID(clubId);
      const amt = parseFloat(transferAmount);
      if (isNaN(amt) || amt <= 0) throw new Error('Invalid transfer amount');
      await WalletService.transferToUser(user?.id || '', transferTarget, amt);
      setSuccess(`Transferred ${fmtChips(amt)} chips.`);
      masterBus.emit('CHIPS_DISTRIBUTED', { clubId: uuid, amount: amt });
      setShowTransfer(false);
      setTransferTarget('');
      setTransferAmount('');
      setTransferNotes('');
      loadDashboard(clubId);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setProcessing(false);
    }
  };

  // ── Derived Data ───────────────────────────────────────────
  const filteredPlayers = useMemo(() => {
    if (!playerSearch) return players;
    const q = playerSearch.toLowerCase();
    return players.filter((p) => {
      const name = (
        p.profile?.display_name ||
        p.profile?.username ||
        p.user_id ||
        ''
      ).toLowerCase();
      return name.includes(q);
    });
  }, [players, playerSearch]);

  const paginatedTx = recentTx.slice(0, txPage * TX_PER_PAGE);
  const totalPlayerChips = players.reduce((sum, p) => sum + (p.chip_balance || 0), 0);
  const onlinePlayers = players.filter((p) => {
    const lastSeen = p.profile?.last_seen_at;
    if (!lastSeen) return false;
    return Date.now() - new Date(lastSeen).getTime() < 300000;
  });

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
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="admin-skeleton" style={{ height: '80px' }} />
            ))}
          </div>
          <div className="admin-skeleton" style={{ height: '36px', marginTop: '16px' }} />
          {[1, 2, 3].map((i) => (
            <div key={i} className="admin-skeleton" style={{ height: '60px', marginTop: '8px' }} />
          ))}
        </div>
      </div>
    );
  }

  const isOwnerOrAdmin = ['owner', 'admin'].includes(role);
  const isOwner = role === 'owner';

  return (
    <div className="admin-page">
      <div className="admin-container">
        {/* Banners */}
        {error && <div className="admin-error-banner">{error}</div>}
        {success && <div className="admin-success-banner">{success}</div>}

        {/* Transfer Modal */}
        {showTransfer && (
          <div className="admin-modal-overlay" onClick={() => setShowTransfer(false)}>
            <div
              className="admin-card"
              style={{ maxWidth: '420px', margin: '60px auto' }}
              onClick={(e) => e.stopPropagation()}
            >
              <h3
                className="admin-card-title"
                style={{ display: 'flex', justifyContent: 'space-between' }}
              >
                <span>💸 Agent-to-Agent Transfer</span>
                <button
                  onClick={() => setShowTransfer(false)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--text-secondary)',
                    cursor: 'pointer',
                    fontSize: '18px',
                  }}
                >
                  ✕
                </button>
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
                <div>
                  <label className="admin-label">Recipient Agent User ID</label>
                  <input
                    className="admin-input"
                    value={transferTarget}
                    onChange={(e) => setTransferTarget(e.target.value)}
                    placeholder="UUID of receiving agent"
                  />
                </div>
                <div>
                  <label className="admin-label">Amount (chips)</label>
                  <input
                    className="admin-input"
                    type="number"
                    value={transferAmount}
                    onChange={(e) => setTransferAmount(e.target.value)}
                    placeholder="0"
                    min="1"
                  />
                </div>
                <div>
                  <label className="admin-label">Notes (optional)</label>
                  <input
                    className="admin-input"
                    value={transferNotes}
                    onChange={(e) => setTransferNotes(e.target.value)}
                    placeholder="Transfer reason..."
                  />
                </div>
                <button
                  onClick={executeTransfer}
                  disabled={processing || !transferTarget || !transferAmount}
                  className="admin-btn admin-btn-primary"
                  style={{ width: '100%' }}
                >
                  {processing
                    ? 'Processing...'
                    : `Transfer ${transferAmount ? fmtChips(parseFloat(transferAmount)) : '0'} chips`}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="admin-page-header">
          <div className="admin-page-title">
            🕵️ Agent Dashboard
            <span className="admin-badge" style={{ marginLeft: '12px' }}>
              {role.toUpperCase()}
            </span>
          </div>
          <div className="admin-header-actions">
            <button onClick={() => navigate('/lobby')} className="admin-btn admin-btn-ghost">
              🏠 Lobby
            </button>
            <button onClick={() => setShowTransfer(true)} className="admin-btn admin-btn-ghost">
              💸 Transfer
            </button>
            <button
              onClick={() => loadDashboard(clubId)}
              className="admin-btn admin-btn-ghost"
              disabled={processing}
            >
              ↻ Refresh
            </button>
          </div>
        </div>

        {/* Pending Cashouts Alert */}
        {pendingCashouts.length > 0 && tab !== 'cashouts' && (
          <div
            className="admin-error-banner"
            style={{
              background: 'rgba(245,166,35,0.1)',
              borderColor: 'rgba(245,166,35,0.3)',
              color: '#F5A623',
              cursor: 'pointer',
              marginBottom: '16px',
            }}
            onClick={() => setTab('cashouts')}
          >
            <strong>{pendingCashouts.length}</strong> pending cashout request
            {pendingCashouts.length !== 1 ? 's' : ''} —{' '}
            {fmtChips(pendingCashouts.reduce((sum: number, c: any) => sum + (c.amount || 0), 0))}{' '}
            chips waiting
          </div>
        )}

        {/* Tabs */}
        <div className="admin-tabs">
          {[
            { id: 'overview' as AgentTab, label: 'Overview' },
            { id: 'players' as AgentTab, label: 'Players', badge: players.length },
            {
              id: 'cashouts' as AgentTab,
              label: 'Cashouts',
              badge: pendingCashouts.length || undefined,
            },
            { id: 'commissions' as AgentTab, label: 'Commissions' },
            { id: 'analytics' as AgentTab, label: 'Analytics' },
            ...(isOwnerOrAdmin ? [{ id: 'promo' as AgentTab, label: '🎁 Promo' }] : []),
            ...(isOwner ? [{ id: 'credit' as AgentTab, label: '🏦 Credit' }] : []),
          ].map((t) => (
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
                    background: 'rgba(69,153,255,0.15)',
                    padding: '2px 6px',
                    borderRadius: '8px',
                    fontSize: '11px',
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
            <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {fmt(players.length)}
                </div>
                <div className="admin-stat-label">Total Players</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {fmt(onlinePlayers.length)}
                </div>
                <div className="admin-stat-label">Online Now</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">{fmtChips(totalPlayerChips)}</div>
                <div className="admin-stat-label">Player Chips</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                  {fmt(pendingCashouts.length)}
                </div>
                <div className="admin-stat-label">Pending Cashouts</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                  {fmtChips(pendingCashouts.reduce((s: number, c: any) => s + (c.amount || 0), 0))}
                </div>
                <div className="admin-stat-label">Cashout Amount</div>
              </div>
            </div>

            {/* Recent Transactions */}
            <h3 className="admin-section-title">Recent Transactions</h3>
            {recentTx.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">📋</span>
                <span>No recent transactions</span>
              </div>
            ) : (
              <>
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Type</th>
                        <th>Amount</th>
                        <th>From / To</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paginatedTx.map((tx: any, i: number) => (
                        <tr key={tx.id || i}>
                          <td>
                            <span className="admin-badge">
                              {tx.type || tx.transaction_type || 'transfer'}
                            </span>
                          </td>
                          <td style={{ fontWeight: 600 }}>{fmtChips(tx.amount)}</td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {tx.from_user_id?.substring(0, 8) || '—'}.. →{' '}
                            {tx.to_user_id?.substring(0, 8) || '—'}..
                          </td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {timeAgo(tx.created_at)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {paginatedTx.length < recentTx.length && (
                  <button
                    onClick={() => setTxPage((p) => p + 1)}
                    className="admin-btn admin-btn-ghost"
                    style={{ width: '100%', marginTop: '12px' }}
                  >
                    Load More
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* ══════ TAB: PLAYERS ══════ */}
        {tab === 'players' && (
          <div className="admin-tab-content">
            <input
              className="admin-input"
              style={{ marginBottom: '16px' }}
              placeholder="Search players by name..."
              value={playerSearch}
              onChange={(e) => setPlayerSearch(e.target.value)}
            />
            <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {filteredPlayers.length}
                </div>
                <div className="admin-stat-label">
                  {playerSearch ? 'Matching' : 'Total'} Players
                </div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {
                    filteredPlayers.filter((p: any) => {
                      const ls = p.profile?.last_seen_at;
                      return ls && Date.now() - new Date(ls).getTime() < 300000;
                    }).length
                  }
                </div>
                <div className="admin-stat-label">Online Now</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value">
                  {fmtChips(
                    filteredPlayers.reduce((sum: number, p: any) => sum + (p.chip_balance || 0), 0)
                  )}
                </div>
                <div className="admin-stat-label">Total Chips</div>
              </div>
            </div>

            {filteredPlayers.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">👥</span>
                <span>
                  {playerSearch
                    ? 'No players match your search'
                    : 'No players in your downline yet'}
                </span>
              </div>
            ) : (
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: '12px',
                }}
              >
                {filteredPlayers.map((p: any) => {
                  const name =
                    p.profile?.display_name || p.profile?.username || p.user_id?.substring(0, 8);
                  const isOnline =
                    p.profile?.last_seen_at &&
                    Date.now() - new Date(p.profile.last_seen_at).getTime() < 300000;
                  return (
                    <div key={p.user_id} className="admin-card" style={{ padding: '14px 16px' }}>
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          marginBottom: '8px',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <div
                            style={{
                              width: '10px',
                              height: '10px',
                              borderRadius: '50%',
                              background: isOnline ? '#31A24C' : '#6B7280',
                              boxShadow: isOnline ? '0 0 6px rgba(49,162,76,0.5)' : 'none',
                            }}
                          />
                          <span style={{ fontWeight: 600, fontSize: '14px' }}>{name}</span>
                        </div>
                        <span
                          className="admin-badge"
                          style={
                            ['agent', 'super_agent', 'sub_agent'].includes(p.role)
                              ? { background: 'rgba(168,85,247,0.15)', color: '#C084FC' }
                              : undefined
                          }
                        >
                          {p.role}
                        </span>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: '12px',
                          fontSize: '12px',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        <span>💰 {fmtChips(p.chip_balance)}</span>
                        <span>⏱ {timeAgo(p.profile?.last_seen_at)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: CASHOUTS ══════ */}
        {tab === 'cashouts' && (
          <div className="admin-tab-content">
            <h3 className="admin-section-title">
              Pending Cashout Requests
              <span className="admin-badge" style={{ marginLeft: '8px' }}>
                {pendingCashouts.length} pending
              </span>
            </h3>

            {pendingCashouts.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">✅</span>
                <span>No pending cashout requests</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Player</th>
                      <th>Amount</th>
                      <th>Note</th>
                      <th>Requested</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pendingCashouts.map((c: any) => (
                      <tr key={c.id}>
                        <td>{c.user_id?.substring(0, 8)}..</td>
                        <td style={{ fontWeight: 700, color: '#F7C52A' }}>{fmtChips(c.amount)}</td>
                        <td
                          style={{
                            fontSize: '12px',
                            color: 'var(--text-secondary)',
                            maxWidth: '200px',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {c.note || '—'}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {timeAgo(c.created_at)}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            <button
                              onClick={() => approveCashout(c.id)}
                              className="admin-btn admin-btn-success admin-btn-sm"
                              disabled={processing}
                            >
                              Approve
                            </button>
                            <button
                              onClick={() => denyCashout(c.id)}
                              className="admin-btn admin-btn-danger admin-btn-sm"
                              disabled={processing}
                            >
                              Deny
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="admin-stats-grid" style={{ marginTop: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                  {fmt(pendingCashouts.length)}
                </div>
                <div className="admin-stat-label">Pending</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                  {fmtChips(pendingCashouts.reduce((s: number, c: any) => s + (c.amount || 0), 0))}
                </div>
                <div className="admin-stat-label">Total Amount</div>
              </div>
            </div>
          </div>
        )}

        {/* ══════ TAB: COMMISSIONS ══════ */}
        {tab === 'commissions' && (
          <div className="admin-tab-content">
            <h3 className="admin-section-title">Commission History</h3>
            {commissions.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">💰</span>
                <span>No commission records yet</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Period</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {commissions.map((c: any, i: number) => (
                      <tr key={c.id || i}>
                        <td style={{ fontWeight: 700, color: '#31A24C' }}>{fmtChips(c.amount)}</td>
                        <td>
                          <span className="admin-badge">{c.status || 'recorded'}</span>
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {c.period_label || c.settlement_period_id?.substring(0, 8) || '—'}
                        </td>
                        <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {timeAgo(c.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: ANALYTICS ══════ */}
        {tab === 'analytics' && (
          <div className="admin-tab-content">
            <div className="admin-stats-grid" style={{ marginBottom: '16px' }}>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#4599FF' }}>
                  {fmt(players.length)}
                </div>
                <div className="admin-stat-label">Total Players</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#31A24C' }}>
                  {fmt(onlinePlayers.length)}
                </div>
                <div className="admin-stat-label">Active (5min)</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#F7C52A' }}>
                  {fmt(
                    players.filter((p: any) => {
                      const ls = p.profile?.last_seen_at;
                      if (!ls) return false;
                      const days = (Date.now() - new Date(ls).getTime()) / 86400000;
                      return days >= 5 && days < 14;
                    }).length
                  )}
                </div>
                <div className="admin-stat-label">At-Risk (5-14d)</div>
              </div>
              <div className="admin-stat-card">
                <div className="admin-stat-value" style={{ color: '#FA383E' }}>
                  {fmt(
                    players.filter((p: any) => {
                      const ls = p.profile?.last_seen_at;
                      if (!ls) return true;
                      return (Date.now() - new Date(ls).getTime()) / 86400000 >= 14;
                    }).length
                  )}
                </div>
                <div className="admin-stat-label">Churned (14d+)</div>
              </div>
            </div>

            <h3 className="admin-section-title">Player Activity</h3>
            {players.length === 0 ? (
              <div className="admin-empty-state">
                <span className="admin-empty-icon">📊</span>
                <span>No player data</span>
              </div>
            ) : (
              <div className="admin-table-scroll">
                <table className="admin-data-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Player</th>
                      <th>Chips</th>
                      <th>Last Active</th>
                      <th>Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    {players.map((p: any, i: number) => {
                      const lastSeen = p.profile?.last_seen_at;
                      const daysSince = lastSeen
                        ? Math.floor((Date.now() - new Date(lastSeen).getTime()) / 86400000)
                        : 999;
                      const color =
                        daysSince <= 5 ? '#31A24C' : daysSince <= 14 ? '#F7C52A' : '#FA383E';
                      return (
                        <tr key={p.user_id || i}>
                          <td>
                            <span
                              style={{
                                display: 'inline-block',
                                width: '10px',
                                height: '10px',
                                borderRadius: '50%',
                                background: color,
                                marginRight: '6px',
                              }}
                            />
                            {daysSince <= 5 ? 'Active' : daysSince <= 14 ? 'At Risk' : 'Churned'}
                          </td>
                          <td style={{ fontWeight: 600 }}>
                            {p.profile?.display_name ||
                              p.profile?.username ||
                              p.user_id?.substring(0, 8)}
                          </td>
                          <td>{fmtChips(p.chip_balance)}</td>
                          <td style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                            {timeAgo(lastSeen)}
                          </td>
                          <td style={{ fontWeight: 600, color }}>{daysSince}d</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ══════ TAB: PROMO ══════ */}
        {tab === 'promo' && isOwnerOrAdmin && (
          <div className="admin-tab-content">
            <div className="admin-card" style={{ marginBottom: '20px', padding: '16px 20px' }}>
              <h3 className="admin-card-title">🎁 Grant Promo to Agent</h3>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <select
                  className="admin-input"
                  style={{ flex: '1 1 200px' }}
                  value={creditTarget}
                  onChange={(e) => setCreditTarget(e.target.value)}
                >
                  <option value="">Select agent...</option>
                  {agents.map((a: any) => (
                    <option key={a.user_id} value={a.user_id}>
                      {a.profile?.display_name || a.profile?.username || a.user_id?.slice(0, 8)} (
                      {fmtChips(a.chip_balance)} chips)
                    </option>
                  ))}
                </select>
                <input
                  className="admin-input"
                  style={{ flex: '0 0 120px' }}
                  type="number"
                  placeholder="Amount"
                  min="1"
                  value={creditAmount}
                  onChange={(e) => setCreditAmount(e.target.value)}
                />
                <button
                  className="admin-btn admin-btn-primary"
                  disabled={processing || !creditTarget || !creditAmount}
                  onClick={async () => {
                    setProcessing(true);
                    setError(null);
                    try {
                      const promoAmt = Number(creditAmount);
                      if (isNaN(promoAmt) || promoAmt <= 0) {
                        setError('Enter a valid chip amount');
                        setProcessing(false);
                        return;
                      }
                      await WalletService.distributePromo(user?.id || '', creditTarget, promoAmt);
                      setSuccess(`Granted ${fmtChips(promoAmt)} promo chips!`);
                      setCreditTarget('');
                      setCreditAmount('');
                      loadDashboard(clubId);
                    } catch (err: any) {
                      setError(err.message);
                    } finally {
                      setProcessing(false);
                    }
                  }}
                >
                  {processing ? 'Granting...' : 'Grant Promo'}
                </button>
              </div>
            </div>

            {agents.length > 0 && (
              <>
                <h3 className="admin-section-title">Agent Breakdown</h3>
                <div className="admin-table-scroll">
                  <table className="admin-data-table">
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Role</th>
                        <th style={{ textAlign: 'right' }}>Chip Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map((a: any) => (
                        <tr key={a.user_id}>
                          <td style={{ fontWeight: 600 }}>
                            {a.profile?.display_name ||
                              a.profile?.username ||
                              a.user_id?.substring(0, 8)}
                          </td>
                          <td>
                            <span className="admin-badge">{a.role}</span>
                          </td>
                          <td
                            style={{
                              textAlign: 'right',
                              fontWeight: 700,
                              color: a.chip_balance > 0 ? '#31A24C' : 'var(--text-secondary)',
                            }}
                          >
                            {fmtChips(a.chip_balance)}
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

        {/* ══════ TAB: CREDIT ══════ */}
        {tab === 'credit' && isOwner && (
          <div className="admin-tab-content">
            <div className="admin-card" style={{ padding: '20px' }}>
              <h3 className="admin-card-title">🏦 Agent Credit Management</h3>
              <div
                className="admin-text-secondary"
                style={{ marginBottom: '16px', lineHeight: 1.5 }}
              >
                Issue credit lines, add prepaid balances, or revoke credit for agents.
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div>
                  <label className="admin-label">Agent</label>
                  <select
                    className="admin-input"
                    value={creditTarget}
                    onChange={(e) => setCreditTarget(e.target.value)}
                  >
                    <option value="">Select agent...</option>
                    {agents.map((a: any) => (
                      <option key={a.user_id} value={a.user_id}>
                        {a.profile?.display_name || a.profile?.username || a.user_id?.slice(0, 8)} —{' '}
                        {a.role}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="admin-label">Action</label>
                  <select
                    className="admin-input"
                    value={creditAction}
                    onChange={(e) => setCreditAction(e.target.value)}
                  >
                    <option value="issue_credit">Issue Credit Line</option>
                    <option value="add_prepaid">Add Prepaid Balance</option>
                    <option value="revoke_credit">Revoke Credit</option>
                  </select>
                </div>
                <div>
                  <label className="admin-label">Amount</label>
                  <input
                    className="admin-input"
                    type="number"
                    value={creditAmount}
                    onChange={(e) => setCreditAmount(e.target.value)}
                    placeholder="0"
                    min="1"
                  />
                </div>
                <div>
                  <label className="admin-label">Notes (optional)</label>
                  <input
                    className="admin-input"
                    value={creditNotes}
                    onChange={(e) => setCreditNotes(e.target.value)}
                    placeholder="Reason..."
                  />
                </div>
                <button
                  className="admin-btn admin-btn-primary"
                  disabled={processing || !creditTarget || !creditAmount}
                  style={{ marginTop: '4px' }}
                  onClick={async () => {
                    setProcessing(true);
                    setError(null);
                    try {
                      const amt = Number(creditAmount);
                      if (isNaN(amt) || amt <= 0) {
                        setError('Enter a valid chip amount');
                        setProcessing(false);
                        return;
                      }
                      if (creditAction === 'issue_credit' || creditAction === 'add_prepaid') {
                        await CreditService.setCreditLine(
                          creditTarget,
                          amt,
                          creditAction === 'add_prepaid'
                        );
                      } else {
                        // revoke_credit: use atomic wallet deduction
                        await WalletService.transferToUser(creditTarget, user?.id || '', amt);
                      }
                      const labels: Record<string, string> = {
                        issue_credit: 'Credit issued',
                        add_prepaid: 'Prepaid added',
                        revoke_credit: 'Credit revoked',
                      };
                      setSuccess(`${labels[creditAction] || 'Done'} — ${fmtChips(amt)} chips`);
                      masterBus.emit('CREDIT_UPDATED', {
                        clubId: clubId || '',
                        userId: creditTarget,
                      });
                      setCreditAmount('');
                      setCreditNotes('');
                      loadDashboard(clubId);
                    } catch (err: any) {
                      setError(err.message);
                    } finally {
                      setProcessing(false);
                    }
                  }}
                >
                  {processing
                    ? 'Processing...'
                    : creditAction === 'issue_credit'
                      ? 'Issue Credit'
                      : creditAction === 'add_prepaid'
                        ? 'Add Prepaid'
                        : 'Revoke Credit'}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
