/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A TOURNAMENT OFFERS MORE TOURNAMENTS — the "+" sheet, from an MTT or SNG
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-10-04, verbatim: "IF YOU ARE CURRENTLY ON A MTT TABLE, AND CLICK
 * THE + BUTTON TO ADD ANOTHER, IT SHOULD BRING YOU TO MORE MTT'S, IT CURRENTLY
 * ONLY IDENTIFIES THE 'GAME TYPE' (NO LIMIT HOLDEM) AND SHOWS YOU CASH GAMES,
 * INSTEAD OF THE CURRENT TOURNAMENTS FOR 'QUICK JOIN' FUNCTIONALITY."
 *
 * MultiTablePage's Quick Join queried `tables` with
 * `.is('tournament_id', null)`: cash tables, by construction. Spins were given
 * their own answer on 2026-09-05 (quickJoinSpins.ts); an MTT or a sit and go
 * was not a Spin, so `quickJoinSpinRows` returned null and the cash sheet ran.
 *
 * ── NOTHING HERE DECIDES WHO MAY ENTER ──────────────────────────────────────
 *
 * The list is read with `tournamentService.getTournaments`, the same read the
 * tournament lobby uses (club events plus the union's, RLS deciding what this
 * viewer may see), and "can this still be entered" is answered by the lobby's
 * own two rules: `isTournamentEntryUnavailable` and `tournamentStatus`. A
 * second copy of either would drift from the lobby and offer a row whose
 * Register button then refuses.
 *
 * ── AND NOTHING HERE REGISTERS ANYBODY ──────────────────────────────────────
 *
 * A row's JOIN opens that tournament's own lobby page in a tab of the strip
 * (MultiTablePage.openTournamentTab), where the existing Register button, its
 * Sign Up card, the wallet check and the seat-first rules all already live.
 * That is what a cash row's JOIN does too: it opens the table, and the buy-in
 * happens there. No money moves from this file.
 */

import { supabase } from './supabase';
import { tournamentService } from '../services/TournamentService';
import { tournamentStatus, type LobbyTournamentRow } from '../components/lobby/lobbyEntries';
import {
  getTournamentEntryCapacity,
  getTournamentFormatKind,
  isTournamentEntryUnavailable,
} from '../utils/tournamentPresentation';
import { formatBuyInShort, totalBuyIn } from '../utils/buyIn';
import { titleCase } from '../utils/titleCase';
import { gameCode } from '../utils/gameCode';
import { reportError } from '../utils/errorReporter';
import {
  rankQuickJoinTournaments,
  type QuickJoinTournamentCandidate,
  type QuickJoinCurrentTournament,
} from './quickJoinRanking';

/** One row of the sheet. Same zones a cash row fills, plus where JOIN goes. */
export interface TournamentQuickJoinRow {
  /** The TOURNAMENT id: the row's key and what JOIN opens. */
  id: string;
  tournamentId: string;
  name: string;
  /** The buy-in as the tournament lobby prints it ("55", "Free Buy"). */
  stakes: string;
  players: number;
  max: number;
  /** "12/200" for a capped event, "12 Entered" for one with no cap. */
  seats: string;
  /** MTT or SNG. */
  code: string;
  /** Start or late registration state ("Registering", "Late Reg"). */
  reason: string;
  tier: string;
}

/** The tournament the player is sitting in, as far as it could be read. */
export interface TournamentQuickJoinContext extends QuickJoinCurrentTournament {
  id: string;
  clubId: string | null;
  format: 'mtt' | 'sng' | 'spin' | 'unknown';
}

/** How many tournaments the sheet shows. Same five the cash path offers. */
export const TOURNAMENT_QUICK_JOIN_LIMIT = 5;

/** States in which the lobby still sells an entry. */
const ENTRY_OPEN_KEYS = new Set(['registering', 'starting_soon', 'late_reg']);

/**
 * Which tournament is this table part of? null for a cash table and for
 * anything unreadable: the caller then decides from what the tab itself knows.
 */
