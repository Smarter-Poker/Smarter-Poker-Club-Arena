/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MYSTERY BOUNTY CHEST — click-to-open reveal, synced to the whole table
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-08-20: "it needs to appear as like a suspense filled in screen with
 * a treasure chest that needs to be CLICKED TO OPEN, and then some animation
 * followed by an EXPLOSION with the amount of the mystery bounty revealed to
 * the winner. (ALL OTHER USERS AT THE TABLE SHOULD SEE THIS AS WELL IN REAL
 * TIME.)"
 *
 * There is an older MysteryBountyReveal (an envelope that opens ITSELF after
 * 1200ms) mounted on TournamentPage. It is not this: it cannot be clicked, it
 * is not a chest, and it never appears at the table where the knockout
 * actually happens. This component replaces it at the table.
 *
 * ─── The five beats ─────────────────────────────────────────────────────────
 *   landing    chest drops in and thumps                            (~700ms)
 *   locked     chest breathes, seams glow, dust rises — SUSPENSE    (until opened)
 *   opening    latch pops, lid swings, light floods the seam        (~900ms)
 *   explosion  white flash, shockwave, coin fountain                (~600ms)
 *   revealed   amount counts up, tier named, confetti on big ones   (~5s)
 *
 * ─── Who can open it ────────────────────────────────────────────────────────
 * Only the winner sees "TAP TO OPEN". Everyone else sees the same chest with
 * "<name> is opening the chest…" so the suspense is genuinely shared rather
 * than each client running its own private timeline.
 *
 * ─── How it stays in sync ───────────────────────────────────────────────────
 * The winner's tap broadcasts `mystery_chest_opened` on the table channel, and
 * every client transitions on receipt. The winner ALSO opens locally without
 * waiting for the round trip, so their own tap feels instant — the broadcast
 * is for everyone else.
 *
 * If the winner never taps (disconnected, AFK, looking away), the chest opens
 * itself after AUTO_OPEN_MS. That timer is owned by the WINNER'S client alone,
 * so nine spectators cannot fire nine broadcasts; every other client falls back
 * to its own longer failsafe only if no broadcast ever arrives.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { soundService } from '../../services/SoundService';
import { getAnimationSpeed, prefersReducedMotion } from '../../utils/animationSpeed';
import { fireVibration } from '../../utils/vibrationGate';
import './MysteryBountyChest.css';

export interface MysteryChestData {
  /** userId of the player who scored the knockout — only they can open it. */
  knockerUserId: string;
  knockerName: string;
  eliminatedName: string;
  /** The hidden prize. */
  amount: number;
  /** Server-supplied tier name, e.g. 'JACKPOT'. Derived from amount if absent. */
  tierLabel?: string;
  isJackpot?: boolean;
  /** Average bounty in this event, used to derive a tier when none is given. */
  avgBounty?: number;
  currency?: string;
}

export interface MysteryBountyChestProps {
  data: MysteryChestData | null;
  /** The viewing player. Compared against knockerUserId to decide who may open. */
  viewerUserId: string | null;
  onDone: () => void;
  /**
   * Tell the rest of the table the chest was opened. Supplied by TablePage,
   * which owns the realtime channel. Absent -> local-only (still works).
   */
  onBroadcastOpen?: () => void;
  /** Set when another client's broadcast says the chest is open. */
  remoteOpened?: boolean;
  /** How many more chests are waiting behind this one. */
  queuedBehind?: number;
  /** False on a background table — visuals still run, audio does not. */
  playSounds?: boolean;
}

type Phase = 'idle' | 'landing' | 'locked' | 'opening' | 'explosion' | 'revealed';

/** Winner's grace period before the chest opens itself. */
const AUTO_OPEN_MS = 9000;
/** Spectator failsafe: only used if no broadcast ever lands. */
const SPECTATOR_FAILSAFE_MS = 14000;

const TIER_COLORS: Record<string, string> = {
  min: '#6b7280',
  small: '#60a5fa',
  medium: '#34d399',
  large: '#fbbf24',
  huge: '#f97316',
  mega: '#ef4444',
  grand: '#a855f7',
  jackpot: '#FFD700',
};

/**
 * Tier from the amount relative to this event's average bounty. Kept identical
 * to the legacy MysteryBountyReveal so the same prize never gets two different
 * names depending on which surface showed it.
 */
