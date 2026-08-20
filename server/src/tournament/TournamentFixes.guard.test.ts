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

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), 'utf8');

const ELIM = read('src/tournament/TournamentManagerEliminations.ts');
const BASE = read('src/tournament/TournamentManagerBase.ts');
const SETTLER = read('src/services/RakebackSettlerService.ts');
const PAYOUT_MATH = read('src/tournament/payoutMath.ts');
const RECOVERY = read('src/tournament/tournamentRecovery.ts');
const MANAGER = read('src/tournament/TournamentManager.ts');

/** Strip line and block comments so a guard cannot pass on a mention in prose. */
const code = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

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
    expect(code(ELIM)).not.toMatch(/Math\.max\(\s*2\s*,/);
    expect(code(ELIM)).toMatch(/basePosition\s*=\s*Math\.max\(\s*playingCount/);
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
    expect(code(PAYOUT_MATH)).toMatch(/safePool\s*-\s*others/);
  });

  it('both payout sites use it, and neither rounds on its own', () => {
    // Defect: each place rounded independently, so a 9-place structure on a
    // 483.00 pool paid 483.01. It also put the engine permanently at odds with
    // fn_tournament_payout_reconcile, which uses the residual rule.
    expect(code(ELIM)).toMatch(/computePlacePrize\(/);
    expect(code(ELIM)).not.toMatch(/prizeRaw/);
  });

  it('the stuck-COMPLETING rescue shares it too', () => {
    // Defect: a THIRD independent formula meant a rescued tournament could be
    // paid a cent differently from one that finished normally.
    expect(code(RECOVERY)).toMatch(/computePlacePrize\(/);
  });
});

describe('every tournament settles against its own prize pool', () => {
  it('the COMPLETED transition reconciles payouts', () => {
    expect(code(ELIM)).toMatch(/fn_tournament_payout_reconcile/);
  });

  it('and clears the break flags on the way out', () => {
    // Defect: endBreak() never runs if the event finishes DURING a break, so
    // COMPLETED tournaments sat flagged on_break=true forever.
    expect(code(ELIM)).toMatch(/on_break:\s*false/);
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

  it('add-ons are offered when the window opens', () => {
    expect(code(BASE)).toMatch(/protected async tryTournamentAddOns/);
    expect(code(BASE)).toMatch(/await this\.tryTournamentAddOns\(\)/);
  });

  it('the add-on call sits inside triggerAddOnPeriod, not orphaned', () => {
    const trigger = code(BASE).slice(code(BASE).indexOf('triggerAddOnPeriod(): Promise<void>'));
    expect(trigger.slice(0, 4000)).toMatch(/tryTournamentAddOns\(\)/);
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
    'runTournamentPayoutSweep',
    'runTournamentChipConservation',
  ];
  for (const s of sentinels) {
    it(`${s} is defined AND called`, () => {
      expect(code(SETTLER)).toMatch(new RegExp(`private async ${s}\\(`));
      expect(code(SETTLER)).toMatch(new RegExp(`await this\\.${s}\\(`));
    });
  }
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

  it('throttles the repeat offer so the 5s sweep does not hammer it', () => {
    expect(code(ELIM)).toMatch(/lastAddOnOfferAt\s*>=\s*20_000|20_000\s*<=/);
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
  it('checks the destination seat actually failed before restoring the source', () => {
    const src = code(MANAGER);
    const idx = src.indexOf('if (seatWriteErr)');
    expect(idx).toBeGreaterThan(-1);
    const restore = src.indexOf('update({ left_at: null })', idx);
    expect(restore).toBeGreaterThan(-1);
    // Structural, not name-based: between entering the error branch and
    // restoring the source seat there must be a READ of the DESTINATION seat
    // and an early exit for the case where it turns out to be present.
    // (Keying this on a variable name made it pass when the name alone was
    // changed -- caught by mutation testing.)
    const window = src.slice(idx, restore);
    expect(window).toContain('move.toTableId');
    expect(window).toContain('move.toSeat');
    expect(window).toMatch(/is\('left_at',\s*null\)/);
    expect(window).toMatch(/\bcontinue;/);
  });

  it('treats a committed-but-errored destination write as a completed move', () => {
    expect(code(MANAGER)).toMatch(/Move_dest_seat_write_false_negative/);
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
    const fn = src.slice(src.indexOf('createTablesAndSeatPlayers(tournament: any)'));
    expect(fn).toMatch(/existingTables/);
    expect(fn).toMatch(/tablesToCreate/);
  });

  it('creates only the shortfall, never a full second set', () => {
    const src = code(BASE);
    const fn = src.slice(src.indexOf('createTablesAndSeatPlayers(tournament: any)'));
    // the create loop must be bounded by the shortfall, not by numTables alone
    expect(fn).toMatch(/Math\.max\(0,\s*numTables\s*-\s*alreadyHave\)/);
  });

  it('never re-seats a player who already holds a live seat', () => {
    const src = code(BASE);
    const fn = src.slice(src.indexOf('createTablesAndSeatPlayers(tournament: any)'));
    expect(fn).toMatch(/alreadySeated/);
    // Anchored to the INSERT itself, not to a slice that runs to end of file:
    // the row written must come from the filtered list, and must NOT come from
    // the unfiltered one. (The looser version of this guard passed when the
    // filter was deleted -- caught by mutation testing.)
    const ins = fn.slice(fn.indexOf("from('table_seats').insert("));
    const row = ins.slice(0, ins.indexOf('});'));
    expect(row).toContain('toSeat[i].user_id');
    expect(row).not.toContain('players[i].user_id');
  });

  it('gives a new seat the lowest FREE seat number so it cannot collide', () => {
    const src = code(BASE);
    const fn = src.slice(src.indexOf('createTablesAndSeatPlayers(tournament: any)'));
    expect(fn).toMatch(/while\s*\(taken\.has\(seatNumber\)\)/);
  });
});
