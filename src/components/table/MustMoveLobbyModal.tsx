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
 * Same 3/4 geometry as TournamentLobbyModal (its CSS is reused: a 75vw panel
 * on the right on desktop, a 75dvh sheet on a phone). Everything shown comes
 * from ONE read, fn_cash_game_lobby, polled every five seconds while open -
 * the same cadence as the controller's tick, so the lobby is never more than
 * one tick behind the board.
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
 * AUDIT 2026-09-09 (lane H): a failed read prints house copy, never the
 * database's code (mustMoveLobbyCopy.ts), and a game that is gone drops its
 * figures rather than showing a lobby for a ghost; the seat-change note
 * yields to ANY pending move, whatever its reason, because the sentence
 * above it already says where the player is going; JOIN GAME no longer
 * borrows .tlm-close (metallic-popups.css painted it as steel close
 * hardware); and the panel is on the #SmarterCasinoRealism chassis
 * (MustMoveLobbyModal.css says what that is and what it is not yet).
 */

import { useEffect } from 'react';
import {
  cancelSeatChange,
  isMainOne,
  joinCashGame,
  joinGameRefusalText,
  leaveCashGameWaitlist,
  lobbyTableLabel,
  mustMoveListRows,
  pendingMoveNotice,
  requestSeatChange,
  seatChangeOutcomeText,
  seatChangeRefusalText,
  waitlistedText,
  type LobbyTable,
} from '../../services/cashGameLobby';
import { formatChips } from '../../lib/utils';
import { CASH_TEMPLATES } from '../../config/cashGames';
import { useToast } from '../common/Toast';
import { lobbyReadErrorText } from './mustMoveLobbyCopy';
import { useCashGameLobby } from './useCashGameLobby';
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
  const {
    lobby,
    error: readError,
    busy,
    load,
    beginAction,
  } = useCashGameLobby(gameId, isOpen, MUST_MOVE_LOBBY_POLL_MS);
  const error = readError ? lobbyReadErrorText(readError) : null;

  // Escape closes, same as every other overlay at the table.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const tableById = new Map<string, LobbyTable>();
  for (const t of lobby?.tables ?? []) tableById.set(t.id, t);
  const labelFor = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const t = tableById.get(id);
    return t ? lobbyTableLabel(t) : null;
  };

  const request = async (toTableId: string | null) => {
    if (!gameId) return;
    const action = beginAction();
    if (!action) return;
    try {
      const r = await requestSeatChange(gameId, toTableId);
      if (!action.isCurrent()) return;
      toast.success(
        seatChangeOutcomeText(r, labelFor(r.to_table_id) ?? (toTableId ? null : 'Any Table'))
      );
      await load();
    } catch (err) {
      if (action.isCurrent()) toast.warning(seatChangeRefusalText(err));
    } finally {
      action.finish();
    }
  };

  const cancel = async () => {
    if (!gameId) return;
    const action = beginAction();
    if (!action) return;
    try {
      const r = await cancelSeatChange(gameId);
      if (!action.isCurrent()) return;
      toast.info(r.cancelled > 0 ? 'Seat Change Request Cancelled.' : 'Nothing To Cancel.');
      await load();
    } catch (err) {
      if (action.isCurrent()) toast.warning(seatChangeRefusalText(err));
    } finally {
      action.finish();
    }
  };

  const leaveWaitlist = async () => {
    if (!gameId) return;
    const action = beginAction();
    if (!action) return;
    try {
      const result = await leaveCashGameWaitlist(gameId);
      if (!action.isCurrent()) return;
      toast.info(
        result.cancelled + result.released_offers > 0
          ? 'You Have Left The Waiting List.'
          : 'You Are Already Off The Waiting List.'
      );
      await load();
    } catch {
      if (action.isCurrent()) toast.warning('Could Not Leave The Waiting List. Please Try Again.');
    } finally {
      action.finish();
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
    if (!gameId) return;
    const action = beginAction();
    if (!action) return;
    try {
      const r = await joinCashGame(gameId);
      if (!action.isCurrent()) return;
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
      if (action.isCurrent()) toast.warning(joinGameRefusalText(err));
    } finally {
      action.finish();
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

  return (
    <div className="tlm-overlay mml-overlay" onClick={onClose} role="presentation">
      <div
        className="tlm-panel mml-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Must Move Lobby"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tlm-grab" aria-hidden="true">
          <span />
        </div>

        <div className="tlm-header">
          <span className="tlm-title">Must Move Lobby</span>
          {/* JOIN GAME sits beside Close for anybody looking at this game
              without a chair in it - viewing a table, or opening the lobby
              from the game list. A seated player never sees it. */}
          {/* NOT `tlm-close` (audit 2026-09-09, lane H). It borrowed that class
              for the geometry, and metallic-popups.css paints every
              `[class*='-close']` inside a dialog as steel close hardware with
              !important - so the one action in the header wore the dismissal's
              dress and its blue never rendered. .mml-join carries its own
              geometry now and the illuminated pill face. */}
          {lobby && !me?.seated && (
            <button
              type="button"
              className="mml-join"
              onClick={() => void join()}
              disabled={busy}
              aria-label="Join Game"
            >
              Join Game
            </button>
          )}
          <button type="button" className="tlm-close" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        <div className="tlm-body mml-body">
          {error && <div className="mml-error">{error}</div>}
          {!lobby && !error && <div className="mml-loading">Reading The Game</div>}

          {lobby && game && (
            <>
              {/* ─── The game ─── */}
              <section className="mml-game">
                <div className="mml-game-name">{game.name}</div>
                <div className="mml-game-line">
                  {styleLabel && <span className="mml-style">{styleLabel.toUpperCase()}</span>}
                  <span className="mml-stakes">
                    {formatChips(Number(game.sb))}/{formatChips(Number(game.bb))}
                  </span>
                  <span className="mml-hand">{game.handedness} Max</span>
                </div>
                <div className="mml-figures">
                  <div className="mml-figure">
                    <span className="mml-figure-value">{playersTotal}</span>
                    <span className="mml-figure-label">Players</span>
                  </div>
                  <div className="mml-figure">
                    <span className="mml-figure-value">{tablesOpen}</span>
                    <span className="mml-figure-label">Tables</span>
                  </div>
                  <div className="mml-figure">
                    <span className="mml-figure-value">{lobby.waitlist?.waiting ?? 0}</span>
                    <span className="mml-figure-label">Waiting</span>
                  </div>
                  <div className="mml-figure">
                    <span className="mml-figure-value">{lobby.must_move_list.length}</span>
                    <span className="mml-figure-label">Must Move</span>
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
                            You Are Number {me.seat_change.request.position ?? '-'} On The List For{' '}
                            {labelFor(me.seat_change.request.to_table_id) ?? 'Any Table'}.
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
                      ) : me.pending_move ? null : (
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

              {!me?.seated && me?.waitlist?.on_list && (
                <section className="mml-me">
                  <div className="mml-section-title">Your Waiting List Place</div>
                  <div className="mml-me-line">
                    {me.waitlist.position
                      ? `You Are Number ${me.waitlist.position} On The Waiting List.`
                      : 'You Are On The Waiting List.'}
                  </div>
                  <button
                    type="button"
                    className="mml-btn"
                    disabled={busy}
                    onClick={() => void leaveWaitlist()}
                  >
                    Leave Waiting List
                  </button>
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
                  The Order Players Joined The Game. Number 1 Takes The Next Seat In The Main Game.
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
      </div>
    </div>
  );
}

export default MustMoveLobbyModal;
