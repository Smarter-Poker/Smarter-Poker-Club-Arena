/**
 * THE MUST MOVE LOBBY - the client's half (Operation Table Stakes; Dan
 * 2026-09-05). One read (`fn_cash_game_lobby`) feeds the in-table lobby:
 * every table of the game with every chair and stack, the must-move list in
 * the order players joined the game, the waitlist count, the per-table
 * seat-change queues and the caller's own state. Two doors: request a seat
 * change (any table but Main 1, or a specific one) and take a request back.
 * The database decides everything; this file only asks and repeats.
 */

import { supabase } from '../lib/supabase';
import { cashBuyInRefusalText } from '../lib/cashBuyIn';

export interface LobbySeat {
  seat_number: number;
  user_id: string | null;
  alias: string | null;
  stack: number | string | null;
  is_sitting_out: boolean | null;
  joined_game_at: string | null;
}

export interface LobbyTable {
  id: string;
  name: string;
  role: 'main' | 'feeder' | string;
  main_index: number | null;
  lifecycle: 'opening' | 'live' | 'breaking' | 'closed' | string;
  status: string;
  max_players: number;
  seated: number;
  open_seats: number;
  seat_change_queue: number;
  seats: LobbySeat[];
}

export interface LobbyListEntry {
  position: number;
  user_id: string;
  alias: string | null;
  table_id: string;
  table_name: string;
  role: string;
  main_index: number | null;
  joined_at: string;
}

export interface LobbySeatChangeRequest {
  id: string;
  to_table_id: string | null;
  created_at: string;
  position: number | null;
}

export interface LobbyPendingMove {
  id: string;
  to_table_id: string;
  to_table_name: string | null;
  to_role: string | null;
  to_main_index: number | null;
  reason: 'must_move' | 'break' | 'seat_change' | 'balance' | string;
  announced: boolean;
  swap: boolean;
  held: boolean;
}

export interface LobbyMe {
  user_id: string;
  seated: boolean;
  table_id: string | null;
  seat_number: number | null;
  stack: number | string | null;
  role: string | null;
  main_index: number | null;
  lifecycle: string | null;
  on_main_one: boolean | null;
  joined_game_at: string | null;
  must_move_position: number | null;
  seat_change: {
    available: boolean;
    used_at: string | null;
    request: LobbySeatChangeRequest | null;
  };
  pending_move: LobbyPendingMove | null;
  /** Not seated: the caller's place on the game's waitlist (Gate 4). */
  waitlist?: { waiting: number; position: number | null; on_list: boolean } | null;
}

export interface CashGameLobby {
  game: {
    id: string;
    name: string;
    template_name: string | null;
    variant: string;
    sb: number | string;
    bb: number | string;
    handedness: number;
    state: string;
    must_move: boolean;
    enabled: boolean;
    last_tick_at: string | null;
  };
  tables: LobbyTable[];
  must_move_list: LobbyListEntry[];
  waitlist: { waiting: number };
  seat_changes_requested: number;
  me: LobbyMe | null;
  as_of: string;
}

export type SeatChangeAction =
  | 'moving'
  | 'swapping'
  | 'listed'
  | 'moved'
  | 'cancelled'
  | 'none'
  | string;

export interface SeatChangeResult {
  ok: boolean;
  action: SeatChangeAction;
  request_id: string | null;
  to_table_id: string | null;
  to_table_name: string | null;
  to_role: string | null;
  to_main_index: number | null;
  position: number | null;
  used_at: string | null;
}

/** The name a table wears in the lobby: "Main 1", "Main 2", "Feeder". */
export function lobbyTableLabel(t: Pick<LobbyTable, 'role' | 'main_index' | 'name'>): string {
  if (t.role === 'main' && t.main_index) return `Main ${t.main_index}`;
  if (t.role === 'feeder') return 'Feeder';
  return t.name || 'Table';
}

/** Is this the main game - the one table a seat change never goes to or from. */
export function isMainOne(t: Pick<LobbyTable, 'role' | 'main_index'>): boolean {
  return t.role === 'main' && t.main_index === 1;
}

/**
 * THE FELT SAYS A MOVE IS COMING (Dan 2026-09-05). The sentence a player with
 * a pending move reads on the table until the move executes, in the engine's
 * own words (seatMoves.ts): "Seat Open On Main 2. Moving After This Hand."
 * A move always executes at the player's NEXT hand boundary - cash_seat_moves
 * carries no hands-until - so there is never an N to count down; the copy is
 * "After This Hand" and it stays up until the chair is at the other table.
 * Title Case, no em dash (the popup law in src/utils/popupStyle.ts).
 */
export function pendingMoveDestination(
  move: Pick<LobbyPendingMove, 'to_role' | 'to_main_index' | 'to_table_name'>
): string {
  if (move.to_role === 'main' && move.to_main_index) return `Main ${move.to_main_index}`;
  if (move.to_role === 'feeder') return 'Feeder';
  return move.to_table_name || 'Your New Table';
}

