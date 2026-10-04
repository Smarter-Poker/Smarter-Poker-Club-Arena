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
 * ─── GEOMETRY: FULL SCREEN, ONE FRAME (Dan 2026-10-04) ───
 * "when you click on the tournament lobby card, nothing work or is functional
 * ... it should be 'full screen pop up' ... remove all these large frames, and
 * make it like a normal, 'industry standard' tournament lobby card", and then,
 * with screenshots: "things seem to 'appear' on desk top, but zero
 * functionality on mobile".
 *
 * This was a 3/4 sheet (75vw down the side on desktop, 75dvh up from the
 * bottom on a phone) holding a painted console - head, a Close row, a foot -
 * around the lobby page, which then drew its own framed header, framed tab
 * rail, framed title strip and framed content well. Measured at 375x667 the
 * stack left the tab panel 52px tall and pushed the footer off the sheet:
 * every tab DID switch, and nothing a player could see changed. That is the
 * whole of "zero functionality on mobile". On a desktop there was just enough
 * room for a sliver of each tab, which is "things seem to appear".
 *
 * So the popup is the whole screen and draws nothing of its own. The lobby
 * page fills it, and the page's own header carries the way out (`onClose`).
 * TournamentDetails still measures its height against the viewport, which is
 * exactly the box it now has.
 *
 * `.tlm-overlay` / `.tlm-panel` keep their 3/4 geometry in the stylesheet:
 * MustMoveLobbyModal borrows it. The full-screen shape is the `--full`
 * modifier on both.
 */

import { useEffect, useRef, type TouchEvent } from 'react';
import TournamentDetails from '../../pages/tournament/TournamentDetails';
import './TournamentLobbyModal.css';

export interface TournamentLobbyModalProps {
  isOpen: boolean;
  tournamentId: string | undefined;
  /** The table this popup is open over. See TournamentDetails `currentTableId`. */
  currentTableId?: string;
  onClose: () => void;
}

const stopTouch = (e: TouchEvent) => e.stopPropagation();

export function TournamentLobbyModal({
  isOpen,
  tournamentId,
  currentTableId,
  onClose,
}: TournamentLobbyModalProps) {
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

  return (
    <div
      className="tlm-overlay tlm-overlay--full"
      role="presentation"
      /* A SWIPE INSIDE THE LOBBY IS NOT A TABLE SWITCH. MultiTablePage listens
         for horizontal touch drags on the container this popup renders inside
         and turns them into "go to the next table". The lobby has a tab strip
         that scrolls sideways and wide tables that do too, so without this a
         player dragging the tabs on a phone with two tables open would drag
         the felt out from under the popup. React bubbles synthetic events
         through the component tree, so stopping them here is enough. */
      onTouchStart={stopTouch}
      onTouchMove={stopTouch}
      onTouchEnd={stopTouch}
      style={isOpen ? undefined : { display: 'none' }}
    >
      <div
        className="tlm-panel tlm-panel--full"
        role="dialog"
        aria-modal="true"
        aria-label="Tournament Lobby"
        /* The popup chassis sheet restyles every button, heading and paragraph
           inside a dialog. This dialog holds a whole page, not a card; see
           the note in styles/metallic-popups.css. */
        data-popup-chassis="none"
      >
        <div className="tlm-body">
          {/* suppressAutoOpenTable: the player is ALREADY at this tournament's
              table - that is where this overlay was opened from. Without it the
              page's auto-seat effect fires `navigate('/table/...')` from inside
              the overlay, which at best re-enters the route we are standing on
              and at worst pulls a multi-tabling player off the table they were
              watching. */}
          <TournamentDetails
            tournamentIdOverride={tournamentId}
            suppressAutoOpenTable
            onClose={onClose}
            currentTableId={currentTableId}
          />
        </div>
      </div>
    </div>
  );
}

export default TournamentLobbyModal;
