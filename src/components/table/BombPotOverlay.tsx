/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  BOMB POT OVERLAY — Dramatic announcement animation
 * ═══════════════════════════════════════════════════════════════════════════════
 */

import React, { useState, useEffect, useRef } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { soundService, haptic } from '../../services/SoundService';
import './BombPotOverlay.css';

interface BombPotOverlayProps {
  tableId: string;
}

export const BombPotOverlay: React.FC<BombPotOverlayProps> = ({ tableId }) => {
  const [visible, setVisible] = useState(false);
  const [anteAmount, setAnteAmount] = useState(0);
  const [doubleBoard, setDoubleBoard] = useState(false);
  const [bbMultiplier, setBBMultiplier] = useState(0);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useMasterBusSubscription('BOMB_POT_TRIGGERED', (payload: any) => {
    if (payload?.tableId === tableId) {
      setAnteAmount(payload.anteAmount || 0);
      setDoubleBoard(payload.doubleBoard || false);
      setBBMultiplier(payload.bbMultiplier || 0);
      setVisible(true);

      // Enhancement #3: Dramatic sound + haptic on bomb pot trigger
      soundService.playAllIn();
      haptic.strong();

      // Clear any existing hide timer
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);

      // Auto-hide after 4 seconds
      hideTimerRef.current = setTimeout(() => setVisible(false), 4000);
    }
  });

  // Feature 2: Listen for BOMB_POT_COMPLETED to dismiss overlay immediately
  useMasterBusSubscription('BOMB_POT_COMPLETED', (payload: any) => {
    if (payload?.tableId === tableId) {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
      setVisible(false);
    }
  });

  useEffect(() => {
    return () => {
      // Feature 5: Clean up timer on unmount — prevents setState-after-unmount
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, []);

  if (!visible) return null;

  return (
    <div className="bomb-pot-overlay">
      <div className="bpo-container">
        <div className="bpo-icon">💣</div>
        <div className="bpo-title">BOMB POT</div>
        <div className="bpo-subtitle">{doubleBoard ? 'DOUBLE BOARD' : 'ALL PLAYERS IN'}</div>
        <div className="bpo-ante">
          Everyone antes {anteAmount.toLocaleString()} ({bbMultiplier}x BB)
        </div>
        <div className="bpo-action">Skipping to the flop!</div>
      </div>
      <div className="bpo-particles">
        {Array.from({ length: 12 }).map((_, i) => (
          <div
            key={i}
            className="bpo-particle"
            style={{
              left: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 0.5}s`,
              animationDuration: `${1 + Math.random()}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
};

export default BombPotOverlay;
