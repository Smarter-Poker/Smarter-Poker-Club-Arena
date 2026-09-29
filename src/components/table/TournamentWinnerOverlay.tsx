/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT WINNER — the biggest moment the product has, on the spade console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE CONSOLE (#ClubArenaConsole). The celebration used to be a hand-drawn
 * card: a 1.5rem rounded rectangle with an amber border, a warm gradient fill,
 * three stacked box-shadows, a pill-shaped kicker badge, a boxed prize
 * "pedestal" and a rounded gold button. Six drawn controls on a surface where
 * the frame is supposed to be painted.
 *
 * It is now Dan's approved spade master. The event is the eyebrow, the
 * headline is engraved in the header well, the finish sits in the well's
 * painted pill slot, the prize prints on the black glass between the rails,
 * and Continue is a lit word on the flat closing cap (one action, so the foot
 * closes rather than painting two plates with one of them empty).
 *
 * EVERY ANIMATION STILL PLAYS (CLAUDE.md 10.6). Nothing was deleted; each cue
 * moved onto the element that replaced its old host, at its full duration:
 *
 *   winnerRays          .winnerOverlay::before   26s   unchanged (the backdrop)
 *   sparkleFloat        .sparkle                 4.0s  unchanged (the embers)
 *   winnerGrandEntrance .winner-entrance         900ms now the console itself
 *   trophyBounce        .trophy-bounce           2.0s  now the painted pill slot
 *   winnerSheen         .winner-golden           3.6s  now the engraved headline
 *   prizeCounterSlideIn .prize-counter           800ms now the prize line
 *
 * The requestAnimationFrame odometer, its stale-frame guard and the 500ms
 * dismiss timer are untouched - they are pinned by
 * tests/unit/winnerPrizeAnimationLifecycle.test.ts.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SpadeConsole } from '../console/SpadeConsole';
import './TournamentWinnerOverlay.css';
import { formatPrizeAtUnit, moneySuffixAtUnit } from '../../utils/format';

interface TournamentWinnerOverlayProps {
  isWinner: boolean;
  prize: number;
  /**
   * THE UNIT THIS EVENT PAID IN (2026-09-21), from the table's own arena via
   * `arenaAssetUnitCentsIfRead`. A Diamond prize is whole Diamonds and says so;
   * a chip prize prints exactly as it always has, because `formatPrizeAtUnit`
   * at the chip unit IS `formatTableChips`. `null` means the table's arena has
   * not been read yet, and the prize line waits for it rather than printing a
   * figure in a currency nobody looked up.
   */
  unitCents: number | null;
  tournamentName: string;
  position?: number;
  onDismiss: () => void;
}

const TournamentWinnerOverlay: React.FC<TournamentWinnerOverlayProps> = ({
  isWinner,
  prize,
  unitCents,
  tournamentName,
  position = 1,
  onDismiss,
}) => {
  const [visible, setVisible] = useState(false);
  const [particles, setParticles] = useState<
    Array<{ id: number; x: number; y: number; delay: number }>
  >([]);
  const [displayPrize, setDisplayPrize] = useState(0);
  // CA-9 BUG FIX: dismissTimerRef — setTimeout(onDismiss, 500) in handleDismiss was
  // fire-and-forget. If the parent unmounts the overlay in the 500ms window, onDismiss
  // fires on a dead component tree. Added ref + unmount guard.
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (isWinner) {
      setVisible(true);
      // Generate gold sparkle particles instead of confetti
      const newParticles = Array.from({ length: 20 }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        delay: Math.random() * 2.5,
      }));
      setParticles(newParticles);
    } else {
      setVisible(false);
    }
  }, [isWinner]);

  // Animate prize amount
  useEffect(() => {
    setDisplayPrize(0);
    if (!isWinner || !visible || prize <= 0) return;

    let stopped = false;
    let frameId = 0;

    const startTime = Date.now();
    const duration = 1500;
    const startValue = 0;

    const animate = () => {
      if (stopped) return;
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      // Easing function
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = startValue + (prize - startValue) * easeOut;

      setDisplayPrize(current);

      if (progress < 1) {
        frameId = requestAnimationFrame(animate);
      }
    };

    frameId = requestAnimationFrame(animate);
    return () => {
      stopped = true;
      cancelAnimationFrame(frameId);
    };
  }, [isWinner, visible, prize]);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(onDismiss, 500);
  }, [onDismiss]);

  if (!isWinner) return null;

  const paidFinish = position > 1;
  const positionLabel =
    position === 2 ? 'Second Place' : position === 3 ? 'Third Place' : `Place ${position}`;

  return (
    <div
      className={`winnerOverlay ${visible ? 'visible' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={paidFinish ? `${positionLabel} Paid Finish` : 'Tournament Champion'}
      onClick={handleDismiss}
    >
      <div className="sparkleContainer">
        {particles.map((p) => (
          <div
            key={p.id}
            className="sparkle"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              animationDelay: `${p.delay}s`,
            }}
          />
        ))}
      </div>
      <SpadeConsole
        onClose={handleDismiss}
        as="div"
        className="winner-console winner-entrance winner-golden"
        eyebrow={tournamentName}
        title={paidFinish ? 'Paid Finish!' : 'Champion!'}
        pill={paidFinish ? positionLabel : 'Winner'}
        pillInk="gold"
        foot="foot"
      >
        {prize > 0 && unitCents != null && (
          <div className="winnerPrize prize-counter">
            {/* To the cent (2026-09-09): this is the banner shown at the
                moment a player cashes, and a prize of 98.72 read "99".
                AT THE EVENT'S UNIT (2026-09-21): the odometer climbs through
                fractions, and the chip contract printed every one of them, so
                a Diamond prize counted up through "12.37" on its way to a
                whole number. A Diamond does not divide; each frame is a whole
                Diamond and the figure names its unit. */}
            Prize: {formatPrizeAtUnit(displayPrize, unitCents)}
            {moneySuffixAtUnit(unitCents)}
          </div>
        )}
        {/* ONE ACTION, SO THE FOOT CLOSES (standard §5). The master paints BOTH
            plates, so a single action would leave the other painted and empty,
            which reads as broken rather than spare. Continue is a lit word on
            the glass above the flat closing cap - the same control Club Rules
            uses for Copy and Retry. */}
        <button type="button" className="winnerDismissBtn" onClick={handleDismiss}>
          Continue
        </button>
      </SpadeConsole>
    </div>
  );
};

export default TournamentWinnerOverlay;