export function pendingMoveNotice(move: LobbyPendingMove | null | undefined): string | null {
  if (!move) return null;
  const where = pendingMoveDestination(move);
  if (move.reason === 'break') {
    return `This Table Is Closing. Moving To ${where} After This Hand.`;
  }
  /* THE ROOM EVENED THE TABLES (Dan 2026-09-05). Same words the engine uses
     (seatMoves.ts): the felt and the lobby must never describe one move two
     ways. It is not a promotion and it is not a closure, so it says neither. */
  if (move.reason === 'balance') {
    return `Balancing The Tables. Moving To ${where} After This Hand.`;
  }
  if (move.reason === 'seat_change') {
    if (move.held) return 'Seat Change: Waiting For The Other Table To Finish Its Hand.';
    return `Seat Change Granted. ${move.swap ? 'Swapping' : 'Moving'} To ${where} After This Hand.`;
  }
  return `Seat Open On ${where}. Moving After This Hand.`;
}

/**
 * THE LIST HAS NAMES (Dan 2026-09-05). One row per player on the must-move
 * list, in the order the database posted (position ascending, whatever order
 * the JSON arrived in), with the name the lobby read for them, the table they
 * sit at, and whether the row is the viewer's own. A missing alias reads
 * "Player", never blank and never a uuid.
 */
export interface MustMoveListRow {
  key: string;
  position: number;
  name: string;
  tableLabel: string;
  me: boolean;
}

export function mustMoveListRows(
  list: ReadonlyArray<LobbyListEntry> | null | undefined,
  viewerId: string | null | undefined
): MustMoveListRow[] {
  return [...(list ?? [])]
    .sort((a, b) => Number(a.position) - Number(b.position))
    .map((e) => ({
      key: e.user_id,
      position: Number(e.position),
      name: (e.alias ?? '').trim() || 'Player',
      tableLabel: lobbyTableLabel({ role: e.role, main_index: e.main_index, name: e.table_name }),
      me: Boolean(viewerId && e.user_id === viewerId),
    }));
}

export async function fetchCashGameLobby(gameId: string): Promise<CashGameLobby> {
  const { data, error } = await supabase.rpc('fn_cash_game_lobby', { p_game_id: gameId });
  if (error) throw error;
  return data as CashGameLobby;
}

/**
 * The refusals the door names, in the player's words (Title Case, no em
 * dash - the popup law in src/utils/popupStyle.ts applies the case; these
 * only need to be sentences).
 */
export const SEAT_CHANGE_REFUSALS: Record<string, string> = {
  SEAT_CHANGE_NOT_FROM_MAIN: 'The Main Game Has No Seat Change.',
  SEAT_CHANGE_NEVER_TO_MAIN: 'The Main Game Fills In Must Move Order Only.',
  SEAT_CHANGE_USED: 'You Have Used Your Seat Change For This Game.',
  SEAT_CHANGE_TABLE_CLOSING: 'This Table Is Closing And The Game Is Already Moving You.',
  SEAT_CHANGE_TABLE_UNAVAILABLE: 'That Table Is Not Open In This Game.',
  SEAT_CHANGE_SAME_TABLE: 'You Are Already At That Table.',
  SEAT_CHANGE_NO_OTHER_TABLE: 'There Is No Other Table To Change To Yet.',
  SEAT_CHANGE_MANUAL_GAME: 'A Manual Table Has No Seat Change.',
  MOVE_PENDING: 'You Are Already Being Moved.',
  NOT_IN_GAME: 'You Are Not Seated In This Game.',
  PLATFORM_FROZEN: 'The Platform Is On Its Maintenance Break.',
};

/** Turn a door's exception into the sentence the player reads. */
export function seatChangeRefusalText(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  const code = msg.split(':')[0]?.trim();
  return (code && SEAT_CHANGE_REFUSALS[code]) || 'Seat Change Not Available Right Now.';
}

export async function requestSeatChange(
  gameId: string,
  toTableId: string | null
): Promise<SeatChangeResult> {
  const { data, error } = await supabase.rpc('fn_cash_seat_change_request', {
    p_game_id: gameId,
    p_to_table_id: toTableId,
  });
  if (error) throw error;
  return data as SeatChangeResult;
}

export async function cancelSeatChange(
  gameId: string
): Promise<{ ok: boolean; cancelled: number }> {
  const { data, error } = await supabase.rpc('fn_cash_seat_change_cancel', { p_game_id: gameId });
  if (error) throw error;
  return data as { ok: boolean; cancelled: number };
}

