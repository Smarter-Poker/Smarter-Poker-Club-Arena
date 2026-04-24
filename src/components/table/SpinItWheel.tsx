/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN-IT WHEEL — Animated Prize Multiplier Wheel
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Premium animated wheel that displays during the Spin-It lobby phase:
 * - Radial segments with multiplier labels
 * - Smooth CSS rotation with anticipation/deceleration
 * - Glow pulse on the winning segment
 * - Sound & haptic integration
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { SpinPrizeConfig, SpinMultiplier } from '../../types/engine/spinIt';
import { haptic, soundService } from '../../services/SoundService';
import './SpinItWheel.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface SpinItWheelProps {
  /** Prize tiers from SpinItEngine.getPrizeTiers() */
  tiers: SpinPrizeConfig[];
  /** The winning multiplier (null = hasn't spun yet) */
  result: SpinMultiplier | null;
  /** Whether the wheel is currently spinning */
  isSpinning: boolean;
  /** Called when the spin animation completes */
  onSpinComplete?: () => void;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export function SpinItWheel({ tiers, result, isSpinning, onSpinComplete }: SpinItWheelProps) {
  const [rotation, setRotation] = useState(0);
  const [showResult, setShowResult] = useState(false);
  const wheelRef = useRef<HTMLDivElement>(null);
  const hasSpunRef = useRef(false);

  const segmentAngle = tiers.length > 0 ? 360 / tiers.length : 360;

  // Calculate rotation to land on winning segment
  const getTargetRotation = useCallback(
    (targetMultiplier: SpinMultiplier): number => {
      const targetIdx = tiers.findIndex((t) => t.multiplier === targetMultiplier);
      if (targetIdx < 0) return 0;

      // Target angle: center of the winning segment at the top (pointer at 0°)
      const segmentCenter = targetIdx * segmentAngle + segmentAngle / 2;
      // Spin 5-8 full rotations + land on the target
      const fullRotations = (5 + Math.random() * 3) * 360;
      return fullRotations + (360 - segmentCenter);
    },
    [tiers, segmentAngle]
  );

  // Trigger spin when result is set
  useEffect(() => {
    if (isSpinning && result && !hasSpunRef.current) {
      hasSpunRef.current = true;
      const target = getTargetRotation(result);

      // Anticipation delay
      const anticipationTimer = setTimeout(() => {
        setRotation(target);
        haptic.strong();

        // Decelerating tick pattern over 4s — fast at start, slow at end
        // Cubic easing mirrors the CSS transform easing for audio/visual sync
        const tickTimers: ReturnType<typeof setTimeout>[] = [];
        const SPIN_DURATION = 4000;
        const TICK_COUNT = 32; // 32 ticks spread across 4s
        for (let i = 0; i < TICK_COUNT; i++) {
          const progress = i / TICK_COUNT;
          // Ease-out cubic so ticks start fast and slow to a halt
          const eased = 1 - Math.pow(1 - progress, 3);
          const delay = eased * SPIN_DURATION;
          tickTimers.push(
            setTimeout(() => {
              soundService.playSpinTick();
            }, delay)
          );
        }

        // Wait for CSS transition to finish (4s)
        const resultTimer = setTimeout(() => {
          setShowResult(true);
          soundService.playSpinResult();
          onSpinComplete?.();
        }, 4200);

        // Store timers for potential cleanup — wheelRef will unmount cleanup anyway
        return () => {
          tickTimers.forEach(clearTimeout);
          clearTimeout(resultTimer);
        };
      }, 300);

      return () => {
        clearTimeout(anticipationTimer);
      };
    }
  }, [isSpinning, result, getTargetRotation, onSpinComplete]);

  // Reset on new game
  useEffect(() => {
    if (!isSpinning && !result) {
      setRotation(0);
      setShowResult(false);
      hasSpunRef.current = false;
    }
  }, [isSpinning, result]);

  return (
    <div className="spin-wheel">
      {/* Pointer / Arrow at top */}
      <div className="spin-wheel__pointer">▼</div>

      {/* Rotating wheel */}
      <div
        ref={wheelRef}
        className={`spin-wheel__disc ${isSpinning ? 'spin-wheel__disc--spinning' : ''}`}
        style={{
          transform: `rotate(${rotation}deg)`,
          transition: rotation > 0 ? 'transform 4s cubic-bezier(0.2, 0.8, 0.3, 1)' : 'none',
        }}
      >
        {tiers.map((tier, i) => {
          const startAngle = i * segmentAngle;
          const isWinner = showResult && tier.multiplier === result;

          return (
            <div
              key={tier.multiplier}
              className={`spin-wheel__segment ${isWinner ? 'spin-wheel__segment--winner' : ''}`}
              style={
                {
                  transform: `rotate(${startAngle}deg)`,
                  '--segment-color': tier.color,
                  '--segment-angle': `${segmentAngle}deg`,
                } as React.CSSProperties
              }
            >
              <span
                className="spin-wheel__label"
                style={{
                  transform: `rotate(${segmentAngle / 2}deg) translateY(-60px)`,
                }}
              >
                {tier.label}
              </span>
            </div>
          );
        })}

        {/* Center hub */}
        <div className="spin-wheel__hub">
          <span className="spin-wheel__hub-text">SPIN</span>
        </div>
      </div>

      {/* Result overlay */}
      {showResult && result && (
        <div className="spin-wheel__result">
          <span className="spin-wheel__result-multiplier">
            {tiers.find((t) => t.multiplier === result)?.label ?? `${result}x`}
          </span>
          <span className="spin-wheel__result-label">PRIZE MULTIPLIER</span>
        </div>
      )}
    </div>
  );
}

export default SpinItWheel;