export function getTier(amount: number, avgBounty: number): { label: string; color: string } {
  if (!avgBounty || avgBounty <= 0) return { label: 'Prize', color: '#60a5fa' };
  const ratio = amount / avgBounty;
  if (ratio >= 50) return { label: 'JACKPOT', color: TIER_COLORS.jackpot };
  if (ratio >= 20) return { label: 'Grand Prize', color: TIER_COLORS.grand };
  if (ratio >= 10) return { label: 'Mega Prize', color: TIER_COLORS.mega };
  if (ratio >= 5) return { label: 'Huge Prize', color: TIER_COLORS.huge };
  if (ratio >= 2.5) return { label: 'Large Prize', color: TIER_COLORS.large };
  if (ratio >= 1.5) return { label: 'Medium Prize', color: TIER_COLORS.medium };
  if (ratio >= 0.5) return { label: 'Small Prize', color: TIER_COLORS.small };
  return { label: 'Min Prize', color: TIER_COLORS.min };
}

function fireConfetti(isJackpot: boolean) {
  import('canvas-confetti')
    .then((mod) => {
      const confetti = mod.default;
      const gold = ['#FFD700', '#FFC107', '#FFB300', '#FF8F00', '#FFECB3'];
      confetti({
        particleCount: isJackpot ? 300 : 140,
        spread: isJackpot ? 180 : 110,
        origin: { y: 0.45 },
        colors: gold,
        scalar: isJackpot ? 1.3 : 1,
      });
      if (isJackpot) {
        setTimeout(
          () =>
            confetti({ particleCount: 150, spread: 120, origin: { y: 0.2, x: 0.2 }, colors: gold }),
          200
        );
        setTimeout(
          () =>
            confetti({ particleCount: 150, spread: 120, origin: { y: 0.2, x: 0.8 }, colors: gold }),
          380
        );
      }
    })
    .catch(() => {
      /* confetti is a bonus, never a requirement */
    });
}

