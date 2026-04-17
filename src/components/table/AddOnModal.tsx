/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT ADD-ON MODAL — 60-Second Add-On Window
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays to all tournament players when the add-on period starts
 * (60 seconds after re-entry period ends).
 * Shows add-on cost, chips received, wallet balance, and countdown timer.
 */

import { useState, useEffect, useRef } from 'react';
import { haptic, soundService } from '../../services/SoundService';

interface AddOnModalProps {
  isVisible: boolean;
  addOnCost: number;
  addOnChips: number;
  walletBalance: number;
  timeRemaining: number; // seconds
  onAccept: () => Promise<void>;
  onDecline: () => void;
}

export default function AddOnModal({
  isVisible,
  addOnCost,
  addOnChips,
  walletBalance,
  timeRemaining: initialTime,
  onAccept,
  onDecline,
}: AddOnModalProps) {
  const [countdown, setCountdown] = useState(initialTime);
  const [processing, setProcessing] = useState(false);
  const [decided, setDecided] = useState(false);
  const [result, setResult] = useState<'accepted' | 'declined' | 'insufficient' | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const onDeclineRef = useRef(onDecline);
  onDeclineRef.current = onDecline;
  const decidedRef = useRef(false);

  const canAfford = walletBalance >= addOnCost;

  useEffect(() => {
    if (!isVisible) {
      setDecided(false);
      decidedRef.current = false;
      setResult(null);
      setProcessing(false);
      return;
    }

    decidedRef.current = false;
    setCountdown(initialTime);
    timerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          // Time expired — auto-decline
          if (timerRef.current) clearInterval(timerRef.current);
          if (!decidedRef.current) {
            decidedRef.current = true;
            setDecided(true);
            setResult('declined');
            onDeclineRef.current();
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isVisible, initialTime]);

  const handleAccept = async () => {
    soundService.playBuyInConfirm();
    if (processing || decided) return;
    setProcessing(true);
    try {
      await onAccept();
      setDecided(true);
      setResult('accepted');
      if (timerRef.current) clearInterval(timerRef.current);
    } catch (err: any) {
      if (err?.message?.includes('Insufficient')) {
        setResult('insufficient');
      }
      setDecided(true);
      if (timerRef.current) clearInterval(timerRef.current);
    }
    setProcessing(false);
  };

  const handleDecline = () => {
    if (processing || decided) return;
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
          border: '1px solid rgba(16,185,129,0.3)',
          borderRadius: 16,
          padding: 24,
          width: '100%',
          maxWidth: 360,
          textAlign: 'center',
          boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        {/* Header */}
        <div style={{ fontSize: 18, fontWeight: 700, color: '#10b981', marginBottom: 4 }}>
          Add-On Available
        </div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)', marginBottom: 16 }}>
          Re-entry period has ended
        </div>

        {/* Countdown */}
        <div
          style={{
            background: countdown <= 10 ? 'rgba(239,68,68,0.15)' : 'rgba(16,185,129,0.1)',
            borderRadius: 12,
            padding: '12px 0',
            marginBottom: 16,
          }}
        >
          <div
            style={{
              fontSize: 32,
              fontWeight: 800,
              color: countdown <= 10 ? '#ef4444' : '#10b981',
            }}
          >
            {countdown}s
          </div>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>Time remaining</div>
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
                {addOnCost.toLocaleString()} chips
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
              <span style={{ color: '#10b981', fontWeight: 600, fontSize: 14 }}>
                +{addOnChips.toLocaleString()} chips
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
                {walletBalance.toLocaleString()} chips
              </span>
            </div>

            {!canAfford && (
              <div style={{ color: '#ef4444', fontSize: 12, marginBottom: 12 }}>
                Insufficient balance for add-on
              </div>
            )}

            {/* Buttons */}
            <div style={{ display: 'flex', gap: 12 }}>
              <button
                onClick={handleDecline}
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
                onClick={handleAccept}
                disabled={!canAfford || processing}
                style={{
                  flex: 1,
                  padding: '12px 0',
                  borderRadius: 10,
                  border: 'none',
                  background: canAfford
                    ? 'linear-gradient(135deg, #10b981 0%, #059669 100%)'
                    : '#374151',
                  color: '#fff',
                  fontSize: 14,
                  fontWeight: 700,
                  cursor: canAfford ? 'pointer' : 'not-allowed',
                  opacity: processing ? 0.6 : 1,
                  minHeight: 48,
                }}
              >
                {processing ? 'Processing...' : `Accept Add-On`}
              </button>
            </div>
          </>
        ) : (
          /* Result display */
          <div style={{ padding: '16px 0' }}>
            {result === 'accepted' && (
              <div style={{ color: '#10b981', fontSize: 16, fontWeight: 600 }}>
                Add-On Accepted — +{addOnChips.toLocaleString()} chips added
              </div>
            )}
            {result === 'declined' && (
              <div style={{ color: 'rgba(255,255,255,0.5)', fontSize: 16, fontWeight: 600 }}>
                Add-On Declined
              </div>
            )}
            {result === 'insufficient' && (
              <div style={{ color: '#ef4444', fontSize: 16, fontWeight: 600 }}>
                Insufficient Balance — Add-On Denied
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
