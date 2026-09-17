/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT CASHOUT PANEL — Manage Player Cashout Requests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Component for agents to view and process pending cashout requests
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { cashoutService, CashoutRequest } from '../../services/CashoutService';
import { CashoutReceiptChecks, useCashoutReceiptChecks } from '../wallet/CashoutReceiptChecks';
import { useCashoutScope, useCashoutScopeKey } from '../../hooks/useCashoutScope';
import { runCashoutOperation, recoverCashoutOperation, captureCashoutStart, assertCashoutStartCurrent, type CashoutStart } from '../../services/CashoutOperation';
import { usePreparedCashoutOperations, isCashoutStartCurrent } from '../../hooks/usePreparedCashoutOperations';
import { useAuthUser } from '../../hooks/useAuthUser';
import { masterBus } from '../../core/MasterBus';
import { checkSettlementLock } from '../../utils/settlementLock';
import { resolveClubUUID } from '../../utils/clubIdResolver';
import { formatRelativeShort as formatTime } from '@/lib/date';
import './AgentCashoutPanel.css';
import { generateDefaultAvatar } from '../../utils/avatarGenerator';
import { reportError } from '../../utils/errorReporter';

import { safeErrorMessage } from '../../utils/safeErrorMessage';
interface AgentCashoutPanelProps {
  clubId?: string;
  onCashoutProcessed?: () => void;
}

export default function AgentCashoutPanel(props: AgentCashoutPanelProps) {
  const { user } = useAuthUser();
  const key = useCashoutScopeKey(user?.id, JSON.stringify([props.clubId]));
  return <AgentCashoutContent key={key} {...props} />;
}

