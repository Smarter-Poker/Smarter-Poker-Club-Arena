/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  FINAL TABLE OVERLAY - the announcement, on the spade console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Shows:
 * - "FINAL TABLE" engraved in the master's header well
 * - Player lineup with auto-classified styles (Shark/Fish/Rock etc.)
 * - Chip counts + rankings, printed as rows on the black glass
 * - Prize pool reminder
 * - Auto-dismiss after 8 seconds (or tap to dismiss)
 *
 * NO player introductions per user requirement.
 *
 * THE CONSOLE (#ClubArenaConsole, 2026-09-08). This was a rounded violet sheet
 * with a crown glyph on top, a headline painted with a clipped gradient, avatar
 * discs and a row of soft-filled tiles. It is now Dan's approved spade master:
 * the event name is the eyebrow, FINAL TABLE is engraved in the header well,
 * the survivor count sits in the well's painted pill slot, and the lineup
 * prints as rows on the glass - rank in the master's lit blue, name and stack
 * in silver, an engraved rule between rows. Nothing is drawn except the
 * chip-share bar, which is data rather than a control (see the stylesheet).
 *
 * EVERY ANIMATION STILL PLAYS (CLAUDE.md 10.6): ftSlideIn, ftSlideOut,
 * ftPlayerIn (with its per-row stagger), ftPulse and ftCrownPulse are all
 * present at their original durations. Only ftCrownPulse moved - the crown it
 * breathed on is painted into the master now, so the beat runs on the prize
 * figure, which is the thing that moment is actually about.
 *
 * FIGURES ARE WHOLE (Dan: never a decimal on a forward-facing page). The chip
 * share printed `chipPct.toFixed(1)` - "18.3%" - and the stacks printed raw
 * separators; both go through the house formatters now.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import {
  playerStyleClassifier,
  type PlayerStyleResult,
} from '../../services/PlayerStyleClassifier';
import { soundService } from '../../services/SoundService';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips, formatPrizeAtUnit, moneyWordAtUnit } from '../../utils/format';
import { CHIP_UNIT_CENTS, normalizeUnitCents } from '../../../server/src/tournament/tournamentUnit';
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
  /**
   * THE UNIT THE POOL IS PAID IN (2026-09-21). TournamentDetails passes
   * `tournamentRowUnitCents(tournament)` off the row it already read; the
   * table passes `arenaAssetUnitCentsIfRead` off its own arena. The row used
   * to print "Chips" after every pool, so a Diamond final table advertised a
   * Chip pool. `null` means the asset has not been read, and the pool line
   * waits for it instead of guessing.
   */
  unitCents: number | null;
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
  unitCents,
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
  const seatsLeft = players.length;

  return (
    <div className={`ft-overlay ft-overlay--${phase}`} onClick={handleDismiss}>
      <div className="ft-overlay__backdrop" />

      <div className="ft-overlay__content">
        <SpadeConsole
          onClose={handleDismiss}
          as="div"
          eyebrow={tournamentName}
          title="Final Table"
          subtitle="The Last Table Standing"
          pill={seatsLeft > 0 ? `${seatsLeft} Left` : undefined}
          pillInk="gold"
          foot="foot"
        >
          {prizePool > 0 && unitCents != null && (
            <div className="ft-overlay__prize-row">
              <span className="ft-overlay__prize-label sc-label sc-ink--blue">Prize Pool</span>
              {/* A chip pool prints exactly as it always has; a Diamond pool
                  is whole Diamonds, named, never "Chips" (2026-09-21). */}
              <span className="ft-overlay__prize sc-ink--gold">
                {normalizeUnitCents(unitCents) === CHIP_UNIT_CENTS
                  ? compactChips(prizePool)
                  : formatPrizeAtUnit(prizePool, unitCents)}{' '}
                {moneyWordAtUnit(unitCents)}
              </span>
            </div>
          )}

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
                  <div className="ft-player__rank sc-ink--blue">{index + 1}</div>

                  {/* Info */}
                  <div className="ft-player__info">
                    <div className="ft-player__name-row">
                      <span className="ft-player__name sc-ink--silver">{player.username}</span>
                      {/* Player Style. Printed as type in the master's muted
                          ink, never as a coloured chip: the classifier's own
                          palette carries ambers and oranges, and Dan's rule is
                          brand colours only. The full description stays on the
                          title so nothing is lost. */}
                      {player.styleResult.style !== 'unknown' && (
                        <span
                          className="ft-player__style sc-ink--muted"
                          title={player.styleResult.tooltip}
                        >
                          {player.styleResult.label}
                        </span>
                      )}
                    </div>
                    <div className="ft-player__chips-row">
                      <span className="ft-player__chips sc-ink--silver">
                        {compactChips(player.chips)}
                      </span>
                      {/* Whole numbers on a forward-facing page. */}
                      <span className="ft-player__chip-pct sc-ink--muted">
                        {Math.round(chipPct)}%
                      </span>
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
          <p className="sc-copy sc-copy--center ft-overlay__dismiss">Tap To Continue</p>
        </SpadeConsole>
      </div>
    </div>
  );
};

export default FinalTableOverlay;
