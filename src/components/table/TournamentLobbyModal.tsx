/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  TOURNAMENT LOBBY, ON THE FELT
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan 2026-08-28: "ALL TOURNAMENTS NEED THE STATS ICON IN THE UPPER RIGHT HAND
 * CORNER. IT SHOULDN'T SHOW THE STATS, BUT OPEN TO THE TOURNAMENT LOBBY PAGE AS
 * A IN GAME 3/4 POP UP."
 *
 * The upper-right button used to open TournamentInfoPanel — a four-tab summary
 * (ranking / prizes / tables / blinds) that is NOT the tournament lobby. The
 * lobby is `src/pages/tournament/TournamentDetails.tsx`, the same screen reached
 * at `/tournaments/:tournamentId`, and it carries considerably more: overview,
 * blinds, ranking, entries, unions, tables, rewards, satellites. This renders
 * that exact page inside the table.
 *
 * WHY THE REAL PAGE AND NOT A COPY: TournamentDetails already accepts
 * `tournamentIdOverride` precisely so it can render outside its own route
 * (Dan 2026-08-19, for MultiTablePage's lobby tab), and its eight tabs are
 * already separate components sharing one contract. A second, table-flavoured
 * rendering of the same data is how two screens start disagreeing about a
 * prize pool — the exact failure mode CLAUDE.md documents for buy-in maths in
 * four places. There is one lobby.
 *
 * ─── GEOMETRY ───
 * Cloned from HandDetailModal, which is where Dan specified this shape:
 * "the previous hand table when opened should only be 3/4 page ... Also when
 * it's 3/4 page you should be able to click off to close as well."
 *   - desktop: a 75vw panel down the left, full height
 *   - phone:   a 75dvh sheet up from the bottom, grab handle, tappable backdrop
 *
 * That geometry is load-bearing here rather than merely consistent.
 * TournamentDetails measures its own top against `window.innerHeight` and
 * writes the remainder into `--details-h`, then hangs a negative margin off the
 * overflow. Any container that does NOT reach the bottom of the viewport makes
 * it compute a height taller than its box and it overflows. Both layouts above
 * end flush with the viewport bottom, so the measurement lands correctly with
 * no override — which is why this is a clone and not a fresh sheet.
 */

import { useEffect, useRef } from 'react';
import TournamentDetails from '../../pages/tournament/TournamentDetails';
import { SpadeConsole } from '../console/SpadeConsole';
import './TournamentLobbyModal.css';

export interface TournamentLobbyModalProps {
  isOpen: boolean;
  tournamentId: string | undefined;
  onClose: () => void;
}

export function TournamentLobbyModal({ isOpen, tournamentId, onClose }: TournamentLobbyModalProps) {
  // Escape closes, same as every other overlay at the table.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  /* Dan 2026-08-30: "OPEN TO THE TOURNAMENT LOBBY INSTANTLY (NO LOAD TIME)."
     The panel used to unmount on close, so every open paid the lobby's full
     fetch again. It now stays MOUNTED (display:none) once it has been opened
     once: re-opens are instant because the page, its data and its realtime
     subscriptions are already there. The first open still mounts fresh - a
     table where the lobby is never opened pays nothing, same as before.
     A resize is dispatched on each show because TournamentDetails measures
     its own height against the viewport and must re-measure after display
     flips from none. */
  const everOpenedRef = useRef(false);
  if (isOpen) everOpenedRef.current = true;
  useEffect(() => {
    if (isOpen) window.dispatchEvent(new Event('resize'));
  }, [isOpen]);

  if ((!isOpen && !everOpenedRef.current) || !tournamentId) return null;

  /* ONE CONSOLE (#ClubArenaConsole) inside the 3/4 sheet: the spade
     master's head at the top, the lobby page on the black glass between the
     rails, the flat cap at the bottom. The sheet's geometry (tlm-overlay /
     tlm-panel) is Dan's and stays; only what it holds changed. A page of
     content with one way out, so the foot carries no plate and CLOSE is a
     lit word under the head. */
  return (
    <div
      className="tlm-overlay"
      onClick={onClose}
      role="presentation"
      style={isOpen ? undefined : { display: 'none' }}
    >
      <div
        className="tlm-panel tlm-panel--console"
        role="dialog"
        aria-modal="true"
        aria-label="Tournament Lobby"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          onClose={onClose}
          eyebrow="Tournament"
          title="Lobby"
          pill="In Game"
          pillInk="blue"
          foot="foot"
          className="tlm-console"
        >
          <div className="tlm-console__bar">
            <button
              type="button"
              className="tlm-word sc-ink--white"
              onClick={onClose}
              aria-label="Close"
            >
              Close
            </button>
          </div>

          <div className="tlm-body">
            {/* suppressAutoOpenTable: the player is ALREADY at this tournament's
                table - that is where this overlay was opened from. Without it the
                page's auto-seat effect fires `navigate('/table/...')` from inside
                the overlay, which at best re-enters the route we are standing on
                and at worst pulls a multi-tabling player off the table they were
                watching. */}
            <TournamentDetails tournamentIdOverride={tournamentId} suppressAutoOpenTable />
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default TournamentLobbyModal;
