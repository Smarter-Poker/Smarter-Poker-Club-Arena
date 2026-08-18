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

import React, { useState, useEffect, useRef } from 'react';
import './BadBeatJackpot.css';

export interface BadBeatJackpotProps {
  amount: number;
  currency?: string;
  qualifyingHand: string; // per-variant rule, e.g. "Aces full of Jacks or better must lose to Quads or better"
  subText?: string; // hole-card requirement line, per variant
  /** Stakes-tiered payout percent (15-85) — this table's actual slice of the pool. */
  payoutPercent?: number;
  isHit?: boolean; // Trigger for the hit animation
  /** Tap handler — opens the last-5-jackpots view (Dan, 2026-08-18). */
  onOpenDetails?: () => void;
  onClaimed?: () => void;
}

export function BadBeatJackpot({
  amount,
  currency = '',
  qualifyingHand,
  subText = 'Both hole cards must play.',
  payoutPercent,
  isHit = false,
  onOpenDetails,
}: BadBeatJackpotProps) {
  const [showInfo, setShowInfo] = useState(false);
  const [displayAmount, setDisplayAmount] = useState(amount);
  // Brief scale/glow whenever the jackpot GROWS (2026-08-18) — a live pool
  // that only changes digits reads as static; a bump reads as money landing.
  const [bump, setBump] = useState(false);
  const prevAmountRef = useRef(amount);

  useEffect(() => {
    if (amount > prevAmountRef.current) {
      setBump(true);
      const t = setTimeout(() => setBump(false), 470);
      prevAmountRef.current = amount;
      return () => clearTimeout(t);
    }
    prevAmountRef.current = amount;
  }, [amount]);

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
      {/* BBJ-UX 2026-08-18: hover shows the quick rule on desktop; a TAP opens
          the full jackpot view (last 5 hits + what this table pays), which is
          what players actually want from the banner. Falls back to toggling
          the popover when no handler is wired. */}
      <div
        className="bbj-widget"
        role="button"
        tabIndex={0}
        aria-label="Bad Beat Jackpot — view recent jackpots"
        onMouseEnter={() => setShowInfo(true)}
        onMouseLeave={() => setShowInfo(false)}
        onClick={() => {
          if (onOpenDetails) {
            setShowInfo(false);
            onOpenDetails();
          } else {
            setShowInfo((v) => !v);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (onOpenDetails) onOpenDetails();
            else setShowInfo((v) => !v);
          }
        }}
      >
        <div className="bbj-widget__label">BAD BEAT JACKPOT</div>
        <div className={`bbj-widget__amount${bump ? ' bbj-widget__amount--bump' : ''}`}>
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
            {/* PAYOUT-TRUTH 2026-08-18: the banner shows the FULL pool, but a
                table only pays its stakes-tiered slice (nano 15% ... 85%).
                Showing the real number here beats a six-figure tease that a
                nano table can never pay. */}
            {typeof payoutPercent === 'number' && payoutPercent > 0 && (
              <p className="bbj-info__payout">
                This table hits for {payoutPercent}% of the pool
                {amount > 0 && (
                  <>
                    {' '}
                    (&asymp; {currency}
                    {Math.trunc((amount * payoutPercent) / 100).toLocaleString('en-US')})
                  </>
                )}
                &nbsp;&mdash; 50% bad beat / 25% winner / 25% table
              </p>
            )}
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
