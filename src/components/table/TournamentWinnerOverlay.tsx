import React, { useState, useEffect, useCallback, useRef } from 'react';
import './TournamentWinnerOverlay.css';

interface TournamentWinnerOverlayProps {
  isWinner: boolean;
  prize: number;
  tournamentName: string;
  position?: number;
  onDismiss: () => void;
}

const TournamentWinnerOverlay: React.FC<TournamentWinnerOverlayProps> = ({
  isWinner,
  prize,
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
      <div className="winnerContent winner-entrance">
        <div className="winnerTrophy trophy-bounce">{paidFinish ? positionLabel : 'Winner'}</div>
        <div className="winnerTitle winner-golden">{paidFinish ? 'Paid Finish!' : 'Champion!'}</div>
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
