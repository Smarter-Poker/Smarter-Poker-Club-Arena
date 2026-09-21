/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  HEADS UP - the duel announcement, on the spade console
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28 (bug 8): "WHEN TWO PLAYERS ARE HEADS UP IN AN MTT, IT SHOULD
 * PLAY THE 'HEADS UP' ANIMATION BEFORE THE HEADS UP MATCH BEGINS." The bus
 * wiring that makes that fire is pinned by tests/unit/headsUpIsAnnounced.test.ts
 * and is untouched here: the subscription, the phase timers, the tap-to-dismiss
 * and the cleanup are exactly what they were.
 *
 * WHAT CHANGED (#ClubArenaConsole, 2026-09-08). It was two CSS boxes either
 * side of a drawn white disc, under a headline painted with a clipped gradient.
 * It is now the spade console - the same approved master every Omaha card is
 * drawn from: the event name is the eyebrow, HEADS UP is engraved in the
 * header well, DUEL sits in the well's painted pill slot, and the two players
 * print as rows on the black glass between the rails, name in the master's lit
 * blue and stack in silver, with an engraved rule between them.
 *
 * EVERY ANIMATION STILL PLAYS (CLAUDE.md 10.6). None was deleted; each moved
 * onto the element that now carries its beat:
 *
 *   huFade      the backdrop, unchanged
 *   huFadeOut   the exit phase, unchanged
 *   huTitleIn   the header well rises in (it carries the headline now)
 *   huSheen     the engraved headline catches the light, on the same 3.4s loop
 *   huBadgeIn   the word in the painted pill slot pops in
 *   huSlideL/R  the two player rows still arrive from opposite edges
 *   huSwordsIn  the VS mark rotates in - the clash beat the swords glyph had
 *   huShock     the shockwave still rings out of that mark
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useMasterBusSubscription } from '../../hooks/useMasterBusSubscription';
import { SpadeConsole } from '../console/SpadeConsole';
import { compactChips } from '../../utils/format';
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
        <SpadeConsole
          as="div"
          className="hu-overlay__console"
          eyebrow={tournamentName}
          title="Heads Up"
          subtitle="Two Players Left"
          pill="Duel"
          pillInk="red"
          foot="foot"
        >
          <div className="hu-overlay__duel">
            <div className="hu-overlay__seat hu-overlay__seat--left">
              <span className="hu-overlay__player-name sc-label sc-ink--blue">
                {player1.username}
              </span>
              <span className="hu-overlay__player-chips sc-ink--silver">
                {compactChips(player1.chips)}
              </span>
            </div>

            <div className="hu-overlay__versus">
              <span className="hu-overlay__vs sc-ink--white">VS</span>
            </div>

            <div className="hu-overlay__seat hu-overlay__seat--right">
              <span className="hu-overlay__player-name sc-label sc-ink--blue">
                {player2.username}
              </span>
              <span className="hu-overlay__player-chips sc-ink--silver">
                {compactChips(player2.chips)}
              </span>
            </div>
          </div>

          <p className="sc-copy sc-copy--center hu-overlay__dismiss">Tap To Continue</p>
        </SpadeConsole>
      </div>
    </div>
  );
};
