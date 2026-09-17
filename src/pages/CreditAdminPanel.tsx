/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CREDIT ADMIN PANEL — Agent Credit Limit Management
 * ═══════════════════════════════════════════════════════════════════════════════
 *  Admin page for adjusting agent credit limits and viewing recent changes.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { masterBus } from '../core/MasterBus';
import { useAuthUser } from '../hooks/useAuthUser';
import { useToast } from '../components/common/Toast';
import { useVisibilityRefresh } from '../hooks/useVisibilityRefresh';
import PageSkeleton from '../components/common/PageSkeleton';
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import { AgentService } from '../services/AgentService';
import { CreditRequestManagerInbox } from '../components/agent/CreditRequestWidget';

import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import FinancialAdminScopeState from '../components/common/FinancialAdminScopeState';
import { clubScoped, useFinancialAdminScope } from '../hooks/useFinancialAdminScope';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import {
  CREDIT_ADMIN_VIEW_LIMIT,
  CREDIT_ADMIN_AUDIT_LIMIT,
  creditAdminAuditRow,
  creditAdminMoney,
  creditAdminRow,
  creditAdminTotal,
  readCreditMoney,
  type AgentCredit,
  type CreditAdminAuditEntry,
} from '../utils/creditAdminData';

export default function CreditAdminPanel() {
  const { user, isHydrating } = useAuthUser();
  const location = useLocation();
  // A route or account change mounts a fresh authority hook as well as fresh
  // data. The previous hook's ready scope cannot flash on the new surface.
  const owner = JSON.stringify([user?.id || null, isHydrating, location.pathname, location.search]);
  return <CreditAdminPanelForScope key={owner} />;
}

