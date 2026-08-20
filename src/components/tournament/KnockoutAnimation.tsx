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
 * ─── The three beats ────────────────────────────────────────────────────────
 *   impact   (0ms)    burst, shockwave, KNOCKOUT slams in, the head cracks
 *   payout   (850ms)  the bounty counts UP, coins scatter
 *   split    (1500ms) PKO only — the head visibly divides: cash to you now,
 *                     the rest welded onto your own head
 *
 * They are separate on purpose. The strike and the payday are two different
 * satisfactions, and a PKO split is a third; collapsing them into one frame
 * spends all three at once and the player registers none of them.
 *
 * ─── Why it never blocks ────────────────────────────────────────────────────
 * pointer-events: none. A knockout lands while you may be IN a hand, so an
 * overlay that swallowed a click on the fold button would be strictly worse
 * than no animation at all. (The mystery chest is the opposite case — that one
 * is a takeover, because it is asking to be tapped.)
 *
 * ─── Why it is queued ───────────────────────────────────────────────────────
 * A three-way all-in busts two players and the engine broadcasts twice. See
 * src/hooks/useAnimationQueue.ts — the parent gives us one at a time, and
 * `queuedBehind` lets us tell the player more are coming.
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
  /** Avatar of the player who busted, if the payload carried one. */
  eliminatedAvatar?: string;
  currency?: string;
}

export interface KnockoutAnimationProps {
  data: KnockoutData | null;
  onDone: () => void;
  /** How many more knockouts are waiting. Shown as a "+N more" hint. */
  queuedBehind?: number;
  /** False on a background table — visuals still run, audio does not. */
  playSounds?: boolean;
}

type Phase = 'idle' | 'impact' | 'payout' | 'split';

const BEAT_PAYOUT_MS = 850;
const BEAT_SPLIT_MS = 1500;
const KNOCKOUT_DURATION_MS = 3600;

