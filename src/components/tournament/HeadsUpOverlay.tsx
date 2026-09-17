import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import './HeadsUpOverlay.css';

interface HeadsUpPlayer {
  userId: string;
  username: string;
  chips: number;
}

interface HeadsUpOverlayProps {
  tournamentId: string;
  tournamentName?: string;
}

export const HeadsUpOverlay: React.FC<HeadsUpOverlayProps> = ({
  tournamentId,
  tournamentName = 'Tournament',
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [player1, setPlayer1] = useState<HeadsUpPlayer | null>(null);
  const [player2, setPlayer2] = useState<HeadsUpPlayer | null>(null);
  const [phase, setPhase] = useState<'enter' | 'show' | 'exit'>('enter');
  const timerRefs = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      timerRefs.current.forEach(clearTimeout);
    };
  }, []);

  // Listen for HEADS_UP_SWITCH event
  useMasterBusSubscription('HEADS_UP_SWITCH', (payload: any) => {
    if (payload.tournamentId !== tournamentId) return;

    setPlayer1(payload.player1);
    setPlayer2(payload.player2);

    setPhase('enter');
    setIsVisible(true);

    timerRefs.current.forEach(clearTimeout);
    timerRefs.current = [];

    // Sequences matching FinalTableOverlay
    timerRefs.current.push(setTimeout(() => setPhase('show'), 800));
    timerRefs.current.push(setTimeout(() => setPhase('exit'), 7200));
    timerRefs.current.push(setTimeout(() => setIsVisible(false), 8000));
  });

  const handleDismiss = useCallback(() => {
    timerRefs.current.forEach(clearTimeout);
    timerRefs.current = [];
    setPhase('exit');
    timerRefs.current.push(setTimeout(() => setIsVisible(false), 600));
  }, []);

  if (!isVisible || !player1 || !player2) return null;

  return (
    <div className={`hu-overlay hu-overlay--${phase}`} onClick={handleDismiss}>
      <div className="hu-overlay__backdrop" />

      <div className="hu-overlay__content">
        <div className="hu-overlay__title-wrap">
          <div className="hu-overlay__swords">⚔</div>
          <h1 className="hu-overlay__title">HEADS UP</h1>
          <div className="hu-overlay__subtitle">{tournamentName}</div>
        </div>

        <div className="hu-overlay__vs-container">
          <div className="hu-overlay__player">
            <div className="hu-overlay__player-name">{player1.username}</div>
            <div className="hu-overlay__player-chips">
              <span className="hu-overlay__chip-icon">◎</span>
              {player1.chips}
            </div>
          </div>

          <div className="hu-overlay__vs-badge">VS</div>

          <div className="hu-overlay__player">
            <div className="hu-overlay__player-name">{player2.username}</div>
            <div className="hu-overlay__player-chips">
              <span className="hu-overlay__chip-icon">◎</span>
              {player2.chips}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
