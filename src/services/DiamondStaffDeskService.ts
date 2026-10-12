/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DIAMOND STAFF DESK - the doors the staff page calls directly
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Diamond Phase 10, line 4, item 8 of the build list in
 * docs/DIAMOND-PHASE-10-AUDIT-2026-09-21.md. The staff page runs Diamond
 * tables and events through the fn_poker_diamond_* platform-staff doors
 * (migrations 20260929213000 and the doors they redefined), and reads the
 * adjustments queue, the health report as the hourly watch last read it, and
 * the books through fn_ca_diamond_staff_books (20260929231500). Incident
 * review and the four adjustment doors have their own services
 * (DiamondIncidentReviewService, DiamondAdjustmentService).
 *
 * Every door checks staff itself (fn_is_platform_admin); PlatformStaffGuard
 * on the route is a courtesy. Nothing is decided here: a refusal comes back
 * as a thrown Error whose message is the door's own refusal in words staff
 * read, never a guess.
 */
import { supabase } from '../lib/supabase';
import { DIAMOND_ARENA_CLUB_ID } from '../lib/constants';

/** The games the arena deals (fn_poker_diamond_cash_variant). */
export const DIAMOND_CASH_GAMES = [
  'nlh',
  'plo4',
  'plo5',
  'plo6',
  'plo8',
  'pineapple',
  'short_deck',
  'flh',
  'flo8',
] as const;

export interface DiamondTable {
  id: string;
  name: string;
  game_variant: string;
  status: string;
  small_blind: number;
  big_blind: number;
  min_buy_in: number;
  max_buy_in: number;
  max_players: number;
  current_players: number | null;
  straddle_enabled: boolean | null;
  auto_utg_straddle: boolean | null;
  run_it_twice: boolean | null;
  bomb_pot_enabled: boolean | null;
  bomb_pot_ante_multiplier: number | null;
  bomb_pot_board_count: number | null;
}

export interface DiamondEvent {
  id: string;
  name: string;
  status: string;
  tournament_type: string | null;
  buy_in_amount: number | null;
  current_players: number | null;
  max_players: number | null;
  start_time: string | null;
}

export interface DiamondEntry {
  user_id: string;
  username: string | null;
  status: string | null;
  registered_at: string | null;
}

export interface TableStakes {
  name: string | null;
  smallBlind: number | null;
  bigBlind: number | null;
  minBuyIn: number | null;
  maxBuyIn: number | null;
  maxPlayers: number | null;
}

export interface HealthArea {
  area: string;
  status: 'ok' | 'attention' | 'critical' | 'unknown';
  detail: string;
}

export interface HealthReading {
  /** When the hourly watch last read the report; null before its first reading. */
  read_at: string | null;
  areas: HealthArea[];
}

export interface TrialBalanceRow {
  account: string;
  balance_now: number | null;
  balance_delta: number | null;
  journal_net: number | null;
  mint_net: number | null;
  difference: number | null;
  note: string | null;
}

export interface DiamondBooks {
  trial_balance: TrialBalanceRow[];
  register: {
    register_net: number;
    meter_total: number;
    player_diamonds: number;
    house_diamonds: number;
    difference: number;
  } | null;
}

export interface QueuedAdjustment {
  id: string;
  status: 'proposed' | 'approved' | 'rejected' | 'settled';
  target_kind: 'diamond_wallet' | 'diamond_house';
  target_id: string | null;
  target_label: string | null;
  amount: number;
  reason: string;
  proposed_by: string;
  proposed_by_label: string | null;
  proposed_at: string;
  approved_by: string | null;
  approved_by_label: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_by_label: string | null;
  rejected_at: string | null;
  decision_note: string | null;
  receipt: {
    source: 'diamond_house' | 'new_issuance';
    settled_by: string;
    settled_by_label: string | null;
    settled_at: string;
    supply_moved: number | null;
  } | null;
}

export interface AdjustmentQueue {
  /** Null until what pays for a correction is authorized: every settle is refused. */
  correction_source: {
    source: 'diamond_house' | 'new_issuance';
    authorized_by: string;
    ruling: string;
    authorized_at: string;
  } | null;
  counts: Partial<Record<QueuedAdjustment['status'], number>>;
  adjustments: QueuedAdjustment[];
}

/** Refusals whose own name would not say enough to the person reading it. */
const PLAIN: Readonly<Record<string, string>> = {
  platform_staff_only: 'Only Platform Staff Can Do That',
  diamond_staff_session_required: 'Your Session Has Ended. Sign In Again.',
  diamond_correction_source_not_authorized:
    'Not Settled: What Pays For A Diamond Correction Has Not Been Authorized Yet, So Nothing Moved',
  four_eyes_violated: 'Not Approved: A Different Staff Member Must Approve A Correction',
  reason_too_short: 'Write A Reason Of At Least 20 Characters',
  not_proposed: 'Only A Proposed Correction Can Be Approved Or Rejected',
  not_approved: 'Only An Approved Correction Can Be Settled',
};

/** Words in Title Case: rule_arming reads Rule Arming. */
export function titleWords(text: string): string {
  return text
    .replace(/_/g, ' ')
    .replace(/(^|\s)(\S)/g, (_m, space: string, first: string) => space + first.toUpperCase());
}

/**
 * A door's refusal in the words staff read: a name such as
 * diamond_table_must_be_empty_to_edit reads Diamond Table Must Be Empty To
 * Edit, a sentence keeps its words in Title Case, and a few names whose words
 * would not say enough are spelled out.
 */
