/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MUST MOVE BOX (Dan 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * The cash-game counterpart of TournamentHUD: a bar in the upper-right corner
 * of a must-move table that reads MUST MOVE, players in the game, tables open
 * and - for a player not yet in the main game - their place on the list. The
 * bar IS the button: tapping it opens the Must Move Lobby, exactly as the
 * level bar opens the tournament lobby (Dan 2026-08-30).
 *
 * Under it, the SEAT CHANGE button: "EACH AND EVERY PLAYER GETS A SEAT CHANGE
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

  const players = (lobby?.tables ?? []).reduce((n, t) => n + Number(t.seated ?? 0), 0);
  const tables = (lobby?.tables ?? []).length;
  const me = lobby?.me ?? null;
  const position = me?.seated && !me.on_main_one ? me.must_move_position : null;
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

  return (
    <div className="cch-column">
      <div
        className="cash-cluster-hud-bar"
        role="button"
        tabIndex={0}
        aria-label="Must Move Game - Open Must Move Lobby"
        onClick={onOpenLobby}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onOpenLobby();
          }
        }}
      >
        <div className="cch-seg cch-seg--title">
          <span className="cch-label">Must Move</span>
          <span className="cch-value">Lobby</span>
        </div>
        <div className="cch-seg">
          <span className="cch-label">Players</span>
          <span className="cch-value">{lobby ? players : '-'}</span>
        </div>
        <div className="cch-seg">
          <span className="cch-label">Tables</span>
          <span className="cch-value">{lobby ? tables : '-'}</span>
        </div>
        {position != null && (
          <div className="cch-seg cch-seg--me">
            <span className="cch-label">You Are</span>
            <span className="cch-value">#{position}</span>
          </div>
        )}
      </div>
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
