/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  THE MUST MOVE LOBBY, ON THE FELT (Dan 2026-09-05)
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Dan: the list "SHOULD BE JUST LIKE THE TOURNAMENTS WITH A BOX IN THE RIGHT
 * CORNER TO CLICK TO SEE ALL TABLES, CHIP STACKS, HOW MANY PLAYERS ETC", and
 * "THEY SHOULD BE ABLE TO DO THIS BY OPENING THE 'MUST MOVE LOBBY' WHERE THEY
 * SHOULD BE ABLE TO SEE ALL GAMES PLAYING AND THEN 'REQUEST A SEAT CHANGE'".
 *
 * Everything shown comes from ONE read, fn_cash_game_lobby, polled every five
 * seconds while open - the same cadence as the controller's tick, so the lobby
 * is never more than one tick behind the board.
 *
 * What it shows, top to bottom:
 *   - the game (name, style, stakes) with PLAYERS and TABLES, the waitlist;
 *   - YOUR SEAT: where you are, your place on the must-move list, and the
 *     seat change - available (Any Table / a specific table), listed (your
 *     number, Cancel), moving / swapping (after this hand), used;
 *   - every table: Main 1, Main 2 ... Feeder, with lifecycle, seated / max,
 *     every chair's name and stack, the seat-change queue on that table,
 *     and REQUEST on the tables you may change to;
 *   - the must-move list: the order players joined the game, everyone not
 *     yet on Main 1. Position 1 takes the next Main 1 seat.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE CONSOLE (#ClubArenaConsole). This borrowed TournamentLobbyModal's 3/4
 * sheet and then drew its own furniture on top of it: a grey header bar with
 * two square buttons, a four-up grid of figure tiles, a rounded card per table
 * with a bordered seat list inside it, and three rounded button styles. That is
 * a frame on a frame carrying a grid of drawn tiles.
 *
 * The sheet's GEOMETRY is still TournamentLobbyModal's - a 75vw panel on the
 * right on desktop, a 75dvh sheet on a phone, which is Dan's ruling and is not
 * this file's to change - but it now paints nothing, and the spade master
 * stands inside it. The game is the eyebrow, MUST MOVE LOBBY is engraved in the
 * header well, your place sits in the well's painted pill slot, every figure
 * and every chair prints as a ROW on the black glass, and CLOSE / JOIN GAME are
 * the plates painted into the foot.
 *
 * Not one call, guard, poll, toast or sentence moved. The must-move rows keep
 * their exact three-cell shape, because a test reads their textContent.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  cancelSeatChange,
  fetchCashGameLobby,
  isMainOne,
  joinCashGame,
  joinGameRefusalText,
  lobbyTableLabel,
  mustMoveListRows,
  pendingMoveNotice,
  requestSeatChange,
  seatChangeOutcomeText,
  seatChangeRefusalText,
  waitlistedText,
  type CashGameLobby,
  type LobbyTable,
} from '../../services/cashGameLobby';
import { formatChips } from '../../lib/utils';
import { CASH_TEMPLATES } from '../../config/cashGames';
import { useToast } from '../common/Toast';
import { SpadeConsole } from '../console/SpadeConsole';
import './TournamentLobbyModal.css';
import './MustMoveLobbyModal.css';

export const MUST_MOVE_LOBBY_POLL_MS = 5000;

export interface MustMoveLobbyModalProps {
  isOpen: boolean;
  gameId: string | null | undefined;
  /** The table the viewer is looking at (highlighted in the list). */
  currentTableId: string | null | undefined;
  onClose: () => void;
  /**
   * JOIN GAME FROM THE LOBBY (Dan 2026-09-05): "if a player 'views table' or
   * is in the 'lobby' of a must move game, there should be a button next to
   * close that said 'Join Game'." The game door picks the table; this carries
   * the viewer to it. A surface with no way to move the viewer may omit it -
   * the door still holds the place and the toast still says where.
   */
  onGoToTable?: (tableId: string) => void;
}

function lifecycleLabel(t: LobbyTable): string {
  if (t.lifecycle === 'opening') return 'Opening';
  if (t.lifecycle === 'breaking') return 'Closing';
  if (t.status === 'running' || t.status === 'active') return 'Running';
  return 'Waiting';
}

