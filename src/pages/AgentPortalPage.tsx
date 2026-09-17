/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT PORTAL PAGE — Agent Financial Command Center (routable wrapper)
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Wraps AgentFinancialPortal component with a routable page, replaces prompt()
 *  with a proper transfer modal, and adds bus listeners for real-time updates.
 */

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import { CreditService } from '../services/CreditService';
import { WalletService } from '../services/WalletService';
import PageSkeleton from '../components/common/PageSkeleton';

import { useIsMounted } from '../hooks/useIsMounted';
import TransactionLedgerView from '../components/common/TransactionLedgerView';
import AgentInvoicesPanel from '../components/agent/AgentInvoicesPanel';
import { reportError } from '../utils/errorReporter';
import { useUserStore } from '../stores/useUserStore';
import { resolveClubUUID } from '../utils/clubIdResolver';

interface AgentWallet {
  agentBal: number;
  playerBal: number;
  promoBal: number;
  creditLimit: number;
  debt: number;
}

interface CommissionDay {
  name: string;
  commissions: number;
}

export default function AgentPortalPage() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();
  const currentClubId = useUserStore((state) => state.currentClubId);
  const [walletError, setWalletError] = useState<string | null>(null);
  const renderScope = JSON.stringify([user?.id, currentClubId]);
  const walletScope = useRef(renderScope);
  walletScope.current = renderScope;
  const walletRequest = useRef(0);
  const commissionRequest = useRef(0);
  const walletIdentity = useRef<{ scope: string; clubId: string } | null>(null);
  const [loadedWalletScope, setLoadedWalletScope] = useState<string | null>(null);

  const [wallet, setWallet] = useState<AgentWallet>({
    agentBal: 0,
    playerBal: 0,
    promoBal: 0,
    creditLimit: 0,
    debt: 0,
  });
  const [commissionData, setCommissionData] = useState<CommissionDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [transferModalOpen, setTransferModalOpen] = useState(false);
  const [transferAmount, setTransferAmount] = useState('');
  const [isTransferring, setIsTransferring] = useState(false);
  const transferInFlight = useRef(false);
  const [visibleSections, setVisibleSections] = useState<Set<number>>(new Set());
  const [agentClubId, setAgentClubId] = useState<string | null>(null);
  const [agentPkId, setAgentPkId] = useState<string | null>(null); // agents.id PK (different from auth.uid)
  const isMounted = useIsMounted();
  const walletReady = loadedWalletScope === renderScope && !!agentClubId;

  useVisibilityRefresh(() => loadData());

  useEffect(() => {
    setTransferModalOpen(false);
    setTransferAmount('');
    setCommissionData([]);
    setAgentPkId(null);
    loadData();
    // Stagger animations — clean up timers on unmount
    const timers = [0, 1, 2, 3, 4].map((i) =>
      setTimeout(() => {
        if (isMounted.current) setVisibleSections((prev) => new Set(prev).add(i));
      }, i * 80)
    );
    return () => timers.forEach(clearTimeout);
  }, [user?.id, currentClubId]);

  // Bus listeners
  useEffect(() => {
    const unsub1 = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadWallet(), 1000);
    return () => {
      unsub1();
    };
  }, [user?.id, currentClubId]);

  // RT subscription: auto-refresh when agent wallet changes in Supabase
  useEffect(() => {
    if (!user?.id || !agentPkId) return;
    const channel = masterBus
      .getOrCreateChannel(`agent-portal-${user.id}-${agentPkId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'agents', filter: `user_id=eq.${user.id}` },
        () => {
          if (isMounted.current) loadWallet();
        }
      )
      .on(
        'postgres_changes',
        {
          // SWEEP #3 (2026-07-23): commission_ledger never existed — the live
          // per-hand commission ledger is agent_commissions, keyed by auth user_id.
          event: 'INSERT',
          schema: 'public',
          table: 'agent_commissions',
          filter: `user_id=eq.${user.id}`,
        },
        () => {
          if (isMounted.current) loadCommissionHistory();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'AgentPortalPage._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[AgentPortalPage] Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(`agent-portal-${user.id}-${agentPkId}`);
    };
  }, [user?.id, currentClubId, agentPkId]);

  const loadingRef = useRef<string | null>(null);

  const loadData = async () => {
    const scope = renderScope;
    if (!user?.id || !isMounted.current || scope !== walletScope.current) return;
    if (loadingRef.current === scope) return;
    loadingRef.current = scope;
    setLoading(true);
    try {
      // loadWallet FIRST — it resolves the agents.id PK needed by AgentInvoicesPanel
      await loadWallet();
      await loadCommissionHistory();
    } finally {
      if (loadingRef.current === scope) loadingRef.current = null;
      if (isMounted.current && walletScope.current === scope) setLoading(false);
    }
  };

  const loadWallet = async (): Promise<string | null> => {
    const scope = renderScope;
    if (!user?.id || !isMounted.current || scope !== walletScope.current) return null;
    const request = ++walletRequest.current;
    const isCurrent = () =>
      isMounted.current && scope === walletScope.current && request === walletRequest.current;
    setAgentClubId(null);
    setLoadedWalletScope(null);
    try {
      const resolvedClub = currentClubId ? await resolveClubUUID(currentClubId) : null;
      if (currentClubId && !resolvedClub)
        throw new Error('Choose A Valid Club Before Using Your Wallet');
      let query = supabase
        .from('agents')
        .select('id, club_id, agent_wallet_balance, promo_wallet_balance, credit_limit')
        // user.id is auth.users.id, NOT agents.id (PK) — query by user_id
        .eq('user_id', user.id);
      if (resolvedClub) query = query.eq('club_id', resolvedClub);
      const { data, error } = await query.maybeSingle();

      if (error || !data) throw new Error('Open Your Club Before Using The Agent Wallet');
      const { data: member, error: memberError } = await supabase
        .from('club_members')
        .select('chip_balance')
        .eq('club_id', data.club_id)
        .eq('user_id', user.id)
        .maybeSingle();
      if (memberError || !member) throw memberError || new Error('Player Wallet Not Found');

      let debt = 0;
      try {
        // Use the resolved agents.id PK — CreditService uses .eq('id', agentId) internally
        const calculatedDebt = await CreditService.calculateDebt(data.id);
        debt = calculatedDebt.debtOwed;
      } catch (err) {
        console.warn('[AgentPortal] Debt calculation skipped:', err);
      }

      if (!isCurrent()) return null;
      setWalletError(null);
      walletIdentity.current = { scope, clubId: data.club_id };
      setLoadedWalletScope(scope);
      setAgentPkId(data.id); // Triggers RT subscription re-creation with correct filter
      if (data.club_id) setAgentClubId(data.club_id);
      setWallet({
        agentBal: data.agent_wallet_balance || 0,
        playerBal: Number(member.chip_balance) || 0,
        promoBal: data.promo_wallet_balance || 0,
        creditLimit: data.credit_limit || 0,
        debt,
      });
      return data.id;
    } catch (err) {
      if (isCurrent()) {
        setWalletError((err as Error).message);
        setAgentClubId(null);
        walletIdentity.current = null;
      }
      reportError(err, 'AgentPortalPage.loadWallet_error');
      return null;
    }
  };

  const loadCommissionHistory = async () => {
    // SWEEP #3 (2026-07-23): repointed off the phantom commission_ledger table.
    // agent_commissions is keyed by auth user_id (not agents.id PK), so no PK
    // resolution is needed here; `amount` is the per-hand commission earned.
    const scope = renderScope;
    const identity = walletIdentity.current;
    if (
      !user?.id ||
      !isMounted.current ||
      scope !== walletScope.current ||
      identity?.scope !== scope
    )
      return;
    const request = ++commissionRequest.current;
    const isCurrent = () =>
      isMounted.current && scope === walletScope.current && request === commissionRequest.current;
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    try {
      const { data, error } = await supabase
        .from('agent_commissions')
        .select('amount, created_at')
        .eq('user_id', user.id)
        .eq('club_id', identity.clubId)
        .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
        .order('created_at', { ascending: true })
        .limit(5000);
      if (!isCurrent()) return;
      if (error) throw error;

      if (data && data.length > 0) {
        const grouped: Record<string, number> = {};
        data.forEach((d: any) => {
          const day = new Date(d.created_at).toLocaleDateString('en-US', { weekday: 'short' });
          grouped[day] = (grouped[day] || 0) + (Number(d.amount) || 0);
        });
        if (isMounted.current)
          setCommissionData(days.map((d) => ({ name: d, commissions: grouped[d] || 0 })));
      } else {
        if (isMounted.current) setCommissionData(days.map((d) => ({ name: d, commissions: 0 })));
      }
    } catch (err) {
      reportError(err, 'AgentPortalPage.Commission_history_error');
    }
  };

  const handleTransfer = async () => {
    const scope = renderScope;
    const isCurrent = () => isMounted.current && scope === walletScope.current;
    const amount = parseFloat(transferAmount);
    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      !user?.id ||
      !walletReady ||
      !isCurrent() ||
      transferInFlight.current
    ) {
      if (isMounted.current) toast.error('Enter a valid amount');
      return;
    }
    // A committed request may already have reduced this display. The RPC must
    // decide insufficiency after replay lookup, so the same intent can recover.
    transferInFlight.current = true;
    setIsTransferring(true);
    try {
      const success = await WalletService.agentSelfTransfer(agentClubId!, amount);
      if (!isCurrent()) return;
      if (success) {
        if (isMounted.current)
          toast.success(`Transferred ${amount.toLocaleString()} chips to Play Wallet`);
        setTransferModalOpen(false);
        setTransferAmount('');
        await loadWallet();
        masterBus.emit('BALANCE_UPDATED', { source: 'agent_transfer', userId: user.id });
      } else {
        if (isMounted.current) toast.error('Transfer failed');
      }
    } catch (err) {
      if (isCurrent()) toast.error('Transfer failed: ' + (err as Error).message);
    } finally {
      transferInFlight.current = false;
      if (isMounted.current) setIsTransferring(false);
    }
  };

  const maxCommission = Math.max(...commissionData.map((d) => d.commissions), 1);

  const sectionStyle = (idx: number): React.CSSProperties => ({
    opacity: visibleSections.has(idx) ? 1 : 0,
    transform: visibleSections.has(idx) ? 'translateY(0)' : 'translateY(10px)',
    transition: 'all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
  });

  if (loading) {
    return (
      <div style={{ padding: '16px', maxWidth: '800px', margin: '0 auto' }}>
        <PageSkeleton variant="stats" />
      </div>
    );
  }

  return (
    <div style={{ padding: '16px', maxWidth: '800px', margin: '0 auto', paddingBottom: '100px' }}>
      {walletError && (
        <div role="alert">
          {walletError}
          <button onClick={() => navigate('/clubs')}>Open Clubs</button>
        </div>
      )}
      {/* Header */}
      <div style={{ marginBottom: '24px', ...sectionStyle(0) }}>
        <button
          onClick={() => navigate(-1)}
          style={{
            background: 'none',
            border: 'none',
            color: '#3b82f6',
            cursor: 'pointer',
            fontSize: '0.85rem',
            padding: 0,
            marginBottom: '6px',
          }}
        >
          ← Back
        </button>
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Agent Command Center</h1>
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
          Triple Wallet Management, Credit Lines, And Commission Trends
        </p>
      </div>

      {/* Triple Wallet Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '10px',
          marginBottom: '16px',
          ...sectionStyle(1),
        }}
      >
        {/* Business Wallet */}
        <div
          style={{
            padding: '14px',
            background: 'rgba(59,130,246,0.08)',
            borderRadius: '12px',
            borderTop: '3px solid #3b82f6',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: '#93c5fd',
              textTransform: 'uppercase',
              fontWeight: 700,
              letterSpacing: '0.5px',
              marginBottom: '6px',
            }}
          >
            Business Wallet
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: 'monospace' }}>
            {wallet.agentBal.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>
            Commissions & Settlements
          </div>
        </div>
        {/* Play Wallet */}
        <div
          style={{
            padding: '14px',
            background: 'rgba(16,185,129,0.08)',
            borderRadius: '12px',
            borderTop: '3px solid #10b981',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: '#6ee7b7',
              textTransform: 'uppercase',
              fontWeight: 700,
              letterSpacing: '0.5px',
              marginBottom: '6px',
            }}
          >
            Play Wallet
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: 'monospace' }}>
            {wallet.playerBal.toLocaleString()}
          </div>
          <button
            onClick={() => setTransferModalOpen(true)}
            disabled={!walletReady || isTransferring}
            style={{
              marginTop: '6px',
              width: '100%',
              padding: '6px',
              minHeight: '44px',
              touchAction: 'manipulation',
              fontSize: '0.7rem',
              fontWeight: 700,
              background: 'rgba(16,185,129,0.12)',
              border: '1px solid rgba(16,185,129,0.3)',
              borderRadius: '6px',
              color: '#10b981',
              cursor: 'pointer',
            }}
          >
            LOAD FROM BIZ →
          </button>
        </div>
        {/* Promo Wallet */}
        <div
          style={{
            padding: '14px',
            background: 'rgba(236,72,153,0.08)',
            borderRadius: '12px',
            borderTop: '3px solid #ec4899',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: '#f9a8d4',
              textTransform: 'uppercase',
              fontWeight: 700,
              letterSpacing: '0.5px',
              marginBottom: '6px',
            }}
          >
            Promo Wallet
          </div>
          <div style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: 'monospace' }}>
            {wallet.promoBal.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.65rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}>
            Non-Cashable Giveaways
          </div>
        </div>
      </div>

      {/* Credit Line Status */}
      <div
        style={{
          padding: '16px',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: '12px',
          border: '1px solid rgba(255,255,255,0.06)',
          marginBottom: '16px',
          ...sectionStyle(2),
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '10px',
          }}
        >
          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>Credit Line</span>
          <span
            style={{ fontSize: '0.75rem', fontFamily: 'monospace', color: 'rgba(255,255,255,0.5)' }}
          >
            Limit: {wallet.creditLimit.toLocaleString()}
          </span>
        </div>
        <div
          style={{
            width: '100%',
            height: '8px',
            background: 'rgba(255,255,255,0.06)',
            borderRadius: '4px',
            overflow: 'hidden',
            marginBottom: '8px',
          }}
        >
          <div
            style={{
              height: '100%',
              background:
                wallet.creditLimit > 0
                  ? `linear-gradient(90deg, #10b981, ${wallet.agentBal / wallet.creditLimit < 0.3 ? '#ef4444' : '#f59e0b'})`
                  : '#333',
              width: `${wallet.creditLimit > 0 ? Math.max(5, Math.min(((wallet.creditLimit - wallet.agentBal) / wallet.creditLimit) * 100, 100)) : 0}%`,
              borderRadius: '4px',
              transition: 'width 0.5s ease',
            }}
          />
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem' }}>
          <span style={{ color: '#ef4444' }}>
            Used: {(wallet.creditLimit - wallet.agentBal).toLocaleString()}
          </span>
          <span style={{ color: '#10b981' }}>Available: {wallet.agentBal.toLocaleString()}</span>
        </div>
        {wallet.debt > 0 && (
          <div
            style={{
              marginTop: '10px',
              padding: '10px 12px',
              background: 'rgba(239,68,68,0.08)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '8px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <div>
              <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#ef4444' }}>
                ⚠ INVOICE DUE
              </div>
              <div style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.6)' }}>
                Settle {wallet.debt.toLocaleString()} Chips
              </div>
            </div>
            <button
              onClick={() => walletReady && navigate(`/clubs/${agentClubId}/settlement`)}
              disabled={!walletReady}
              style={{
                padding: '6px 14px',
                minHeight: '44px',
                touchAction: 'manipulation',
                background: 'rgba(239,68,68,0.15)',
                border: '1px solid rgba(239,68,68,0.4)',
                borderRadius: '8px',
                color: '#ef4444',
                fontWeight: 700,
                fontSize: '0.75rem',
                cursor: walletReady ? 'pointer' : 'not-allowed',
                opacity: walletReady ? 1 : 0.5,
              }}
            >
              SETTLE NOW
            </button>
          </div>
        )}
      </div>

      {/* Credit Invoices — view + pay weekly invoices */}
      <AgentInvoicesPanel agentId={agentPkId} />

      {/* Commission Trends (inline mini-chart) */}
      <div
        style={{
          padding: '16px',
          background: 'rgba(255,255,255,0.03)',
          borderRadius: '12px',
          border: '1px solid rgba(255,255,255,0.06)',
          ...sectionStyle(3),
        }}
      >
        <div style={{ fontSize: '0.9rem', fontWeight: 700, marginBottom: '12px' }}>
          Commission Trends (7 Days)
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: '6px', height: '80px' }}>
          {commissionData.map((d) => (
            <div
              key={d.name}
              style={{
                flex: 1,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: '4px',
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: `${Math.max(4, (d.commissions / maxCommission) * 60)}px`,
                  background:
                    d.commissions > 0
                      ? 'linear-gradient(180deg, #8b5cf6, #6d28d9)'
                      : 'rgba(255,255,255,0.06)',
                  borderRadius: '3px 3px 0 0',
                  transition: 'height 0.5s ease',
                }}
              />
              <span style={{ fontSize: '0.55rem', color: 'rgba(255,255,255,0.4)' }}>{d.name}</span>
            </div>
          ))}
        </div>
        <div
          style={{
            textAlign: 'right',
            fontSize: '0.65rem',
            color: 'rgba(255,255,255,0.3)',
            marginTop: '6px',
          }}
        >
          Total: {commissionData.reduce((s, d) => s + d.commissions, 0).toLocaleString()} Chips
        </div>
      </div>

      {/* Transfer Modal */}
      {transferModalOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
          }}
          onClick={() => setTransferModalOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-primary, #111)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '16px',
              padding: '24px',
              maxWidth: '380px',
              width: '92%',
            }}
          >
            <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>Transfer To Play Wallet</h3>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', margin: '0 0 12px' }}>
              Available:{' '}
              <span style={{ color: '#3b82f6', fontWeight: 700 }}>
                {wallet.agentBal.toLocaleString()}
              </span>{' '}
              Chips
            </p>
            <input
              type="number"
              placeholder="Amount"
              value={transferAmount}
              onChange={(e) => setTransferAmount(e.target.value)}
              style={{
                width: '100%',
                padding: '10px',
                background: 'rgba(0,0,0,0.3)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: '8px',
                color: '#fff',
                fontSize: '0.9rem',
                boxSizing: 'border-box',
                marginBottom: '12px',
              }}
            />
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setTransferModalOpen(false)}
                style={{
                  flex: 1,
                  padding: '10px',
                  background: 'rgba(255,255,255,0.06)',
                  border: '1px solid rgba(255,255,255,0.08)',
                  borderRadius: '8px',
                  color: '#aaa',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleTransfer}
                disabled={isTransferring || !transferAmount || !walletReady}
                style={{
                  flex: 1,
                  padding: '10px',
                  background: 'rgba(16,185,129,0.15)',
                  border: '1px solid rgba(16,185,129,0.3)',
                  borderRadius: '8px',
                  color: '#10b981',
                  fontWeight: 700,
                  fontSize: '0.85rem',
                  cursor: isTransferring ? 'wait' : 'pointer',
                  opacity: isTransferring || !transferAmount ? 0.5 : 1,
                }}
              >
                {isTransferring ? 'Transferring...' : 'Transfer'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* TRANSACTION HISTORY */}
      <div style={{ padding: '16px', maxWidth: '600px', margin: '0 auto' }}>
        <div
          style={{
            background: 'rgba(255,255,255,0.03)',
            borderRadius: '12px',
            padding: '16px',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <h3 style={{ margin: '0 0 12px', fontSize: '14px', fontWeight: 700, color: '#e0e0e0' }}>
            My Transactions
          </h3>
          <TransactionLedgerView userId={user?.id} limit={15} />
        </div>
      </div>
    </div>
  );
}