function CreditAdminPanelForScope() {
  const navigate = useNavigate();
  const { user, isHydrating } = useAuthUser();
  const toast = useToast();

  const [agentRows, setAgents] = useState<AgentCredit[]>([]);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const [loadedGeneration, setLoadedGeneration] = useState(0);
  const [loading, setLoading] = useState(true);
  /* A FAILED READ IS NOT "NO AGENT HAS OUTSTANDING CREDIT" (2026-09-10). The
     agents read discarded its error and rendered an empty console. */
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [newLimit, setNewLimit] = useState('');
  const [saving, setSaving] = useState(false);
  const [auditLog, setAuditLog] = useState<CreditAdminAuditEntry[]>([]);
  const [auditError, setAuditError] = useState(false);
  const [visibleRows, setVisibleRows] = useState<Set<number>>(new Set());
  const isMounted = useIsMounted();
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /* WHICH CLUB'S CREDIT (2026-09-10). The only gate here was "is the viewer
     staff of ANY club", and the agents read carried no club filter - so one
     club's credit operator saw every club's agent wallets and credit limits
     that RLS let them read (a union overseer's grant is the whole union).
     The scope names the club, checks the finance role IN THAT CLUB, and
     every read below is filtered to it. */
  const scope = useFinancialAdminScope();
  const scopeStatus = scope.status;
  const scopeClubId = scope.clubId;
  const scopePlatformWide = scope.platformWide;
  const scopeReady =
    scopeStatus === 'ready' && !isHydrating && !!user?.id && scope.userId === user.id;
  const scopeIdentity = scopeReady
    ? JSON.stringify([user.id, scopeClubId, scopePlatformWide, scope.clubRole, scope.isPlatformStaff])
    : null;
  const currentScopeRef = useRef(scopeIdentity);
  currentScopeRef.current = scopeIdentity;
  const loadGeneration = useRef(0);
  const savingRef = useRef(false);
  const saveGeneration = useRef(0);
  const agents = loadedScope === scopeIdentity && scopeIdentity !== null ? agentRows : [];
  const dataReady = !!scopeIdentity && loadedScope === scopeIdentity &&
    loadedGeneration === loadGeneration.current && !loading && !loadError;
  const canEdit = dataReady && (scope.isPlatformStaff || ['owner', 'co_owner', 'admin'].includes(scope.clubRole || ''));

  useVisibilityRefresh(() => {
    if (scopeStatus === 'ready') loadAgents();
  });

  const loadAgents = useCallback(async () => {
    if (!scopeIdentity || currentScopeRef.current !== scopeIdentity || !isMounted.current) return;
    const generation = ++loadGeneration.current;
    const isCurrent = () =>
      isMounted.current && loadGeneration.current === generation && currentScopeRef.current === scopeIdentity;
    const retryOwner = { get current() { return isCurrent(); } };
    setLoading(true);
    setLoadError(null);
    setLoadedScope(null);
    setAgents([]);
    setAuditLog([]);
    setAuditError(false);
    setEditingAgent(null);
    setNewLimit('');
    setVisibleRows(new Set());
    staggerTimersRef.current.forEach(clearTimeout);
    const scopeKey = { status: scopeStatus, clubId: scopeClubId, platformWide: scopePlatformWide };
    try {
      const { data, error } = await retryFetch(
        () =>
          clubScoped(
            supabase
              .from('agents')
              .select('id, user_id, club_id, agent_wallet_balance::text, credit_limit::text, credit_used::text, status'),
            scopeKey
          )
            .order('credit_limit', { ascending: false })
            .order('id', { ascending: true })
            .limit(CREDIT_ADMIN_VIEW_LIMIT)
            .then((r) => r),
        { maxRetries: 2, isMountedRef: retryOwner }
      );
      if (!isCurrent()) return;
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('The agent credit records were not returned.');

      const userIds = data.map((a) => a.user_id).filter(Boolean);
      const profileMap: Record<string, { display_name?: string; username?: string }> = {};
      if (userIds.length > 0) {
        try {
          const { data: profiles, error: profilesError } = await supabase
            .from('profiles')
            .select(`id, ${PLAYER_NAME_COLUMNS}`)
            .in('id', userIds);
          if (!isCurrent()) return;
          if (profilesError) throw profilesError;
          for (const profile of profiles || []) profileMap[profile.id] = profile;
        } catch (err) {
          if (!isCurrent()) return;
          reportError(err, 'CreditAdminPanel.names');
          // Stable agent IDs remain available if display names cannot be read.
        }
      }
      if (!isCurrent()) return;
      const mapped = data.map((row) => creditAdminRow(
        row,
        profileMap[row.user_id] ? playerDisplayName(profileMap[row.user_id]) : String(row.id).slice(0, 8)
      ));
      if (!scopePlatformWide && mapped.some((row) => row.clubId !== scopeClubId)) {
        throw new Error('The returned agent records do not belong to this club.');
      }
      setAgents(mapped);
      setLoadedScope(scopeIdentity);
      setLoadedGeneration(generation);
      staggerTimersRef.current = mapped.map((_, i) => setTimeout(() => {
        if (isCurrent()) setVisibleRows((prev) => new Set(prev).add(i));
      }, i * 40));

      try {
        if (mapped.length === 0) return;
        const shownAgents = new Map(mapped.map((agent) => [agent.id, agent]));
        // Canonical audit rows carry agent_id, not club_id. Restrict this
        // recent view to the already scoped agents; existing RLS still decides
        // which of their changes the caller may read. No global-history claim.
        const { data: auditData, error: auditReadError } = await retryFetch(
          () => supabase.from('credit_assignments')
            .select('id, agent_id, old_limit::text, new_limit::text, created_at')
            .in('agent_id', [...shownAgents.keys()])
            .order('created_at', { ascending: false })
            .order('id', { ascending: false })
            .limit(CREDIT_ADMIN_AUDIT_LIMIT).then((r) => r),
          { maxRetries: 2, isMountedRef: retryOwner }
        );
        if (!isCurrent()) return;
        if (auditReadError || !Array.isArray(auditData) || auditData.length > CREDIT_ADMIN_AUDIT_LIMIT) {
          throw auditReadError || new Error('The credit change history was not returned.');
        }
        setAuditLog(auditData.map((row) => creditAdminAuditRow(row, shownAgents)));
      } catch (err) {
        if (!isCurrent()) return;
        reportError(err, 'CreditAdminPanel.audit_log');
        setAuditLog([]);
        setAuditError(true);
      }
    } catch (err) {
      if (!isCurrent()) return;
      reportError(err, 'CreditAdminPanel.Load_failed');
      setAgents([]);
      setLoadedScope(null);
      setLoadError(safeErrorMessage(err, 'The Agent Credit Lines Could Not Be Loaded.'));
      toast.error('Failed to load agents');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [toast, scopeIdentity, scopeStatus, scopeClubId, scopePlatformWide, isMounted]);

  useEffect(() => {
    // A refreshed authority can change without changing the URL or account.
    // Retire only its UI ownership; the submitted server operation may commit.
    ++saveGeneration.current;
    savingRef.current = false;
    setSaving(false);
  }, [scopeIdentity]);

  useEffect(() => {
    if (scopeIdentity) {
      void loadAgents();
    } else {
      ++loadGeneration.current;
      setLoadedScope(null);
      setAgents([]);
      setAuditLog([]);
      setEditingAgent(null);
      setNewLimit('');
    }
  }, [loadAgents, scopeIdentity]);

  // Cleanup stagger timers on unmount
  useEffect(() => {
    return () => {
      ++loadGeneration.current;
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
    if (!scopeIdentity) return;
    const channelKey = `credit-admin-agents:${scopeIdentity}`;
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
  }, [loadAgents, scopeIdentity]);

  const handleSaveLimit = async (agentId: string) => {
    const agent = agents.find((row) => row.id === agentId);
    if (!isMounted.current || !canEdit || savingRef.current || !scopeIdentity ||
      loadedGeneration !== loadGeneration.current ||
      currentScopeRef.current !== scopeIdentity || editingAgent !== agentId ||
      !agent || agent.creditLimit === null || agent.debtOwed === null || agent.currentBalance === null) return;
    const limit = readCreditMoney(newLimit);
    if (limit === null) {
      toast.error('Enter a valid credit limit');
      return;
    }
    const saveScope = scopeIdentity;
    const saveToken = ++saveGeneration.current;
    const saveIsCurrent = () => isMounted.current && currentScopeRef.current === saveScope &&
      saveGeneration.current === saveToken;
    savingRef.current = true;
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
        user!.id,
        'Credit limit set via admin panel'
      );
      if (!saveIsCurrent()) return;
      if (!ok) throw new Error('Credit limit update failed');

      toast.success(`Credit limit updated to ${limit.toLocaleString()}`);
      setEditingAgent(null);
      setNewLimit('');
      masterBus.emit('CREDIT_UPDATED', { clubId: agent.clubId, userId: agent.userId, amount: limit });
      masterBus.emit('BALANCE_UPDATED', { source: 'credit_limit_change', agentId });
      void loadAgents();
    } catch (err) {
      if (saveIsCurrent()) toast.error(err instanceof Error ? err.message : 'Failed to update credit limit');
    } finally {
      if (saveGeneration.current === saveToken) {
        savingRef.current = false;
        if (saveIsCurrent()) setSaving(false);
      }
    }
  };

  const totalCreditExposure = dataReady ? creditAdminTotal(agents, 'creditLimit') : null;
  const totalDebt = dataReady ? creditAdminTotal(agents, 'debtOwed') : null;

  // Nothing financial renders until the scope has named a club (or the
  // platform) and confirmed the viewer's finance role in it.
  if (scope.status !== 'ready' || !scopeReady) {
    return (
      <div style={{ padding: '16px', width: '100%', maxWidth: '800px', margin: '0 auto' }}>
        {scope.status !== 'ready' ? <FinancialAdminScopeState scope={scope} /> : <PageSkeleton variant="list" />}
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
              disabled={!dataReady}
              onClick={() => {
                if (!isMounted.current || !dataReady || currentScopeRef.current !== scopeIdentity ||
                  loadedGeneration !== loadGeneration.current) return;
                try {
                  const shownRows = agents.map((agent) => ({
                    ...agent,
                    creditLimit: agent.creditLimit === null ? 'Unavailable' : agent.creditLimit.toFixed(2),
                    currentBalance: agent.currentBalance === null ? 'Unavailable' : agent.currentBalance.toFixed(2),
                    debtOwed: agent.debtOwed === null ? 'Unavailable' : agent.debtOwed.toFixed(2),
                  }));
                  exportToCSV(shownRows, 'credit_admin_shown_rows.csv', [
                    { key: 'id', label: 'Agent ID' },
                    { key: 'userId', label: 'User ID' },
                    { key: 'clubId', label: 'Club ID' },
                    { key: 'displayName', label: 'Agent' },
                    { key: 'creditLimit', label: 'Credit Limit' },
                    { key: 'currentBalance', label: 'Balance' },
                    { key: 'debtOwed', label: 'Debt Owed' },
                    { key: 'status', label: 'Status' },
                  ]);
                } catch (e) {
                  reportError(e, 'CreditAdminPanel');
                  toast.error('The shown rows could not be exported.');
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
              Export Shown Rows
            </button>
          )}
        </div>
        <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.6)' }}>
          Showing up to {CREDIT_ADMIN_VIEW_LIMIT} agents, ordered by credit limit. Totals and CSV
          cover the shown rows only.
        </p>
      </div>

      {scopeReady && scopeClubId && !scopePlatformWide && (
        <CreditRequestManagerInbox clubId={scopeClubId} />
      )}

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
            Credit Limits In View
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#3b82f6',
              fontFamily: 'monospace',
            }}
          >
            {creditAdminMoney(totalCreditExposure)}
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
            Debt In View
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#ef4444',
              fontFamily: 'monospace',
            }}
          >
            {creditAdminMoney(totalDebt)}
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
            Agents In View
          </div>
          <div
            style={{
              fontSize: '1.3rem',
              fontWeight: 800,
              color: '#10b981',
              fontFamily: 'monospace',
            }}
          >
            {dataReady ? agents.length : 'Unavailable'}
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
      {!dataReady && !loadError ? (
        <PageSkeleton variant="list" />
      ) : loadError ? (
        <div role="alert" style={{ textAlign: 'center', padding: '32px', color: '#f87171' }}>
          <div>{loadError}</div>
          <button
            type="button"
            onClick={() => loadAgents()}
            style={{
              marginTop: '12px',
              padding: '8px 16px',
              background: 'rgba(239,68,68,0.15)',
              border: '1px solid rgba(239,68,68,0.3)',
              borderRadius: '8px',
              color: '#f87171',
              cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Retry
          </button>
        </div>
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
                      {creditAdminMoney(agent.currentBalance)}
                    </span>
                    {' '}· Debt:{' '}
                    <span style={{ color: '#ef4444' }}>{creditAdminMoney(agent.debtOwed)}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  {editingAgent === agent.id ? (
                    <>
                      <input
                        type="number"
                        value={newLimit}
                        onChange={(e) => setNewLimit(e.target.value)}
                        placeholder={agent.creditLimit === null ? 'Unavailable' : String(agent.creditLimit)}
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
                        disabled={saving || !canEdit}
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
                        {creditAdminMoney(agent.creditLimit)}
                      </span>
                      <button
                        disabled={!canEdit || saving || agent.creditLimit === null ||
                          agent.debtOwed === null || agent.currentBalance === null}
                        onClick={() => {
                          if (!isMounted.current || !canEdit || savingRef.current ||
                            currentScopeRef.current !== scopeIdentity || loadedGeneration !== loadGeneration.current ||
                            agent.creditLimit === null || agent.debtOwed === null || agent.currentBalance === null) return;
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
      {dataReady && auditError && <p role="status">Recent credit changes are unavailable.</p>}
      {dataReady && !auditError && agents.length > 0 && (
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
            Recent Credit Changes For Agents In View
          </div>
          <p style={{ fontSize: '0.75rem', color: 'rgba(255,255,255,0.5)' }}>
            Up to {CREDIT_ADMIN_AUDIT_LIMIT} recent changes available to your account.
          </p>
          {auditLog.length === 0 && <p>No visible credit changes for agents in this view.</p>}
          {auditLog.map((log) => (
            <div
              key={log.id}
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
                {log.agentName} · {log.createdAt ? new Date(log.createdAt).toLocaleDateString() : 'Unavailable'}
              </span>
              <span>
                <span style={{ color: '#ef4444' }}>{creditAdminMoney(log.oldLimit)}</span>
                <span style={{ color: 'rgba(255,255,255,0.3)' }}> → </span>
                <span style={{ color: '#10b981' }}>{creditAdminMoney(log.newLimit)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