/** Leaving a game queue also releases the table offers belonging to it. */
export async function leaveCashGameWaitlist(
  gameId: string
): Promise<{ ok: true; cancelled: number; released_offers: number }> {
  const { data, error } = await supabase.rpc('fn_cash_game_leave_waitlist', { p_game_id: gameId });
  if (error) throw error;
  if (
    data?.ok !== true ||
    !Number.isSafeInteger(data.cancelled) ||
    data.cancelled < 0 ||
    !Number.isSafeInteger(data.released_offers) ||
    data.released_offers < 0
  )
    throw new Error('Waitlist cancellation was not confirmed');
  return data;
}

/** The sentence for a seat-change outcome, matching the engine's notices. */
export function seatChangeOutcomeText(r: SeatChangeResult, tableLabel: string | null): string {
  const where = tableLabel ?? 'Your New Table';
  switch (r.action) {
    case 'moving':
      return `Seat Change Granted. Moving To ${where} After This Hand.`;
    case 'swapping':
      return `Seat Change Granted. Swapping To ${where} After This Hand.`;
    case 'listed':
      return r.position
        ? `Added To The List. You Are Number ${r.position} For ${where}.`
        : `Added To The List For ${where}.`;
    default:
      return 'Seat Change Requested.';
  }
}

/** The answer of the game door (fn_cash_game_join): where to sit, or the place held. */
export interface CashGameJoinResult {
  ok: boolean;
  action: 'seated' | 'seat' | 'waitlisted' | string;
  table_id?: string | null;
  table_name?: string | null;
  seat_number?: number | null;
  role?: string | null;
  main_index?: number | null;
  open_seats?: number | null;
  position?: number | null;
  waiting?: number | null;
  tables?: number | null;
  opening_hold_since?: string | null;
}

/**
 * JOIN GAME (Gate 4): the game decides the table - the shortest live Main
 * with an unreserved chair, then the feeder; none, and the caller's place is
 * held on the game's waitlist, where the OPEN rule counts them as a buyer.
 * Seating itself stays the table's own buy-in door.
 */
export async function joinCashGame(gameId: string): Promise<CashGameJoinResult> {
  const { data, error } = await supabase.rpc('fn_cash_game_join', { p_game_id: gameId });
  if (error) throw error;
  if (data?.ok !== true) {
    throw new Error(String(data?.reason ?? data?.action ?? 'Game admission was not confirmed'));
  }
  if (
    !['seat', 'seated', 'waitlisted'].includes(data.action) ||
    (data.action !== 'waitlisted' && (typeof data.table_id !== 'string' || !data.table_id.trim()))
  ) {
    throw new Error('Game admission did not name a destination or queue place');
  }
  return data as CashGameJoinResult;
}

export const JOIN_GAME_REFUSALS: Record<string, string> = {
  GAME_CLOSED: 'This Game Is Not Taking Players.',
  GAME_NOT_FOUND: 'This Game Is No Longer Here.',
  NOT_AUTHENTICATED: 'Sign In To Join A Game.',
};

/**
 * GAME_BARRED IS NOT IN THE TABLE ABOVE ON PURPOSE (2026-09-05). The door
 * raises `GAME_BARRED:<seconds>` for a player booted for low VPIP, and the
 * number is the whole message - "you may rejoin in 4 minutes" is an answer,
 * "the game could not seat you right now" is not. `cashBuyInRefusalText`
 * already writes that sentence for the buy-in door's identical VPIP_BARRED,
 * so this asks IT rather than keeping a second copy of the wording and the
 * seconds-to-minutes arithmetic: two copies of one sentence is how the two
 * doors end up telling a player different things about the same bar.
 *
 * Until today this fell through to the generic line, so the Take A Chair
 * button on CashClusterHUD refused a barred player without ever saying why
 * or for how long, while the buy-in modal three taps away said both.
 */
export function joinGameRefusalText(err: unknown): string {
  const msg = String((err as { message?: string })?.message ?? err ?? '');
  const code = msg.split(':')[0]?.trim();
  const mapped = code ? JOIN_GAME_REFUSALS[code] : undefined;
  if (mapped) return mapped;
  /* Only the bar is delegated. Asking the buy-in translator about EVERY
     refusal would let a buy-in sentence answer a join question. */
  if (code === 'GAME_BARRED') {
    return cashBuyInRefusalText(msg) || 'You Cannot Rejoin This Game Yet.';
  }
  return 'The Game Could Not Seat You Right Now.';
}

/** The waitlist sentence (OPORD 1.4 s18.3: "Next table opens when one more player sits"). */
export function waitlistedText(r: CashGameJoinResult): string {
  const pos = r.position ? `You Are Number ${r.position}` : 'You Are On The List';
  return r.opening_hold_since
    ? `${pos}. The Next Table Opens When One More Player Sits.`
    : `${pos} On The Waitlist. You Will Be Seated At The Next Open Chair.`;
}
