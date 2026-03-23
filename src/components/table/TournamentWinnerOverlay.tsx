import React, { useState, useEffect, useCallback } from 'react';
import './TournamentWinnerOverlay.css';

interface TournamentWinnerOverlayProps {
  isWinner: boolean;
  prize: number;
  tournamentName: string;
  onDismiss: () => void;
}

const TournamentWinnerOverlay: React.FC<TournamentWinnerOverlayProps> = ({
  isWinner,
  prize,
  tournamentName,
  onDismiss,
}) => {
  const [visible, setVisible] = useState(false);
  const [particles, setParticles] = useState<
    Array<{ id: number; x: number; y: number; delay: number }>
  >([]);
  const [displayPrize, setDisplayPrize] = useState(0);

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
    setTimeout(onDismiss, 500);
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
        <div className="winnerTrophy trophy-bounce">🏆</div>
        <div className="winnerTitle winner-golden">CHAMPION!</div>
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
