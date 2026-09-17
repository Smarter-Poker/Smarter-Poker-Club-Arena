/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT ADD-ON MODAL - Persisted Add-On Window
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays to all tournament players when the add-on period starts
 * after re-entry closes (or from sit-down for Free Buy events).
 * Shows add-on cost, chips received, wallet balance, and countdown timer.
 */

import { useState, useEffect, useRef } from 'react';
import { haptic, soundService } from '../../services/SoundService';

// Whole-number tournament money (Dan 2026-08-20).
import { money, moneyExact } from '../../utils/buyIn';
import DiamondsToChipsButton from '../games/DiamondsToChipsButton';
import { TournamentPurchaseNotSubmittedError } from '../../services/TournamentPurchaseIntent';

interface AddOnModalProps {
  isVisible: boolean;
  /** Base add-on cost — the part that feeds the prize pool. */
  addOnCost: number;
  /**
   * House fee charged ON TOP of addOnCost (10% by default). The modal used to
   * be unaware of it and quoted the base only, while processAddOn debits
   * base + fee.
   */
  addOnFee?: number;
  addOnChips: number;
  walletBalance: number;
  /** Absolute server-persisted deadline, in epoch milliseconds. */
  endsAtMs?: number | null;
  timeRemaining: number; // seconds
  /**
   * Resolve TRUE only for a confirmed receipt. FALSE is unconfirmed, not
   * proof that the wallet was not charged. Before 2026-08-20 this was `Promise<void>` and the parent
   * swallowed its own errors, so the modal announced "Add-On Accepted — +N
   * chips added" on every failed add-on. Required boolean, not `boolean | void`,
   * so reverting the parent to a void handler fails the build.
   */
  onAccept: () => Promise<boolean>;
  onDecline: () => void;
  /**
   * The club whose host runs the Diamond Games (Dan 2026-09-10: a player who
   * cannot cover the add-on is offered the diamonds-to-chips door). Omitted,
   * the door is not offered.
   */
  diamondGamesClubId?: string | null;
  onPlayDiamonds?: (path: string) => void;
}

function secondsUntilAddOnDeadline(endsAtMs: number | null, fallbackSeconds: number): number {
  return Number.isFinite(endsAtMs)
    ? Math.max(0, Math.ceil(((endsAtMs as number) - Date.now()) / 1000))
    : Math.max(0, Math.ceil(fallbackSeconds));
}

