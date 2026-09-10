/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  MTT PAYOUT, ELIMINATION AND FINISH — the money must survive a failed query
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * Two kinds of test, because the defects come in two kinds.
 *
 * BEHAVIOURAL, against computePlacePrize. It is import-free by design, so the
 * arithmetic can be pinned exactly rather than scanned for. The rule it must
 * hold, for ANY structure: every place except the last is its own rounded
 * percentage, the last paid place absorbs the residual, and the places sum to
 * the pool to the cent.
 *
 * SOURCE GUARDS, in the style of TournamentFixes.guard.test.ts, for the fixes
 * that live inside a supabase round-trip and cannot be reached without one.
 * Each guard names the defect it prevents so a future reader can decide
 * whether the rule still applies rather than deleting a test they do not
 * understand. If a fix here is deliberately superseded, delete the guard IN
 * THE SAME COMMIT and say why.
 *
 * THE ONE RULE UNDERNEATH ALL OF IT: an unreadable count, list or row is
 * UNKNOWN, never zero and never empty. Every guard below is one more place
 * where `?? []` or `|| 0` was quietly turning a database timeout into a
 * decision about somebody's money.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

import { computePlacePrize } from './payoutMath.js';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const ELIM = read('src/tournament/TournamentManagerEliminations.ts');
const RECOVERY = read('src/tournament/tournamentRecovery.ts');
const ATOMIC_ELIMINATION = read(
  '../supabase/migrations/20260908042000_bounty_elimination_outbox_is_atomic_and_recoverable.sql'
);
const migrationNames = fs
  .readdirSync(path.join(process.cwd(), '..', 'supabase', 'migrations'))
  .filter((name) => name.endsWith('.sql'));
const terminalSettlementName = migrationNames.find((name) =>
  name.includes('non_satellite_terminal_settlement_commits_one_stored_receipt')
);
if (!terminalSettlementName) {
  throw new Error('current tournament terminal settlement migration is missing');
}
const TERMINAL_SETTLEMENT = read(`../supabase/migrations/${terminalSettlementName}`);
const seatExitSettlementName = migrationNames.find((name) =>
  name.includes('tournament_seat_exits_stay_inside_tournament_authority')
);
if (!seatExitSettlementName) {
  throw new Error('current tournament seat-exit authority migration is missing');
}
const SEAT_EXIT_SETTLEMENT = read(`../supabase/migrations/${seatExitSettlementName}`);

/** Strip line and block comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

/** Isolate one PL/pgSQL definition so an assertion cannot pass on a sibling function. */
const sqlFunction = (src: string, name: string): string => {
  const start = src.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  if (start < 0) throw new Error(`SQL function ${name} is missing`);
  const body = src.slice(start).match(/\bAS\s+(\$[A-Za-z0-9_]*\$)/);
  if (!body || body.index == null) throw new Error(`SQL function ${name} has no body`);
  const tag = body[1];
  const bodyStart = start + body.index + body[0].length;
  const end = src.indexOf(`${tag};`, bodyStart);
  if (end < 0) throw new Error(`SQL function ${name} has no complete body`);
  return src.slice(start, end + tag.length + 1);
};

