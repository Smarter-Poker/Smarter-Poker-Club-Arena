/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MUST MOVE BOX (Dan 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * THE BAR IS GONE (Dan 2026-09-05). This used to open with a bar across the
 * upper-right corner reading MUST MOVE / LOBBY / PLAYERS n / TABLES n, which
 * was also the button that opened the lobby. Dan moved that to the action pill
 * row - "THE LOBBY RECTANGLE, NEEDS TO MOVE TO ... WHERE THE '4 SQUARE' BOX
 * IS ... AND SAY 'LOBBY' ON IT" - where it is one word beside the 4-square
 * button (MultiTablePage, .mtp-lobby-btn) and covers no seats. Do not put a
 * readout bar back on the felt; every figure it carried is in the lobby it
 * opens, one tap away.
 *
 * What is left here is what the bar was not: a sentence that has to sit beside
 * the seats it is about, and buttons that DO something.
 *
 * The SEAT CHANGE button: "EACH AND EVERY PLAYER GETS A SEAT CHANGE
 * BUTTON WHEN THEY SIT DOWN AT ANY 'FEEDER GAME'." Shown only while the
 * database says the change is available (seated, not on Main 1, not used,
 * nothing pending); it opens the lobby, where the player picks Any Table or
 * a specific one. A player on Main 1 sees the bar and no button.
 *
 * The figures come from the same read the lobby uses (fn_cash_game_lobby),
 * every ten seconds while the table is open - two controller ticks - and at
 * once whenever the engine says a move is pending, landed or held.
 *
 * THE FELT SAYS A MOVE IS COMING (Dan 2026-09-05). The engine's
 * SEAT_MOVE_PENDING toast is shown once and gone in seconds; the hero then
 * plays a whole hand not knowing whether they are still leaving. So while the
 * database holds a pending move for the viewer, the sentence stays under the
 * bar - "Seat Open On Main 2. Moving After This Hand." - and leaves only when
 * the move has executed (the read no longer returns it). A move always runs
 * at the next hand boundary, so there is no hands-out count to show. It lives
 * in this corner column, above the seats and far from the action buttons at
 * the foot of a 375px screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchCashGameLobby,
  joinCashGame,
  joinGameRefusalText,
  pendingMoveNotice,
  waitlistedText,
  type CashGameLobby,
} from '../../services/cashGameLobby';
import { useToast } from '../common/Toast';
import './CashClusterHUD.css';

export const CASH_CLUSTER_HUD_POLL_MS = 10_000;

export interface CashClusterHUDProps {
  gameId: string;
  /** Bumped by the page whenever a seat-move event lands, to re-read at once. */
  refreshKey?: number;
  onOpenLobby: () => void;
  onSeatChange: () => void;
  /**
   * A viewer holding a place on the game's waitlist is sent to the table the
   * game door names the moment a chair opens (Gate 4). Optional: a surface
   * with no way to move the viewer simply shows the place.
   */
  onGoToTable?: (tableId: string) => void;
}

export function CashClusterHUD({
  gameId,
  refreshKey = 0,
  onOpenLobby,
  onSeatChange,
  onGoToTable,
}: CashClusterHUDProps) {
  const toast = useToast();
  const [lobby, setLobby] = useState<CashGameLobby | null>(null);
  const [joining, setJoining] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await fetchCashGameLobby(gameId);
      if (mountedRef.current) setLobby(data);
    } catch {
      /* the bar keeps its last figures; the lobby itself reports errors */
    }
  }, [gameId]);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), CASH_CLUSTER_HUD_POLL_MS);
    return () => window.clearInterval(id);
  }, [load, refreshKey]);

  const me = lobby?.me ?? null;
  const moveNotice = me?.seated ? pendingMoveNotice(me.pending_move) : null;
  const seatChangeAvailable = Boolean(me?.seated && me.seat_change.available);
  const listed = me?.seat_change.request ?? null;
  const onWaitlist = Boolean(me && !me.seated && me.waitlist?.on_list);
  const chairOpen = (lobby?.tables ?? []).some(
    (t) => Number(t.open_seats ?? 0) > 0 && (t.lifecycle === 'live' || t.lifecycle === 'opening')
  );

  const takeChair = async () => {
    if (joining) return;
    setJoining(true);
    try {
      const r = await joinCashGame(gameId);
      if (r.action === 'waitlisted') {
        toast.info(waitlistedText(r));
      } else if (r.table_id) {
        onGoToTable?.(r.table_id);
      }
      await load();
    } catch (err) {
      toast.warning(joinGameRefusalText(err));
    } finally {
      if (mountedRef.current) setJoining(false);
    }
  };

  /* NOTHING TO SAY, NOTHING DRAWN (2026-09-05). With the bar gone this column
     is only a notice and up to two buttons, and a player sitting quietly in
     the main game has none of them. An empty flex box in the corner is not
     visible, but it is still a pointer-events:auto node over the felt (see
     .hud-ur-column in TableHUD.css), so it does not get rendered at all. */
  if (!moveNotice && !seatChangeAvailable && !listed && !onWaitlist) return null;

  return (
    <div className="cch-column">
      {/* THE BAR IS GONE FROM THE FELT (Dan 2026-09-05). It read MUST MOVE /
          LOBBY / PLAYERS n / TABLES n across the upper-right corner, over two
          seats, and Dan moved it into the action pill row beside the 4-square
          button as one word: "THE LOBBY RECTANGLE, NEEDS TO MOVE TO ... WHERE
          THE '4 SQUARE' BOX IS ... AND SAY 'LOBBY' ON IT." The button lives in
          MultiTablePage now and opens this same lobby over the bus.

          What stays here is what the bar was NOT: the pending-move sentence,
          which has to be beside the seats it is about, and the seat-change /
          waitlist buttons, which are actions rather than a readout. Every
          figure the bar carried is one tap away inside the lobby. */}
      {moveNotice && (
        <div
          className="cch-move-notice"
          role="status"
          aria-live="polite"
          data-testid="cch-move-notice"
        >
          {moveNotice}
        </div>
      )}
      {seatChangeAvailable && (
        <button
          type="button"
          className="cch-seat-change"
          onClick={onSeatChange}
          aria-label="Seat Change - Request A Table Change"
        >
          Seat Change
        </button>
      )}
      {listed && (
        <button
          type="button"
          className="cch-seat-change cch-seat-change--listed"
          onClick={onOpenLobby}
        >
          Seat Change: #{listed.position ?? '-'} On The List
        </button>
      )}
      {onWaitlist && (
        <button
          type="button"
          className={`cch-seat-change${chairOpen ? '' : ' cch-seat-change--listed'}`}
          disabled={joining}
          onClick={() => (chairOpen ? void takeChair() : onOpenLobby())}
          aria-label={chairOpen ? 'A Chair Is Open - Take It' : 'Your Place On The Waitlist'}
        >
          {chairOpen
            ? 'Chair Open: Take A Seat'
            : `Waitlist: #${me?.waitlist?.position ?? '-'} Of ${me?.waitlist?.waiting ?? '-'}`}
        </button>
      )}
    </div>
  );
}

export default CashClusterHUD;
