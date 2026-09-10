/**
 * REGRESSION GUARDS — every tournament fix that has been silently reverted,
 * or could be.
 *
 * WHY THIS FILE EXISTS
 *
 * Twice in one day a live fix disappeared without anyone noticing, and both
 * times the cause was identical: a commit built by copying a whole file from
 * a working copy that was behind origin/main. The rewrite carried no conflict,
 * the build was green, the deploy succeeded, and the fix was simply gone.
 *
 *   - runUnionEcoRecord was clobbered by a stale copy of
 *     RakebackSettlerService.
 *   - tryTournamentAddOns was clobbered by a stale copy of
 *     TournamentManagerBase, putting add-ons back to NEVER executing - the
 *     state they had been in for the entire life of the platform.
 *
 * A green deploy does not mean your code is in it. These tests are the thing
 * that does mean it: `npm test` runs inside auto-deploy-hetzner.yml BEFORE it
 * builds or ships anything, so a revert now fails the deploy instead of
 * vanishing quietly.
 *
 * Each guard names the defect it prevents, so a future reader can decide
 * whether the rule still applies rather than deleting a test they do not
 * understand. If a fix here is deliberately superseded, delete the guard IN
 * THE SAME COMMIT and say why.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { sliceMethod, sliceCall, sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const ELIM = read('src/tournament/TournamentManagerEliminations.ts');
const BASE = read('src/tournament/TournamentManagerBase.ts');
const SETTLER = read('src/services/RakebackSettlerService.ts');
const PAYOUT_MATH = read('src/tournament/payoutMath.ts');
const RECOVERY = read('src/tournament/tournamentRecovery.ts');
const MANAGER = read('src/tournament/TournamentManager.ts');
const SEAT_ASSIGNMENT_RPC = read('src/tournament/tournamentSeatAssignmentRpc.ts');
const SEAT_MOVE_RPC = read('src/tournament/tournamentSeatMoveRpc.ts');
const PLACE_SETTLEMENT_MIGRATION_NAME = fs
  .readdirSync(path.join(process.cwd(), '..', 'supabase', 'migrations'))
  .find((name) => name.includes('tournament_cash_settlement_has_one_atomic_authority'));
if (!PLACE_SETTLEMENT_MIGRATION_NAME)
  throw new Error('current atomic cash settlement migration is missing');
const PLACE_SETTLEMENT_MIGRATION = read(
  `../supabase/migrations/${PLACE_SETTLEMENT_MIGRATION_NAME}`
);
const TERMINAL_SETTLEMENT_MIGRATION_NAME = fs
  .readdirSync(path.join(process.cwd(), '..', 'supabase', 'migrations'))
  .find((name) => name.includes('non_satellite_terminal_settlement_commits_one_stored_receipt'));
if (!TERMINAL_SETTLEMENT_MIGRATION_NAME)
  throw new Error('current terminal settlement migration is missing');
const TERMINAL_SETTLEMENT_MIGRATION = read(
  `../supabase/migrations/${TERMINAL_SETTLEMENT_MIGRATION_NAME}`
);

/** Strip line and block comments so a guard cannot pass on a mention in prose. */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

describe('a failed query must never read as "nobody is left"', () => {
  it('the finish check treats an unreadable count as UNKNOWN, not zero', () => {
    // Defect: `if ((remainingCount || 0) <= 1)` with the query error discarded.
    // On a supabase timeout count is null, `|| 0` makes it 0, and the engine
    // finished tournaments that still had players in them. Afternoon Bounty
    // ended with 5 players still status='playing' and position=NULL - exactly
    // the paid places - so their prize money was never emitted.
    expect(code(ELIM)).toMatch(/remaining_count_unavailable/);
    expect(code(ELIM)).not.toMatch(/\(\s*remainingCount\s*\|\|\s*0\s*\)\s*<=\s*1/);
  });

  it('positions are not derived from a count we could not read', () => {
    expect(code(ELIM)).toMatch(/playing_count_unavailable/);
  });
});

