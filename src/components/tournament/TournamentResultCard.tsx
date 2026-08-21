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

/**
 * AUDIT 2026-08-20: this printed "21th Place", "22th Place", "23th Place".
 * Only 1, 2 and 3 were special-cased and everything else got "th" appended,
 * so every finish whose last digit was 1, 2 or 3 above third was wrong — and
 * in a 128-runner field that is most of the table. Suffix by the last digit,
 * with the 11/12/13 exception that makes 11th..13th correct.
 */
function placeLabel(position: number): string {
  if (!(position > 0)) return 'Finished';
  const n = Math.floor(position);
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th Place`;
  switch (n % 10) {
    case 1:
      return `${n}st Place`;
    case 2:
      return `${n}nd Place`;
    case 3:
      return `${n}rd Place`;
    default:
      return `${n}th Place`;
  }
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
