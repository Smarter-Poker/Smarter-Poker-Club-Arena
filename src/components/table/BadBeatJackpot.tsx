/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BAD BEAT JACKPOT — Jackpot Display & Trigger
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Displays the current Bad Beat Jackpot amount.
 * - Live ticker update
 * - Qualifying hand info
 * - "Jackpot Hit" celebration animation
 */

import React, { useState, useEffect } from 'react';
import './BadBeatJackpot.css';

export interface BadBeatJackpotProps {
  amount: number;
  currency?: string;
  qualifyingHand: string; // per-variant rule, e.g. "Aces full of Jacks or better must lose to Quads or better"
  subText?: string; // hole-card requirement line, per variant
  isHit?: boolean; // Trigger for the hit animation
  onClaimed?: () => void;
}

export function BadBeatJackpot({
  amount,
  currency = '',
  qualifyingHand,
  subText = 'Both hole cards must play.',
  isHit = false,
}: BadBeatJackpotProps) {
  const [showInfo, setShowInfo] = useState(false);
  const [displayAmount, setDisplayAmount] = useState(amount);

  // Smooth ticker effect for amount changes
  useEffect(() => {
    if (amount === displayAmount) return;

    // Simple lerp for visual effect (or direct set if preferring instant)
    const diff = amount - displayAmount;
    const step = diff / 20; // 20 frames to reach target

    const interval = setInterval(() => {
      setDisplayAmount((prev) => {
        const next = prev + step;
        if ((step > 0 && next >= amount) || (step < 0 && next <= amount)) {
          clearInterval(interval);
          return amount;
        }
        return next;
      });
    }, 50);

    return () => clearInterval(interval);
  }, [amount]);

  return (
    <>
      {/* Table Widget */}
      {/* BBJ-UX 2026-08-18: hover-only popover was unreachable on touch
          devices (the primary client at 375px). Tap now toggles it too. */}
      <div
        className="bbj-widget"
        onMouseEnter={() => setShowInfo(true)}
        onMouseLeave={() => setShowInfo(false)}
        onClick={() => setShowInfo((v) => !v)}
      >
        <div className="bbj-widget__label">BAD BEAT JACKPOT</div>
        <div className="bbj-widget__amount">
          {currency}
          {/* Dan 2026-04-17: 2-decimal precision was pushing the banner wider
              than the center gap between hamburger + stats pill at 375px,
              triggering the "truncated" look Dan flagged. For amounts ≥ 1000
              we drop the decimals — the cents on a six-figure jackpot aren't
              informative and burned 3+ chars of width. */}
          {displayAmount >= 1000
            ? Math.trunc(displayAmount).toLocaleString('en-US')
            : (Math.trunc(displayAmount * 100) / 100).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
        </div>

        {/* Info Popover */}
        {showInfo && (
          <div className="bbj-info">
            <h4 className="bbj-info__title">Qualifying Hand</h4>
            <p className="bbj-info__rule">{qualifyingHand}</p>
            {subText && <p className="bbj-info__sub">{subText}</p>}
          </div>
        )}
      </div>

      {/* Hit Animation Overlay */}
      {isHit && (
        <div className="bbj-hit-overlay">
          <div className="bbj-hit-content">
            <div className="bbj-hit__title">BAD BEAT JACKPOT</div>
            <div className="bbj-hit__subtitle">HIT!</div>
            <div className="bbj-hit__amount">
              {currency}
              {(Math.trunc(amount * 100) / 100).toLocaleString('en-US', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}
            </div>
            <div className="bbj-hit__particles">
              {/* CSS particles handled in stylesheet */}
              {[...Array(20)].map((_, i) => (
                <div key={i} className="bbj-particle" />
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export default BadBeatJackpot;