function AgentCashoutContent({ clubId, onCashoutProcessed }: AgentCashoutPanelProps) {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
  const isCurrent = useCashoutScope(user?.id, clubId ?? 'all-clubs');
  const loadGeneration = useRef(0);
  const rowsCurrent = useRef<(() => boolean) | null>(null);
  // Visibility belongs to the original account/view, even during a same-scope
  // refresh. The stricter row generation still controls financial actions.
  const rowsScope = useRef<(() => boolean) | null>(null);
  const [cashouts, setCashouts] = useState<CashoutRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visibleItems, setVisibleItems] = useState<Set<number>>(new Set());
  const staggerTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  /**
   * `disabled={processing === cashout.id}` needs a render to take effect. Two
   * taps in the same frame both read the old value and both called an RPC that
   * moves real chips. The set is written synchronously, so the second tap on the
   * SAME card is refused in the same tick.
   *
   * Per cashout, not global: two different players' requests are two different
   * decisions, and their buttons are separately enabled on screen. A global lock
   * would leave the second card looking tappable and doing nothing.
   */
  const inFlightRef = useRef<Set<string>>(new Set());
  const queuedCashoutReload = useRef(false);

  /**
   * The skeleton belongs to the FIRST load only. `setLoading(true)` on every
   * refresh meant that each debounced BALANCE_UPDATED - and every cashout row
   * changing anywhere in the club - replaced the whole worked queue with three
   * shimmer bars and then re-ran the 60ms stagger fade. An agent reading a
   * request watched it vanish and slide back in under their thumb.
   */
  const hasLoadedRef = useRef(false);

  // Load pending cashouts
  const loadCashouts = useCallback(async () => {
    if (!user?.id || !isCurrent()) return;
    // Own realtime/balance events must not retire the accepted row while its
    // verified receipt is being acknowledged. Account/route fences stay live.
    if (inFlightRef.current.size > 0) { queuedCashoutReload.current = true; return; }
    const generation = ++loadGeneration.current;
    const current = () => isCurrent() && generation === loadGeneration.current;

    if (!hasLoadedRef.current) setLoading(true);
    try {
      const pending = await cashoutService.getAgentPendingCashouts(user.id, clubId);
      if (!current()) return;
      rowsCurrent.current = current;
      rowsScope.current = isCurrent;
      setCashouts(pending);
      // A load that succeeded clears the previous failure. Without this the
      // error banner sat above a perfectly fresh list forever.
      setError(null);
      setVisibleItems(new Set());
      // Clear previous stagger timers
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = pending.map((_, i) =>
        setTimeout(() => { if (current()) setVisibleItems((prev) => new Set(prev).add(i)); }, i * 60)
      );
    } catch (err) {
      reportError(err, 'AgentCashoutPanel.Failed_to_load_cashouts');
      if (current()) { rowsScope.current = isCurrent; setCashouts([]); setError(safeErrorMessage(err, 'Failed to load cashout requests')); }
    }
    if (current()) { hasLoadedRef.current = true; setLoading(false); }
  }, [user?.id, clubId, isMounted, isCurrent]);

  useEffect(() => {
    loadCashouts();

    // Bus listener: instant refresh when any balance changes (cashout requested/cancelled)
    const unsubBalance = masterBus.subscribeDebounced(
      'BALANCE_UPDATED',
      () => {
        loadCashouts();
      },
      500
    );

    // Bus listener: refresh when data mutations occur (replaces 30s polling)
    const unsubMutation = masterBus.subscribeDebounced(
      'DATA_MUTATED',
      () => {
        loadCashouts();
      },
      500
    );

    // Supabase real-time via masterBus channel manager: instant refresh on cashout_requests changes
    const channelKey = `agent-cashouts-${user?.id || 'anon'}-${clubId || 'all'}`;

    /**
     * THE FILTER HAS TO CARRY A UUID.
     *
     * `clubId` arrives from a route param and is routinely a 6-digit club code
     * or a slug - that is the entire reason every service call in this file goes
     * through resolveClubUUID first. `club_id=eq.25450` against a uuid column
     * matches nothing, so scoping the subscription silently switched realtime
     * OFF for exactly the clubs whose id was not already a uuid, and the panel
     * fell back to the debounced bus events alone. Resolve first, subscribe
     * second; an unresolvable id subscribes unfiltered rather than to nothing.
     */
    let cancelled = false;
    (async () => {
      const resolved = clubId ? await resolveClubUUID(clubId) : null;
      if (cancelled || !isMounted.current) return;

      const changeFilter: {
        event: '*';
        schema: 'public';
        table: 'cashout_requests';
        filter?: string;
      } = { event: '*', schema: 'public', table: 'cashout_requests' };
      if (resolved) changeFilter.filter = `club_id=eq.${resolved}`;

      masterBus
        .getOrCreateChannel(channelKey)
        .on('postgres_changes', changeFilter, () => {
          loadCashouts();
        })
        .subscribe((status: string, err?: Error) => {
          if (status === 'CHANNEL_ERROR') {
            if (err) reportError(err?.message || err, 'AgentCashoutPanel._Realtime_channel_error');
          }
          if (status === 'TIMED_OUT') {
            console.warn('[AgentCashoutPanel] Realtime channel timed out');
          }
        });
    })();

    return () => {
      cancelled = true;
      unsubBalance();
      unsubMutation();
      masterBus.removeRegisteredChannel(channelKey);
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = [];
    };
  }, [loadCashouts, user?.id, clubId, isMounted]);

  const decisions = usePreparedCashoutOperations(cashouts.flatMap(row => [
    { key: `${row.id}:approve`, intent: { userId: user?.id ?? '', receiptViewCurrent: isCurrent, playerId: row.playerId,
      clubId: row.clubId, targetId: row.id, kind: 'cashout_approve' as const, amount: row.amount } },
    { key: `${row.id}:reject`, intent: { userId: user?.id ?? '', receiptViewCurrent: isCurrent, playerId: row.playerId,
      clubId: row.clubId, targetId: row.id, kind: 'cashout_decline' as const,
      amount: row.amount, note: 'Request declined' } },
  ]), rowsCurrent.current, cashouts);

  const receiptChecks = useCashoutReceiptChecks(isCurrent, () => { void loadCashouts(); onCashoutProcessed?.(); });

  const processCashout = async (cashout: CashoutRequest, action: 'approve' | 'reject', reason?: string) => {
    if (!user?.id || !isCurrent() || !rowsCurrent.current?.() || cashout.status !== 'pending') return;
    if (inFlightRef.current.has(cashout.id)) return;
    inFlightRef.current.add(cashout.id);
    setProcessing(cashout.id);
    setError(null);
    let start: CashoutStart | null = null;
    let checkingOutcome = false;
    try {
      if (action === 'reject' && reason !== 'Request declined') throw new Error('Refresh To Verify This Cashout Decision');
      const prepared = decisions.get(`${cashout.id}:${action}`, action === 'approve' ? 'cashout_approve' : 'cashout_decline');
      if (!prepared) throw new Error('Wait For This Cashout Request To Be Verified');
      start = captureCashoutStart(prepared);
      checkingOutcome = true;
      const recovery = await recoverCashoutOperation(start);
      checkingOutcome = false;
      assertCashoutStartCurrent(start);
      if (!recovery.found) {
        const lock = await checkSettlementLock(start.clubId);
        assertCashoutStartCurrent(start);
        if (lock.locked) throw new Error('Settlement In Progress. Cashout Actions Are Frozen');
        checkingOutcome = true;
        await runCashoutOperation(start);
        checkingOutcome = false;
      }
      assertCashoutStartCurrent(start);
      void loadCashouts();
      onCashoutProcessed?.();
    } catch (err) {
      if (checkingOutcome && start && isCurrent()) receiptChecks.retain(`${cashout.id}:${action}`,
        cashout.amount, action === 'approve' ? 'Cashout Approval' : 'Cashout Decline', start);
      if (isCurrent() && (!start || isCashoutStartCurrent(start))) setError(safeErrorMessage(err, 'Refresh To Check The Cashout Outcome'));
    } finally {
      inFlightRef.current.delete(cashout.id);
      if (isCurrent()) {
        setProcessing(null);
        if (inFlightRef.current.size === 0 && queuedCashoutReload.current) {
          queuedCashoutReload.current = false;
          void loadCashouts();
        }
      }
    }
  };
  const handleApprove = (cashout: CashoutRequest) => processCashout(cashout, 'approve');
  const handleReject = (cashout: CashoutRequest, reason?: string) => processCashout(cashout, 'reject', reason);

  if (loading || !rowsScope.current?.()) {
    return (
      <div className="agent-cashout-panel">
        <CashoutReceiptChecks checks={receiptChecks} />
        <div className="panel-header">
          <h3>Pending Cashouts</h3>
        </div>
        <div style={{ padding: '12px' }}>
          {Array.from({ length: 3 }).map((_, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                padding: '12px',
                marginBottom: '8px',
                borderRadius: '8px',
                background: 'rgba(255,255,255,0.02)',
                animation: `animationsShimmerFade 1.4s ease-in-out ${i * 0.1}s infinite`,
              }}
            >
              <div
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  background:
                    'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                  backgroundSize: '200px 100%',
                  animation: 'animationsShimmerSlide 1.4s ease-in-out infinite',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    width: `${50 + ((i * 13) % 30)}%`,
                    height: '12px',
                    borderRadius: '4px',
                    background:
                      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                    backgroundSize: '200px 100%',
                    animation: 'animationsShimmerSlide 1.4s ease-in-out infinite',
                    marginBottom: '6px',
                  }}
                />
                <div
                  style={{
                    width: '40%',
                    height: '10px',
                    borderRadius: '4px',
                    background:
                      'linear-gradient(90deg, rgba(255,255,255,0.04) 25%, rgba(255,255,255,0.08) 50%, rgba(255,255,255,0.04) 75%)',
                    backgroundSize: '200px 100%',
                    animation: 'animationsShimmerSlide 1.4s ease-in-out infinite',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
        {/* The <style> block that used to sit here declared @keyframes
            shimmerSlide and shimmerFade. Every skeleton above asks for
            animationsShimmerSlide / animationsShimmerFade, which live in
            src/styles/animations.css, so these two definitions matched nothing
            and were injected into the document on every render of the loading
            state for nothing. Deleted, not renamed: the real ones already
            exist. */}
      </div>
    );
  }

  if (error && cashouts.length === 0) {
    return (
      <div className="agent-cashout-panel">
        <CashoutReceiptChecks checks={receiptChecks} />
        <div className="panel-header">
          <h3>Pending Cashouts</h3>
        </div>
        <div style={{ textAlign: 'center', padding: '24px 16px', color: '#94a3b8' }}>
          <div style={{ fontSize: '24px', marginBottom: '8px' }}>⚠</div>
          <p style={{ margin: '0 0 12px', fontSize: '13px' }}>Failed To Load Cashout Requests</p>
          <button
            onClick={loadCashouts}
            style={{
              padding: '8px 20px',
              background: 'rgba(59,130,246,0.15)',
              border: '1px solid rgba(59,130,246,0.3)',
              borderRadius: '8px',
              color: '#60a5fa',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            ↻ Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="agent-cashout-panel">
        <CashoutReceiptChecks checks={receiptChecks} />
      <div className="panel-header">
        <h3>Pending Cashouts</h3>
        <span className="count-badge">{cashouts.length}</span>
        <button className="refresh-btn" onClick={loadCashouts} title="Refresh">
          ↻
        </button>
      </div>

      {(error || decisions.error) && <div className="error-banner">{error || decisions.error}</div>}

      {cashouts.length === 0 ? (
        <div className="empty-state">
          <span className="empty-icon">◉</span>
          <p>No Pending Cashout Requests</p>
        </div>
      ) : (
        <div className="cashout-list">
          {cashouts.map((cashout, i) => (
            <div
              key={cashout.id}
              className="cashout-card"
              style={{
                opacity: visibleItems.has(i) ? 1 : 0,
                transform: visibleItems.has(i) ? 'translateY(0)' : 'translateY(8px)',
                transition: 'all 0.35s cubic-bezier(0.175, 0.885, 0.32, 1.275)',
              }}
            >
              <div className="cashout-header">
                <div className="player-info">
                  <img
                    loading="lazy"
                    decoding="async"
                    src={cashout.playerAvatar || generateDefaultAvatar()}
                    alt=""
                    className="player-avatar"
                  />
                  <div className="player-details">
                    <span className="player-name">{cashout.playerName || 'Player'}</span>
                    <span className="request-time">{formatTime(cashout.createdAt)}</span>
                  </div>
                </div>
                <div className="cashout-amount">
                  <span className="amount-value">{cashout.amount.toLocaleString()}</span>
                  <span className="amount-label">Chips</span>
                </div>
              </div>

              {cashout.playerNote && <div className="player-note">"{cashout.playerNote}"</div>}

              <div className="cashout-actions">
                <button
                  className="action-btn approve"
                  onClick={() => handleApprove(cashout)}
                  disabled={processing === cashout.id || !decisions.get(`${cashout.id}:approve`, 'cashout_approve')}
                >
                  {processing === cashout.id ? 'Approving...' : 'Approve Cashout'}
                </button>
                <button
                  className="action-btn reject"
                  onClick={() => handleReject(cashout, 'Request declined')}
                  disabled={processing === cashout.id || !decisions.get(`${cashout.id}:reject`, 'cashout_decline')}
                >
                  {processing === cashout.id ? 'Working...' : 'Reject'}
                </button>
              </div>

              <div className="escrow-notice">
                Approval Transfers The Verified Hold Into Your Agent Wallet. Rejection Returns
                The Verified Hold To The Player.
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