export function refusalWords(raw: unknown, fallback = 'The Server Refused That'): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return fallback;
  return Object.prototype.hasOwnProperty.call(PLAIN, text) ? PLAIN[text] : titleWords(text);
}

async function door<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(refusalWords(error.message));
  return data as T;
}

/** A door that answers { ok: false, <reason> } instead of raising. */
async function answered<T>(fn: string, args: Record<string, unknown>, key: string): Promise<T> {
  const answer = await door<Record<string, unknown> | null>(fn, args);
  if (!answer || answer.ok !== true) throw new Error(refusalWords(answer?.[key]));
  return answer as T;
}

async function rows<T>(
  query: PromiseLike<{ data: unknown; error: { message: string } | null }>
): Promise<T[]> {
  const { data, error } = await query;
  if (error) throw new Error(refusalWords(error.message));
  return (data ?? []) as T[];
}

const TABLE_COLUMNS =
  'id,name,game_variant,status,small_blind,big_blind,min_buy_in,max_buy_in,max_players,current_players,' +
  'straddle_enabled,auto_utg_straddle,run_it_twice,bomb_pot_enabled,bomb_pot_ante_multiplier,bomb_pot_board_count';

/** The arena's cash tables, newest first. */
export function listDiamondTables(): Promise<DiamondTable[]> {
  return rows(
    supabase
      .from('tables')
      .select(TABLE_COLUMNS)
      .eq('club_id', DIAMOND_ARENA_CLUB_ID)
      .is('tournament_id', null)
      .order('created_at', { ascending: false })
      .limit(100)
  );
}

/** The arena's events, latest start first. */
export function listDiamondEvents(): Promise<DiamondEvent[]> {
  return rows(
    supabase
      .from('tournaments')
      .select('id,name,status,tournament_type,buy_in_amount,current_players,max_players,start_time')
      .eq('club_id', DIAMOND_ARENA_CLUB_ID)
      .order('start_time', { ascending: false })
      .limit(50)
  );
}

/** Who is entered in one event. */
export function listDiamondEntries(eventId: string): Promise<DiamondEntry[]> {
  return rows(
    supabase
      .from('tournament_players')
      .select('user_id,username,status,registered_at')
      .eq('tournament_id', eventId)
      .order('registered_at', { ascending: true })
  );
}

/** Open a plain Diamond cash table; answers the new table's id. */
export function openDiamondTable(stakes: TableStakes, gameVariant: string): Promise<string> {
  return door('fn_poker_diamond_open_cash_table', {
    p_name: stakes.name,
    p_small_blind: stakes.smallBlind,
    p_big_blind: stakes.bigBlind,
    p_min_buy_in: stakes.minBuyIn,
    p_max_buy_in: stakes.maxBuyIn,
    p_max_players: stakes.maxPlayers,
    p_game_variant: gameVariant,
  });
}

/** Edit an empty waiting table; a null field keeps what the table has. */
export function editDiamondTable(tableId: string, stakes: TableStakes): Promise<unknown> {
  return answered(
    'fn_poker_diamond_edit_cash_table',
    {
      p_table_id: tableId,
      p_name: stakes.name,
      p_small_blind: stakes.smallBlind,
      p_big_blind: stakes.bigBlind,
      p_min_buy_in: stakes.minBuyIn,
      p_max_buy_in: stakes.maxBuyIn,
      p_max_players: stakes.maxPlayers,
    },
    'reason'
  );
}

export function closeDiamondTable(tableId: string): Promise<unknown> {
  return answered('fn_poker_diamond_close_cash_table', { p_table_id: tableId }, 'reason');
}

export function setDiamondStraddle(tableId: string, enabled: boolean, autoUtg: boolean) {
  return door<null>('fn_poker_diamond_set_table_straddle', {
    p_table_id: tableId,
    p_enabled: enabled,
    p_auto_utg: enabled && autoUtg,
  });
}

export function setDiamondRunItTwice(tableId: string, enabled: boolean) {
  return door<null>('fn_poker_diamond_set_table_run_it_twice', {
    p_table_id: tableId,
    p_enabled: enabled,
  });
}

export function setDiamondBombPot(
  tableId: string,
  enabled: boolean,
  anteMultiplier: number,
  boardCount: number
) {
  return door<null>('fn_poker_diamond_set_table_bomb_pot', {
    p_table_id: tableId,
    p_enabled: enabled,
    p_ante_multiplier: anteMultiplier,
    p_board_count: boardCount,
  });
}

/** Cancel an event: every entry goes home and the receipt names the operator. */
export function cancelDiamondEvent(eventId: string): Promise<Record<string, unknown>> {
  return door('fn_poker_diamond_cancel_tournament', { p_tournament_id: eventId });
}

/** Remove one player from an event that has not started; the entry goes home. */
export function removeDiamondEntry(
  eventId: string,
  userId: string
): Promise<{ refunded_diamonds?: number }> {
  return answered(
    'fn_poker_diamond_remove_tournament_player',
    { p_tournament_id: eventId, p_user_id: userId, p_request_id: null },
    'reason'
  );
}

function staffBooks<T>(view: 'adjustments' | 'health' | 'books'): Promise<T> {
  return answered('fn_ca_diamond_staff_books', { p_view: view }, 'refused_reason');
}

export const readAdjustmentQueue = () => staffBooks<AdjustmentQueue>('adjustments');
export const readHealthReading = () => staffBooks<HealthReading>('health');
export const readDiamondBooks = () => staffBooks<DiamondBooks>('books');
