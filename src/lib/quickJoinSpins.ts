/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  A SPIN OFFERS MORE SPINS — the "+" sheet, when you are already in one
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Dan, 2026-09-05: "WHEN YOU ARE INSIDE A SPIN, AND HIT THE + BUTTON, IT
 * SHOULD RECOMMEND MORE SPINS, NOT CASH GAMES."
 *
 * MultiTablePage's Quick Join has always queried `tables` with
 * `.is('tournament_id', null)`. That is the right query for a cash player and
 * the wrong one for everybody else: a Spin is a tournament, so its tables were
 * excluded by construction and the sheet offered a cash game to a player who
 * had just chosen not to be in one.
 *
 * ── WHY THIS IS ITS OWN QUERY AND NOT A FLAG ON THE CASH ONE ────────────────
 *
 * A spin board is not a table with seats to browse. It is a STAKE with a
 * recycler behind it — exactly one open board per stake x variant, replaced
 * the moment it fills (the supply audit behind PR #1702's Play Again). So the
 * useful ranking is by stake, the row's "players" is the board's fill, and the
 * question "which table has room" does not arise: a REGISTERING spin board
 * always has room, or it would not be REGISTERING.
 *
 * ── EVERY FAILURE FALLS THROUGH, NEVER TO AN EMPTY SHEET ────────────────────
 *
 * `null` means "this is not a spin context, or I could not answer" and the
 * caller then runs the cash path it always ran. An empty ARRAY is never
 * returned for a readable-but-empty result either — a Spin player with no
 * sibling board is better served by the cash sheet than by "No Open Seats",
 * which is the exact failure the 2026-08-26 scope bug produced.
 */

import { supabase } from './supabase';
import { gameCode } from '../utils/gameCode';
import { reportError } from '../utils/errorReporter';

export interface SpinQuickJoinRow {
  id: string;
  name: string;
  stakes: string;
  players: number;
  max: number;
  code: string;
  reason?: string;
  tier?: string;
}

/** How many boards the sheet shows. Same five the cash path offers. */
export const SPIN_QUICK_JOIN_LIMIT = 5;

/**
 * Is the table the player is looking at a Spin, and if so which one?
 * Returns null for a cash table, an MTT, a heads-up, or anything unreadable.
 */
export async function readSpinContext(activeTableId: string | null): Promise<{
  tournamentId: string;
  clubId: string | null;
  buyIn: number;
  gameType: string | null;
} | null> {
  if (!activeTableId) return null;
  const { data: tbl, error: tblErr } = await supabase
    .from('tables')
    .select('id, tournament_id')
    .eq('id', activeTableId)
    .maybeSingle();
  if (tblErr || !tbl?.tournament_id) return null;

  const { data: t, error: tErr } = await supabase
    .from('tournaments')
    .select('id, club_id, buy_in_amount, game_type, variant, tournament_type')
    .eq('id', tbl.tournament_id as string)
    .maybeSingle();
  if (tErr || !t) return null;

  /* The same two-column test every other seat-first gate uses — variant OR
     tournament_type. Reading only one is how a satellite heads-up got filed
     as an MTT (TablePage, 2026-09-03). */
  const isSpin =
    String(t.variant ?? '').toLowerCase() === 'spin' ||
    String(t.tournament_type ?? '').toUpperCase() === 'SPIN';
  if (!isSpin) return null;

  return {
    tournamentId: String(t.id),
    clubId: (t.club_id as string | null) ?? null,
    buyIn: Number(t.buy_in_amount) || 0,
    gameType: (t.game_type as string | null) ?? null,
  };
}

/**
 * The open spin boards worth offering, ranked, or null to fall through to the
 * cash sheet.
 *
 * @param scopeClubIds the union hub AND the entry club, the same pair the cash
 *   query scopes to — a union's games all carry the UNION's club_id, and
 *   scoping to the entry club alone is what emptied this sheet in August.
 */
export async function quickJoinSpinRows(
  scopeClubIds: string[],
  activeTableId: string | null,
  openTableIds: Set<string>
): Promise<SpinQuickJoinRow[] | null> {
  try {
    const ctx = await readSpinContext(activeTableId);
    if (!ctx) return null;

    let q = supabase
      .from('tournaments')
      .select('id, name, buy_in_amount, buy_in_fee, max_players, game_type, current_players')
      .eq('variant', 'spin')
      .in('status', ['REGISTERING', 'ANNOUNCED'])
      .neq('id', ctx.tournamentId)
      .order('created_at', { ascending: true })
      .limit(60);
    /* Scope exactly as the cash path does. An unscoped hop nearly seated a
       player in a stranger's club once (PR #1702) and that rule holds here. */
    if (scopeClubIds.length > 0) q = q.in('club_id', scopeClubIds);

    const { data: boards, error } = await q;
    if (error) {
      reportError(error, 'QuickJoinSpins.board_read_failed', {
        tournamentId: ctx.tournamentId,
      });
      return null;
    }
    if (!boards || boards.length === 0) return null;

    /* One table read for every board, not one per board. `tables` carries the
       tournament_id, so the whole set comes back in a single round trip;
       resolveTournamentLiveTable would have been N sequential calls on the
       critical path of a button press. Oldest non-closed table per tournament,
       which is the same bias the engine's own primary-table election uses. */
    const ids = boards.map((b) => String(b.id));
    const { data: tbls, error: tblErr } = await supabase
      .from('tables')
      .select('id, tournament_id, current_players, max_players, created_at, status')
      .in('tournament_id', ids)
      .neq('status', 'closed')
      .order('created_at', { ascending: true });
    if (tblErr) {
      reportError(tblErr, 'QuickJoinSpins.board_tables_read_failed', {
        tournamentId: ctx.tournamentId,
      });
      return null;
    }

    const tableFor = new Map<string, { id: string; players: number; max: number }>();
    for (const row of tbls ?? []) {
      const tid = String(row.tournament_id);
      if (tableFor.has(tid)) continue; // oldest wins
      tableFor.set(tid, {
        id: String(row.id),
        players: Number(row.current_players) || 0,
        max: Number(row.max_players) || 0,
      });
    }

    const rows: SpinQuickJoinRow[] = [];
    for (const b of boards) {
      const live = tableFor.get(String(b.id));
      if (!live) continue; // a board with no table is not an offer
      if (openTableIds.has(live.id)) continue; // already in a tab
      const cost = Number(b.buy_in_amount) || 0;
      const sameStake = cost === ctx.buyIn;
      rows.push({
        id: live.id,
        name: String(b.name ?? 'Spin'),
        /* A spin has one price and no blinds a player picks between, so the
           stake IS the label. Rendering "0/0" here (the blind formatter's
           answer for a tournament) is how the sheet would look broken. */
        stakes: cost > 0 ? cost.toLocaleString() : '',
        players: live.players,
        max: live.max || Number(b.max_players) || 3,
        /* `tournamentFormat: 'spin'` is what makes this read SPIN rather than
           MTT — gameCode's tournament branch guesses MTT for an unresolved
           format, and every row here is a Spin by the query above. */
        code: gameCode({
          isTournament: true,
          tournamentFormat: 'spin',
          maxPlayers: live.max || Number(b.max_players) || 3,
        }),
        reason: sameStake ? 'Same Stake' : 'Spin',
        tier: sameStake ? 'same-stakes' : 'similar',
      });
    }
    if (rows.length === 0) return null;

    /* Same stake first, then the closest stake to the one being played — a
       player who just bought a 10 is far more likely to want another 10 than
       a 1,000. Deterministic tie-break on the table id so two presses of the
       same button cannot produce two different lists. */
    rows.sort((a, b) => {
      const aSame = a.tier === 'same-stakes' ? 0 : 1;
      const bSame = b.tier === 'same-stakes' ? 0 : 1;
      if (aSame !== bSame) return aSame - bSame;
      const an = Number(String(a.stakes).replace(/[^\d.]/g, '')) || 0;
      const bn = Number(String(b.stakes).replace(/[^\d.]/g, '')) || 0;
      const ad = Math.abs(an - ctx.buyIn);
      const bd = Math.abs(bn - ctx.buyIn);
      if (ad !== bd) return ad - bd;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    return rows.slice(0, SPIN_QUICK_JOIN_LIMIT);
  } catch (err) {
    reportError(err as Error, 'QuickJoinSpins.unexpected');
    return null;
  }
}
