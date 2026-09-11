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

import React, { useState, useEffect, useMemo, useRef } from 'react';
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
  /**
   * THE MINI, UNDER THE PLATE (Dan 2026-09-11): "UNDER IT SHOULD BE A MINI BBJ
   * AMOUNT THAT IS DYNAMIC AND ADJUSTS WITH THE TABLE. (IT SHOULD DISPLAY WHAT
   * IT PAYS OUT UNDER IT)." The flat amount the mini pays at THIS table's
   * stakes, from lib/bbjMiniFeed. Null or 0 draws nothing - a mini that cannot
   * pay right now (reserve at its floor, tier disabled) must not be promised.
   */
  miniAmount?: number | null;
  /** The mini's own bar at this table, for the hover summary. */
  miniQualifyingHand?: string | null;
}

export function BadBeatJackpot({
  amount,
  currency = '',
  qualifyingHand,
  subText = 'Both hole cards must play.',
  payoutPercent,
  isHit = false,
  onOpenDetails,
  miniAmount = null,
  miniQualifyingHand = null,
}: BadBeatJackpotProps) {
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

  /**
   * THE HOVER POPOVER IS GONE (audit 2026-08-25). See the note above
   * `.bbj-widget { overflow: hidden }` in BadBeatJackpot.css for the full
   * reasoning; in short, `.bbj-info` was a `top: 100%` child of a plate that
   * has clipped its overflow since the 2026-08-18 sheen pass, so it has not
   * been visible to anyone for a week, and every fact it carried is in
   * BBJInfoModal — which this plate opens on tap or Enter — in a better form.
   *
   * The information itself was worth keeping for a desktop glance, so it moved
   * to the plate's native `title`. A tooltip is painted by the browser outside
   * the document, so no ancestor's `overflow`, `transform` or `contain` can
   * ever clip it again — which is exactly the failure mode being fixed.
   */
  const hoverSummary = useMemo(() => {
    const lines = [`Qualifying Hand: ${qualifyingHand}`];
    if (subText) lines.push(subText);
    if (typeof payoutPercent === 'number' && payoutPercent > 0) {
      const share =
        amount > 0
          ? ` (about ${currency}${Math.trunc((amount * payoutPercent) / 100).toLocaleString('en-US')})`
          : '';
      lines.push(
        `This table hits for ${payoutPercent}% of the pool${share} - 50% bad beat / 25% winner / 25% table.`
      );
    }
    if (typeof miniAmount === 'number' && miniAmount > 0) {
      lines.push(
        `Mini jackpot at these stakes: ${currency}${Math.trunc(miniAmount).toLocaleString('en-US')}` +
          (miniQualifyingHand ? ` - ${miniQualifyingHand}.` : '.')
      );
    }
    lines.push('Tap for the last five jackpots.');
    return lines.join('\n');
  }, [qualifyingHand, subText, payoutPercent, amount, currency, miniAmount, miniQualifyingHand]);

  const showMini = typeof miniAmount === 'number' && miniAmount > 0;

  return (
    <>
      {/* Table Widget — a TAP (or Enter/Space) opens the full jackpot view:
          last 5 hits, what this table pays, and the qualifying hands. */}
      <div
        className="bbj-widget"
        role="button"
        tabIndex={0}
        aria-label="Bad Beat Jackpot - View Recent Jackpots"
        title={hoverSummary}
        onClick={() => onOpenDetails?.()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenDetails?.();
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
      </div>

      {/* THE MINI ROW, hung under the plate. Its own element rather than a
          third line inside the plate, because the phone plate is a DECLARED
          22px single row (see --sp-bbj-plate-h in BadBeatJackpot.css) and the
          felt's top reserve is measured against it. The reserve reads
          --sp-bbj-h, which grows by this row's height when TablePage stamps
          data-bbj-mini="1" - the same condition that renders this. The amount
          is the flat mini for THIS table's stakes, so it changes with the
          table, as asked. Same tap, same popup. */}
      {showMini && (
        <div
          className="bbj-mini-plate"
          role="button"
          tabIndex={0}
          aria-label="Mini Bad Beat Jackpot - View Recent Jackpots"
          title={hoverSummary}
          onClick={() => onOpenDetails?.()}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onOpenDetails?.();
            }
          }}
        >
          <span className="bbj-mini-plate__label">MINI BBJ</span>
          <span className="bbj-mini-plate__amount">
            {currency}
            {Math.trunc(miniAmount as number).toLocaleString('en-US')}
          </span>
        </div>
      )}

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
