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
  const [visibleSections, setVisibleSections] = useState<Set<number>>(new Set());
  const [agentClubId, setAgentClubId] = useState<string | null>(null);
  const [agentPkId, setAgentPkId] = useState<string | null>(null); // agents.id PK (different from auth.uid)
  const isMounted = useIsMounted();

  useVisibilityRefresh(() => loadData());

  useEffect(() => {
    loadData();
    // Stagger animations — clean up timers on unmount
    const timers = [0, 1, 2, 3, 4].map((i) =>
      setTimeout(() => {
        if (isMounted.current) setVisibleSections((prev) => new Set(prev).add(i));
      }, i * 80)
    );
    return () => timers.forEach(clearTimeout);
  }, [user?.id]);

  // Bus listeners
  useEffect(() => {
    const unsub1 = masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadWallet(), 1000);
    const unsub2 = masterBus.subscribeDebounced('COMMISSION_PAID', () => loadData(), 1000);
    const unsub3 = masterBus.subscribeDebounced('SETTLEMENT_COMPLETED', () => loadData(), 1000);
    return () => {
      unsub1();
      unsub2();
      unsub3();
    };
  }, []);

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
          event: 'INSERT',
          schema: 'public',
          table: 'commission_ledger',
          filter: `agent_id=eq.${agentPkId}`,
        },
        () => {
          if (isMounted.current) loadCommissionHistory();
        }
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          console.error('[AgentPortalPage] ❌ Realtime channel error:', err?.message || err);
        }
        if (status === 'TIMED_OUT') {
          console.warn('[AgentPortalPage] ⏱️ Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(`agent-portal-${user.id}-${agentPkId}`);
    };
  }, [user?.id, agentPkId]);

  const loadingRef = useRef(false);

  const loadData = async () => {
    if (!user?.id) return;
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      // loadWallet FIRST — it resolves the agents.id PK needed by loadCommissionHistory
      const resolvedPkId = await loadWallet();
      // Pass resolved PK directly — agentPkId state won't be updated until next render
      await loadCommissionHistory(resolvedPkId ?? undefined);
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }
  };

  const loadWallet = async (): Promise<string | null> => {
    if (!user?.id) return null;
    try {
      const { data, error } = await supabase
        .from('agents')
        .select(
          'id, club_id, agent_wallet_balance, player_wallet_balance, promo_wallet_balance, credit_limit'
        )
        // user.id is auth.users.id, NOT agents.id (PK) — query by user_id
        .eq('user_id', user.id)
        .maybeSingle();

      if (error || !data) return null;

      let debt = 0;
      try {
        // Use the resolved agents.id PK — CreditService uses .eq('id', agentId) internally
        const calculatedDebt = await CreditService.calculateDebt(data.id);
        debt = calculatedDebt.debtOwed;
      } catch (err) {
        console.warn('[AgentPortal] Debt calculation skipped:', err);
      }

      if (!isMounted.current) return data.id;
      setAgentPkId(data.id); // Triggers RT subscription re-creation with correct filter
      if (data.club_id) setAgentClubId(data.club_id);
      setWallet({
        agentBal: data.agent_wallet_balance || 0,
        playerBal: data.player_wallet_balance || 0,
        promoBal: data.promo_wallet_balance || 0,
        creditLimit: data.credit_limit || 0,
        debt,
      });
      return data.id;
    } catch (err) {
      console.error('[AgentPortal] loadWallet error:', err);
      return null;
    }
  };

  const loadCommissionHistory = async (overridePkId?: string) => {
    // commission_ledger.agent_id stores agents.id PK, not auth.uid()
    // overridePkId lets loadData pass the PK directly before React re-renders
    const agentId = overridePkId || agentPkId;
    if (!agentId) return;
    const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    try {
      const { data, error } = await supabase
        .from('commission_ledger')
        .select('commission_earned, created_at')
        .eq('agent_id', agentId)
        .gte('created_at', new Date(Date.now() - 7 * 86400000).toISOString())
        .order('created_at', { ascending: true })
        .limit(5000);
      if (error) console.error('[AgentPortal] Commission history load failed:', error.message);

      if (data && data.length > 0) {
        const grouped: Record<string, number> = {};
        data.forEach((d: any) => {
          const day = new Date(d.created_at).toLocaleDateString('en-US', { weekday: 'short' });
          grouped[day] = (grouped[day] || 0) + (d.commission_earned || 0);
        });
        if (isMounted.current)
          setCommissionData(days.map((d) => ({ name: d, commissions: grouped[d] || 0 })));
      } else {
        if (isMounted.current) setCommissionData(days.map((d) => ({ name: d, commissions: 0 })));
      }
    } catch (err) {
      console.error('[AgentPortal] Commission history error:', err);
    }
  };

  const handleTransfer = async () => {
    const amount = parseFloat(transferAmount);
    if (!amount || amount <= 0 || !user?.id) {
      if (isMounted.current) toast.error('Enter a valid amount');
      return;
    }
    if (amount > wallet.agentBal) {
      if (isMounted.current) toast.error('Insufficient balance in Business Wallet');
      return;
    }
    setIsTransferring(true);
    try {
      const success = await WalletService.agentSelfTransfer(user.id, amount);
      if (success) {
        if (isMounted.current)
          toast.success(`Transferred ${amount.toLocaleString()} chips to Play Wallet`);
        setTransferModalOpen(false);
        setTransferAmount('');
        masterBus.emit('BALANCE_UPDATED', { source: 'agent_transfer', userId: user.id });
      } else {
        if (isMounted.current) toast.error('Transfer failed');
      }
    } catch (err) {
      if (isMounted.current) toast.error('Transfer failed: ' + (err as Error).message);
    }
    setIsTransferring(false);
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
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>🏧 Agent Command Center</h1>
        <p style={{ margin: '4px 0 0', fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
          Triple wallet management, credit lines, and commission trends
        </p>
      </div>

      {/* Triple Wallet Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
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
            style={{
              marginTop: '6px',
              width: '100%',
              padding: '6px',
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
            Non-cashable giveaways
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
          <span style={{ fontWeight: 700, fontSize: '0.9rem' }}>💳 Credit Line</span>
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
                Settle {wallet.debt.toLocaleString()} chips
              </div>
            </div>
            <button
              onClick={() => agentClubId && navigate(`/clubs/${agentClubId}/settlement`)}
              disabled={!agentClubId}
              style={{
                padding: '6px 14px',
                background: 'rgba(239,68,68,0.15)',
                border: '1px solid rgba(239,68,68,0.4)',
                borderRadius: '8px',
                color: '#ef4444',
                fontWeight: 700,
                fontSize: '0.75rem',
                cursor: agentClubId ? 'pointer' : 'not-allowed',
                opacity: agentClubId ? 1 : 0.5,
              }}
            >
              SETTLE NOW
            </button>
          </div>
        )}
      </div>

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
          📈 Commission Trends (7 Days)
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
          Total: {commissionData.reduce((s, d) => s + d.commissions, 0).toLocaleString()} chips
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
            <h3 style={{ margin: '0 0 16px', fontSize: '1.05rem' }}>Transfer to Play Wallet</h3>
            <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)', margin: '0 0 12px' }}>
              Available:{' '}
              <span style={{ color: '#3b82f6', fontWeight: 700 }}>
                {wallet.agentBal.toLocaleString()}
              </span>{' '}
              chips
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
                disabled={isTransferring || !transferAmount}
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
    </div>
  );
}