export function MustMoveLobbyModal({
  isOpen,
  gameId,
  currentTableId,
  onClose,
  onGoToTable,
}: MustMoveLobbyModalProps) {
  const toast = useToast();
  const [lobby, setLobby] = useState<CashGameLobby | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    if (!gameId) return;
    try {
      const data = await fetchCashGameLobby(gameId);
      if (!mountedRef.current) return;
      setLobby(data);
      setError(null);
    } catch (err) {
      if (!mountedRef.current) return;
      setError(String((err as { message?: string })?.message ?? 'The Lobby Could Not Be Read.'));
    }
  }, [gameId]);

  // Escape closes, same as every other overlay at the table.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  // Read on open, then every tick while open. Nothing runs while closed.
  useEffect(() => {
    if (!isOpen || !gameId) return;
    void load();
    const id = window.setInterval(() => void load(), MUST_MOVE_LOBBY_POLL_MS);
    return () => window.clearInterval(id);
  }, [isOpen, gameId, load]);

  const tableById = new Map<string, LobbyTable>();
  for (const t of lobby?.tables ?? []) tableById.set(t.id, t);
  const labelFor = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const t = tableById.get(id);
    return t ? lobbyTableLabel(t) : null;
  };

  const request = async (toTableId: string | null) => {
    if (!gameId || busy) return;
    setBusy(true);
    try {
      const r = await requestSeatChange(gameId, toTableId);
      toast.success(
        seatChangeOutcomeText(r, labelFor(r.to_table_id) ?? (toTableId ? null : 'Any Table'))
      );
      await load();
    } catch (err) {
      toast.warning(seatChangeRefusalText(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  const cancel = async () => {
    if (!gameId || busy) return;
    setBusy(true);
    try {
      const r = await cancelSeatChange(gameId);
      toast.info(r.cancelled > 0 ? 'Seat Change Request Cancelled.' : 'Nothing To Cancel.');
      await load();
    } catch (err) {
      toast.warning(seatChangeRefusalText(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  /**
   * JOIN GAME. One call to the game door (fn_cash_game_join): it picks the
   * shortest table with an unreserved chair and answers with it, or holds the
   * caller's place on the waitlist. Nothing here chooses a table - the door
   * does, so the lobby and the felt can never disagree about where a player
   * belongs. The buy-in stays the table's own door once we arrive.
   */
  const join = async () => {
    if (!gameId || busy) return;
    setBusy(true);
    try {
      const r = await joinCashGame(gameId);
      if (r.action === 'waitlisted') {
        toast.info(waitlistedText(r));
        await load();
      } else if (r.table_id) {
        /* THE DOOR SAYS WHERE, EVERY TIME (2026-09-06). This used to close and
           navigate in silence, which reads as "nothing happened" in two real
           cases: a surface that passes no `onGoToTable`, and a door that seats
           you at the table you are ALREADY looking at (TablePage's handler
           returns early on `dest === tableId`). The seat is reserved
           server-side either way and the buy-in door is the table's own, so the
           player has to be told which table is now theirs. */
        toast.success(`Seat Reserved At ${labelFor(r.table_id) ?? r.table_name ?? 'Your Table'}.`);
        onClose();
        onGoToTable?.(r.table_id);
      } else {
        /* A REFUSAL THAT DOES NOT THROW IS STILL A REFUSAL. fn_cash_game_join
           can answer `{ok:false}` with no table and no waitlist place; the
           button used to swallow that and look broken. */
        toast.warning(joinGameRefusalText(new Error(String(r.action ?? ''))));
        await load();
      }
    } catch (err) {
      toast.warning(joinGameRefusalText(err));
    } finally {
      if (mountedRef.current) setBusy(false);
    }
  };

  if (!isOpen || !gameId) return null;

  const me = lobby?.me ?? null;
  const game = lobby?.game ?? null;
  const styleLabel = game
    ? (CASH_TEMPLATES.find((t) => t.id === String(game.template_name ?? '').toLowerCase())?.label ??
      null)
    : null;
  const playersTotal = (lobby?.tables ?? []).reduce((n, t) => n + Number(t.seated ?? 0), 0);
  const tablesOpen = (lobby?.tables ?? []).length;
  const myTableId = me?.table_id ?? null;
  const canRequestTo = (t: LobbyTable): boolean =>
    Boolean(me?.seat_change.available) &&
    !isMainOne(t) &&
    t.id !== myTableId &&
    (t.lifecycle === 'live' || t.lifecycle === 'opening');
  const otherTablesExist = (lobby?.tables ?? []).some((t) => canRequestTo(t));

  /* YOUR PLACE, in the well's painted pill slot. */
  const pill = !me?.seated
    ? 'Watching'
    : me.on_main_one
      ? 'Main Game'
      : me.must_move_position
        ? `#${me.must_move_position}`
        : 'Seated';
  const pillInk = !me?.seated ? 'muted' : me.on_main_one ? 'green' : 'blue';

  return (
    <div className="tlm-overlay mml-overlay" onClick={onClose} role="presentation">
      <div
        className="tlm-panel mml-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Must Move Lobby"
        onClick={(e) => e.stopPropagation()}
      >
        <SpadeConsole
          as="div"
          className="mml-console"
          eyebrow={game?.name ?? 'Cash Game'}
          title="Must Move Lobby"
          pill={pill}
          pillInk={pillInk}
          plates={{
            secondary: { label: 'Close', onClick: onClose, 'aria-label': 'Close' },
            /* JOIN GAME sits beside Close for anybody looking at this game
               without a chair in it - viewing a table, or opening the lobby
               from the game list. A seated player sees the plate say so
               rather than a plate painted and empty. */
            primary:
              lobby && !me?.seated
                ? {
                    label: 'Join Game',
                    ink: 'white' as const,
                    onClick: () => void join(),
                    disabled: busy,
                    'aria-label': 'Join Game',
                  }
                : { label: 'Seated', ink: 'muted' as const, disabled: true },
          }}
        >
          <div className="mml-body">
            {error && <div className="mml-error">{error}</div>}
            {!lobby && !error && <div className="mml-loading">Reading The Game</div>}

            {lobby && game && (
              <>
                {/* ─── The game ─── */}
                <section className="mml-game">
                  <div className="mml-game-line">
                    {styleLabel && <span className="mml-style">{styleLabel.toUpperCase()}</span>}
                    <span className="mml-stakes">
                      {formatChips(Number(game.sb))}/{formatChips(Number(game.bb))}
                    </span>
                    <span className="mml-hand">{game.handedness} Max</span>
                  </div>
                  <div className="mml-figures">
                    <div className="mml-figure">
                      <span className="mml-figure-label">Players</span>
                      <span className="mml-figure-value">{playersTotal}</span>
                    </div>
                    <div className="mml-figure">
                      <span className="mml-figure-label">Tables</span>
                      <span className="mml-figure-value">{tablesOpen}</span>
                    </div>
                    <div className="mml-figure">
                      <span className="mml-figure-label">Waiting</span>
                      <span className="mml-figure-value">{lobby.waitlist?.waiting ?? 0}</span>
                    </div>
                    <div className="mml-figure">
                      <span className="mml-figure-label">Must Move</span>
                      <span className="mml-figure-value">{lobby.must_move_list.length}</span>
                    </div>
                  </div>
                </section>

                {/* ─── Your seat ─── */}
                {me?.seated && (
                  <section className="mml-me">
                    <div className="mml-section-title">Your Seat</div>
                    <div className="mml-me-line">
                      {labelFor(me.table_id) ?? 'This Table'}
                      {me.seat_number ? `, Seat ${me.seat_number}` : ''}
                      {me.stack != null ? ` (${formatChips(Number(me.stack))})` : ''}
                    </div>
                    {me.on_main_one ? (
                      <div className="mml-me-note">You Are In The Main Game.</div>
                    ) : me.must_move_position ? (
                      <div className="mml-me-note">
                        You Are Number {me.must_move_position} On The Must Move List.
                      </div>
                    ) : null}

                    {/* The same sentence the felt shows (CashClusterHUD), from
                        one helper, so the lobby and the table can never
                        disagree about where the player is going. */}
                    {me.pending_move && (
                      <div className="mml-me-move">{pendingMoveNotice(me.pending_move)}</div>
                    )}

                    {/* The seat change: once per stay, never from or to Main 1. */}
                    {!me.on_main_one && (
                      <div className="mml-seat-change">
                        <div className="mml-section-title">Seat Change</div>
                        {me.seat_change.request ? (
                          <div className="mml-listed">
                            <span>
                              You Are Number {me.seat_change.request.position ?? '-'} On The List
                              For {labelFor(me.seat_change.request.to_table_id) ?? 'Any Table'}.
                            </span>
                            <button
                              type="button"
                              className="mml-btn mml-btn--ghost"
                              disabled={busy}
                              onClick={() => void cancel()}
                            >
                              Cancel Request
                            </button>
                          </div>
                        ) : me.seat_change.available ? (
                          <div className="mml-request-row">
                            <button
                              type="button"
                              className="mml-btn"
                              disabled={busy || !otherTablesExist}
                              onClick={() => void request(null)}
                            >
                              Request Any Table
                            </button>
                            <span className="mml-hint">
                              {otherTablesExist
                                ? 'Or Pick A Table Below. You May Change Once.'
                                : 'No Other Table To Change To Yet.'}
                            </span>
                          </div>
                        ) : me.pending_move?.reason === 'seat_change' ? null : (
                          <div className="mml-me-note">
                            {me.seat_change.used_at
                              ? 'Seat Change Used For This Game.'
                              : me.lifecycle === 'breaking'
                                ? 'This Table Is Closing.'
                                : 'Seat Change Not Available Right Now.'}
                          </div>
                        )}
                      </div>
                    )}
                  </section>
                )}

                {/* ─── The tables ─── */}
                <section className="mml-tables">
                  <div className="mml-section-title">Tables</div>
                  {lobby.tables.map((t) => (
                    <div
                      key={t.id}
                      className={`mml-table${t.id === currentTableId ? ' mml-table--here' : ''}${t.lifecycle === 'breaking' ? ' mml-table--closing' : ''}`}
                    >
                      <div className="mml-table-head">
                        <span className="mml-table-name">{lobbyTableLabel(t)}</span>
                        <span className="mml-table-state">{lifecycleLabel(t)}</span>
                        <span className="mml-table-count">
                          {t.seated}/{t.max_players}
                        </span>
                        {t.seat_change_queue > 0 && (
                          <span className="mml-table-queue">
                            {t.seat_change_queue} Waiting To Change Here
                          </span>
                        )}
                        {canRequestTo(t) && (
                          <button
                            type="button"
                            className="mml-btn mml-btn--small"
                            disabled={busy}
                            onClick={() => void request(t.id)}
                          >
                            Request
                          </button>
                        )}
                      </div>
                      <ul className="mml-seats">
                        {Array.from({ length: t.max_players }, (_, i) => i + 1).map((n) => {
                          const s = t.seats.find((x) => x.seat_number === n);
                          const mine = Boolean(s?.user_id && me?.user_id === s.user_id);
                          return (
                            <li
                              key={n}
                              className={`mml-seat${!s?.user_id ? ' mml-seat--open' : ''}${mine ? ' mml-seat--me' : ''}`}
                            >
                              <span className="mml-seat-n">{n}</span>
                              <span className="mml-seat-name">
                                {s?.user_id ? (s.alias ?? 'Player') : 'Open'}
                              </span>
                              <span className="mml-seat-stack">
                                {s?.user_id ? formatChips(Number(s.stack ?? 0)) : ''}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  ))}
                </section>

                {/* ─── The must-move list ─── */}
                <section className="mml-list">
                  <div className="mml-section-title">Must Move List</div>
                  <div className="mml-list-note">
                    The Order Players Joined The Game. Number 1 Takes The Next Seat In The Main
                    Game.
                  </div>
                  {lobby.must_move_list.length === 0 ? (
                    <div className="mml-me-note">Everyone Is In The Main Game.</div>
                  ) : (
                    <ol className="mml-list-rows" aria-label="Must Move List, In Join Order">
                      {mustMoveListRows(lobby.must_move_list, me?.user_id).map((row) => (
                        <li
                          key={row.key}
                          className={`mml-list-row${row.me ? ' mml-list-row--me' : ''}`}
                          aria-current={row.me ? 'true' : undefined}
                        >
                          <span className="mml-list-pos">{row.position}</span>
                          <span className="mml-list-name">
                            {row.name}
                            {row.me && <span className="mml-list-you">You</span>}
                          </span>
                          <span className="mml-list-table">{row.tableLabel}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </section>
              </>
            )}
          </div>
        </SpadeConsole>
      </div>
    </div>
  );
}

export default MustMoveLobbyModal;