export async function readTournamentContext(
  activeTableId: string | null
): Promise<TournamentQuickJoinContext | null> {
  if (!activeTableId) return null;
  const { data: tbl, error: tblErr } = await supabase
    .from('tables')
    .select('id, tournament_id')
    .eq('id', activeTableId)
    .maybeSingle();
  if (tblErr || !tbl?.tournament_id) return null;

  const { data: t, error: tErr } = await supabase
    .from('tournaments')
    .select(
      'id, club_id, buy_in_amount, buy_in_fee, game_type, variant, tournament_type, format_contract, max_players'
    )
    .eq('id', tbl.tournament_id as string)
    .maybeSingle();
  if (tErr || !t) return null;

  /* The format contract first, then the same two-column test the Spin sheet
     uses: a row without a readable contract is still a Spin if either column
     says so, and a Spin must keep going to its own sheet. */
  let format = getTournamentFormatKind(t);
  if (
    String(t.variant ?? '').toLowerCase() === 'spin' ||
    String(t.tournament_type ?? '').toUpperCase() === 'SPIN'
  ) {
    format = 'spin';
  }

  return {
    id: String(t.id),
    clubId: (t.club_id as string | null) ?? null,
    buyIn: totalBuyIn(Number(t.buy_in_amount) || 0, Number(t.buy_in_fee) || 0),
    variant: (t.game_type as string | null) ?? null,
    format,
  };
}

/** A lobby tournament row as the pure ranking wants it. */
export function toQuickJoinTournamentCandidate(
  t: LobbyTournamentRow
): QuickJoinTournamentCandidate {
  const entrants = Math.max(0, Math.trunc(Number(t.current_players) || 0));
  const status = tournamentStatus(t);
  const startMs = t.start_time ? Date.parse(t.start_time) : NaN;
  return {
    id: String(t.id),
    /* A tournament's name is typed by a club owner and printed to a player:
       Title Case Every Word, acronyms kept, em dashes stripped (titleCase). */
    name: titleCase(t.name) || 'Tournament',
    variant: t.game_type ?? null,
    format: getTournamentFormatKind(t),
    buyIn: totalBuyIn(Number(t.buy_in_amount) || 0, Number(t.buy_in_fee) || 0),
    entrants,
    capacity: getTournamentEntryCapacity(t),
    entryOpen: !isTournamentEntryUnavailable(t, entrants) && ENTRY_OPEN_KEYS.has(status.key),
    stateLabel: status.label,
    startMs: Number.isFinite(startMs) ? startMs : null,
  };
}

/**
 * The tournaments a player sitting in one can enter right now, ranked.
 *
 * Always an ARRAY, possibly empty. Empty is a real answer here ("No Open
 * Tournaments Right Now") and must not fall through to the cash sheet: the
 * owner's ruling is that a tournament player is never shown cash games by this
 * button. The reads below degrade rather than throw, so a failed registration
 * read costs only the "already entered" filter, and that row's own page still
 * says "You Are Registered".
 *
 * @param scopeClubIds the union hub AND the entry club, the same pair the cash
 *   and Spin paths scope to.
 */
export async function quickJoinTournamentRows(
  scopeClubIds: string[],
  context: TournamentQuickJoinContext | null,
  userId: string | null | undefined
): Promise<TournamentQuickJoinRow[]> {
  const clubIds = Array.from(new Set((scopeClubIds || []).filter(Boolean)));

  const [lists, regs] = await Promise.all([
    Promise.all(
      clubIds.map((clubId) =>
        tournamentService.getTournaments(clubId).catch((err: unknown) => {
          reportError(err, 'QuickJoinTournaments.list_read_failed', { clubId });
          return [];
        })
      )
    ),
    userId
      ? supabase
          .from('tournament_players')
          .select('tournament_id')
          .eq('user_id', userId)
          .in('status', ['registered', 'playing'])
          .limit(500)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (regs.error) {
    reportError(regs.error, 'QuickJoinTournaments.registrations_read_failed');
  }
  const mine = ((regs.data ?? []) as Array<{ tournament_id: string | null }>)
    .map((r) => r.tournament_id)
    .filter((id): id is string => !!id);

  const rows = lists.flat() as unknown as LobbyTournamentRow[];
  const ranked = rankQuickJoinTournaments(rows.map(toQuickJoinTournamentCandidate), {
    currentTournament: context,
    excludeIds: mine,
    limit: TOURNAMENT_QUICK_JOIN_LIMIT,
  });

  const byId = new Map(rows.map((r) => [String(r.id), r]));
  return ranked.map((t) => {
    const raw = byId.get(t.id);
    const entrants = Math.max(0, Number(t.entrants) || 0);
    const cap = Number(t.capacity) > 0 ? Number(t.capacity) : 0;
    return {
      id: t.id,
      tournamentId: t.id,
      name: t.name,
      stakes: formatBuyInShort(Number(raw?.buy_in_amount) || 0, Number(raw?.buy_in_fee) || 0),
      players: entrants,
      max: cap,
      seats:
        cap > 0
          ? `${entrants.toLocaleString()}/${cap.toLocaleString()}`
          : `${entrants.toLocaleString()} Entered`,
      code: gameCode({ isTournament: true, tournamentFormat: t.format === 'sng' ? 'sng' : 'mtt' }),
      reason: t.stateLabel,
      tier: t.tier,
    };
  });
}