export default function MysteryBountyChest({
  data,
  viewerUserId,
  onDone,
  onBroadcastOpen,
  remoteOpened = false,
  queuedBehind = 0,
  playSounds = true,
}: MysteryBountyChestProps) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [displayAmount, setDisplayAmount] = useState(0);
  /**
   * How long the winner has been staring at a locked chest, in whole seconds.
   *
   * Suspense that stays at one intensity stops being suspense — it becomes a
   * paused screen. The chest rattles harder and the glow tightens the longer
   * it goes unopened, which also quietly communicates that something is going
   * to happen whether or not they tap.
   */
  const [tension, setTension] = useState(0);
  const [pressed, setPressed] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const rafRef = useRef<number | null>(null);
  const openedRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  const isWinner = !!data && !!viewerUserId && data.knockerUserId === viewerUserId;
  const tier = data?.tierLabel
    ? { label: data.tierLabel, color: TIER_COLORS[data.tierLabel.toLowerCase()] || '#60a5fa' }
    : getTier(data?.amount ?? 0, data?.avgBounty ?? data?.amount ?? 0);
  const isJackpot = data?.isJackpot || tier.label === 'JACKPOT';

  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  };

  /** Run the open -> explosion -> reveal sequence. Idempotent. */
  const runOpen = useCallback(() => {
    if (openedRef.current || !data) return;
    openedRef.current = true;

    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();
    setPhase('opening');

    if (playSounds) {
      try {
        soundService.playMysteryChestOpen();
      } catch {
        /* best effort */
      }
    }
    fireVibration([20, 40, 30]);

    const openMs = (reduced ? 250 : 900) * speed;
    const boomMs = (reduced ? 150 : 600) * speed;

    const toExplosion = setTimeout(() => {
      setPhase('explosion');
      if (playSounds) {
        try {
          soundService.playMysteryChestExplosion();
        } catch {
          /* best effort */
        }
      }
      fireVibration([50, 30, 80]);
    }, openMs);

    const toRevealed = setTimeout(() => {
      setPhase('revealed');
      if (playSounds) {
        try {
          soundService.playMysteryBountyReveal();
        } catch {
          /* best effort */
        }
      }
      if (!reduced) fireConfetti(!!isJackpot);

      // Count the number UP rather than printing it. The climb is the reward;
      // a number that simply appears is a receipt.
      const target = data.amount;
      if (reduced) {
        setDisplayAmount(target);
      } else {
        const started = performance.now();
        const durationMs = 1100 * speed;
        const step = (now: number) => {
          const t = Math.min(1, (now - started) / durationMs);
          // Ease-out cubic: fast at first, settling onto the true figure.
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
    }, openMs + boomMs);

    const toEnd = setTimeout(
      () => {
        setPhase('idle');
        onDoneRef.current();
      },
      openMs + boomMs + (reduced ? 2200 : 5200) * speed
    );

    timersRef.current.push(toExplosion, toRevealed, toEnd);
  }, [data, isJackpot, playSounds]);

  /** The winner's tap. Opens locally at once, and tells everyone else. */
  const handleOpenClick = useCallback(() => {
    if (!isWinner || openedRef.current || phase !== 'locked') return;
    try {
      onBroadcastOpen?.();
    } catch {
      // A failed broadcast must not stop the winner seeing their own prize.
    }
    runOpen();
  }, [isWinner, phase, runOpen, onBroadcastOpen]);

  // ── Arrival ───────────────────────────────────────────────────────────────
  useEffect(() => {
    clearTimers();
    openedRef.current = false;
    setDisplayAmount(0);

    if (!data) {
      setPhase('idle');
      return;
    }

    const speed = getAnimationSpeed();
    const reduced = prefersReducedMotion();

    setPhase('landing');
    if (playSounds) {
      try {
        soundService.playMysteryChestLand();
      } catch {
        /* best effort */
      }
    }

    const toLocked = setTimeout(() => setPhase('locked'), (reduced ? 200 : 700) * speed);
    timersRef.current.push(toLocked);

    return clearTimers;
  }, [data, playSounds]);

  // ── Auto-open failsafes ───────────────────────────────────────────────────
  useEffect(() => {
    if (!data || phase !== 'locked') return;

    // Only the WINNER'S client owns the real timer and the broadcast, so an
    // AFK winner cannot produce one broadcast per spectator.
    if (isWinner) {
      const t = setTimeout(() => {
        if (openedRef.current) return;
        try {
          onBroadcastOpen?.();
        } catch {
          /* ignore */
        }
        runOpen();
      }, AUTO_OPEN_MS * getAnimationSpeed());
      timersRef.current.push(t);
      return () => clearTimeout(t);
    }

    // Spectators: open anyway if no broadcast ever arrives, so a dropped
    // packet cannot leave the table staring at a chest forever.
    const t = setTimeout(() => {
      if (!openedRef.current) runOpen();
    }, SPECTATOR_FAILSAFE_MS * getAnimationSpeed());
    timersRef.current.push(t);
    return () => clearTimeout(t);
  }, [data, phase, isWinner, runOpen, onBroadcastOpen]);

  // ── Someone else opened it ────────────────────────────────────────────────
  useEffect(() => {
    if (remoteOpened && data && !openedRef.current && phase !== 'idle') {
      runOpen();
    }
  }, [remoteOpened, data, phase, runOpen]);

  // ── Escalating tension while it sits locked ───────────────────────────────
  useEffect(() => {
    if (phase !== 'locked') {
      setTension(0);
      return;
    }
    const id = setInterval(() => setTension((t) => Math.min(t + 1, 6)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  if (!data || phase === 'idle') return null;

  const currency = data.currency ?? '';
  const canTap = isWinner && phase === 'locked';
  // "50x the average bounty" tells you what the number MEANS. A big figure with
  // no reference point is just a big figure — this is what makes a jackpot read
  // as a jackpot rather than as an unusually long number.
  const multiple =
    data.avgBounty && data.avgBounty > 0 ? data.amount / data.avgBounty : null;

  return (
    <div
      className={`mbc mbc--${phase}${isJackpot ? ' mbc--jackpot' : ''}${
        pressed ? ' mbc--pressed' : ''
      }`}
      style={{ ['--mbc-tension' as string]: tension, ['--mbc-tier' as string]: tier.color }}
      role="dialog"
      aria-modal="true"
      aria-label="Mystery bounty"
    >
      <div className="mbc__backdrop" />

      {/* Rising embers during the wait — the screen should feel alive while
          nothing is happening yet, or the suspense reads as a freeze. */}
      {(phase === 'landing' || phase === 'locked') && (
        <div className="mbc__embers" aria-hidden="true">
          {Array.from({ length: 14 }, (_, i) => (
            <span key={i} className="mbc__ember" style={{ ['--mbc-e' as string]: i }} />
          ))}
        </div>
      )}

      <div className="mbc__stage">
        <div className="mbc__eyebrow">MYSTERY BOUNTY</div>
        <div className="mbc__subject">
          <span className="mbc__winner-name">{data.knockerName}</span>
          <span className="mbc__subject-verb"> eliminated </span>
          <span className="mbc__loser-name">{data.eliminatedName}</span>
        </div>

        {/* ── The chest ── */}
        <button
          type="button"
          className={`mbc__chest${canTap ? ' mbc__chest--tappable' : ''}`}
          onClick={handleOpenClick}
          /* Press physicality: the chest sinks under the finger and releases.
             A button that only reacts on click feels like a link; a lid you can
             feel yourself pushing on is what makes the tap satisfying. Pointer
             events rather than mouse/touch pairs so one path covers both. */
          onPointerDown={() => canTap && setPressed(true)}
          onPointerUp={() => setPressed(false)}
          onPointerLeave={() => setPressed(false)}
          onPointerCancel={() => setPressed(false)}
          disabled={!canTap}
          aria-label={canTap ? 'Tap to open the mystery bounty chest' : 'Mystery bounty chest'}
        >
          <span className="mbc__glow" aria-hidden="true" />

          {/* Sparks escaping the seam while it is locked — the chest is
              straining to open, which is the whole feeling of the beat. */}
          {phase === 'locked' && (
            <span className="mbc__sparks" aria-hidden="true">
              {Array.from({ length: 7 }, (_, i) => (
                <span key={i} className="mbc__spark" style={{ ['--mbc-s' as string]: i }} />
              ))}
            </span>
          )}

          <span className="mbc__chest-lid" aria-hidden="true">
            <span className="mbc__lid-band" />
            <span className="mbc__lid-stud mbc__lid-stud--l" />
            <span className="mbc__lid-stud mbc__lid-stud--r" />
          </span>

          {/* The light escaping from inside, revealed as the lid lifts. */}
          <span className="mbc__inner-light" aria-hidden="true" />

          {/* God-rays fanning out of the open chest. These are what sell the
              idea that something enormous is inside, rather than that a box
              opened. Only rendered once the lid is actually moving. */}
          {(phase === 'opening' || phase === 'explosion' || phase === 'revealed') && (
            <span className="mbc__rays" aria-hidden="true">
              {Array.from({ length: 9 }, (_, i) => (
                <span key={i} className="mbc__ray" style={{ ['--mbc-r' as string]: i }} />
              ))}
            </span>
          )}

          <span className="mbc__chest-base" aria-hidden="true">
            <span className="mbc__base-band" />
            <span className="mbc__lock" />
            <span className="mbc__base-stud mbc__base-stud--l" />
            <span className="mbc__base-stud mbc__base-stud--r" />
          </span>

          <span className="mbc__seam" aria-hidden="true" />
        </button>

        {/* ── Explosion layer ── */}
        {(phase === 'explosion' || phase === 'revealed') && (
          <>
            <div className="mbc__flash" aria-hidden="true" />
            <div className="mbc__shock" aria-hidden="true" />
            <div className="mbc__shock mbc__shock--2" aria-hidden="true" />
            <div className="mbc__coins" aria-hidden="true">
              {Array.from({ length: 18 }, (_, i) => (
                <span key={i} className="mbc__coin" style={{ ['--mbc-c' as string]: i }} />
              ))}
            </div>
          </>
        )}

        {/* ── Prompt / status ── */}
        {phase === 'locked' && (
          <div className="mbc__prompt">
            {isWinner ? (
              <>
                <span className="mbc__prompt-main">TAP THE CHEST TO OPEN</span>
                <span className="mbc__prompt-sub">Your bounty is inside</span>
              </>
            ) : (
              <>
                <span className="mbc__prompt-main mbc__prompt-main--waiting">
                  {data.knockerName} is opening the chest
                  <span className="mbc__dots">
                    <i />
                    <i />
                    <i />
                  </span>
                </span>
                <span className="mbc__prompt-sub">Watch the reveal</span>
              </>
            )}
          </div>
        )}

        {/* ── Reveal ── */}
        {phase === 'revealed' && (
          <div className="mbc__reveal">
            <div className="mbc__tier" style={{ color: tier.color }}>
              {tier.label}
            </div>
            <div className="mbc__amount" style={{ ['--mbc-tier' as string]: tier.color }}>
              {currency}
              {displayAmount.toLocaleString()}
            </div>
            {/* What the number MEANS. A big figure with no reference point is
                just a big figure; "50x the average bounty" is what makes a
                jackpot read as a jackpot. Only shown when it is actually
                notable — 1.1x is noise. */}
            {multiple !== null && multiple >= 2 && (
              <div className="mbc__multiple">
                {multiple >= 10 ? Math.round(multiple) : multiple.toFixed(1)}× the average bounty
              </div>
            )}

            <div className="mbc__won-by">
              won by <strong>{data.knockerName}</strong>
            </div>
          </div>
        )}

        {queuedBehind > 0 && (
          <div className="mbc__queued">
            +{queuedBehind} more bount{queuedBehind > 1 ? 'ies' : 'y'} to reveal
          </div>
        )}
      </div>
    </div>
  );
}
