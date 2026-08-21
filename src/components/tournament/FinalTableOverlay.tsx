/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINAL TABLE OVERLAY — Dramatic tournament final table announcement
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows:
 * - "FINAL TABLE" headline with cinematic entrance
 * - Player lineup with auto-classified styles (Shark/Fish/Rock etc.)
 * - Chip counts + rankings
 * - Prize pool reminder
 * - Auto-dismiss after 8 seconds (or tap to dismiss)
 *
 * NO player introductions per user requirement.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import {
  playerStyleClassifier,
  type PlayerStyleResult,
} from '../../services/PlayerStyleClassifier';
import { soundService } from '../../services/SoundService';
import './FinalTableOverlay.css';

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface FinalTablePlayer {
  userId: string;
  username: string;
  chips: number;
  avatar?: string;
  /** Stats for style classification */
  stats?: {
    handsPlayed: number;
    vpipCount: number;
    pfrCount: number;
    aggressiveActions?: number;
    passiveActions?: number;
  };
}

interface FinalTableOverlayProps {
  tournamentId: string;
  tournamentName?: string;
  prizePool?: number;
  /** Fallback: get client-side HUD stats when DB stats are missing */
  hudStatsProvider?: (
    userId: string
  ) => { handsPlayed: number; vpipCount: number; pfrCount: number } | null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════

export const FinalTableOverlay: React.FC<FinalTableOverlayProps> = ({
  tournamentId,
  tournamentName = 'Tournament',
  prizePool = 0,
  hudStatsProvider,
}) => {
  const [isVisible, setIsVisible] = useState(false);
  const [players, setPlayers] = useState<FinalTablePlayer[]>([]);
  const [phase, setPhase] = useState<'enter' | 'show' | 'exit'>('enter');
  const timerRefs = React.useRef<ReturnType<typeof setTimeout>[]>([]);

  // Clean up timers on unmount
  useEffect(() => {
    return () => {
      timerRefs.current.forEach(clearTimeout);
    };
  }, []);

  // Listen for FINAL_TABLE bus event
  useMasterBusSubscription('FINAL_TABLE_REACHED', (payload: any) => {
    if (payload.tournamentId !== tournamentId) return;

    const ftPlayers = (payload.players || []) as FinalTablePlayer[];
    // Sort by chips descending — spread first to avoid mutating source array
    const sorted = [...ftPlayers].sort((a, b) => b.chips - a.chips);
    setPlayers(sorted);
    setPhase('enter');
    setIsVisible(true);

    // Cinematic power-chord fanfare for final table reveal
    soundService.playTournamentFinalTable();

    // Clear any previous timers
    timerRefs.current.forEach(clearTimeout);
    timerRefs.current = [];

    // Phase transitions — tracked for cleanup
    timerRefs.current.push(setTimeout(() => setPhase('show'), 800));
    timerRefs.current.push(setTimeout(() => setPhase('exit'), 7200));
    timerRefs.current.push(setTimeout(() => setIsVisible(false), 8000));
  });

  // Dismiss on tap
  const handleDismiss = useCallback(() => {
    timerRefs.current.forEach(clearTimeout);
    timerRefs.current = [];
    setPhase('exit');
    timerRefs.current.push(setTimeout(() => setIsVisible(false), 600));
  }, []);

  // Classify each player's style
  const classifiedPlayers = useMemo(() => {
    return players.map((p) => {
      // Priority: event payload stats → client-side HUD stats → default unknown
      const payloadStats = p.stats;
      const hudStats = hudStatsProvider?.(p.userId);
      const statsToUse =
        payloadStats ||
        (hudStats
          ? {
              handsPlayed: hudStats.handsPlayed,
              vpipCount: hudStats.vpipCount,
              pfrCount: hudStats.pfrCount,
            }
          : { handsPlayed: 0, vpipCount: 0, pfrCount: 0 });

      const styleResult: PlayerStyleResult = playerStyleClassifier.classify(statsToUse);
      return { ...p, styleResult };
    });
  }, [players, hudStatsProvider]);

  if (!isVisible) return null;

  const totalChips = players.reduce((s, p) => s + p.chips, 0);

  return (
    <div className={`ft-overlay ft-overlay--${phase}`} onClick={handleDismiss}>
      <div className="ft-overlay__backdrop" />

      <div className="ft-overlay__content">
        {/* Title */}
        <div className="ft-overlay__title-wrap">
          <div className="ft-overlay__crown">♛</div>
          <h1 className="ft-overlay__title">FINAL TABLE</h1>
          <div className="ft-overlay__subtitle">{tournamentName}</div>
          {prizePool > 0 && (
            <div className="ft-overlay__prize">Prize Pool: {prizePool.toLocaleString()} Chips</div>
          )}
        </div>

        {/* Player List */}
        <div className="ft-overlay__players">
          {classifiedPlayers.map((player, index) => {
            const chipPct = totalChips > 0 ? (player.chips / totalChips) * 100 : 0;
            return (
              <div
                key={player.userId}
                className="ft-player"
                style={{ animationDelay: `${index * 100 + 400}ms` }}
              >
                {/* Rank */}
                <div className="ft-player__rank">#{index + 1}</div>

                {/* Avatar */}
                <div className="ft-player__avatar">
                  {player.avatar ? (
                    <img
                      loading="lazy"
                      decoding="async"
                      src={player.avatar}
                      alt={player.username}
                      className="ft-player__avatar-img"
                    />
                  ) : (
                    <span className="ft-player__avatar-initial">
                      {player.username.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>

                {/* Info */}
                <div className="ft-player__info">
                  <div className="ft-player__name-row">
                    <span className="ft-player__name">{player.username}</span>
                    {/* Player Style Badge */}
                    {player.styleResult.style !== 'unknown' && (
                      <span
                        className="ft-player__style-badge"
                        style={{
                          color: player.styleResult.color,
                          backgroundColor: player.styleResult.bgColor,
                        }}
                        title={player.styleResult.tooltip}
                      >
                        {player.styleResult.icon} {player.styleResult.label}
                      </span>
                    )}
                  </div>
                  <div className="ft-player__chips-row">
                    <span className="ft-player__chips">{player.chips.toLocaleString()}</span>
                    <span className="ft-player__chip-pct">{chipPct.toFixed(1)}%</span>
                  </div>
                </div>

                {/* Chip Bar */}
                <div className="ft-player__bar-wrap">
                  <div className="ft-player__bar" style={{ width: `${chipPct}%` }} />
                </div>
              </div>
            );
          })}
        </div>

        {/* Tap to dismiss */}
        <div className="ft-overlay__dismiss">Tap To Continue</div>
      </div>
    </div>
  );
};

export default FinalTableOverlay;