export default function KnockoutAnimation({
  data,
  onDone,
  queuedBehind = 0,
  playSounds = true,
}: KnockoutAnimationProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [displayAmount, setDisplayAmount] = useState(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafRef = useRef<number | null>(null);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const hasSplit = (data?.addedToHead ?? 0) > 0;

  useEffect(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    if (!data) {
      setPhase('idle');
      setDisplayAmount(0);
      return;
    }

    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();

    setPhase('impact');
    setDisplayAmount(0);
    if (playSounds) {
      try {
        soundService.playBountyCollected();
      } catch {
        /* audio is best-effort — never let it break the visual */
      }
    }

    const payoutAt = (reduced ? 200 : BEAT_PAYOUT_MS) * speed;
    const splitAt = (reduced ? 500 : BEAT_SPLIT_MS) * speed;

    const toPayout = setTimeout(() => {
      setPhase('payout');

      // Count the bounty UP rather than printing it. Same reasoning as the
      // mystery chest: the climb is the reward, a number that simply appears
      // is a receipt. Short — this is a beat, not a ceremony.
      const target = data.amount;
      if (reduced || target <= 0) {
        setDisplayAmount(target);
      } else {
        const started = performance.now();
        const durationMs = 620 * speed;
        const step = (now: number) => {
          const t = Math.min(1, (now - started) / durationMs);
          const eased = 1 - Math.pow(1 - t, 3);
          setDisplayAmount(Math.round(target * eased));
          if (t < 1) {
            rafRef.current = requestAnimationFrame(step);
          } else {
            rafRef.current = null;
            setDisplayAmount(target);
          }
        };
        rafRef.current = requestAnimationFrame(step);
      }
    }, payoutAt);

    const timers = [toPayout];

    if (hasSplit) {
      timers.push(setTimeout(() => setPhase('split'), splitAt));
    }

    timers.push(
      setTimeout(
        () => {
          setPhase('idle');
          onDoneRef.current();
        },
        (reduced ? 1600 : KNOCKOUT_DURATION_MS) * speed
      )
    );

    timersRef.current = timers;
    return () => {
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    // `data` identity changes per knockout, which is exactly the retrigger we
    // want; onDone is held in a ref so a new callback identity cannot restart
    // the sequence mid-flight.
  }, [data, playSounds, hasSplit]);

  if (!data || phase === 'idle') return null;

  const currency = data.currency ?? '';
  const showMoney = phase === 'payout' || phase === 'split';
  const initial = (data.eliminatedName || '?').charAt(0).toUpperCase();

  return (
    <div
      className={`ko ko--${phase}${data.isHero ? ' ko--hero' : ''}`}
      role="status"
      aria-live="polite"
      aria-label={`${data.knockerName} knocked out ${data.eliminatedName} for ${currency}${data.amount}`}
    >
      <div className="ko__vignette" />

      {/* Impact burst behind the word, so "KNOCKOUT" reads as the cause. */}
      <div className="ko__burst" aria-hidden="true">
        {Array.from({ length: 8 }, (_, i) => (
          <span key={i} className="ko__ray" style={{ ['--ko-ray-i' as string]: i }} />
        ))}
      </div>
      <div className="ko__shockwave" aria-hidden="true" />
      <div className="ko__shockwave ko__shockwave--2" aria-hidden="true" />

      <div className="ko__stack">
        {/* ── The head ──
            A bounty IS a head. Showing the eliminated player's face crack and
            fall makes the abstraction concrete in a way a struck-through name
            cannot — and it is the object the money visibly comes from. */}
        <div className="ko__head" aria-hidden="true">
          <div className="ko__head-disc">
            {data.eliminatedAvatar ? (
              <img className="ko__head-img" src={data.eliminatedAvatar} alt="" />
            ) : (
              <span className="ko__head-initial">{initial}</span>
            )}
            <span className="ko__crack ko__crack--1" />
            <span className="ko__crack ko__crack--2" />
            <span className="ko__crack ko__crack--3" />
          </div>
          <div className="ko__head-ring" />
        </div>

        <div className="ko__stamp">KNOCKOUT</div>

        <div className="ko__names">
          <span className="ko__knocker">{data.knockerName}</span>
          <span className="ko__verb">eliminated</span>
          <span className="ko__eliminated">{data.eliminatedName}</span>
        </div>

        {showMoney && (
          <>
            <div className="ko__bounty">
              <span className="ko__bounty-plus">+</span>
              <span className="ko__bounty-amount">
                {currency}
                {displayAmount.toLocaleString()}
              </span>
              <span className="ko__bounty-label">BOUNTY</span>
            </div>

            <div className="ko__coins" aria-hidden="true">
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} className="ko__coin" style={{ ['--ko-coin-i' as string]: i }} />
              ))}
            </div>
          </>
        )}

        {/* ── PKO split ──
            Players consistently miss that half the head becomes their OWN
            bounty, which changes how everyone else should play against them.
            Stated as a split with two destinations rather than as a footnote. */}
        {phase === 'split' && hasSplit && (
          <div className="ko__split">
            <div className="ko__split-arm ko__split-arm--cash">
              <span className="ko__split-amount">
                {currency}
                {data.amount.toLocaleString()}
              </span>
              <span className="ko__split-label">paid to you</span>
            </div>
            <span className="ko__split-divider" aria-hidden="true" />
            <div className="ko__split-arm ko__split-arm--head">
              <span className="ko__split-amount ko__split-amount--head">
                {currency}
                {(data.addedToHead ?? 0).toLocaleString()}
              </span>
              <span className="ko__split-label">onto your head</span>
            </div>
          </div>
        )}

        {/* More knockouts waiting. Without this a player who busted two people
            sees one celebration end and another begin with no explanation. */}
        {queuedBehind > 0 && (
          <div className="ko__queued">
            +{queuedBehind} more knockout{queuedBehind > 1 ? 's' : ''}
          </div>
        )}
      </div>
    </div>
  );
}