describe('finishing places must be distinct', () => {
  it('no Math.max(2, ...) clamp in position assignment', () => {
    // Defect: the clamp collapsed every position below 2 onto 2, so several
    // players were stamped place 2 and EACH collected a full 2nd-place prize.
    // The idempotency key dedupes a repeated user, not a repeated PLACE.
    const sweep = sliceMethod(code(ELIM), 'private async runEliminationSweep(');
    expect(sweep).not.toMatch(/Math\.max\(\s*2\s*,/);
  });

  it('places are taken from the FREE set, not from a live count (2026-08-27)', () => {
    // The `basePosition = Math.max(playingCount, n + 1)` arithmetic this test
    // used to pin made places distinct WITHIN one sweep, but playingCount is
    // not monotonic — atomic late registration can promote entrants to
    // playing after eliminations begin — so a later sweep could re-stamp a
    // place an earlier sweep had already PAID. Confirmed live: 206 duplicated
    // places across 138 tournaments, worst case 107% of a pool disbursed.
    // The live elimination sweep walks the free set. Terminal settlement then
    // re-derives the complete final order from unique elimination sequences
    // before any place is paid, so no second process-side assignment exists.
    const elim = code(ELIM);
    expect(elim).toMatch(/not\('position', 'is', null\)/);
    expect(elim).toMatch(/takenPositions/);
    expect(elim).toMatch(/while \(place >= 2 && takenPositions\.has\(place\)\) place--;/);
    expect(elim).toMatch(/no_free_finishing_place/);

    const cash = code(PLACE_SETTLEMENT_MIGRATION);
    expect(cash).toMatch(/count\(DISTINCT tp\.elimination_sequence\)/);
    expect(cash).toMatch(
      /row_number\(\) OVER \([\s\S]*?ORDER BY tp\.elimination_sequence DESC, tp\.id ASC[\s\S]*?\)::integer \+ 1 AS expected_position/
    );
  });
});

describe('one rounding rule, shared by every payout site', () => {
  it('computePlacePrize lives in its own import-free module', () => {
    // Hosting it in the eliminations module made the import graph circular
    // (recovery -> eliminations -> base -> recovery).
    expect(PAYOUT_MATH).toMatch(/export function computePlacePrize/);
    expect(code(PAYOUT_MATH)).not.toMatch(/^import /m);
  });

  it('the last paid place absorbs the residual, so places sum to the pool', () => {
    expect(PAYOUT_MATH).toMatch(/lastPlace/);
    // 2026-08-29: this pinned `safePool - others`, dollars subtracted from
    // dollars. The residual RULE is unchanged and still pinned; what changed
    // is that the whole ladder is now built at once in integer cents, so the
    // pool is spent DOWN and can never be overspent -- pricing one place in
    // isolation clamped a negative last place at zero and paid out more than
    // the pool. Moved to the new mechanism in the same commit that shipped
    // it, as the house rule asks. See the note in payoutMath.ts.
    expect(code(PAYOUT_MATH)).toMatch(/remaining/);
    expect(code(PAYOUT_MATH)).toMatch(/isLast\s*\?\s*remaining/);
  });

  it('the money is integer cents, never a binary float', () => {
    // Dan 2026-08-29, binding: exact to the cent, always. `513 * 3.5 / 100`
    // is 17.954999999999998 in a double, which rounded DOWN to 17.95 while
    // Postgres numeric made it 17.96 -- and the reconciler then "topped up"
    // the difference, pushing a 513.00 pool to 513.01 on every run of that
    // event. There is no epsilon that fixes that; the arithmetic has to be
    // integers.
    const src = code(PAYOUT_MATH);
    expect(src).toMatch(/poolCents/);
    expect(src).toMatch(/basis points|\bbp\(/);
    // No dollar-scale rounding helper survives in the money path.
    expect(src).not.toMatch(/const round2 =/);
  });

  it('both payout sites use it, and neither rounds on its own', () => {
    // Defect: each place rounded independently, so a 9-place structure on a
    // 483.00 pool paid 483.01. It also put the engine permanently at odds with
    // fn_tournament_payout_reconcile, which uses the residual rule.
    expect(code(ELIM)).toMatch(/computePlacePrize\(/);
    expect(code(ELIM)).not.toMatch(/prizeRaw/);
  });

  it('the stuck-COMPLETING rescue has no pricing formula of its own', () => {
    const recovery = sliceMethod(
      code(RECOVERY),
      'export async function recoverStuckCompletingTournaments('
    );
    expect(recovery).toMatch(/requestTournamentTerminalReceipt\(/);
    expect(recovery).not.toMatch(/computePlacePrize|settleTournamentObligation/);
    expect(code(PLACE_SETTLEMENT_MIGRATION)).toMatch(/fn_ca_tournament_place_amounts/);
  });
});

describe('every tournament settles against its own prize pool', () => {
  it('normal completion pays every place and completes through one atomic boundary', () => {
    const finish = sliceMethod(code(ELIM), 'finishTournament(winnerId: string): Promise<void>');
    expect(finish).toMatch(
      /requestTournamentTerminalReceipt\(this\.tournamentId, 'places', winnerId\)/
    );
    expect(finish).not.toMatch(
      /resolvePayoutStructure|computePlacePrize|settleTournamentObligation/
    );
    expect(finish).toMatch(/TerminalSettlementRefusedError/);
    expect(finish).toMatch(/TerminalSettlementOutcomeUnknownError/);
  });

  it('normal completion has no direct terminal write or post-hoc reconciler', () => {
    const finish = sliceMethod(code(ELIM), 'finishTournament(winnerId: string): Promise<void>');

    // Both normal and satellite finishes enter their format-owned whole-event
    // transaction. The manager must never recreate a money or status edge.
    expect(finish).toMatch(/requestTournamentTerminalReceipt\(/);
    expect(finish).toMatch(/processSatelliteAwards\(tournament, winnerId\)/);
    expect(finish).not.toMatch(/\.from\('tournaments'\)\s*\.update\(\{[\s\S]*?status:/);
    expect(finish).not.toMatch(/status:\s*'(?:COMPLETING|COMPLETED)'/);
    expect(finish).not.toMatch(/settleTournamentObligation\(/);
    expect(finish).not.toMatch(/fn_settle_tournament_obligation/);
    expect(finish).not.toMatch(/fn_tournament_payout_reconcile/);

    // The replacement is stronger than the deleted client writers: the outer
    // SQL authority calls one cash branch, bounty, rake, lifecycle and receipt
    // without swallowing an exception.
    const atomic = code(TERMINAL_SETTLEMENT_MIGRATION);
    const settle = atomic.indexOf(
      'CREATE OR REPLACE FUNCTION public.fn_complete_tournament_terminal('
    );
    const pay = atomic.indexOf('public.fn_settle_tournament_places(', settle);
    const complete = atomic.indexOf("SET status = 'COMPLETED'", pay);
    const receipt = atomic.indexOf('INSERT INTO public.tournament_terminal_settlements', complete);
    expect(settle).toBeGreaterThanOrEqual(0);
    expect(pay).toBeGreaterThan(settle);
    expect(complete).toBeGreaterThan(pay);
    expect(receipt).toBeGreaterThan(complete);
    expect(atomic.slice(settle, receipt)).not.toMatch(/EXCEPTION WHEN OTHERS/);
  });

  it('clears the break flags inside the same atomic completion boundary', () => {
    // Defect: endBreak() never runs if the event finishes DURING a break, so
    // COMPLETED tournaments sat flagged on_break=true forever.
    expect(code(TERMINAL_SETTLEMENT_MIGRATION)).toMatch(/on_break\s*=\s*false/);
  });
});

describe('rebuys and add-ons actually happen', () => {
  it('rebuys are offered before finishing places are assigned', () => {
    // Both had NEVER executed: zero 'addon' rows in all of history and the last
    // 'rebuy' dated 2026-04-19, because process_tournament_rebuy's only caller
    // was the SPA and there are no human players yet.
    expect(code(ELIM)).toMatch(/private async tryTournamentRebuys/);
    expect(code(ELIM)).toMatch(/await this\.tryTournamentRebuys\(/);
  });

  it('re-entry-only events send horses through the executable re-entry product', () => {
    const rebuys = sliceMethod(code(ELIM), 'private async tryTournamentRebuys(');
    expect(rebuys).toMatch(/!t\?\.is_rebuy\s*&&\s*!t\?\.is_reentry/);
    expect(rebuys).toContain("const recoveryType = t.is_rebuy ? 'rebuy' : 'reentry'");
    expect(rebuys).toMatch(/p_rebuy_type:\s*recoveryType/);
    expect(rebuys).not.toMatch(/p_rebuy_type:\s*'rebuy'/);
  });

  it('enforces the deterministic Free Buy horse allowance before the money RPC', () => {
    const rebuys = sliceMethod(code(ELIM), 'private async tryTournamentRebuys(');
    const allowance = rebuys.indexOf('horseRebuyAllowance(');
    const rpc = rebuys.indexOf("supabase.rpc('process_tournament_rebuy'");
    expect(allowance).toBeGreaterThanOrEqual(0);
    expect(rpc).toBeGreaterThan(allowance);
    expect(rebuys.slice(allowance, rpc)).toMatch(/answered\.add\(h\.id\)/);
  });

  it('add-ons are offered when the window opens', () => {
    expect(code(BASE)).toMatch(/protected async tryTournamentAddOns/);
    const stage = sliceEnclosingBlock(
      code(ELIM),
      'if (this.addOnPeriodTriggered && !this.prizePoolFinalized)'
    );
    expect(stage).toMatch(/await this\.tryTournamentAddOns\(\)/);
  });

  it('the durable window queues bounded scheduler work instead of running a field loop inline', () => {
    const trigger = sliceMethod(code(BASE), 'triggerAddOnPeriod(): Promise<void>');
    const durableProof = trigger.indexOf('durableWindowProven = true');
    const wake = trigger.indexOf('this.requestEliminationSweep()', durableProof);
    const retry = trigger.indexOf('this.scheduleAddOnRetry()', wake);
    expect(durableProof).toBeGreaterThanOrEqual(0);
    expect(wake).toBeGreaterThan(durableProof);
    expect(retry).toBeGreaterThan(wake);
    expect(trigger).not.toMatch(/tryTournamentAddOns\(\)/);
  });
});

describe('a rebuy or add-on lands in the seat, or does not happen', () => {
  it('add-ons are only offered to players holding a live seat', () => {
    // Defect: process_tournament_rebuy updated the seat behind `IF FOUND` with
    // no ELSE, so a player between seats during table consolidation was
    // charged and had the grant erased by the chip sync. On the first add-on
    // window ever run, 103 were charged and ~91 delivered nothing.
    // The database now refuses those outright; this keeps the engine from
    // generating a refusal per player.
    expect(code(BASE)).toMatch(/left_at.*is\(|is\('left_at'/s);
    expect(code(BASE)).toMatch(/seated\.has\(/);
  });
});

describe('the settler keeps running every sentinel it is meant to', () => {
  // Defect: runUnionEcoRecord was deleted by a stale-copy rewrite and nobody
  // noticed until the running build was grepped by hand.
  const sentinels = [
    'runUnionEcoRecord',
    'runUnionRakeRollupCatchup',
    'runTournamentChipConservation',
  ];
  for (const s of sentinels) {
    it(`${s} is defined AND called`, () => {
      expect(code(SETTLER)).toMatch(new RegExp(`private async ${s}\\(`));
      expect(code(SETTLER)).toMatch(new RegExp(`await this\\.${s}\\(`));
    });
  }

  it('never applies the retired tournament payout sweep', () => {
    const settler = code(SETTLER);
    expect(settler).not.toMatch(/runTournamentPayoutSweep/);
    expect(settler).not.toMatch(/fn_tournament_payout_sweep/);
  });
});

describe('ESM: every relative import carries its .js extension', () => {
  it('because Node resolves the specifier literally at runtime', () => {
    // Defect: two files imported '../config/spinSpec' with no extension. tsc
    // accepts it, so it cleared the build gate and only died on boot with
    // ERR_MODULE_NOT_FOUND - which left main unbootable and blocked EVERY
    // engine deploy until it was found.
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full, out);
        else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) out.push(full);
      }
      return out;
    };
    const offenders: string[] = [];
    for (const file of walk(path.join(process.cwd(), 'src'))) {
      const src = code(fs.readFileSync(file, 'utf8'));
      // Relative specifiers only; bare/node_modules specifiers are resolved by
      // Node and must NOT carry an extension.
      //
      // Matched on `from '...'` and `import('...')` rather than on the whole
      // import statement: the first version of this guard anchored to the line
      // start and used [^'"\n]*, so it could not span newlines and therefore
      // MISSED multi-line imports - including the exact one that broke main
      // (`import {\n ... \n} from '../config/spinSpec'`). Verified by
      // deliberately dropping the extension and confirming this fails.
      const patterns = [/\bfrom\s+'(\.[^']*)'/g, /\bimport\s*\(\s*'(\.[^']*)'/g];
      for (const re of patterns) {
        let m: RegExpExecArray | null;
        while ((m = re.exec(src)) !== null) {
          const spec = m[1];
          if (!spec.endsWith('.js') && !spec.endsWith('.json')) {
            offenders.push(`${path.relative(process.cwd(), file)} -> ${spec}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('add-ons must always award their chips to the stack', () => {
  /**
   * process_tournament_rebuy now REFUSES to charge a player who has no live
   * seat, because a grant to a seatless player is erased by the chip sync.
   * That closes the money hole, but on its own it costs those players their
   * add-on: the offer used to be made exactly once, when the window opened,
   * so a player mid-table-move at that instant was skipped forever.
   *
   * Defect measured 2026-08-20 on the first add-on window ever run: 103
   * add-ons charged, ~91 delivered nothing.
   */
  it('re-offers add-ons for as long as the window is open, not once', () => {
    const src = code(ELIM);
    expect(src).toMatch(/addOnPeriodTriggered\s*&&\s*!this\.prizePoolFinalized/);
    expect(src).toMatch(/lastAddOnOfferAt/);
    expect(src).toMatch(/tryTournamentAddOns\(\)/);
  });

  it('throttles the repeat offer so clustered event wakes do not hammer it', () => {
    const base = code(BASE);
    const stage = sliceEnclosingBlock(
      code(ELIM),
      'if (this.addOnPeriodTriggered && !this.prizePoolFinalized)'
    );
    expect(base).toMatch(/static readonly ADD_ON_RETRY_MS = 20_000/);
    expect(stage).toMatch(
      /nowMs - this\.lastAddOnOfferAt >= TournamentManagerBase\.ADD_ON_RETRY_MS/
    );
    expect(stage).toMatch(/this\.scheduleAddOnRetry\(\)/);
    expect(stage).not.toMatch(/20_000/);
  });

  it('only offers add-ons to players who currently hold a seat', () => {
    // A seatless player would be charged for chips the sync then erases.
    expect(code(BASE)).toMatch(/seated\.has\(/);
  });
});

describe('a table move must never leave a player holding two live seats', () => {
  /**
   * The rollback used to re-activate the source seat whenever the destination
   * write returned an error - including the case where the write had actually
   * COMMITTED and only the client saw a failure. Five players in production
   * ended up with two live seats, each pair carrying an identical stack.
   *
   * Two live seats means the chip sync and the rebuy/add-on RPC must pick one,
   * and picking the stale row erases purchases or reports the wrong stack
   * (15,000 against a true 2,728,737 in Union Grand Championship).
   */
  it('moves source and destination through one receipt authority', () => {
    const move = sliceMethod(
      code(MANAGER),
      'private async executePlayerMovesOwned(moves: MoveInstruction[])'
    );
    const request = move.indexOf('requestTournamentSeatMoveAtBoundary(input, boundary)');
    const success = move.indexOf('moved++;', request);
    expect(request).toBeGreaterThanOrEqual(0);
    expect(success).toBeGreaterThan(request);
    expect(move.slice(0, success)).not.toMatch(/\.from\('table_seats'\)|restore|compensat/i);
  });

  it('replays the exact move identity and never guesses after an ambiguous response', () => {
    const rpc = code(SEAT_MOVE_RPC);
    const request = rpc.indexOf('const request = {');
    const retry = rpc.indexOf('for (let attempt = 0; attempt < 2; attempt++)', request);
    const invoke = rpc.indexOf("supabase.rpc('fn_move_tournament_player', request)", retry);
    const verified = rpc.indexOf('const receipt = verify(data, input)', invoke);
    const unknown = rpc.indexOf('throw new TournamentSeatMoveOutcomeUnknownError(', verified);
    expect(request).toBeGreaterThanOrEqual(0);
    expect(retry).toBeGreaterThan(request);
    expect(invoke).toBeGreaterThan(retry);
    expect(verified).toBeGreaterThan(invoke);
    expect(unknown).toBeGreaterThan(verified);
  });
});

describe('no seating path may write a second live seat in the same tournament', () => {
  /**
   * WHY THE GUARD ABOVE DID NOT CATCH THIS.
   *
   * The guard above pins ONE branch of ONE writer: the error rollback in
   * executePlayerMoves, where a committed-but-errored destination write used
   * to be undone by re-activating the source. That branch is fine and stayed
   * fine. The 144 duplicate rows measured on production did not come through
   * it — they came from the SEATING paths, which the guard says nothing about.
   *
   * `createTablesAndSeatPlayers` reads `alreadySeated` ONCE and then writes
   * one seat per statement for the whole field. On tournament
   * bae46dbf-7cf6-42c0-a709-c38a97306a08 ("$100 Freeroll 12:00 PM",
   * 497 entrants) that loop ran from 17:11:39 to 17:16:44 on 2026-08-25. A
   * second pass over the same tournament inside that window takes its own
   * snapshot, sees every not-yet-written player as unseated, and seats them
   * again — 72 players, 144 live seats, 46 of the pairs exactly 14 tables
   * apart, which is two round-robin cursors walking one table list.
   * `idx_unique_active_user_per_table` is UNIQUE (table_id, user_id) WHERE
   * left_at IS NULL — per TABLE. It cannot object to the second seat, because
   * the second seat is at a different table.
   *
   * So the rule is not "the snapshot said they were unseated". The rule is
   * that every writer re-asks the database immediately before it writes.
   */
  const SEAT_CLAIM = read('src/tournament/seatClaim.ts');

  it('the claim is scoped to the TOURNAMENT, not to one table', () => {
    const src = code(SEAT_CLAIM);
    // Reached through the join, because table_seats carries no tournament_id.
    expect(src).toContain('tables!inner(tournament_id)');
    expect(src).toMatch(/eq\('tables\.tournament_id'/);
    expect(src).toMatch(/is\('left_at',\s*null\)/);
  });

  it('an unreadable claim refuses the seat instead of granting it', () => {
    const src = code(SEAT_CLAIM);
    // A read error must not collapse into "no seats found".
    expect(src).toMatch(/ok:\s*false/);
    expect(src).toMatch(/unknown:\s*true/);
    // Never `allowed: true` on the error path.
    const errBranch = src.slice(
      src.indexOf('if (!found.ok)'),
      src.indexOf('if (found.seats.length')
    );
    expect(errBranch).not.toMatch(/allowed:\s*true/);
  });

  it('start-seating delegates the complete seat mutation to one database authority', () => {
    const src = code(BASE);
    const fn = sliceMethod(src, 'protected async createTablesAndSeatPlayers(');
    const loop = fn.indexOf('for (let i = 0; i < toSeat.length; i++)');
    const assignment = fn.indexOf('assignTournamentPlayerSeatAtomically({', loop);
    expect(loop).toBeGreaterThan(-1);
    expect(assignment).toBeGreaterThan(loop);
    expect(fn.slice(assignment)).toMatch(/userId:\s*toSeat\[i\]\.user_id/);
    expect(fn.slice(loop)).not.toMatch(
      /from\('table_seats'\)[\s\S]{0,80}\.(?:insert|update|delete)\(/
    );
    expect(code(SEAT_ASSIGNMENT_RPC)).toMatch(/fn_assign_tournament_player_seat_atomic/);
  });

  it('has no periodic process-side late-registration seat writer', () => {
    const manager = code(MANAGER);
    const eliminations = code(ELIM);
    expect(manager).not.toContain('ensureLateRegSeated');
    expect(manager).not.toContain('atomic_late_reg_seat');
    expect(eliminations).not.toContain('ensureLateRegSeated');
    expect(manager).not.toContain('assignTournamentPlayerSeatAtomically');
  });

  it('a move has one database authority and no compensating seat writes', () => {
    const src = code(MANAGER);
    const fn = src.slice(
      src.indexOf('private async executePlayerMovesOwned(moves: MoveInstruction[])')
    );
    const end = fn.indexOf('protected async waitForHandComplete');
    const move = fn.slice(0, end);
    expect(move).toContain('requestTournamentSeatMoveAtBoundary(input, boundary)');
    expect(move).toContain('const requestId = randomUUID()');
    expect(src).toContain(
      'return moveTournamentPlayerAtomically(input, { outcomeWasAlreadyUnknown })'
    );
    expect(move).not.toMatch(/\.from\('table_seats'\)/);
    expect(move).not.toMatch(/\.from\('tournament_players'\)/);
    expect(move).not.toMatch(/restore|compensat/i);
  });
});

describe('seating a tournament twice must not build a second set of tables', () => {
  /**
   * start() calls createTablesAndSeatPlayers BEFORE the
   * "only REGISTERING -> RUNNING" status guard, so calling it on a tournament
   * that was already RUNNING created a whole second set of tables and re-seated
   * the field, leaving the originals live.
   *
   * Production 2026-08-20: "5 Chip Turbo SNG 6-Max NLH" held THREE tables all
   * named "Table 1" (20:20:53 real, 20:33:58 and 20:34:04 duplicates), six
   * players seated twice at tables dealing concurrently, 18,000 chips against
   * 9,000 issued.
   */
  it('adopts tables the tournament already has instead of recreating them', () => {
    const src = code(BASE);
    const fn = src.slice(src.indexOf('protected async createTablesAndSeatPlayers('));
    expect(fn).toMatch(/existingTables/);
    expect(fn).toMatch(/tablesToCreate/);
  });

  it('creates only the shortfall, and measures it in SEATS not tables', () => {
    const src = code(BASE);
    const fn = src.slice(src.indexOf('protected async createTablesAndSeatPlayers('));
    /**
     * UPDATED 2026-08-25. This used to pin
     * `Math.max(0, numTables - alreadyHave)`, and that formula is the defect:
     * `numTables = ceil(players.length / maxPerTable)` assumes every adopted
     * table is EMPTY, which is the one thing adoption guarantees they are not.
     * One adopted table already holding 9 of 9 seats plus 10 entrants asked
     * for 2 tables, had 1, created 1 — and the tenth entrant was handed to the
     * FULL table. Live footprint 2026-08-25: 54 seats above their table's own
     * max_players across 53 tournament tables ("Turbo Tuesday Graveyard"
     * tables 44-56 each carrying a seat_number 10 on max_players 9).
     *
     * The shortfall is now counted in seats against real free capacity, which
     * is strictly stronger: it still creates only the shortfall, and it can no
     * longer under-create.
     */
    expect(fn).not.toMatch(/Math\.max\(0,\s*numTables\s*-\s*alreadyHave\)/);
    expect(fn).toMatch(/freeSeatsNow/);
    expect(fn).toMatch(/seatShortfall/);
    expect(fn).toMatch(/tablesToCreate\s*=\s*Math\.ceil\(seatShortfall\s*\/\s*maxPerTable\)/);
  });

  it('never re-seats a player who already holds a live seat', () => {
    const src = code(BASE);
    const fn = src.slice(src.indexOf('protected async createTablesAndSeatPlayers('));
    expect(fn).toMatch(/alreadySeated/);
    // Anchored to the INSERT itself, not to a slice that runs to end of file:
    // the row written must come from the filtered list, and must NOT come from
    // the unfiltered one. (The looser version of this guard passed when the
    // filter was deleted -- caught by mutation testing.)
    const assignment = fn.slice(fn.indexOf('assignTournamentPlayerSeatAtomically({'));
    const row = assignment.slice(0, assignment.indexOf('});'));
    expect(row).toContain('userId: toSeat[i].user_id');
    expect(row).not.toContain('players[i].user_id');
    expect(fn).toMatch(
      /const toSeat = players\.filter\(\(p: any\) => !alreadySeated\.has\(p\.user_id\)\)/
    );
  });

  it('gives a new seat the lowest FREE seat number WITHIN the table capacity', () => {
    const src = code(BASE);
    const fn = src.slice(src.indexOf('protected async createTablesAndSeatPlayers('));
    /**
     * UPDATED 2026-08-25. The pinned scan was `while (taken.has(seatNumber))
     * seatNumber++` — lowest free, with NO CEILING. Handed a full 9-max table
     * it returned seat 10, walking straight past the max_players that
     * clampSeatsForVariant had just clamped for deck safety (#782). The
     * Lowest-free is still the rule. It is now bounded by the table's own
     * capacity, and a launch with no in-capacity seat is refused for an exact
     * lifecycle retry rather than given an illegal seat.
     */
    expect(fn).not.toMatch(/while\s*\(taken\.has\(seatNumber\)\)\s*seatNumber\+\+/);
    expect(fn).toMatch(/capacityOf/);
    // The scan is bounded by the capacity on BOTH the loop and the acceptance.
    expect(fn).toMatch(/while\s*\(n\s*<=\s*cap\s*&&\s*taken\.has\(n\)\)/);
    expect(fn).toMatch(/if\s*\(n\s*<=\s*cap\)/);
    // No in-capacity seat anywhere is reported, never papered over.
    expect(fn).toMatch(/seating_capacity_exhausted/);
  });
});

/**
 * ───────────────────────────────────────────────────────────────────────────
 * THE OCCUPIED TABLE IS THE REAL TABLE (2026-08-24)
 *
 * Dan registered during late registration and got no seat, no chips, and a
 * tournament that never started. One defect produced all three.
 *
 * A seat-first game's field size is read off ONE chosen table, and that
 * choice had been made two different ways, both of which pick a corpse:
 * 20260823330000 took the oldest table ever created, 20260824050000 took the
 * newest non-closed one. These games are created with two `waiting` tables
 * about 0.6s apart; the players sit on the FIRST and the empty one is NEWER.
 *
 * Measured in production before the fix: 126 live tournaments, 39 with
 * current_players below their real field, every one of them startable, one
 * stuck 471 minutes. Of 31 past-start games 28 were blocked and in 12 an
 * empty table had outranked a sibling holding the whole game. Per hour, games
 * with a duplicate live table equalled stuck games exactly: 2/2, 2/2, 9/9.
 *
 * The rule is occupancy first, oldest to break the tie - which is what
 * fn_seat_late_registrant already did. These guards keep the engine agreeing
 * with it, because a third definition is how this happened twice already.
 * ───────────────────────────────────────────────────────────────────────────
 */
const GAMESERVER = read('src/GameServer.ts');
const RECURRING = read('src/services/TournamentRecurringService.ts');
const OCCUPIED_MIGRATION = read(
  '../supabase/migrations/20260824070000_the_occupied_table_is_the_real_table.sql'
);

describe('the paid-seat gate reads the table the game is actually on', () => {
  it('does not choose the newest live table', () => {
    // `newestTable` is the identifier the broken selection used. Its absence
    // is the cheapest durable signal that the rule has not been reinstated.
    expect(code(GAMESERVER)).not.toContain('newestTable');
  });

  it('chooses by occupancy, with the oldest table breaking the tie', () => {
    const src = code(GAMESERVER);
    expect(src).toContain('primaryTable');
    // seats win outright; equal seats fall back to the EARLIER created_at
    expect(src).toContain('seats > seen.seats');
    expect(src).toContain('createdAt < seen.createdAt');
  });

  it('counts seats for every live table, not for one guessed table', () => {
    // Choosing by occupancy is only possible if the seats of all candidates
    // were read. The old code read seats for the single table it had already
    // picked, which is what made the wrong pick undetectable.
    expect(code(GAMESERVER)).toContain('const liveTableIds = (liveTables || [])');
  });
});

describe('a seat-first top-up is measured in seats, not registrations', () => {
  it('asks the database which table is the game', () => {
    expect(code(RECURRING)).toContain('fn_tournament_primary_table');
  });

  it('never computes the shortfall from the bare registration count', () => {
    // registrations 3/3 with seats 1/3 computed a shortfall of zero, so the
    // missing horse was never seated and the start gate never opened. Five
    // Spins were deadlocked that way, the oldest for 486 minutes.
    expect(code(RECURRING)).not.toContain('const shortfall = targetPlayers - (liveCount || 0);');
    expect(code(RECURRING)).toContain('const shortfall = targetPlayers - liveCount;');
  });

  it('does not run an idle count reconciler when there is nothing to add', () => {
    // The exact count now commits in every canonical seat mutation. An idle
    // top-up pass has no write authority and the private AFTER-seat helper is
    // deliberately not exposed to service_role.
    expect(code(RECURRING)).not.toContain('if (shortfall <= 0) return 0;');
    expect(code(RECURRING)).toContain('if (shortfall <= 0) {');
    expect(code(RECURRING)).not.toContain("supabase.rpc('fn_sync_seat_first_player_count'");
  });
});

describe('the database agrees with the engine about which table is the game', () => {
  it('defines one shared primary-table function, ordered by occupancy', () => {
    const sql = OCCUPIED_MIGRATION;
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.fn_tournament_primary_table');
    expect(sql).toContain('tb.created_at ASC');
  });

  it('ships the late-registration sweep that the client comments promise', () => {
    // fn_seat_late_registrant had NO caller anywhere outside
    // fn_register_for_tournament, yet useTournamentRegistration.ts and
    // TablePage.tsx both promise that the engine recovery lane seats him.
    // A paid, seatless player waited forever.
    expect(OCCUPIED_MIGRATION).toContain(
      'CREATE OR REPLACE FUNCTION public.fn_sweep_seatless_late_registrants'
    );
    expect(OCCUPIED_MIGRATION).toContain('public.fn_seat_late_registrant(');
  });

  it('repairs the counter that gates every tournament start', () => {
    // fn_reconcile_tournament_denormals ran every minute and fixed roster
    // seats and table stakes, but never current_players - the one denormal
    // the start gate actually reads.
    expect(OCCUPIED_MIGRATION).toContain('player_counts_fixed');
    expect(OCCUPIED_MIGRATION).toContain('empty_dupes_closed');
  });
});

describe('a tournament that started and never dealt is rescued whatever its variant', () => {
  /**
   * The started-but-never-dealt sweep shipped filtered to ['sng', 'spin'] —
   * the two variants the outage that prompted it happened to contain — while
   * its own comment said "no existing sweep covers this state". MTTs were
   * therefore covered by nothing. Found live 2026-08-25: an 18-player PLO6
   * Turbo 183 minutes into a RUNNING status with zero hands, and a 499-player
   * freezeout holding 56 tables and 548 live seats, also with zero hands.
   * Buy-ins committed, players seated, nothing looking for either of them.
   */
  it('does not filter the never-dealt sweep down to seat-first variants', () => {
    expect(code(GAMESERVER)).not.toContain("in('variant', ['sng', 'spin'])");
  });

  it('releases the exact idle manager without rewinding durable launch state', () => {
    // A completed launch receipt and RUNNING are one immutable fact. Recovery
    // relinquishes only the dead in-memory generation so ordinary RUNNING
    // discovery resumes it; rewriting REGISTERING strands the receipt.
    const src = code(GAMESERVER);
    expect(src).toContain('const neverDealtCutoff');
    expect(src).toContain("'GameServer.never_dealt_stop_engine'");
    expect(src).not.toContain("update({ status: 'REGISTERING' })");
  });

  it('requeues only once every playing player holds a live seat', () => {
    // A large MTT seats over several passes. Without this, a game still
    // mid-seating reads identically to a dead one and gets bounced back
    // through the start gate for no reason.
    const src = code(GAMESERVER);
    expect(src).toContain('const { count: stillPlaying');
    expect(src).toContain('if (liveSeats < stillPlaying) continue;');
  });

  it('treats a playing-count it could not read as UNKNOWN, not as settled', () => {
    // Same rule the finish check holds: an unreadable count must never be
    // allowed to mean zero, or a failed query silently requeues a live game.
    expect(code(GAMESERVER)).toContain(
      'if (playingCountErr || stillPlaying === null || stillPlaying === undefined) continue;'
    );
  });
});
