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

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const ELIM = read('src/tournament/TournamentManagerEliminations.ts');
const RECOVERY = read('src/tournament/tournamentRecovery.ts');

/** Strip line and block comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

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
    expect(code(ELIM)).toMatch(/computePlacePrize\(\s*finalPrizePool\s*,/);
    expect(code(ELIM)).not.toMatch(/finalPrizePool\s*\*\s*payoutEntry\.percentage/);
  });

  it('and resolves the structure the same way the live payout sites do', () => {
    // A bare JSON.parse of the cached column cannot rebuild a Spin's split
    // from its multiplier, so the top-up used a different structure than the
    // payment.
    expect(code(ELIM)).toMatch(/resolvePayoutStructure\(this\.tournamentCache/);
  });
});

describe('a failed query must never read as "nobody is left" — the money paths', () => {
  it('a cancelled tournament with an unreadable registration list refunds nobody AND closes nobody', () => {
    // Defect: `openRows ?? []` made an unreadable list an empty one. The
    // refund loop found nothing, then the code below closed every
    // 'playing'/'registered' row and the tables — destroying every entrant's
    // buy-in, rebuys and add-ons, and leaving no candidates for a retry.
    expect(code(RECOVERY)).toMatch(/cancel_refund_open_rows_unreadable/);
    expect(code(RECOVERY)).not.toMatch(/const\s*\{\s*data:\s*openRows\s*\}\s*=/);
    // The branch must be REACHED, not merely present: an early sabotage run
    // replaced `if (openRowsErr)` with `if (false)` and every string-matching
    // assertion above still passed.
    expect(code(RECOVERY)).toMatch(/if\s*\(\s*openRowsErr\s*\)\s*\{[\s\S]{0,600}?\n\s*return;/);
  });

  it('the stuck-COMPLETING rescue refuses to complete a field it could not read', () => {
    // Defect: `players ?? []` paid nobody and then flipped COMPLETING ->
    // COMPLETED anyway. Terminal: this watchdog only looks at COMPLETING, so
    // the tournament it just emptied can never be rescued again.
    expect(code(RECOVERY)).not.toMatch(/const\s*\{\s*data:\s*players\s*\}\s*=/);
    // Reached, not merely present — `if (false) { throw ... }` passed a
    // string-only assertion during the sabotage run.
    expect(code(RECOVERY)).toMatch(
      /if\s*\(\s*playersErr\s*\)\s*\{[\s\S]{0,400}?refusing to complete a tournament we cannot pay/
    );
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
    const branch = code(ELIM).slice(
      code(ELIM).indexOf('if (!tournament || tourneyLoadErr)'),
      code(ELIM).indexOf('const isSatelliteFinish')
    );
    expect(branch.length).toBeGreaterThan(0);
    expect(branch).not.toMatch(/COMPLETED/);
    expect(code(ELIM)).toMatch(/left in COMPLETING for recoverStuckCompletingTournaments/);
  });
});

describe('finishing places must be distinct — in the rescue path too', () => {
  it('the rescue refuses to hand a survivor a place an eliminated player already holds', () => {
    // Defect: survivors were given 1..N with no regard for the places already
    // recorded. The wallet key `tourney:{id}:prize:{user}:{place}` dedupes a
    // repeated USER, not a repeated PLACE, so both holders are paid in full.
    // Identical shape to the Math.max(2, ...) clamp that cost 11 tournaments
    // 12 extra payments.
    expect(code(RECOVERY)).toMatch(/recoverStuckCompleting_position_collision/);
  });
});

describe('a write that decides a payout is checked', () => {
  it('the elimination status write asks for a row count, so its CAS can actually fire', () => {
    // Defect: PostgREST only returns a count when asked. `updateCount` was
    // always null, so the `updateCount === 0` half of the guard was dead code.
    expect(code(ELIM)).toMatch(/\{\s*count:\s*'exact'\s*\}\s*\)\s*\n?\s*\.eq\('tournament_id'/);
    expect(code(ELIM)).toMatch(/elimination_write_failed/);
  });

  it('the winner row stamp is checked on both finish paths', () => {
    expect(code(ELIM)).toMatch(/winner_row_stamp_failed/);
    expect(code(ELIM)).toMatch(/final_table_deal_winner_stamp_failed/);
  });

  it('a settled final-table deal that stays COMPLETING is reported, not swallowed', () => {
    // A dealt event left in COMPLETING is picked up by the recovery watchdog,
    // which pays from the PAYOUT STRUCTURE — the one thing a deal must never
    // be re-paid from.
    expect(code(ELIM)).toMatch(/final_table_deal_completed_transition_failed/);
  });

  it('the rescue only claims to have recovered a tournament it actually completed', () => {
    expect(code(RECOVERY)).toMatch(/could not mark COMPLETED/);
  });
});

describe('one player, one stack', () => {
  it('the chip sync keys on the player, not on the seat', () => {
    // Defect: one entry pushed per SEAT. A table move that writes the
    // destination seat without stamping left_at on the source leaves a player
    // holding two open seats. Measured on production 2026-08-25, one running
    // MTT: 502 open seats across 376 players, 108 holding more than one,
    // double-counting 1,461,180 chips. Postgres resolves
    // `UPDATE ... FROM jsonb_to_recordset` against duplicate keys by picking an
    // ARBITRARY row, so fn_sync_tournament_chips could overwrite a live stack
    // with a dead one — and a dead seat's stack is usually 0, which is exactly
    // what the bust sweep eliminates players for.
    expect(code(ELIM)).not.toMatch(/chipUpdates\.push\(\{\s*user_id:\s*seat\.user_id/);
    expect(code(ELIM)).toMatch(/bestSeat/);
    expect(code(ELIM)).toMatch(/joined_at/);
  });

  it('two live seats with no usable joined_at is UNKNOWN, not a guess', () => {
    expect(code(ELIM)).toMatch(/ambiguous_live_seat/);
  });

  it('a failed seat read stops the sweep rather than busting on a partial picture', () => {
    // Defect: `if (seats)` skipped a table whose read failed exactly as if it
    // had no seats, and the sweep went on to decide who was out.
    // Reached, not merely present.
    expect(code(ELIM)).toMatch(
      /if\s*\(\s*seatsErr\s*\)\s*\{[\s\S]{0,600}?seat_read_failed[\s\S]{0,120}?\n\s*return;/
    );
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
