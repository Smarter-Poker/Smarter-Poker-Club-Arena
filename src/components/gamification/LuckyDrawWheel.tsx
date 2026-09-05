/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  LUCKY DRAW WHEEL — Premium animated spin wheel bonus
 * ═══════════════════════════════════════════════════════════════════════════════
 * CSS-driven wheel spin with deceleration easing, pointer tick sound,
 * haptic feedback, and reward reveal. Upgrades the existing DailyBonusWheel
 * with richer animations.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { useIsMounted } from '../../hooks/useIsMounted';
import { triggerHaptic } from '../../services/HapticService';
import { masterBus } from '../../core/MasterBus';
import './LuckyDrawWheel.css';
import { reportError } from '../../utils/errorReporter';

interface WheelSegment {
  id: string;
  label: string;
  icon: string;
  color: string;
  amount: number;
  type: 'diamonds' | 'chips' | 'bonus';
}

interface LuckyDrawWheelProps {
  segments?: WheelSegment[];
  /** Called when user spins — should return the winning segment ID */
  onSpin: () => Promise<string>;
  onClose: () => void;
  spinsRemaining?: number;
  totalSpins?: number;
  streakMultiplier?: number;
}

const DEFAULT_SEGMENTS: WheelSegment[] = [
  { id: '1', label: '10', icon: '◆', color: '#7c3aed', amount: 10, type: 'diamonds' },
  { id: '2', label: '50', icon: '◉', color: '#00c853', amount: 50, type: 'chips' },
  { id: '3', label: '25', icon: '◆', color: '#1a73e8', amount: 25, type: 'diamonds' },
  { id: '4', label: '100', icon: '◉', color: '#ff6d00', amount: 100, type: 'chips' },
  { id: '5', label: '5', icon: '◆', color: '#e91e63', amount: 5, type: 'diamonds' },
  { id: '6', label: '200', icon: '◉', color: '#ffd700', amount: 200, type: 'chips' },
  { id: '7', label: '50', icon: '◆', color: '#00bcd4', amount: 50, type: 'diamonds' },
  { id: '8', label: '500', icon: '★', color: '#9c27b0', amount: 500, type: 'chips' },
];

