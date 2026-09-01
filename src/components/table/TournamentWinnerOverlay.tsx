import React, { useState, useEffect, useCallback, useRef } from 'react';
import './TournamentWinnerOverlay.css';

interface TournamentWinnerOverlayProps {
  isWinner: boolean;
  prize: number;
  tournamentName: string;
  onDismiss: () => void;
  /**
   * ═══════════════════════════════════════════════════════════════════════
   *  A PAID FINISH IS NOT A BUST (2026-09-01)
   * ═══════════════════════════════════════════════════════════════════════
   *
   * Only `position === 1` reached this overlay. Everyone else went out
   * through the busted door: a 2.5 second elimination beat and the lobby.
   * At 10x and above a Spin pays 2nd and 3rd - 80/12/8 or 80/20 - so a 100x
   * runner-up took a fifth of the pool and was shown the same animation as
   * somebody who lost everything.
   *
   * Passing the finishing position lets the same overlay say what actually
   * happened. First place keeps CHAMPION exactly as it was.
   */
  position?: number;
}

/** 1st, 2nd, 3rd, 4th... for the finishing place. */
function ordinalPlace(n: number): string {
  const abs = Math.abs(Math.trunc(n));
  const tens = abs % 100;
  if (tens >= 11 && tens <= 13) return `${abs}th`;
  switch (abs % 10) {
    case 1:
      return `${abs}st`;
    case 2:
      return `${abs}nd`;
    case 3:
      return `${abs}rd`;
    default:
      return `${abs}th`;
  }
}

const TournamentWinnerOverlay: React.FC<TournamentWinnerOverlayProps> = ({
  isWinner,
  prize,
  tournamentName,
  onDismiss,
  position = 1,
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
    }
  }, [isWinner]);

  // Animate prize amount
  useEffect(() => {
    if (!visible || prize <= 0) return;

    const startTime = Date.now();
    const duration = 1500;
    const startValue = 0;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      // Easing function
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = startValue + (prize - startValue) * easeOut;

      setDisplayPrize(current);

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    };

    const frameId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frameId);
  }, [visible, prize]);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(onDismiss, 500);
  }, [onDismiss]);

  if (!isWinner) return null;

  return (
    <div className={`winnerOverlay ${visible ? 'visible' : ''}`} onClick={handleDismiss}>
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
      <div className="winnerContent winner-entrance">
        <div className="winnerTrophy trophy-bounce">
          {position === 1 ? 'WINNER' : 'IN THE MONEY'}
        </div>
        <div className="winnerTitle winner-golden">
          {position === 1 ? 'CHAMPION!' : `${ordinalPlace(position)} PLACE`}
        </div>
        <div className="winnerTournament">{tournamentName}</div>
        {prize > 0 && (
          <div className="winnerPrize prize-counter">
            Prize: {Math.round(displayPrize).toLocaleString()}
          </div>
        )}
        <button className="winnerDismissBtn" onClick={handleDismiss}>
          Continue
        </button>
      </div>
    </div>
  );
};

export default TournamentWinnerOverlay;
