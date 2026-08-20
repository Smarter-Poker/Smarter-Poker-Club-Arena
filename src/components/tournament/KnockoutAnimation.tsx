/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  KNOCKOUT ANIMATION — a bounty being claimed, at the table (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: "when a player knocks another player out, we need a fully built
 * animation for that."
 *
 * Until now a knockout in a bounty event produced a one-line text banner and a
 * cha-ching. The single most dramatic thing that happens in a bounty
 * tournament — you took someone's head and got paid for it — read like a
 * system notice.
 *
 * The engine already broadcasts `bounty_collected` to the WHOLE table, so this
 * plays for every seat simultaneously with no new plumbing. TablePage feeds it
 * the payload and suppresses the old text banner for this event type.
 *
 * Deliberately NOT click-blocking: it sits over the felt with pointer-events
 * none and clears itself. A knockout happens to you while you are in a hand;
 * it must never eat the fold button. (The mystery-bounty chest is the opposite
 * case — that one is a takeover, because it is asking you to open it.)
 */

import React, { useEffect, useRef, useState } from 'react';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import './KnockoutAnimation.css';

export interface KnockoutData {
  /** Player who scored the knockout. */
  knockerName: string;
  /** Player who was eliminated. */
  eliminatedName: string;
  /** Cash value of the bounty claimed. */
  amount: number;
  /** Portion added to the knocker's own head (PKO). 0 for a flat bounty. */
  addedToHead?: number;
  /** True when the hero is the one who scored it — earns a warmer treatment. */
  isHero?: boolean;
  currency?: string;
}

export interface KnockoutAnimationProps {
  data: KnockoutData | null;
  onDone: () => void;
  /** False on a background table — visuals still run, audio does not. */
  playSounds?: boolean;
}

/** Total time the overlay is on screen, before the speed multiplier. */
const KNOCKOUT_DURATION_MS = 3200;

export default function KnockoutAnimation({
  data,
  onDone,
  playSounds = true,
}: KnockoutAnimationProps) {
  const [phase, setPhase] = useState<'idle' | 'impact' | 'payout'>('idle');
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    if (!data) {
      setPhase('idle');
      return;
    }

    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();

    setPhase('impact');
    if (playSounds) {
      try {
        soundService.playBountyCollected();
      } catch {
        /* audio is best-effort — never let it break the visual */
      }
    }

    // The bounty amount arrives AFTER the hit, never with it. The strike and
    // the payday are two separate satisfactions and collapsing them into one
    // frame wastes both.
    const toPayout = setTimeout(() => setPhase('payout'), (reduced ? 200 : 850) * speed);
    const toEnd = setTimeout(
      () => {
        setPhase('idle');
        onDoneRef.current();
      },
      (reduced ? 1400 : KNOCKOUT_DURATION_MS) * speed
    );

    timersRef.current = [toPayout, toEnd];
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
    };
    // `data` identity changes per knockout, which is exactly the retrigger we
    // want; onDone is held in a ref so a new callback identity cannot restart
    // the sequence mid-flight.
  }, [data, playSounds]);

  if (!data || phase === 'idle') return null;

  const currency = data.currency ?? '';
  const showHeadGrowth = (data.addedToHead ?? 0) > 0;

  return (
    <div
      className={`ko${data.isHero ? ' ko--hero' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`${data.knockerName} knocked out ${data.eliminatedName} for ${currency}${data.amount}`}
    >
      {/* Vignette — pulls the eye to the middle without hiding the felt. */}
      <div className="ko__vignette" />

      {/* Impact burst behind the word, so "KNOCKOUT" reads as the cause. */}
      <div className="ko__burst" aria-hidden="true">
        <span className="ko__ray" style={{ ['--ko-ray-i' as string]: 0 }} />
        <span className="ko__ray" style={{ ['--ko-ray-i' as string]: 1 }} />
        <span className="ko__ray" style={{ ['--ko-ray-i' as string]: 2 }} />
        <span className="ko__ray" style={{ ['--ko-ray-i' as string]: 3 }} />
        <span className="ko__ray" style={{ ['--ko-ray-i' as string]: 4 }} />
        <span className="ko__ray" style={{ ['--ko-ray-i' as string]: 5 }} />
      </div>
      <div className="ko__shockwave" aria-hidden="true" />

      <div className="ko__stack">
        <div className="ko__stamp">KNOCKOUT</div>

        <div className="ko__names">
          <span className="ko__knocker">{data.knockerName}</span>
          <span className="ko__verb">eliminated</span>
          <span className="ko__eliminated">{data.eliminatedName}</span>
        </div>

        {phase === 'payout' && (
          <>
            <div className="ko__bounty">
              <span className="ko__bounty-plus">+</span>
              <span className="ko__bounty-amount">
                {currency}
                {data.amount.toLocaleString()}
              </span>
              <span className="ko__bounty-label">BOUNTY</span>
            </div>

            {showHeadGrowth && (
              // PKO: half the head goes to your own bounty. Players consistently
              // miss this, so it is stated rather than implied.
              <div className="ko__head-growth">
                {currency}
                {(data.addedToHead ?? 0).toLocaleString()} added to your head
              </div>
            )}

            <div className="ko__coins" aria-hidden="true">
              {Array.from({ length: 10 }, (_, i) => (
                <span key={i} className="ko__coin" style={{ ['--ko-coin-i' as string]: i }} />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
