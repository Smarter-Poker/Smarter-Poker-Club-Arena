/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CREDIT ADMIN PANEL — Agent Credit Limit Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Admin page for setting/adjusting agent credit limits with full audit trail.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import { AgentService } from '../services/AgentService';

import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';

interface AgentCredit {
  id: string;
  displayName: string;
  creditLimit: number;
  currentBalance: number;
  debtOwed: number;
  status: string;
}

export default function CreditAdminPanel() {
  const navigate = useNavigate();
  const { user } = useAuthUser();
  const toast = useToast();

  const [agents, setAgents] = useState<AgentCredit[]>([]);
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [newLimit, setNewLimit] = useState('');
  const [saving, setSaving] = useState(false);
  const [auditLog, setAuditLog] = useState<any[]>([]);
  const [visibleRows, setVisibleRows] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Permission check: only club owners/admins can access credit admin
  useEffect(() => {
    if (!user?.id) return;
    (async () => {
      try {
        const { data } = await supabase
          .from('club_members')
          .select('role')
          .eq('user_id', user.id)
          .in('role', ['owner', 'co_owner', 'admin'])
          .limit(1)
          .maybeSingle();
        if (isMounted.current) setAuthorized(!!data);
      } catch (e) {
        reportError(e, 'CreditAdminPanel.async');
        if (isMounted.current) setAuthorized(false);
      }
    })();
  }, [user?.id]);

  useVisibilityRefresh(() => {
    if (authorized) loadAgents();
  });

  const loadingRef = useRef(false);

  const loadAgents = useCallback(async () => {
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    try {
      const { data } = await retryFetch(
        () =>
          supabase
            .from('agents')
            .select('id, user_id, agent_wallet_balance, credit_limit, status')
            .order('credit_limit', { ascending: false })
            .limit(100)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );

      if (data) {
        if (!isMounted.current) return;

        // Batch-fetch profile names separately (no FK hint needed)
        const userIds = data.map((a: any) => a.user_id).filter(Boolean);
        const profileMap: Record<string, { display_name?: string; username?: string }> = {};
        try {
          const { data: profiles } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}`)
            .in('id', userIds);
          if (profiles) {
            for (const p of profiles) profileMap[p.id] = p;
          }
        } catch (e) {
          reportError(e, 'CreditAdminPanel.map');
          /* non-critical */
        }

        const mapped: AgentCredit[] = data.map((a: any) => ({
          id: a.id,
          displayName: profileMap[a.user_id]
            ? playerDisplayName(profileMap[a.user_id])
            : a.id.substring(0, 8),
          creditLimit: a.credit_limit || 0,
          currentBalance: a.agent_wallet_balance || 0,
          debtOwed: Math.max(0, (a.credit_limit || 0) - (a.agent_wallet_balance || 0)),
          status: a.status || 'active',
        }));
        setAgents(mapped);
        // Clear previous stagger timers before starting new ones
        staggerTimersRef.current.forEach(clearTimeout);
        staggerTimersRef.current = mapped.map((_, i) =>
          setTimeout(() => {
            if (isMounted.current) setVisibleRows((prev) => new Set(prev).add(i));
          }, i * 40)
        );
      }
    } catch (err) {
      reportError(err, 'CreditAdminPanel.Load_failed');
      if (isMounted.current) toast.error('Failed to load agents');
    } finally {
      loadingRef.current = false;
      if (isMounted.current) setLoading(false);
    }

    // Load audit log
    try {
      const { data: auditData } = await retryFetch(
        () =>
          supabase
            .from('commission_rate_audit')
            .select('agent_id, old_rate, new_rate, created_at')
            .eq('rate_type', 'credit_limit')
            .order('created_at', { ascending: false })
            .limit(20)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: isMounted }
      );
      if (isMounted.current) setAuditLog(auditData || []);
    } catch (e) {
      reportError(e, 'CreditAdminPanel.then');
      /* table may not exist */
    }
  }, [toast]);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      staggerTimersRef.current.forEach(clearTimeout);
    };
  }, []);

  useEffect(() => {
    const unsubs = [
      masterBus.subscribeDebounced('BALANCE_UPDATED', () => loadAgents(), 1000),
      masterBus.subscribeDebounced('CREDIT_UPDATED', () => loadAgents(), 500),
      masterBus.subscribeDebounced('AGENT_UPDATED', () => loadAgents(), 500),
    ];
    return () => {
      unsubs.forEach((u) => u());
    };
  }, [loadAgents]);

  // ── Supabase Realtime — cross-user WebSocket updates ──
  useEffect(() => {
    const channelKey = 'credit-admin-agents';
    const channel = masterBus.getOrCreateChannel(channelKey);
    channel
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'agents' }, () =>
        loadAgents()
      )
      .subscribe((status: string, err?: Error) => {
        if (status === 'CHANNEL_ERROR') {
          if (err) reportError(err?.message || err, 'CreditAdminPanel._Realtime_channel_error');
        }
        if (status === 'TIMED_OUT') {
          console.warn('[CreditAdminPanel] Realtime channel timed out');
        }
      });
    return () => {
      masterBus.removeRegisteredChannel(channelKey);
    };
  }, [loadAgents]);

  const handleSaveLimit = async (agentId: string) => {
    const limit = parseFloat(newLimit);
    if (isNaN(limit) || limit < 0) {
      toast.error('Enter a valid credit limit');
      return;
    }
    setSaving(true);
    try {
      // agents is service-role-write-only under RLS — a direct browser update here
      // silently affects 0 rows (and the manual audit insert would then record a
      // change that never happened). Route through fn_admin_update_agent, which
      // authorizes the caller as club owner/admin, enforces the parent-limit rule,
      // updates the limit, and writes the credit_assignments audit server-side.
      const ok = await AgentService.setCreditLimit(
        agentId,
        limit,
        user?.id || '',
        'Credit limit set via admin panel'
      );
      if (!ok) throw new Error('Credit limit update failed');

      toast.success(`Credit limit updated to ${limit.toLocaleString()}`);
      setEditingAgent(null);
      setNewLimit('');
      masterBus.emit('CREDIT_UPDATED', { clubId: '', userId: agentId, amount: limit });
      masterBus.emit('BALANCE_UPDATED', { source: 'credit_limit_change', agentId });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to update credit limit');
    }
    setSaving(false);
  };

  const totalCreditExposure = agents.reduce((s, a) => s + a.creditLimit, 0);
  const totalDebt = agents.reduce((s, a) => s + a.debtOwed, 0);

  // Block unauthorized access
  if (authorized === false) {
    return (
      <div style={{ padding: '40px', textAlign: 'center', color: 'rgba(255,255,255,0.4)' }}>
        <div style={{ fontSize: '2rem', marginBottom: '12px' }}>◈</div>
        <div style={{ fontSize: '0.9rem', fontWeight: 600 }}>Access Denied</div>
        <div style={{ fontSize: '0.75rem', marginTop: '4px' }}>
          Only Club Owners And Admins Can Access The Credit Admin Panel.
        </div>
        <button
          onClick={() => navigate(-1)}
          style={{
            marginTop: '16px',
            padding: '8px 16px',
            background: 'rgba(59,130,246,0.15)',
            border: '1px solid rgba(59,130,246,0.3)',
            borderRadius: '8px',
            color: '#3b82f6',
            cursor: 'pointer',
            fontWeight: 600,
          }}
        >
          ← Go Back
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '16px',
        width: '100%',
        maxWidth: '800px',
        margin: '0 auto',
        paddingBottom: '100px',
        overflowX: 'hidden',
      }}
    >
      {/* Header */}
      <div style={{ marginBottom: '24px' }}>
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
        <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: 700 }}>Credit Admin Panel</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
          <p style={{ margin: 0, fontSize: '0.8rem', color: 'rgba(255,255,255,0.5)' }}>
            Manage Agent Credit Limits And Monitor Exposure
          </p>
          {agents.length > 0 && (
            <button
              onClick={() => {
                try {
                  exportToCSV(agents, 'credit_admin.csv', [
                    { key: 'displayName', label: 'Agent' },
                    { key: 'creditLimit', label: 'Credit Limit' },
                    { key: 'currentBalance', label: 'Balance' },
                    { key: 'debtOwed', label: 'Debt Owed' },
                    { key: 'status', label: 'Status' },
                  ]);
                } catch (e) {
                  reportError(e, 'CreditAdminPanel');
                  /* silent */
                }
              }}
              style={{
                background: 'rgba(59,130,246,0.1)',
                border: '1px solid rgba(59,130,246,0.25)',
                borderRadius: '6px',
                color: '#3b82f6',
                fontSize: '0.7rem',
                fontWeight: 600,
                padding: '4px 10px',
                minHeight: '44px',
                touchAction: 'manipulation',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Export
            </button>
          )}
        </div>
      </div>

      {/* Summary Cards */}
      <div
        style={{
          display: 'grid',
          /* auto-fit lets the three cards drop to 2-up/1-up on narrow phones
             instead of scrunching the monospace totals (no media query needed
             for inline styles) */
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: '10px',
          marginBottom: '20px',
        }}
      >
        <div
          style={{
            padding: '14px',
            background: 'rgba(59,130,246,0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(59,130,246,0.2)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Total Exposure
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#3b82f6',
              fontFamily: 'monospace',
            }}
          >
            {totalCreditExposure.toLocaleString()}
          </div>
        </div>
        <div
          style={{
            padding: '14px',
            background: 'rgba(239,68,68,0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(239,68,68,0.2)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Outstanding Debt
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#ef4444',
              fontFamily: 'monospace',
            }}
          >
            {totalDebt.toLocaleString()}
          </div>
        </div>
        <div
          style={{
            padding: '14px',
            background: 'rgba(16,185,129,0.08)',
            borderRadius: '12px',
            border: '1px solid rgba(16,185,129,0.2)',
          }}
        >
          <div
            style={{
              fontSize: '0.65rem',
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Active Agents
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#10b981',
              fontFamily: 'monospace',
            }}
          >
            {agents.length}
          </div>
        </div>
      </div>

      {/* Agent List */}
      <div
        style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: 'rgba(255,255,255,0.4)',
          textTransform: 'uppercase',
          letterSpacing: '0.5px',
          marginBottom: '8px',
        }}
      >
        Agents
      </div>
      {loading && agents.length === 0 ? (
        <PageSkeleton variant="list" />
      ) : agents.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'rgba(255,255,255,0.3)' }}>
          No Agents Found
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {agents.map((agent, idx) => (
            <div
              key={agent.id}
              style={{
                padding: '12px 14px',
                background: 'rgba(255,255,255,0.03)',
                borderRadius: '10px',
                border: '1px solid rgba(255,255,255,0.06)',
                opacity: visibleRows.has(idx) ? 1 : 0,
                transform: visibleRows.has(idx) ? 'translateX(0)' : 'translateX(-10px)',
                transition: 'all 0.3s ease',
              }}
            >
              <div
                style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
              >
                <div>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700 }}>{agent.displayName}</div>
                  <div
                    style={{ fontSize: '0.7rem', color: 'rgba(255,255,255,0.4)', marginTop: '2px' }}
                  >
                    Balance:{' '}
                    <span style={{ color: '#10b981' }}>
                      {agent.currentBalance.toLocaleString()}
                    </span>
                    {agent.debtOwed > 0 && (
                      <>
                        {' '}
                        · Debt:{' '}
                        <span style={{ color: '#ef4444' }}>{agent.debtOwed.toLocaleString()}</span>
                      </>
                    )}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {editingAgent === agent.id ? (
                    <>
                      <input
                        type="number"
                        value={newLimit}
                        onChange={(e) => setNewLimit(e.target.value)}
                        placeholder={agent.creditLimit.toString()}
                        style={{
                          width: '100px',
                          padding: '6px',
                          background: 'rgba(0,0,0,0.3)',
                          border: '1px solid rgba(255,255,255,0.15)',
                          borderRadius: '6px',
                          color: '#fff',
                          fontSize: '16px' /* under 16px makes iOS zoom the page on focus */,
                          minHeight: '44px',
                        }}
                      />
                      <button
                        onClick={() => handleSaveLimit(agent.id)}
                        disabled={saving}
                        style={{
                          padding: '6px 10px',
                          minWidth: '44px',
                          minHeight: '44px',
                          touchAction: 'manipulation',
                          background: 'rgba(16,185,129,0.15)',
                          border: '1px solid rgba(16,185,129,0.3)',
                          borderRadius: '6px',
                          color: '#10b981',
                          fontWeight: 700,
                          fontSize: '0.7rem',
                          cursor: 'pointer',
                        }}
                      >
                        {saving ? '...' : '✓'}
                      </button>
                      <button
                        onClick={() => {
                          setEditingAgent(null);
                          setNewLimit('');
                        }}
                        style={{
                          padding: '6px 10px',
                          minWidth: '44px',
                          minHeight: '44px',
                          touchAction: 'manipulation',
                          background: 'rgba(239,68,68,0.1)',
                          border: '1px solid rgba(239,68,68,0.3)',
                          borderRadius: '6px',
                          color: '#ef4444',
                          fontWeight: 700,
                          fontSize: '0.7rem',
                          cursor: 'pointer',
                        }}
                      >
                        ✕
                      </button>
                    </>
                  ) : (
                    <>
                      <span
                        style={{
                          fontSize: '0.85rem',
                          fontWeight: 700,
                          color: '#f59e0b',
                          fontFamily: 'monospace',
                        }}
                      >
                        {agent.creditLimit.toLocaleString()}
                      </span>
                      <button
                        onClick={() => {
                          setEditingAgent(agent.id);
                          setNewLimit(agent.creditLimit.toString());
                        }}
                        style={{
                          padding: '4px 10px',
                          minWidth: '44px',
                          minHeight: '44px',
                          touchAction: 'manipulation',
                          background: 'rgba(255,255,255,0.06)',
                          border: '1px solid rgba(255,255,255,0.1)',
                          borderRadius: '6px',
                          color: 'rgba(255,255,255,0.6)',
                          fontSize: '0.7rem',
                          cursor: 'pointer',
                        }}
                      >
                        Edit
                      </button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Audit Log */}
      {auditLog.length > 0 && (
        <div style={{ marginTop: '24px' }}>
          <div
            style={{
              fontSize: '0.75rem',
              fontWeight: 600,
              color: 'rgba(255,255,255,0.4)',
              textTransform: 'uppercase',
              letterSpacing: '0.5px',
              marginBottom: '8px',
            }}
          >
            Recent Changes
          </div>
          {auditLog.slice(0, 5).map((log, i) => (
            <div
              key={i}
              style={{
                padding: '8px 10px',
                background: 'rgba(255,255,255,0.02)',
                borderRadius: '6px',
                marginBottom: '4px',
                display: 'flex',
                justifyContent: 'space-between',
                fontSize: '0.75rem',
              }}
            >
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>
                {new Date(log.created_at).toLocaleDateString()}
              </span>
              <span>
                <span style={{ color: '#ef4444' }}>{log.old_rate?.toLocaleString()}</span>
                <span style={{ color: 'rgba(255,255,255,0.3)' }}> → </span>
                <span style={{ color: '#10b981' }}>{log.new_rate?.toLocaleString()}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
