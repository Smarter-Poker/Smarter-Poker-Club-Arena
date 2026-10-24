import { supabase } from '../lib/supabase';
import type { TournamentResult } from './pendingSessionSummary';
import { MysteryBountyService, playerTotalsFromAwards } from './MysteryBountyService';
import { readMySatelliteQualifierResult } from './satelliteQualifierResult';
import { getTournamentFormatKind } from '../utils/tournamentPresentation';
import { reportError } from '../utils/errorReporter';

export interface TournamentResultRead extends TournamentResult {
  /** A failed or absent read never proves that an entrant finished. */
  entryStatus?: string | null;
}

export async function fetchTournamentResult(
  tournamentId: string,
  userId: string
): Promise<TournamentResultRead> {
  const empty: TournamentResultRead = {
    tournamentId,
    userId,
    finishPlace: null,
    entrants: null,
    prize: 0,
    bountyWinnings: 0,
    knockouts: 0,
    rebuys: 0,
    addOns: 0,
    isSpin: false,
  };

  try {
    /* AUDIT 2026-08-20 — entrants is COUNTED, not read off the tournament row.

       `tournaments.current_players` is an entry counter incremented on register
       and decremented only on UNregister; no elimination path touches it. It is
       close to the field size and drifts from it, which is why TournamentClock
       already stopped trusting it ("the clock showed the starting field for the
       whole tournament"). Counting tournament_players is the same source the
       clock uses, so the two agree, and it stays right for re-entry events.
       current_players remains the fallback if the count cannot be read. */
    /* A FAILED READ MAY NOT BE REPORTED AS A PRIZE OF ZERO (2026-08-28 audit).
       These three destructured `data`/`count` and discarded `error`. This
       function's own header promises that "on any failure it returns a result
       with nulls, so the summary shows '—' … rather than falling back to a
       chip panel that would be actively wrong" — but that only held for the
       outer catch, which a Supabase query-level error never reaches (it
       RESOLVES with `{data: null, error}`). So winning a 100x Spin and hitting
       a transient error on the entry read told the player they finished
       nowhere and won 0, with the Spin branding stripped off the card too.
       Throwing hands the failure to the outer catch, which already returns
       the honest all-nulls result. */
    const [entryRes, tourneyRes, countRes] = await Promise.all([
      supabase
        .from('tournament_players')
        .select(
          'position, prize, bounty_winnings, bounties_collected, rebuys, add_on, status, elimination_sequence'
        )
        .eq('tournament_id', tournamentId)
        .eq('user_id', userId)
        .maybeSingle(),
      supabase
        .from('tournaments')
        /* format_contract identifies a known settled format. Unmarked historical
           rows keep their results without claiming a Spin format.

           is_mystery_bounty gates the second read below, so an ordinary
           freezeout makes no extra RPC calls on the way out of the table. */
        .select(
          'format_contract, name, current_players, variant, tournament_type, is_mystery_bounty, buy_in_amount, buy_in_fee'
        )
        .eq('id', tournamentId)
        .maybeSingle(),
      supabase
        .from('tournament_players')
        .select('user_id', { count: 'exact', head: true })
        .eq('tournament_id', tournamentId),
    ]);

    if (entryRes.error) throw entryRes.error;
    if (tourneyRes.error) throw tourneyRes.error;
    if (countRes.error) throw countRes.error;
    const entry = entryRes.data;
    const tourney = tourneyRes.data;
    const entryCount = countRes.count;

    /* MYSTERY BOUNTY (sections 43, 44). The chest half of what this player won,
       from the RPCs - `tournament_bounty_awards` has RLS on with no select
       policy, so reading the table directly returns nothing and no error. */
    let mystery: { bounties: number; cents: number; largestCents: number } | null = null;
    if ((tourney as { is_mystery_bounty?: boolean } | null)?.is_mystery_bounty) {
      const [board, awards] = await Promise.all([
        MysteryBountyService.getLeaderboard(tournamentId),
        MysteryBountyService.getAllAwards(tournamentId),
      ]);
      const boardRow = board.find((r) => r.userId === userId);
      const fromAwards = playerTotalsFromAwards(awards.rows).get(userId);
      const bounties = boardRow?.bountiesWon ?? fromAwards?.bountiesWon ?? 0;
      const cents = boardRow?.earningsCents ?? fromAwards?.earningsCents ?? 0;
      if (bounties > 0 || cents > 0) {
        mystery = { bounties, cents, largestCents: fromAwards?.largestCents ?? 0 };
      }
    }

    const qualification =
      entry?.status === 'winner' && entry.position === null
        ? await readMySatelliteQualifierResult(tournamentId, userId)
        : null;
    return {
      satelliteQualification: qualification?.qualified
        ? {
            targetId: qualification.targetId,
            deliveryKind: qualification.deliveryKind as 'seat' | 'ticket' | 'cash',
            amount: qualification.amount,
          }
        : undefined,
      name: tourney?.name || undefined,
      entryStatus: entry?.status ?? null,
      finishSequence:
        entry?.elimination_sequence == null ? undefined : String(entry.elimination_sequence),
      tournamentId,
      userId,
      buyInAmount: tourney
        ? Number(tourney.buy_in_amount ?? 0) + Number(tourney.buy_in_fee ?? 0)
        : undefined,
      finishPlace: entry?.position ?? null,
      entrants: entryCount ?? tourney?.current_players ?? null,
      prize: Number(entry?.prize) || 0,
      bountyWinnings: Number(entry?.bounty_winnings) || 0,
      knockouts: Number(entry?.bounties_collected) || 0,
      mysteryBounties: mystery?.bounties,
      mysteryBountyCents: mystery?.cents,
      largestMysteryBountyCents: mystery?.largestCents,
      rebuys: Number(entry?.rebuys) || 0,
      // add_on is a count on some rows and a boolean on older ones; both mean
      // "how many add-ons", so coerce rather than trusting the column type.
      addOns:
        typeof entry?.add_on === 'boolean' ? (entry.add_on ? 1 : 0) : Number(entry?.add_on) || 0,
      isSpin: getTournamentFormatKind(tourney) === 'spin',
    };
  } catch (err) {
    reportError(err, 'TablePage.fetchTournamentResult');
    return empty;
  }
}

/** Final results are recoverable during an ongoing event only after this
 * entrant has finished and cannot still buy back into it. */
export function canRestoreFinishedTournamentReport(input: {
  entryStatus?: unknown;
  tournamentStatus?: unknown;
  prizePoolFinalized?: unknown;
  isRebuy?: unknown;
  isReentry?: unknown;
}): boolean {
  if (!['RUNNING', 'COMPLETED'].includes(String(input.tournamentStatus))) return false;
  if (!['eliminated', 'winner'].includes(String(input.entryStatus))) return false;
  // Winner payout/completion keeps its existing committed-event boundary.
  if (input.entryStatus === 'winner' && input.tournamentStatus !== 'COMPLETED') return false;
  return (
    input.tournamentStatus === 'COMPLETED' ||
    input.prizePoolFinalized === true ||
    (input.isRebuy === false && input.isReentry === false)
  );
}
