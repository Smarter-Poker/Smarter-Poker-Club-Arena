/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  CLUB ARENA — All-In Equity Display
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows equity percentage bars next to each player during all-in situations.
 * Bar shifts as community cards are dealt.
 *
 * Also supports legacy single-equity display for backward compatibility.
 */

import React, { memo, useState, useEffect, useRef } from 'react';
import './EquityDisplay.css';

// Legacy single equity display
interface LegacyEquityDisplayProps {
  equity: number; // 0-100
  showBar?: boolean;
  size?: 'small' | 'medium' | 'large';
  outs?: number;
}

function LegacyEquityDisplay({
  equity,
  showBar = true,
  size = 'medium',
  outs,
}: LegacyEquityDisplayProps) {
  const [displayEquity, setDisplayEquity] = useState(equity);
  const [fillWidth, setFillWidth] = useState(0);
  const animationFrameRef = useRef<number>(0);
  const countStartRef = useRef(0);

  const getColor = () => {
    if (equity >= 60) return '#4dc660';
    if (equity >= 40) return '#fbbf24';
    return '#f87171';
  };

  // Animate equity value on change
  useEffect(() => {
    countStartRef.current = displayEquity;
    const startTime = Date.now();
    const duration = 600;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      // Cubic easing for smooth animation
      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = countStartRef.current + (equity - countStartRef.current) * easeOut;

      setDisplayEquity(current);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [equity]);

  // Animate bar fill on mount
  useEffect(() => {
    const timer = setTimeout(() => setFillWidth(equity), 50);
    return () => clearTimeout(timer);
  }, [equity]);

  return (
    <div className={`equity-display ${size}`}>
      <span className="equity-value" style={{ color: getColor() }}>
        {displayEquity.toFixed(1)}%
      </span>

      {showBar && (
        <div className="equity-bar">
          <div
            className="equity-fill"
            style={{ width: `${fillWidth}%`, backgroundColor: getColor() }}
          />
        </div>
      )}

      {outs !== undefined && <span className="outs">{outs} Outs</span>}
    </div>
  );
}

// Multi-player equity bars for all-in situations
export interface EquityBarProps {
  equity: number; // 0-100
  isHero: boolean;
  playerName: string;
  isLeading: boolean;
}

export const EquityBar = memo(function EquityBar({
  equity,
  isHero,
  playerName,
  isLeading,
}: EquityBarProps) {
  const [displayEquity, setDisplayEquity] = useState(equity);
  const [fillWidth, setFillWidth] = useState(0);
  const animationFrameRef = useRef<number>(0);
  const countStartRef = useRef(0);

  const barColor = isLeading ? '#3fb950' : '#ef4444';
  const bgColor = isLeading ? 'rgba(63, 185, 80, 0.15)' : 'rgba(239, 68, 68, 0.15)';

  // Animate equity value on change
  useEffect(() => {
    countStartRef.current = displayEquity;
    const startTime = Date.now();
    const duration = 500;

    const animate = () => {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(1, elapsed / duration);

      const easeOut = 1 - Math.pow(1 - progress, 3);
      const current = countStartRef.current + (equity - countStartRef.current) * easeOut;

      setDisplayEquity(current);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [equity]);

  // Animate bar fill
  useEffect(() => {
    const timer = setTimeout(() => setFillWidth(Math.min(100, Math.max(0, equity))), 50);
    return () => clearTimeout(timer);
  }, [equity]);

  return (
    <div className={`equity-bar ${isHero ? 'equity-bar--hero' : ''} equity-bar--animated`}>
      <div className="equity-bar__track" style={{ background: bgColor }}>
        <div
          className="equity-bar__fill"
          style={{
            width: `${fillWidth}%`,
            background: barColor,
            boxShadow: `0 0 8px ${barColor}60`,
          }}
        />
      </div>
      <span className="equity-bar__pct" style={{ color: barColor }}>
        {Math.round(displayEquity)}%
      </span>
    </div>
  );
});

export interface MultiPlayerEquityDisplayProps {
  players: Array<{
    id: string;
    name: string;
    equity: number;
    isHero: boolean;
  }>;
  isVisible: boolean;
}

export const MultiPlayerEquityDisplay = memo(function MultiPlayerEquityDisplay({
  players,
  isVisible,
}: MultiPlayerEquityDisplayProps) {
  if (!isVisible || players.length === 0) return null;

  const maxEquity = Math.max(...players.map((p) => p.equity));

  return (
    <div className="equity-display equity-display--multi">
      {players.map((player) => (
        <EquityBar
          key={player.id}
          equity={player.equity}
          isHero={player.isHero}
          playerName={player.name}
          isLeading={player.equity === maxEquity}
        />
      ))}
    </div>
  );
});

// Alias for backward compatibility
export type EquityDisplayProps = LegacyEquityDisplayProps;

export function EquityDisplay(props: LegacyEquityDisplayProps) {
  return <LegacyEquityDisplay {...props} />;
}

export default EquityDisplay;