// The 9-place structure carried by 410 live tournaments, verbatim.
const NINE_PLACE = [
  { place: 1, percentage: 30 },
  { place: 2, percentage: 20 },
  { place: 3, percentage: 15 },
  { place: 4, percentage: 10 },
  { place: 5, percentage: 8 },
  { place: 6, percentage: 6 },
  { place: 7, percentage: 5 },
  { place: 8, percentage: 3.5 },
  { place: 9, percentage: 2.5 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** What every place, paid together, actually disburses. */
const totalPaid = (pool: number, payouts: Array<{ place?: number; percentage?: number }>) =>
  round2(payouts.reduce((sum, p) => sum + computePlacePrize(pool, payouts, Number(p.place)), 0));

describe('the places sum to the pool, whatever the structure', () => {
  it('pays 483.00 out of a 483.00 pool on the 9-place structure', () => {
    // The named defect: independently rounded places sum to 483.01 here — a
    // one-cent overpay on every such event, and a permanent false "overpaid"
    // from fn_tournament_payout_reconcile, which implements the residual rule.
    expect(totalPaid(483, NINE_PLACE)).toBe(483);
    // And the adjustment lands on the SMALLEST prize, never a headline one.
    expect(computePlacePrize(483, NINE_PLACE, 1)).toBe(144.9);
    expect(computePlacePrize(483, NINE_PLACE, 9)).toBe(12.07);
  });

  it('holds across a matrix of pools and structures', () => {
    const structures = [
      NINE_PLACE,
      [{ place: 1, percentage: 100 }],
      [
        { place: 1, percentage: 80 },
        { place: 2, percentage: 20 },
      ],
      [
        { place: 1, percentage: 80 },
        { place: 2, percentage: 12 },
        { place: 3, percentage: 8 },
      ],
      [
        { place: 1, percentage: 50 },
        { place: 2, percentage: 30 },
        { place: 3, percentage: 20 },
      ],
    ];
    for (const s of structures) {
      for (const pool of [0.03, 1, 7.77, 75, 100, 483, 1000.01, 12345.67]) {
        expect(totalPaid(pool, s), `${s.length} places on ${pool}`).toBe(round2(pool));
      }
    }
  });
});

describe('a malformed structure degrades, it never overpays', () => {
  it('a duplicate place entry does not shrink the last place', () => {
    // Defect: `find` paid the FIRST entry for a place once, while the residual
    // sum counted BOTH — so the last paid place lost a whole extra share and
    // the pool under-paid by that amount.
    const dupe = [
      { place: 1, percentage: 50 },
      { place: 1, percentage: 50 },
      { place: 2, percentage: 50 },
    ];
    expect(computePlacePrize(100, dupe, 1)).toBe(50);
    expect(computePlacePrize(100, dupe, 2)).toBe(50);
  });

  it('a non-numeric place does not switch the residual rule off', () => {
    // Defect: `lastPlace` was Math.max over Number(place), so one place that
    // does not coerce to a number made it NaN. `place !== NaN` is true for
    // EVERY place, so the residual branch became unreachable and every place —
    // including the last — was paid its own independently rounded percentage.
    // ('2nd' rather than null on purpose: Number(null) is 0, which still
    // coerces; a non-numeric string is what actually produces the NaN.)
    const junk = [...NINE_PLACE, { place: '2nd' as unknown as number, percentage: 0 }];
    const paid = round2(
      NINE_PLACE.reduce((sum, p) => sum + computePlacePrize(483, junk, p.place), 0)
    );
    // 483.01 under independent rounding; 483.00 once the residual rule is
    // reachable again. The 9-place structure is used deliberately — a
    // two-place structure happens to round to the pool either way, so it
    // cannot tell the two rules apart (an early sabotage run proved that).
    expect(paid).toBe(483);
    expect(computePlacePrize(483, junk, 9)).toBe(12.07);
  });

  it('a negative percentage never pays a negative prize, at any place', () => {
    const bad = [
      { place: 1, percentage: 120 },
      { place: 2, percentage: -20 },
    ];
    expect(computePlacePrize(100, bad, 1)).toBeGreaterThanOrEqual(0);
    expect(computePlacePrize(100, bad, 2)).toBeGreaterThanOrEqual(0);
    expect(totalPaid(100, bad)).toBeLessThanOrEqual(100);
  });

  it('an unpaid place, an empty structure and a dead pool all pay nothing', () => {
    expect(computePlacePrize(100, NINE_PLACE, 10)).toBe(0);
    expect(computePlacePrize(100, [], 1)).toBe(0);
    expect(computePlacePrize(0, NINE_PLACE, 1)).toBe(0);
    expect(computePlacePrize(-5, NINE_PLACE, 1)).toBe(0);
    expect(computePlacePrize(100, NINE_PLACE, NaN)).toBe(0);
  });
});

describe('every payout site shares the one rounding rule', () => {
  it('the late-reg prize recalc goes through computePlacePrize', () => {
    // Defect: recalculateEliminatedPrizes was a FOURTH independent formula —
    // `Math.round(((finalPrizePool * percentage) / 100) * 100) / 100` — so a
    // top-up disagreed with the payment it was adjusting, wrote its own number
    // into `prize`, and left the row permanently at odds with
    // fn_tournament_payout_reconcile.
    expect(code(ELIM)).toMatch(/computePlacePrize\(\s*ladderPool\s*,/);
    expect(code(ELIM)).not.toMatch(/finalPrizePool\s*\*\s*payoutEntry\.percentage/);
  });

  it('and resolves the structure the same way the live payout sites do', () => {
    // A bare JSON.parse of the cached column cannot rebuild a Spin's split
    // from its multiplier, so the top-up used a different structure than the
    // payment.
    expect(code(ELIM)).toMatch(/resolvePayoutStructure\(\s*this\.tournamentCache/);
    // STRONGER 2026-08-27: and it must resolve with the FIELD SIZE, like every
    // other payout site, or the top-up would price a short field by a
    // structure that still contains the place nobody reached.
    // The count may be awaited first so an unreadable final field can fail
    // closed before payout resolution; pin the data flow, not one expression
    // shape.
    expect(code(ELIM)).toMatch(/const\s+finalField\s*=\s*await\s+this\.finalFieldSize\(\)/);
    expect(code(ELIM)).toMatch(
      /resolvePayoutStructure\(\s*this\.tournamentCache(?:\s+as\s+any)?\s*,\s*finalField\s*\)/
    );
  });

  it('every payout site trims the structure to the field it can actually fill', () => {
    /**
     * SHORT-FIELD RESIDUAL 2026-08-27. computePlacePrize gives the LAST place
     * the leftover. With fewer entrants than the structure pays, that place has
     * no finisher and the leftover was never awarded: 250.00 of a 10,000.00
     * pool on one event, eight events in thirty days, and a
     * no_finisher_recorded critical on each that the reconciler will not
     * resolve on its own.
     *
     * All four sites must pass a field size, or the ones that do not would pay
     * a different structure from the ones that do - the exact "two formulas
     * for one number" defect the rest of this file exists to prevent.
     */
    const src = code(ELIM);
    const resolves = src.match(/resolvePayoutStructure\(/g) ?? [];
    const withField = src.match(/resolvePayoutStructure\([\s\S]{0,140}?[Ff]ield/g) ?? [];
    expect(resolves.length).toBeGreaterThan(0);
    expect(withField.length).toBe(resolves.length);
  });

  it('the field size is everyone who entered, and only once entry is closed', () => {
    /**
     * The two rules that make trimming safe, because trimming is the direction
     * that OVERPAYS: a field size that is too small promotes an earlier place
     * to residual holder.
     *
     *   - undefined until prize_pool_finalized, because late registration can
     *     still grow the field;
     *   - counted from tournament_players, never from a live seat counter like
     *     current_players, which drains toward 1 as players bust.
     */
    const src = code(ELIM);
    expect(src).toMatch(/if\s*\(!this\.prizePoolFinalized\)\s*return undefined;/);
    expect(src).toMatch(/from\('tournament_players'\)[\s\S]{0,160}count: 'exact'/);
    expect(src).not.toMatch(/finalFieldSize[\s\S]{0,400}current_players/);
  });
});

describe('a failed query must never read as "nobody is left" - the money paths', () => {
  it('the engine has no cancellation refund or close fallback to misread a list', () => {
    // Cancellation moved completely into the database transaction authority.
    // Keeping the former TypeScript helper, even unused, would preserve a
    // second partial refund/close implementation that a future caller could
    // reconnect. Recovery may resolve COMPLETING receipts only; it never
    // cancels a tournament or writes cancellation money/state itself.
    const recovery = code(RECOVERY);
    expect(recovery).not.toMatch(/refundAndCloseCancelledTournament/);
    expect(recovery).not.toMatch(/atomic_cancel_tournament/);
    expect(recovery).not.toMatch(/cancel_refund_/);
    expect(recovery).not.toMatch(/\.update\(\{\s*status:\s*['"]CANCELLED['"]/);
    expect(recovery).not.toMatch(/\.from\(['"]tournament_players['"]\)[\s\S]{0,180}?\.delete\(/);
  });

  it('the stuck-COMPLETING rescue refuses to complete a field it could not read', () => {
    // Defect: `players ?? []` paid nobody and then flipped COMPLETING ->
    // COMPLETED anyway. Terminal: this watchdog only looks at COMPLETING, so
    // the tournament it just emptied can never be rescued again.
    const recovery = sliceMethod(
      code(RECOVERY),
      'export async function recoverStuckCompletingTournaments('
    );
    const readField = recovery.indexOf('const field = await readRecoveryField(tournament.id)');
    const refusal = recovery.indexOf('if (!field.rows || field.rows.length < 1)', readField);
    const receipt = recovery.indexOf('requestTournamentTerminalReceipt(', refusal);
    expect(code(RECOVERY)).toMatch(
      /return \{ rows: !error && Array\.isArray\(data\) \? \(data as RecoveryPlayer\[\]\) : null, error \}/
    );
    expect(readField).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThan(readField);
    expect(receipt).toBeGreaterThan(refusal);
    expect(recovery.slice(refusal, receipt)).toMatch(/field_unreadable[\s\S]*?continue;/);
  });

  it('and an unreadable COMPLETING scan is not an empty one', () => {
    expect(code(RECOVERY)).toMatch(/recoverStuckCompleting_scan_failed/);
    expect(code(RECOVERY)).not.toMatch(/const\s*\{\s*data:\s*stuck\s*\}\s*=/);
  });

  it('an unreadable bust list skips the sweep instead of finishing the tournament', () => {
    // Defect: the error was discarded, so a failed read looked like "nobody
    // busted" and the sweep fell straight through to the finish check.
    expect(code(ELIM)).toMatch(
      /if\s*\(\s*bustedErr\s*\)\s*\{[\s\S]{0,600}?busted_list_unavailable[\s\S]{0,120}?\n\s*return;/
    );
  });

  it('an unreadable count does not burst the bubble', () => {
    // Defect: `(playingNow || 0) <= payoutCount` — a timeout read as zero
    // players left, cancelled hand-for-hand and resumed every engine while the
    // field was still one elimination from the money.
    expect(code(ELIM)).toMatch(/hand_for_hand_count_unavailable/);
    expect(code(ELIM)).not.toMatch(/\(\s*playingNow\s*\|\|\s*0\s*\)/);
  });

  it('an unreadable tournament row is not a prize of zero', () => {
    // Defect: `if (tournament)` skipped the prize calculation, so the player
    // was stamped eliminated / position N / prize 0 and the early-return guard
    // at the top of eliminatePlayer meant nothing ever revisited it.
    expect(code(ELIM)).not.toMatch(/const\s*\{\s*data:\s*tournament\s*\}\s*=/);
    // Reached, not merely present.
    expect(code(ELIM)).toMatch(
      /if\s*\(\s*tournamentErr\s*\|\|\s*!tournament\s*\)\s*\{[\s\S]{0,600}?elimination_tournament_unreadable/
    );
  });
});

describe('a tournament that cannot be paid is left where the watchdog can find it', () => {
  it('finishTournament does not mark COMPLETED when it could not load the tournament', () => {
    // Defect: it wrote COMPLETED with NO CAS guard while stating it was paying
    // nobody. recoverStuckCompletingTournaments only looks at COMPLETING, so
    // that write put the event permanently beyond the one mechanism built to
    // rescue it.
    const finish = sliceMethod(code(ELIM), 'finishTournament(winnerId: string): Promise<void>');
    const branch = finish.slice(
      finish.indexOf('if (!tournament)'),
      finish.indexOf('const isSatelliteFinish')
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).not.toMatch(/COMPLETED/);
    expect(branch).not.toMatch(/requestTournamentTerminalReceipt|processSatelliteAwards/);
    expect(branch).toMatch(/finish_identity_unavailable[\s\S]*?return;/);
  });
});

describe('finishing places must be distinct - in the rescue path too', () => {
  it('the rescue refuses to hand a survivor a place an eliminated player already holds', () => {
    // Defect: survivors were given 1..N with no regard for the places already
    // recorded. The wallet key `tourney:{id}:prize:{user}:{place}` dedupes a
    // repeated USER, not a repeated PLACE, so both holders are paid in full.
    // Identical shape to the Math.max(2, ...) clamp that cost 11 tournaments
    // 12 extra payments.
    const recovery = sliceMethod(
      code(RECOVERY),
      'export async function recoverStuckCompletingTournaments('
    );
    expect(recovery).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
    expect(recovery).toMatch(/recovery will not invent a multi-player finish from stacks/);
  });

  it('proves one durable winner witness before asking the terminal authority', () => {
    const recovery = sliceMethod(
      code(RECOVERY),
      'export async function recoverStuckCompletingTournaments('
    );
    const winner = recovery.indexOf(
      'winnerId = live.length === 1 ? live[0].user_id : canonicalWinner(rows)'
    );
    const refusal = recovery.indexOf('if (!winnerId)', winner);
    const settlement = recovery.indexOf('requestTournamentTerminalReceipt(', refusal);
    const ranker = code(RECOVERY).slice(
      code(RECOVERY).indexOf('function canonicalWinner('),
      code(RECOVERY).indexOf('async function readRecoveryField(')
    );
    expect(ranker).toMatch(/if \(winners\.length > 1\) return null/);
    expect(ranker).toMatch(/eliminated\.length !== rows\.length/);
    expect(ranker).toMatch(
      /new Set\(sequenced\.map\(\(\{ sequence \}\) => sequence\)\)\.size !== sequenced\.length/
    );
    expect(winner).toBeGreaterThanOrEqual(0);
    expect(refusal).toBeGreaterThan(winner);
    expect(settlement).toBeGreaterThan(refusal);
  });
});

/**
 * A BUSTED PLAYER IS ALWAYS ELIMINATED (2026-08-28).
 *
 * Union PKO Afternoon (PLO4) 4f42d847 hung heads-up for hours: 39 entrants,
 * places 2..38 gapless and collision-free, place 39 never used, and the last
 * busted player left `status='playing'` at 0 chips because the walk down the
 * ladder found nothing free and `break`-ed. `remainingCount` can then never
 * reach 1, so finishTournament is unreachable and the event never closes —
 * blinds escalating, table dead, champion uncrowned, first prize unpaid.
 *
 * The ladder was one place short from the very first bust because it was
 * seeded off a live `playing` count, which can miss an entrant whose atomic
 * late-registration transaction has not yet become visible to that snapshot.
 */
describe('the finishing ladder cannot drift, and cannot strand a busted player', () => {
  it('seeds the ladder from players who hold no place yet, not from a live playing count', () => {
    // `playingCount` misses `registered` entrants, so it drifts SHORT and the
    // shortfall is only discovered when the last player has nowhere to go.
    // Unplaced = still in contention + busting now, registered included.
    expect(code(ELIM)).toMatch(/\.is\('position', null\)/);
    expect(code(ELIM)).toMatch(
      /nextPosition\s*=\s*Math\.max\(\s*unplacedCount\s*,\s*playingCount\s*,\s*bustedOrdered\.length \+ 1\s*\)/
    );
  });

  it('an unreadable unplaced count defers the eliminations instead of guessing', () => {
    expect(code(ELIM)).toMatch(
      /if\s*\(\s*unplacedErr[\s\S]{0,500}?unplaced_count_unavailable[\s\S]{0,120}?\n\s*return;/
    );
  });

  it('an unreadable taken-places list is UNKNOWN, not "every place is free"', () => {
    // `takenRows || []` meant a failed read handed out a place that may
    // already have been paid — the exact collision this block exists to stop.
    expect(code(ELIM)).not.toMatch(/\(\s*takenRows\s*\|\|\s*\[\]\s*\)/);
    expect(code(ELIM)).toMatch(
      /if\s*\(\s*takenErr\s*\|\|\s*!takenRows\s*\)\s*\{[\s\S]{0,400}?taken_places_unavailable[\s\S]{0,120}?\n\s*return;/
    );
  });

  it('never abandons a busted player when the ladder is exhausted downward', () => {
    // THE DEADLOCK. Leaving a 0-chip player `playing` makes finishTournament
    // unreachable for the life of the process. A mislabelled place is a
    // bookkeeping error; refusing to eliminate strands the whole field's money.
    expect(code(ELIM)).toMatch(/finishing_ladder_exhausted/);
    // The up-walk must actually place the player, not just log.
    expect(code(ELIM)).toMatch(/place\s*=\s*up;/);
  });

  it('still hands out strictly decreasing, distinct places in the normal case', () => {
    expect(code(ELIM)).toMatch(/while\s*\(place >= 2 && takenPositions\.has\(place\)\) place--;/);
    expect(code(ELIM)).toMatch(/takenPositions\.add\(place\);/);
    expect(code(ELIM)).toMatch(/nextPosition = Math\.min\(nextPosition, place\) - 1;/);
  });
});

describe('a write that decides a payout is checked', () => {
  it('the elimination status write asks for a row count, so its CAS can actually fire', () => {
    // The status, prize, payment and seat release now share one database
    // transaction. Its exact row-count CAS raises, so every earlier write in
    // that same RPC rolls back on a race.
    expect(code(ELIM)).toContain("'fn_eliminate_tournament_player_atomic'");
    expect(ATOMIC_ELIMINATION).toMatch(
      /UPDATE public\.tournament_players[\s\S]*?GET DIAGNOSTICS v_changed=ROW_COUNT;[\s\S]*?IF v_changed <> 1 THEN[\s\S]*?RAISE EXCEPTION/
    );
    expect(code(ELIM)).toMatch(/atomic elimination FAILED/);
  });

  it('the terminal transaction proves exactly one durable winner on both cash modes', () => {
    const terminal = sqlFunction(TERMINAL_SETTLEMENT, 'fn_complete_tournament_terminal(');
    const count = terminal.indexOf('SELECT count(*) INTO v_winner_count');
    const identity = terminal.indexOf('INTO v_winner_id', count);
    const refusal = terminal.indexOf('IF v_winner_count <> 1 OR v_winner_id IS NULL', identity);
    const candidate = terminal.indexOf(
      'v_winner_id IS DISTINCT FROM p_observed_winner_id',
      refusal
    );
    expect(count).toBeGreaterThanOrEqual(0);
    expect(identity).toBeGreaterThan(count);
    expect(refusal).toBeGreaterThan(identity);
    expect(candidate).toBeGreaterThan(refusal);
  });

  it('the final-table-deal domain transaction owns every payment and COMPLETED together', () => {
    const atomic = sqlFunction(TERMINAL_SETTLEMENT, 'fn_complete_tournament_terminal(');
    const rootLock = atomic.indexOf('pg_advisory_xact_lock(');
    const replay = atomic.indexOf('RETURN public.fn_ca_tournament_terminal_receipt(', rootLock);
    const deal = atomic.indexOf('public.fn_settle_tournament_final_table_deal(', replay);
    const bounty = atomic.indexOf('public.fn_finalize_bounty_pool(', deal);
    const rake = atomic.indexOf('public.fn_settle_tournament_rake(', deal);
    const seatClose = atomic.indexOf('UPDATE public.table_seats', Math.max(bounty, rake));
    const complete = atomic.indexOf("SET status = 'COMPLETED'", seatClose);
    const tableClose = atomic.indexOf('UPDATE public.tables', complete);
    const receipt = atomic.indexOf(
      'INSERT INTO public.tournament_terminal_settlements',
      tableClose
    );

    expect(rootLock).toBeGreaterThanOrEqual(0);
    expect(replay).toBeGreaterThan(rootLock);
    expect(deal).toBeGreaterThan(replay);
    expect(bounty).toBeGreaterThan(deal);
    expect(rake).toBeGreaterThan(deal);
    expect(seatClose).toBeGreaterThan(Math.max(bounty, rake));
    expect(complete).toBeGreaterThan(seatClose);
    expect(tableClose).toBeGreaterThan(complete);
    expect(receipt).toBeGreaterThan(tableClose);
    expect(atomic).not.toMatch(/EXCEPTION WHEN OTHERS/);
  });

  it('COMPLETED and its immutable receipt are one database transaction', () => {
    const terminal = sqlFunction(TERMINAL_SETTLEMENT, 'fn_complete_tournament_terminal(');
    const complete = terminal.indexOf("SET status = 'COMPLETED'");
    const receipt = terminal.indexOf(
      'INSERT INTO public.tournament_terminal_settlements',
      complete
    );
    const returned = terminal.indexOf('RETURN public.fn_ca_tournament_terminal_receipt(', receipt);
    expect(complete).toBeGreaterThanOrEqual(0);
    expect(receipt).toBeGreaterThan(complete);
    expect(returned).toBeGreaterThan(receipt);
    expect(code(ELIM)).not.toMatch(/certifyTournamentFinish|status:\s*'COMPLETED'/);
    expect(code(RECOVERY)).not.toMatch(/certifyTournamentFinish|status:\s*'COMPLETED'/);
  });

  it('a final-table deal requires atomic completion proof before its runtime tail', () => {
    // The former server loop could pay some shares, fail another, and still
    // write COMPLETED. The database RPC now owns shares + standings + terminal
    // state, and the server refuses to continue on ok:true without completed.
    const deal = sliceMethod(code(ELIM), 'private async completeFinalTableDealAtBoundary(');
    const request = deal.indexOf('requestTournamentTerminalReceipt(');
    const shape = deal.indexOf('const payoutShapeIsExact', request);
    const committed = deal.indexOf('this.committedFinalTableDealReceipt = receipt', shape);
    const tail = deal.indexOf('return this.settleFinalTableDeal(receipt)', committed);

    expect(request).toBeGreaterThanOrEqual(0);
    expect(deal).toMatch(/'final_table_deal',[\s\S]*?null/);
    expect(shape).toBeGreaterThan(request);
    expect(committed).toBeGreaterThan(shape);
    expect(tail).toBeGreaterThan(committed);
  });

  it('the rescue only claims success after the atomic settlement proves completion', () => {
    const recovery = sliceMethod(
      code(RECOVERY),
      'export async function recoverStuckCompletingTournaments('
    );
    const request = recovery.indexOf('await requestTournamentTerminalReceipt(');
    const success = recovery.indexOf('[GameServer] Recovered tournament', request);
    const refusal = recovery.indexOf('error instanceof TerminalSettlementRefusedError', success);
    const unknown = recovery.indexOf('reportUnknownRecoveryOutcome(', refusal);

    expect(request).toBeGreaterThanOrEqual(0);
    expect(success).toBeGreaterThan(request);
    expect(refusal).toBeGreaterThan(success);
    expect(unknown).toBeGreaterThan(refusal);
    expect(recovery).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
});

describe('one player, one stack', () => {
  it('the accepted hand mirrors the exact player roster before it commits', () => {
    const stacks = sqlFunction(TERMINAL_SETTLEMENT, 'fn_ca_settle_hand_stacks_absolute');
    expect(stacks).toMatch(
      /UPDATE public\.tournament_players tp[\s\S]*?tp\.tournament_id = v_tournament_id[\s\S]*?tp\.user_id = target\.user_id[\s\S]*?tp\.status::text = 'playing'/
    );
    expect(stacks).toContain('tournament % hand % did not durably sync every final seat stack');
  });

  it('has no delayed chip snapshot writer left in runtime or schema', () => {
    expect(code(ELIM)).not.toMatch(/fn_sync_tournament_(?:live_seat_)?chips/);
    expect(SEAT_EXIT_SETTLEMENT).toContain(
      'DROP FUNCTION public.fn_sync_tournament_live_seat_chips(uuid) RESTRICT;'
    );
    expect(SEAT_EXIT_SETTLEMENT).toContain(
      'DROP FUNCTION public.fn_sync_tournament_chips(uuid,jsonb) RESTRICT;'
    );
  });

  it('a failed roster read stops the sweep rather than guessing that nobody busted', () => {
    // The accepted-hand transaction is now the only seat-to-roster writer.
    // An unreadable roster is still UNKNOWN and must stop this sweep before
    // any placement, payout, or terminal decision.
    expect(code(ELIM)).toMatch(
      /if\s*\(bustedErr\)\s*\{[\s\S]{0,700}?busted_list_unavailable[\s\S]*?return;/
    );
  });

  it('reads the already-committed roster once instead of reconstructing it from seats', () => {
    const sweep = sliceMethod(code(ELIM), 'private async runEliminationSweep(');
    expect(sweep).toContain(".from('tournament_players')");
    expect(sweep).toContain(".eq('tournament_id', this.tournamentId)");
    expect(sweep).not.toMatch(/\.from\(['"]table_seats['"]\)|tables!inner/);
  });
});

describe('no second, unused money path', () => {
  it('creditBountyToWallet is gone', () => {
    // It had zero callers across all of server/src — fn_collect_bounty
    // replaced it on 2026-08-15. Left in place it was a live hazard: it
    // credits `tourney:{id}:bounty:{e}:{k}` on its own, outside the funded
    // pool's cap and outside its tournament_bounties accounting.
    expect(code(ELIM)).not.toMatch(/creditBountyToWallet/);
  });
});
