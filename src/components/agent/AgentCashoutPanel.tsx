/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  AGENT CASHOUT PANEL — Manage Player Cashout Requests
 * ═══════════════════════════════════════════════════════════════════════════════
 * Component for agents to view and process pending cashout requests
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { cashoutService, newOpId, CashoutRequest } from '../../services/CashoutService';
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

export default function AgentCashoutPanel({ clubId, onCashoutProcessed }: AgentCashoutPanelProps) {
  const isMounted = useIsMounted();
  const { user } = useAuthUser();
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

  /**
   * One op id PER CASHOUT PER ACTION, minted once, held across a failure,
   * dropped on success. The service used to mint a fresh one inside every call,
   * which is no protection at all: the retry that matters is the agent's SECOND
   * tap after their connection dropped, and a second call carried a second key.
   * With this, that retry lands on fn_cashout_approve's replay branch instead of
   * trying to release the escrow twice.
   *
   * Keyed by ACTION as well as id because the unique index behind the
   * idempotency check spans every cashout transaction type at once
   * (chip_transactions_agent_wallet_op_id_uidx). Reusing an approve's key for a
   * later decline of the same request would collide on that index rather than
   * replay, and fn_cashout_release has no unique_violation handler to soften it.
   */
  const opIdsRef = useRef<Map<string, string>>(new Map());
  const opIdFor = (action: 'approve' | 'reject', cashoutId: string): string => {
    const key = `${action}:${cashoutId}`;
    const held = opIdsRef.current.get(key);
    if (held) return held;
    const fresh = newOpId();
    opIdsRef.current.set(key, fresh);
    return fresh;
  };

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
    if (!user?.id) return;

    if (!hasLoadedRef.current) setLoading(true);
    try {
      const pending = await cashoutService.getAgentPendingCashouts(user.id, clubId);
      if (!isMounted.current) return;
      setCashouts(pending);
      // A load that succeeded clears the previous failure. Without this the
      // error banner sat above a perfectly fresh list forever.
      setError(null);
      setVisibleItems(new Set());
      // Clear previous stagger timers
      staggerTimersRef.current.forEach((t) => clearTimeout(t));
      staggerTimersRef.current = pending.map((_, i) =>
        setTimeout(() => setVisibleItems((prev) => new Set(prev).add(i)), i * 60)
      );
    } catch (err) {
      reportError(err, 'AgentCashoutPanel.Failed_to_load_cashouts');
      if (isMounted.current) setError(safeErrorMessage(err, 'Failed to load cashout requests'));
    }
    hasLoadedRef.current = true;
    if (isMounted.current) setLoading(false);
  }, [user?.id, clubId, isMounted]);

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

  const handleApprove = async (cashout: CashoutRequest) => {
    if (!user?.id) return;
    if (inFlightRef.current.has(cashout.id)) return;
    inFlightRef.current.add(cashout.id);

    setProcessing(cashout.id);
    setError(null);

    // SETTLEMENT FREEZE CHECK
    try {
      const lockResult = await checkSettlementLock(clubId || '');
      if (lockResult.locked) {
        if (isMounted.current) setError('Settlement In Progress. Cashout Actions Are Frozen');
        inFlightRef.current.delete(cashout.id);
        if (isMounted.current) setProcessing(null);
        return;
      }
    } catch (e) {
      reportError(e, 'AgentCashoutPanel.handleApprove');
      // Fail-open
    }

    try {
      // Atomic and terminal. fn_cashout_approve releases the escrow into THIS
      // approver's agent wallet (Dan 2026-08-25: "Once approved the chips go
      // into the agent's wallet"), writes the ledger row and notifies the
      // player, all in one transaction. It used to credit the approver's
      // club_members.chip_balance, which is their player wallet.
      await cashoutService.approveCashout(
        cashout.id,
        user.id,
        undefined,
        opIdFor('approve', cashout.id)
      );
      opIdsRef.current.delete(`approve:${cashout.id}`);
      loadCashouts();
      onCashoutProcessed?.();
      // The BALANCE_UPDATED event is emitted by approveCashout itself, carrying
      // the player id under the `userId` key every listener filters on. The
      // duplicate emitted here used the key `playerId`, which matched nothing,
      // and fired a second refresh of every wallet surface for no reason.
    } catch (err: any) {
      // The op id is held, not dropped: this may have committed with the
      // response lost, and the retry has to replay rather than release twice.
      const msg = err instanceof Error ? err.message : err?.message || String(err);
      if (isMounted.current) setError(msg);
    }
    inFlightRef.current.delete(cashout.id);
    if (isMounted.current) setProcessing(null);
  };

  const handleReject = async (cashout: CashoutRequest, reason?: string) => {
    if (!user?.id) return;
    if (inFlightRef.current.has(cashout.id)) return;
    inFlightRef.current.add(cashout.id);

    setProcessing(cashout.id);
    setError(null);

    // SETTLEMENT FREEZE CHECK
    try {
      const lockResult = await checkSettlementLock(clubId || '');
      if (lockResult.locked) {
        if (isMounted.current) setError('Settlement In Progress. Cashout Actions Are Frozen');
        inFlightRef.current.delete(cashout.id);
        if (isMounted.current) setProcessing(null);
        return;
      }
    } catch (e) {
      reportError(e, 'AgentCashoutPanel.handleReject');
      // Fail-open
    }

    try {
      await cashoutService.rejectCashout(
        cashout.id,
        user.id,
        reason,
        opIdFor('reject', cashout.id)
      );
      opIdsRef.current.delete(`reject:${cashout.id}`);
      loadCashouts();
      onCashoutProcessed?.();
      // See handleApprove: rejectCashout already emits BALANCE_UPDATED with the
      // correct `userId` key.
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : err?.message || String(err);
      if (isMounted.current) setError(msg);
    }
    inFlightRef.current.delete(cashout.id);
    if (isMounted.current) setProcessing(null);
  };

  if (loading) {
    return (
      <div className="agent-cashout-panel">
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
      <div className="panel-header">
        <h3>Pending Cashouts</h3>
        <span className="count-badge">{cashouts.length}</span>
        <button className="refresh-btn" onClick={loadCashouts} title="Refresh">
          ↻
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

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
                  disabled={processing === cashout.id}
                >
                  {processing === cashout.id ? 'Approving...' : 'Approve & Complete'}
                </button>
                <button
                  className="action-btn reject"
                  onClick={() => handleReject(cashout, 'Request declined')}
                  disabled={processing === cashout.id}
                >
                  {processing === cashout.id ? 'Working...' : 'Reject'}
                </button>
              </div>

              <div className="escrow-notice">
                Chips Are Locked In Escrow. Approving Moves Them Into Your Agent Wallet. Rejecting
                Returns Them To The Player.
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