export default function AddOnModal({
  isVisible,
  addOnCost,
  addOnFee = 0,
  addOnChips,
  walletBalance,
  endsAtMs = null,
  timeRemaining: initialTime,
  onAccept,
  onDecline,
  diamondGamesClubId,
  onPlayDiamonds,
}: AddOnModalProps) {
  const [countdown, setCountdown] = useState(() =>
    secondsUntilAddOnDeadline(endsAtMs, initialTime)
  );
  const [processing, setProcessing] = useState(false);
  const [decided, setDecided] = useState(false);
  const [result, setResult] = useState<'accepted' | 'declined' | 'unknown' | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const processingRef = useRef(false);
  const confirmationNeededRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDeclineRef = useRef(onDecline);
  onDeclineRef.current = onDecline;
  const decidedRef = useRef(false);

  // Add-ons are currently unraked, but preserve exact cents if a historical
  // row supplies a split. Adding before formatting prevents component-wise
  // rounding from inventing a higher charge.
  const totalCost = Math.round((Number(addOnCost) + Number(addOnFee)) * 100) / 100;
  // Gate on the TOTAL, and never on a zero price. `addOnCost` is fed from a
  // realtime broadcast that defaults it to 0 when the field is missing; a 0
  // price made canAfford unconditionally true and let players buy at a price
  // the modal never actually showed them.
  const priceKnown = totalCost > 0;
  const canAfford = priceKnown && walletBalance >= totalCost;
  const canAccept = canAfford && countdown > 0;

  useEffect(() => {
    if (!isVisible) {
      setDecided(false);
      decidedRef.current = false;
      setResult(null);
      setFailureMessage(null);
      processingRef.current = false;
      confirmationNeededRef.current = false;
      setProcessing(false);
      return;
    }

    const tick = () => {
      const remaining = secondsUntilAddOnDeadline(endsAtMs, initialTime);
      setCountdown(remaining);
      if (
        remaining > 0 ||
        decidedRef.current ||
        processingRef.current ||
        confirmationNeededRef.current
      )
        return;

      // The persisted deadline expired - auto-decline exactly once. Deriving
      // from Date.now() avoids extending the offer when browser timers were
      // throttled while the tab was in the background.
      decidedRef.current = true;
      setDecided(true);
      setResult('declined');
      if (timerRef.current) clearInterval(timerRef.current);
      onDeclineRef.current();
    };
    tick();
    if (!decidedRef.current) timerRef.current = setInterval(tick, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isVisible, initialTime, endsAtMs]);

  const handleAccept = async () => {
    const retrying = confirmationNeededRef.current;
    // The confirm sound used to fire BEFORE this guard, so a locked-out or
    // double tap still played "purchase confirmed" at the player.
    if (
      processingRef.current ||
      processing ||
      (!retrying &&
        (decided || !canAfford || secondsUntilAddOnDeadline(endsAtMs, initialTime) <= 0))
    )
      return;
    processingRef.current = true;
    confirmationNeededRef.current = true;
    setFailureMessage(null);
    soundService.playBuyInConfirm();
    haptic.medium();
    setProcessing(true);
    try {
      const ok = (await onAccept()) === true;
      if (timerRef.current) clearInterval(timerRef.current);
      decidedRef.current = true;
      setDecided(true);
      confirmationNeededRef.current = !ok;
      setResult(ok ? 'accepted' : 'unknown');
      if (!ok) {
        setFailureMessage('The Purchase May Have Completed. Retry To Confirm The Same Purchase.');
      }
    } catch (error) {
      if (error instanceof TournamentPurchaseNotSubmittedError) {
        confirmationNeededRef.current = false;
        decidedRef.current = false;
        setDecided(false);
        setResult(null);
        setFailureMessage('The Purchase Was Not Submitted. Please Try Again.');
        return;
      }
      if (timerRef.current) clearInterval(timerRef.current);
      decidedRef.current = true;
      setDecided(true);
      setResult('unknown');
      setFailureMessage('The Purchase May Have Completed. Retry To Confirm The Same Purchase.');
    } finally {
      processingRef.current = false;
      setProcessing(false);
    }
  };

  const handleDecline = () => {
    if (processingRef.current || processing || (decided && !confirmationNeededRef.current)) return;
    haptic.light();
    if (confirmationNeededRef.current) {
      // Closing an unknown result is only presentation dismissal, not a
      // refusal or proof that the original purchase did not complete.
      onDecline();
      return;
    }
    setDecided(true);
    setResult('declined');
    if (timerRef.current) clearInterval(timerRef.current);
    onDecline();
  };

  if (!isVisible) return null;

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0,0,0,0.7)',
        backdropFilter: 'blur(4px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 9999,
        padding: 16,
      }}
    >
      <div
        style={{
          background: 'linear-gradient(145deg, #1a1a2e 0%, #16213e 100%)',
          border: '1px solid rgba(63,185,80,0.3)',
          borderRadius: 16,
          padding: 24,
          width: '100%',
          maxWidth: 360,
          textAlign: 'center',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div style={{ fontSize: 18, fontWeight: 700, color: '#3fb950', marginBottom: 4 }}>
          Add-On Available
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>
          One Add-On Per Player
        </div>

        {/* Countdown */}
        <div
          style={{
            background: countdown <= 10 ? 'rgba(239,68,68,0.15)' : 'rgba(63,185,80,0.1)',
            borderRadius: 12,
            padding: '12px 0',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 32,
              fontWeight: 800,
              color: countdown <= 10 ? '#ef4444' : '#3fb950',
            }}
          >
            {countdown}s
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>Time Remaining</div>
        </div>

        {/* Add-On Details */}
        {!decided ? (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 16px',
                marginBottom: 4,
              }}
            >
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>Add-On Cost</span>
              <span style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>
                {moneyExact(addOnCost)} Chips
              </span>
            </div>
            {addOnFee > 0 && (
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  padding: '8px 16px',
                  marginBottom: 4,
                }}
              >
                <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>House Fee</span>
                <span style={{ color: '#fff', fontWeight: 600, fontSize: 14 }}>
                  {moneyExact(addOnFee)} Chips
                </span>
              </div>
            )}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 16px',
                marginBottom: 4,
                borderTop: '1px solid rgba(255,255,255,0.1)',
                paddingTop: 12,
              }}
            >
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>Total Charged</span>
              <span style={{ color: '#fff', fontWeight: 700, fontSize: 14 }}>
                {money(totalCost)} Chips
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 16px',
                marginBottom: 4,
              }}
            >
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>Chips Received</span>
              <span style={{ color: '#3fb950', fontWeight: 600, fontSize: 14 }}>
                +{addOnChips.toLocaleString()} Chips
              </span>
            </div>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                padding: '8px 16px',
                marginBottom: 16,
                borderTop: '1px solid rgba(255,255,255,0.1)',
                paddingTop: 12,
              }}
            >
              <span style={{ color: 'rgba(255,255,255,0.6)', fontSize: 14 }}>Your Balance</span>
              <span
                style={{ color: canAfford ? '#fbbf24' : '#ef4444', fontWeight: 600, fontSize: 14 }}
              >
                {walletBalance.toLocaleString()} Chips
              </span>
            </div>

            {!priceKnown && (
              <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>
                Add-On Price Unavailable - Cannot Purchase Right Now
              </div>
            )}
            {priceKnown && !canAfford && (
              <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>
                Insufficient Balance - You Need {totalCost.toLocaleString()} Chips
              </div>
            )}
            {priceKnown && !canAfford && onPlayDiamonds && (
              <div style={{ marginBottom: 12 }}>
                <DiamondsToChipsButton
                  clubId={diamondGamesClubId}
                  enabled={isVisible}
                  size="compact"
                  onGo={onPlayDiamonds}
                />
              </div>
            )}

            {/* Buttons */}
            {failureMessage && (
              <div role="alert" style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>
                {failureMessage}
              </div>
            )}
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                type="button"
                onClick={handleDecline}
                disabled={processing}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  borderRadius: 10,
                  border: '1px solid rgba(255,255,255,0.2)',
                  background: 'transparent',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 600,
                  cursor: 'pointer',
                  minHeight: 48,
                }}
              >
                Decline
              </button>
              <button
                type="button"
                onClick={handleAccept}
                disabled={!canAccept || processing}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  borderRadius: 10,
                  border: 'none',
                  background: canAccept
                    ? 'linear-gradient(135deg, #3fb950 0%, #2ea043 100%)'
                    : '#374151',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: canAccept ? 'pointer' : 'not-allowed',
                  opacity: processing ? 0.6 : 1,
                  minHeight: 48,
                }}
              >
                {processing
                  ? 'Processing...'
                  : priceKnown
                    ? `Accept For ${totalCost.toLocaleString()}`
                    : 'Accept Add-On'}
              </button>
            </div>
          </>
        ) : (
          /* Result display */
          <div style={{ padding: '16px 0' }}>
            {result === 'accepted' && (
              <div style={{ color: '#3fb950', fontSize: 16, fontWeight: 600 }}>
                Add-On Accepted - +{addOnChips.toLocaleString()} Chips Added
              </div>
            )}
            {result === 'declined' && (
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 16, fontWeight: 600 }}>
                Add-On Declined
              </div>
            )}
            {result === 'unknown' && (
              <div style={{ color: '#ef4444', fontSize: 15, fontWeight: 600 }} role="alert">
                Add-On Not Confirmed
                <div
                  style={{
                    color: 'rgba(255,255,255,0.65)',
                    fontSize: 12,
                    fontWeight: 500,
                    marginTop: 6,
                  }}
                >
                  {failureMessage}
                </div>
                <div style={{ display: 'flex', gap: 12, marginTop: 16 }}>
                  <button
                    type="button"
                    onClick={handleDecline}
                    disabled={processing}
                    style={{
                      flex: 1,
                      padding: '12px 0',
                      borderRadius: 10,
                      border: '1px solid rgba(255,255,255,0.2)',
                      background: 'transparent',
                      color: '#fff',
                      fontSize: 14,
                      fontWeight: 600,
                      cursor: processing ? 'not-allowed' : 'pointer',
                      minHeight: 48,
                    }}
                  >
                    Close
                  </button>
                  <button
                    type="button"
                    onClick={handleAccept}
                    disabled={processing}
                    style={{
                      flex: 1,
                      padding: '12px 0',
                      borderRadius: 10,
                      border: 'none',
                      background: 'linear-gradient(135deg, #3fb950 0%, #2ea043 100%)',
                      color: '#fff',
                      fontSize: 14,
                      fontWeight: 700,
                      cursor: processing ? 'not-allowed' : 'pointer',
                      opacity: processing ? 0.6 : 1,
                      minHeight: 48,
                    }}
                  >
                    {processing ? 'Processing...' : 'Retry Confirmation'}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
