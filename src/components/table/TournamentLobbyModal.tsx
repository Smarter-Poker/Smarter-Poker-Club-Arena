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
  const panelRef = useRef<HTMLDivElement | null>(null);
  const restoreFocusTo = useRef<HTMLElement | null>(null);
  /* `onClose` is an inline arrow at the call site (TablePage), so it is a new
     function on every render of a component that renders many times a second.
     Read through a ref, the keyboard effect below binds once per open instead
     of once per table render. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  /**
   * DIALOG SEMANTICS: Escape, focus in, Tab kept inside, focus back out
   * (2026-10-04 review pass).
   *
   * This declared `role="dialog"` and `aria-modal="true"` and implemented one
   * third of it. Focus stayed on the LOBBY button underneath - which the popup
   * covers - so Tab walked through a live table's controls behind a
   * full-screen page, and Enter pressed whichever one it had reached.
   *
   * ESCAPE BELONGS TO THE TOPMOST DIALOG. The Sign Up card (register, late
   * register, a satellite card's Register) opens ABOVE this popup and cancels
   * itself on Escape from a capture-phase listener, calling preventDefault.
   * This listener is on `window` in the bubble phase, so it ran afterwards for
   * the same key press and closed the whole lobby under the card the player
   * had only meant to dismiss. A key another dialog has already answered is
   * not ours.
   */
  useEffect(() => {
    if (!isOpen) return;
    restoreFocusTo.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus({ preventScroll: true });
    const FOCUSABLE =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    /* A dialog stacked on top of this one (Sign Up, Watch This Player Live,
       a deal review) owns the keyboard while it is open. Those are portalled
       to <body>, so "inside another dialog that is not ours" is the test. */
    const focusIsInAnotherDialog = () => {
      const active = document.activeElement as HTMLElement | null;
      const host = active?.closest?.('[role="dialog"], [role="alertdialog"]');
      return !!host && host !== panelRef.current;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (e.defaultPrevented || focusIsInAnotherDialog()) return;
        onCloseRef.current();
        return;
      }
      const panel = panelRef.current;
      if (e.key !== 'Tab' || !panel || e.defaultPrevented || focusIsInAnotherDialog()) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      /* Focus outside the popup is the common case, not an edge one: tap any
         text and activeElement becomes <body>. Pull it back in. */
      if (!panel.contains(active) || active === panel) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      /* Give focus back only if it is still ours to give: a Take Seat or a
         Watch that moved the player to another table has already put focus
         where it belongs. */
      const active = document.activeElement;
      if (!active || active === document.body || panelRef.current?.contains(active)) {
        restoreFocusTo.current?.focus?.({ preventScroll: true });
      }
    };
  }, [isOpen]);

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
        tabIndex={-1}
        ref={panelRef}
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
