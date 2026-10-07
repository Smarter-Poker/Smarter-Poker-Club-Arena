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
import { retryFetch } from '../utils/retryFetch';
import { exportToCSV } from '../lib/export';
import { AgentService } from '../services/AgentService';
import { CreditRequestManagerInbox } from '../components/agent/CreditRequestWidget';
import { SpadeConsole } from '../components/console/SpadeConsole';

import { useIsMounted } from '../hooks/useIsMounted';
import { reportError } from '../utils/errorReporter';
import { safeErrorMessage } from '../utils/safeErrorMessage';
import FinancialAdminScopeState from '../components/common/FinancialAdminScopeState';
import { clubScoped, useFinancialAdminScope } from '../hooks/useFinancialAdminScope';
import { playerDisplayName, PLAYER_NAME_COLUMNS } from '../utils/playerDisplayName';
import { titleCase } from '../utils/titleCase';
import { isAuthzError } from '../utils/clubDashboard';
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
import styles from './CreditAdminPanel.module.css';

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
  const isMounted = useIsMounted();

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
  const hasCreditClubRole = ['owner', 'co_owner', 'admin'].includes(scope.clubRole || '');
  const scopeReady =
    scopeStatus === 'ready' &&
    !scopePlatformWide &&
    !!scopeClubId &&
    hasCreditClubRole &&
    !isHydrating &&
    !!user?.id &&
    scope.userId === user.id;
  const scopeIdentity = scopeReady
    ? JSON.stringify([
        user.id,
        scopeClubId,
        scopePlatformWide,
        scope.clubRole,
        scope.isPlatformStaff,
      ])
    : null;
  const currentScopeRef = useRef(scopeIdentity);
  currentScopeRef.current = scopeIdentity;
  const loadGeneration = useRef(0);
  const savingRef = useRef(false);
  const saveGeneration = useRef(0);
  const agents = loadedScope === scopeIdentity && scopeIdentity !== null ? agentRows : [];
  const dataReady =
    !!scopeIdentity &&
    loadedScope === scopeIdentity &&
    loadedGeneration === loadGeneration.current &&
    !loading &&
    !loadError;
  const canEdit = dataReady && hasCreditClubRole && !scopePlatformWide && !!scopeClubId;

  const revokeCreditAccess = useCallback(() => {
    // The authority hook may still hold its previous ready result after an
    // in-place role change. A 42501 from the authoritative writer is the
    // revocation signal: retire every async owner, remove every protected
    // value/control, and leave the page immediately.
    ++loadGeneration.current;
    ++saveGeneration.current;
    savingRef.current = false;
    setSaving(false);
    setLoading(false);
    setLoadError(null);
    setLoadedScope(null);
    setAgents([]);
    setAuditLog([]);
    setAuditError(false);
    setEditingAgent(null);
    setNewLimit('');
    navigate('/financial-admin', { replace: true });
  }, [navigate]);

  useVisibilityRefresh(() => {
    if (scopeStatus === 'ready') loadAgents();
  });

  const loadAgents = useCallback(async () => {
    if (!scopeIdentity || currentScopeRef.current !== scopeIdentity || !isMounted.current) return;
    const generation = ++loadGeneration.current;
    const isCurrent = () =>
      isMounted.current &&
      loadGeneration.current === generation &&
      currentScopeRef.current === scopeIdentity;
    const retryOwner = {
      get current() {
        return isCurrent();
      },
    };
    setLoading(true);
    setLoadError(null);
    setLoadedScope(null);
    setAgents([]);
    setAuditLog([]);
    setAuditError(false);
    setEditingAgent(null);
    setNewLimit('');
    const scopeKey = { status: scopeStatus, clubId: scopeClubId, platformWide: scopePlatformWide };
    try {
      const { data, error } = await retryFetch(
        () =>
          clubScoped(
            supabase
              .from('agents')
              .select(
                'id, user_id, club_id, agent_wallet_balance::text, credit_limit::text, credit_used::text, status'
              ),
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

      const userIds = [...new Set(data.map((a) => a.user_id).filter(Boolean))];
      const clubIds = [...new Set(data.map((a) => a.club_id).filter(Boolean))];
      const profileMap: Record<string, { display_name?: string; username?: string }> = {};
      const clubMap: Record<string, string> = {};
      if (userIds.length > 0 || clubIds.length > 0) {
        try {
          const [profilesResult, clubsResult] = await Promise.all([
            userIds.length > 0
              ? supabase.from('profiles').select(`id, ${PLAYER_NAME_COLUMNS}`).in('id', userIds)
              : Promise.resolve({ data: [], error: null }),
            clubIds.length > 0
              ? supabase.from('clubs').select('id, name').in('id', clubIds)
              : Promise.resolve({ data: [], error: null }),
          ]);
          if (!isCurrent()) return;
          if (profilesResult.error) throw profilesResult.error;
          if (clubsResult.error) throw clubsResult.error;
          for (const profile of profilesResult.data || []) profileMap[profile.id] = profile;
          for (const club of clubsResult.data || []) {
            if (typeof club.id === 'string' && typeof club.name === 'string' && club.name.trim()) {
              clubMap[club.id] = titleCase(club.name);
            }
          }
        } catch (err) {
          if (!isCurrent()) return;
          reportError(err, 'CreditAdminPanel.names');
          throw new Error('Agent And Club Names Could Not Be Verified.');
        }
      }
      if (!isCurrent()) return;
      if (clubIds.some((clubId) => !clubMap[clubId])) {
        throw new Error('Every Agent Club Name Could Not Be Verified.');
      }
      const mapped = data.map((row) =>
        creditAdminRow(
          row,
          profileMap[row.user_id]
            ? playerDisplayName(profileMap[row.user_id])
            : 'Agent Name Unavailable',
          clubMap[row.club_id]
        )
      );
      const agentIds = new Set<string>();
      const agentAccounts = new Set<string>();
      for (const row of mapped) {
        const accountKey = `${row.clubId}:${row.userId}`;
        if (agentIds.has(row.id) || agentAccounts.has(accountKey)) {
          throw new Error('Duplicate Agent Credit Records Could Not Be Verified.');
        }
        agentIds.add(row.id);
        agentAccounts.add(accountKey);
      }
      if (!scopePlatformWide && mapped.some((row) => row.clubId !== scopeClubId)) {
        throw new Error('The returned agent records do not belong to this club.');
      }
      setAgents(mapped);
      setLoadedScope(scopeIdentity);
      setLoadedGeneration(generation);

      try {
        if (mapped.length === 0) return;
        const shownAgents = new Map(mapped.map((agent) => [agent.id, agent]));
        // Canonical audit rows carry agent_id, not club_id. Restrict this
        // recent view to the already scoped agents; existing RLS still decides
        // which of their changes the caller may read. No global-history claim.
        const { data: auditData, error: auditReadError } = await retryFetch(
          () =>
            supabase
              .from('credit_assignments')
              .select('id, agent_id, old_limit::text, new_limit::text, created_at')
              .in('agent_id', [...shownAgents.keys()])
              .order('created_at', { ascending: false })
              .order('id', { ascending: false })
              .limit(CREDIT_ADMIN_AUDIT_LIMIT)
              .then((r) => r),
          { maxRetries: 2, isMountedRef: retryOwner }
        );
        if (!isCurrent()) return;
        if (
          auditReadError ||
          !Array.isArray(auditData) ||
          auditData.length > CREDIT_ADMIN_AUDIT_LIMIT
        ) {
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

  useEffect(() => {
    return () => {
      ++loadGeneration.current;
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
    if (
      !isMounted.current ||
      !canEdit ||
      savingRef.current ||
      !scopeIdentity ||
      loadedGeneration !== loadGeneration.current ||
      currentScopeRef.current !== scopeIdentity ||
      editingAgent !== agentId ||
      !agent ||
      agent.creditLimit === null ||
      agent.debtOwed === null ||
      agent.currentBalance === null
    )
      return;
    const limit = readCreditMoney(newLimit);
    if (limit === null) {
      toast.error('Enter a valid credit limit');
      return;
    }
    const saveScope = scopeIdentity;
    const saveToken = ++saveGeneration.current;
    const saveIsCurrent = () =>
      isMounted.current &&
      currentScopeRef.current === saveScope &&
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
        'Credit limit set via admin panel',
        scopeClubId!
      );
      if (!saveIsCurrent()) return;
      if (!ok) throw new Error('Credit limit update failed');

      toast.success(`Credit limit updated to ${creditAdminMoney(limit)}`);
      setEditingAgent(null);
      setNewLimit('');
      masterBus.emit('CREDIT_UPDATED', {
        clubId: agent.clubId,
        userId: agent.userId,
        amount: limit,
      });
      masterBus.emit('BALANCE_UPDATED', { source: 'credit_limit_change', agentId });
      void loadAgents();
    } catch (err) {
      if (saveIsCurrent()) {
        if (isAuthzError(err)) {
          revokeCreditAccess();
          return;
        }
        toast.error(err instanceof Error ? err.message : 'Failed to update credit limit');
      }
    } finally {
      if (saveGeneration.current === saveToken) {
        savingRef.current = false;
        if (saveIsCurrent()) setSaving(false);
      }
    }
  };

  const totalCreditExposure = dataReady ? creditAdminTotal(agents, 'creditLimit') : null;
  const totalDebt = dataReady ? creditAdminTotal(agents, 'debtOwed') : null;
  const hasExport = dataReady && agents.length > 0;

  const exportShownRows = () => {
    if (
      !isMounted.current ||
      !dataReady ||
      currentScopeRef.current !== scopeIdentity ||
      loadedGeneration !== loadGeneration.current
    )
      return;
    try {
      const shownRows = agents.map((agent) => ({
        ...agent,
        creditLimit: agent.creditLimit === null ? 'Unavailable' : agent.creditLimit.toFixed(2),
        currentBalance:
          agent.currentBalance === null ? 'Unavailable' : agent.currentBalance.toFixed(2),
        debtOwed: agent.debtOwed === null ? 'Unavailable' : agent.debtOwed.toFixed(2),
      }));
      exportToCSV(shownRows, 'credit_admin_shown_rows.csv', [
        { key: 'id', label: 'Agent ID' },
        { key: 'userId', label: 'User ID' },
        { key: 'clubId', label: 'Club ID' },
        { key: 'clubName', label: 'Club' },
        { key: 'displayName', label: 'Agent' },
        { key: 'creditLimit', label: 'Credit Limit' },
        { key: 'currentBalance', label: 'Balance' },
        { key: 'debtOwed', label: 'Debt Owed' },
        { key: 'status', label: 'Status' },
      ]);
    } catch (error) {
      reportError(error, 'CreditAdminPanel');
      toast.error('The shown rows could not be exported.');
    }
  };

  // Nothing financial renders until the scope has named one club and
  // confirmed the viewer's finance role in it.
  if (scope.status !== 'ready') {
    return <FinancialAdminScopeState scope={scope} />;
  }

  // The agents and credit_assignments policies are deliberately club-scoped.
  // A platform role is not, by itself, authority to read or change every
  // agent's credit line. Until a server-owned platform snapshot and writer
  // contract are explicitly approved, this surface fails closed and requires
  // an actual owner/co_owner/admin assignment in one selected club.
  if (scopePlatformWide || !scopeClubId || !hasCreditClubRole) {
    return (
      <FinancialAdminScopeState
        scope={{
          ...scope,
          status: 'denied',
          clubId: null,
          platformWide: false,
          message:
            'Credit Admin Requires An Authorized Club. Select A Club Where You Are An Owner, Co Owner Or Admin. No Credit Data Has Been Loaded.',
        }}
      />
    );
  }

  if (!scopeReady) {
    return (
      <main className={styles.page}>
        <SpadeConsole
          className={styles.console}
          family="spade"
          crest="spade"
          eyebrow="Club Arena"
          title="Credit Admin"
          titleAs="h1"
          pill="Verifying"
          pillInk="gold"
          foot="foot"
          aria-busy="true"
        >
          <button type="button" className={styles.backWord} onClick={() => navigate(-1)}>
            Back
          </button>
          <p className={styles.state} role="status">
            Verifying Credit Access.
          </p>
        </SpadeConsole>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <SpadeConsole
        className={styles.console}
        family="spade"
        crest="spade"
        eyebrow="Club Arena"
        title="Credit Admin"
        titleAs="h1"
        subtitle="Agent Credit Control"
        pill={scopePlatformWide ? 'Platform' : 'Club'}
        pillInk={loadError ? 'red' : 'gold'}
        foot={hasExport ? 'plates' : 'foot'}
        aria-busy={loading || undefined}
        plates={
          hasExport
            ? {
                secondary: { label: 'Back', onClick: () => navigate(-1) },
                primary: { label: 'Export Shown Rows', onClick: exportShownRows },
              }
            : undefined
        }
      >
        {!hasExport && (
          <button type="button" className={styles.backWord} onClick={() => navigate(-1)}>
            Back
          </button>
        )}
        <p className={styles.scopeNote}>
          Showing Up To {CREDIT_ADMIN_VIEW_LIMIT} Agents, Ordered By Credit Limit. Totals And CSV
          Cover The Shown Rows Only.
        </p>

        {scopeClubId && !scopePlatformWide && <CreditRequestManagerInbox clubId={scopeClubId} />}

        <dl className={styles.summary} aria-label="Credit Exposure Summary">
          <div className={styles.summaryRow}>
            <dt>Credit Limits In View</dt>
            <dd className="sc-ink--blue">{creditAdminMoney(totalCreditExposure)}</dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>Debt In View</dt>
            <dd className="sc-ink--red">{creditAdminMoney(totalDebt)}</dd>
          </div>
          <div className={styles.summaryRow}>
            <dt>Agents In View</dt>
            <dd className="sc-ink--green">{dataReady ? agents.length : 'Unavailable'}</dd>
          </div>
        </dl>

        <section aria-labelledby="credit-agents-heading">
          <h2 id="credit-agents-heading" className={styles.sectionHeading}>
            Agents
          </h2>
          {!dataReady && !loadError ? (
            <p className={styles.state} role="status">
              Loading Agent Credit Lines.
            </p>
          ) : loadError ? (
            <div role="alert" className={styles.state}>
              <p>{loadError}</p>
              <button type="button" onClick={() => loadAgents()} className={styles.wordButton}>
                Retry
              </button>
            </div>
          ) : agents.length === 0 ? (
            <p className={styles.state}>No Agents Found</p>
          ) : (
            <div className={styles.agentList}>
              {agents.map((agent) => (
                <article key={agent.id} className={styles.agentRow}>
                  <div className={styles.agentIdentity}>
                    <strong data-player-name>{titleCase(agent.displayName)}</strong>
                    <span className={styles.clubName}>{titleCase(agent.clubName)}</span>
                    <span className={styles.agentStatus}>{titleCase(agent.status)}</span>
                    <dl className={styles.agentMoney}>
                      <div>
                        <dt>Balance</dt>
                        <dd className="sc-ink--green">{creditAdminMoney(agent.currentBalance)}</dd>
                      </div>
                      <div>
                        <dt>Debt</dt>
                        <dd className="sc-ink--red">{creditAdminMoney(agent.debtOwed)}</dd>
                      </div>
                    </dl>
                  </div>
                  <div className={styles.agentActions}>
                    {editingAgent === agent.id ? (
                      <>
                        <label className={styles.limitField}>
                          <span>New Limit</span>
                          <input
                            type="number"
                            min="0"
                            step="0.01"
                            value={newLimit}
                            onChange={(event) => setNewLimit(event.target.value)}
                            placeholder={
                              agent.creditLimit === null ? 'Unavailable' : String(agent.creditLimit)
                            }
                          />
                        </label>
                        <div className={styles.actionWords}>
                          <button
                            type="button"
                            onClick={() => handleSaveLimit(agent.id)}
                            disabled={saving || !canEdit}
                            className={`${styles.wordButton} sc-ink--green`}
                          >
                            {saving ? 'Saving' : 'Save'}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setEditingAgent(null);
                              setNewLimit('');
                            }}
                            className={`${styles.wordButton} sc-ink--red`}
                          >
                            Cancel
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className={`${styles.creditLimit} sc-ink--gold`}>
                          {creditAdminMoney(agent.creditLimit)}
                        </span>
                        <button
                          type="button"
                          disabled={
                            !canEdit ||
                            saving ||
                            agent.creditLimit === null ||
                            agent.debtOwed === null ||
                            agent.currentBalance === null
                          }
                          onClick={() => {
                            if (
                              !isMounted.current ||
                              !canEdit ||
                              savingRef.current ||
                              currentScopeRef.current !== scopeIdentity ||
                              loadedGeneration !== loadGeneration.current ||
                              agent.creditLimit === null ||
                              agent.debtOwed === null ||
                              agent.currentBalance === null
                            )
                              return;
                            setEditingAgent(agent.id);
                            setNewLimit(agent.creditLimit.toString());
                          }}
                          className={styles.wordButton}
                        >
                          Edit
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        {dataReady && auditError && (
          <p className={styles.state} role="status">
            Recent Credit Changes Are Unavailable.
          </p>
        )}
        {dataReady && !auditError && agents.length > 0 && (
          <section className={styles.audit} aria-labelledby="credit-audit-heading">
            <h2 id="credit-audit-heading" className={styles.sectionHeading}>
              Recent Credit Changes For Agents In View
            </h2>
            <p className={styles.scopeNote}>
              Up To {CREDIT_ADMIN_AUDIT_LIMIT} Recent Changes Available To Your Account.
            </p>
            {auditLog.length === 0 && <p>No Visible Credit Changes For Agents In This View.</p>}
            <ol className={styles.auditList}>
              {auditLog.map((log) => (
                <li key={log.id} className={styles.auditRow}>
                  <span>
                    <strong data-player-name>{titleCase(log.agentName)}</strong>
                    <small>
                      {titleCase(log.clubName)} /{' '}
                      {log.createdAt
                        ? new Date(log.createdAt).toLocaleDateString()
                        : 'Date Unavailable'}
                    </small>
                  </span>
                  <span className={styles.auditChange}>
                    <span className="sc-ink--red">From {creditAdminMoney(log.oldLimit)}</span>
                    <span className="sc-ink--green">To {creditAdminMoney(log.newLimit)}</span>
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </SpadeConsole>
    </main>
  );
}
