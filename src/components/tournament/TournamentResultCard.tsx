/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT RESULT CARD — Where A Finished Player Lands (2026-08-20)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan, from a live table: "at the end of the tournament when you lose, you
 * need to be auto removed from the table, placed inside the lobby and your
 * tournament result card shown … winners should be auto removed at the end
 * as well."
 *
 * TablePage handles the removal and the navigation; this card is the landing.
 * It renders in ClubLobby when the router state carries a `tournamentResult`,
 * says the one thing that matters (place and money) at poster size, and gets
 * out of the way — dismiss on tap, on the X, or on the View Results button.
 *
 * Deliberately a dumb component: everything it shows arrived in the state it
 * was handed. No fetches — the player has just been moved between pages and
 * the LAST thing that moment needs is a loading spinner on their own result.
 */

import React from 'react';
import { useNavigate } from 'react-router-dom';
import './TournamentResultCard.css';

export interface TournamentResult {
  tournamentId: string | null;
  tournamentName: string;
  position: number;
  prize: number;
  isSpin?: boolean;
  at?: number;
}

const PLACE_LABEL: Record<number, string> = { 1: '1st Place', 2: '2nd Place', 3: '3rd Place' };

function placeLabel(position: number): string {
  if (PLACE_LABEL[position]) return PLACE_LABEL[position];
  if (position > 0) return `${position}th Place`;
  return 'Finished';
}

export default function TournamentResultCard({
  result,
  onDismiss,
}: {
  result: TournamentResult;
  onDismiss: () => void;
}) {
  const navigate = useNavigate();
  const won = result.position === 1;
  const cashed = result.prize > 0;

  return (
    <div className="trc" role="dialog" aria-modal="true" aria-label="Tournament Result">
      <div className="trc__backdrop" onClick={onDismiss} />
      <div className={`trc__card${won ? ' trc__card--won' : ''}`}>
        <button className="trc__close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>

        <div className="trc__eyebrow">
          {result.isSpin ? 'SPIN COMPLETE' : 'TOURNAMENT COMPLETE'}
        </div>
        <div className="trc__name">{result.tournamentName}</div>

        <div className={`trc__place${won ? ' trc__place--won' : ''}`}>
          {placeLabel(result.position)}
        </div>

        {cashed ? (
          <div className="trc__prize">
            <span className="trc__prize-amt">+{result.prize.toLocaleString()}</span>
            <span className="trc__prize-lbl">Chips Won</span>
          </div>
        ) : (
          <div className="trc__nocash">No Cash This Time</div>
        )}

        <div className="trc__actions">
          {result.tournamentId && (
            <button
              className="trc__btn trc__btn--ghost"
              onClick={() => navigate(`/tournament-results?id=${result.tournamentId}`)}
            >
              View Full Results
            </button>
          )}
          <button className="trc__btn trc__btn--primary" onClick={onDismiss}>
            Back To The Lobby
          </button>
        </div>
      </div>
    </div>
  );
}