export default function LuckyDrawWheel({
  segments = DEFAULT_SEGMENTS,
  onSpin,
  onClose,
  spinsRemaining = 1,
  totalSpins = 0,
  streakMultiplier = 1,
}: LuckyDrawWheelProps) {
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<WheelSegment | null>(null);
  const [rotation, setRotation] = useState(0);
  const wheelRef = useRef<HTMLDivElement>(null);
  const spinTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMounted = useIsMounted();

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (spinTimerRef.current) clearTimeout(spinTimerRef.current);
    };
  }, []);

  const segAngle = segments.length > 0 ? 360 / segments.length : 45; // fallback to 8 segments

  const handleSpin = useCallback(async () => {
    if (spinning || spinsRemaining <= 0 || segments.length === 0) return;
    setSpinning(true);
    setResult(null);
    triggerHaptic('medium');

    let winnerId: string;
    try {
      // Get winning segment from server
      winnerId = await onSpin();
    } catch (err) {
      // Error recovery: reset spinning state so user can retry
      reportError(err, 'LuckyDrawWheel.onSpin_failed');
      if (isMounted.current) setSpinning(false);
      return;
    }

    if (!isMounted.current) return;

    const winIndex = segments.findIndex((s) => s.id === winnerId);
    const safeIndex = winIndex >= 0 ? winIndex : 0;
    const winSegment = segments[safeIndex];

    // Calculate final rotation:
    // Multiple full spins (4-6) + offset to land on winning segment
    const fullSpins = (4 + Math.random() * 2) * 360;
    // The pointer is at the top (0°), so we need the winning segment's center there
    const segCenterAngle = safeIndex * segAngle + segAngle / 2;
    const targetRotation = rotation + fullSpins + (360 - segCenterAngle);

    setRotation(targetRotation);

    // Wait for spin to complete (matches CSS transition duration)
    spinTimerRef.current = setTimeout(() => {
      if (!isMounted.current) return;
      triggerHaptic('success');
      masterBus.emit('WHEEL_SPIN_RESULT', {
        segmentId: winSegment.id,
        amount: winSegment.amount,
        type: winSegment.type,
      });
      setResult(winSegment);
      setSpinning(false);
    }, 4000);
  }, [spinning, spinsRemaining, onSpin, segments, rotation, segAngle]);

  return (
    <div className="ldw-overlay" onClick={!spinning ? onClose : undefined}>
      <div className="ldw-container" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="ldw-header">
          <span className="ldw-title">Lucky Draw</span>
          <button className="ldw-close" onClick={onClose} aria-label="Close Lucky Draw">
            ✕
          </button>
        </div>

        {/* 2026-09-05: the "{n}x Streak Bonus!" banner is REMOVED, and so is
            the multiplication further down. `claim_lucky_wheel_spin` credits
            `v_pick.amount` exactly - it applies no streak multiplier of any
            kind - so both were advertising a bonus the ledger does not pay.
            Nobody was misled only because this component is imported by no
            file and `user_lucky_wheel_spins` holds 0 rows: the wheel has
            never been spun, by anyone. If it is ever mounted, it now tells
            the truth. See docs/changelog/2026-09-04-profile-credential-
            casino-realism.md. */}

        {/* Wheel */}
        <div className="ldw-wheel-frame">
          {/* Pointer (top center) */}
          <div className="ldw-pointer">▼</div>

          {/* Spinning wheel */}
          <div
            className="ldw-wheel"
            ref={wheelRef}
            style={{
              transform: `rotate(${rotation}deg)`,
              transition: spinning ? 'transform 4s cubic-bezier(0.17, 0.67, 0.12, 0.99)' : 'none',
            }}
          >
            {segments.map((seg, i) => {
              const angle = i * segAngle;
              return (
                <div
                  key={seg.id}
                  className="ldw-segment"
                  style={
                    {
                      transform: `rotate(${angle}deg)`,
                      '--seg-color': seg.color,
                      '--seg-angle': `${segAngle}deg`,
                    } as React.CSSProperties
                  }
                >
                  <div
                    className="ldw-seg-content"
                    style={{ transform: `rotate(${segAngle / 2}deg)` }}
                  >
                    <span className="ldw-seg-icon">{seg.icon}</span>
                    <span className="ldw-seg-label">{seg.label}</span>
                  </div>
                </div>
              );
            })}
            {/* Center hub */}
            <div className="ldw-hub">
              <span className="ldw-hub-text">SPIN</span>
            </div>
          </div>
        </div>

        {/* Result */}
        {result && (
          <div className="ldw-result">
            <span className="ldw-result-icon">{result.icon}</span>
            <span className="ldw-result-text">
              You Won{' '}
              {/* The amount the RPC actually credited. It was multiplied by
                  `streakMultiplier` here, which claim_lucky_wheel_spin never
                  applies - the player would have been shown up to twice what
                  landed in their wallet. */}
              <strong>
                +{result.amount.toLocaleString()} {result.label}
              </strong>
              !
            </span>
          </div>
        )}

        {/* Spin Button */}
        <button
          className="ldw-spin-btn"
          onClick={handleSpin}
          disabled={spinning || spinsRemaining <= 0}
        >
          {spinning ? 'Spinning...' : result ? 'Spin Again' : 'SPIN THE WHEEL'}
        </button>

        {spinsRemaining > 0 && !spinning && (
          <span className="ldw-spins-left">
            {spinsRemaining} Spin{spinsRemaining !== 1 ? 's' : ''} Remaining
          </span>
        )}

        {totalSpins > 0 && (
          <span className="ldw-total-spins">Total Spins: {totalSpins.toLocaleString()}</span>
        )}
      </div>
    </div>
  );
}

export { DEFAULT_SEGMENTS };
export type { WheelSegment };
