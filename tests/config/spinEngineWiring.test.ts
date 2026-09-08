/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  SPIN ENGINE WIRING — source-level guards on the money path
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * These read the source rather than executing it, because the engine needs a
 * live Postgres and a running tournament to exercise. What needs pinning is
 * not behaviour under load — it is that five specific mistakes cannot come
 * back:
 *
 *   1. A Spin priced like an MTT (buy-in + fee). Dan: "THEY ARE STRAIGHT JUST
 *      10 BUY IN... NO ADDITIONAL RAKE IS ADDED." A fee on top would double
 *      the true house edge from 7.87% to 14.7%.
 *   2. A local multiplier table. FOUR of them disagreed (EV 3.00 / 2.75 /
 *      2.24 / 2.33); the one that ran was not the one documented.
 *   3. prize_pool overwritten with no ledger row — the leak that put ~1,160
 *      of margin into no ledger at all across 2,091 games.
 *   4. An ungated jackpot: a multiplier selected without asking the reserve.
 *   5. A draw that exists BEFORE start. Any creation-time multiplier sits
 *      readable on the row for a minute — and even with every label hidden,
 *      prize_pool = buyIn x multiplier leaks it arithmetically. The only
 *      draw a lobby client cannot read early is one that has not happened.
 *
 * 2026-08-20 (second pass): the draw MOVED from creation to start. These
 * guards now pin the draw's LOCATION as hard as its gating.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { sliceEnclosingBlock } from '../helpers/sourceWindow';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

/**
 * Comments quote the very things these tests ban (that is what a good
 * comment does — it names the old bug). Never match against them.
 */
const code = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

const recurringRaw = read('server/src/services/TournamentRecurringService.ts');
const engineRaw = read('server/src/tournament/TournamentManagerBase.ts');
const orchestratorRaw = read('src/services/HorseOrchestrator.ts');
const tournamentServiceRaw = read('src/services/TournamentService.ts');

const recurring = code(recurringRaw);
const engine = code(engineRaw);
const orchestrator = code(orchestratorRaw);
const tournamentService = code(tournamentServiceRaw);

/**
 * The insert object for the Spin, bounded by where it actually ends. This
 * used to be `.slice(0, 1600)`, a guess about block length that broke the
 * SpinSeatCount guard the day comments were added above the line it checked.
 * A test that fails when a comment is added is a test people learn to ignore.
 */
function spinInsertBlock(src: string): string {
  const i = src.indexOf("tournament_type: 'SPIN',");
  expect(i, 'expected a Spin insert').toBeGreaterThan(-1);
  const end = src.indexOf("createSeatFirstGameAtomic(spinRow, 'spin')", i);
  expect(end, 'Spin config does not reach the atomic seat-first creator').toBeGreaterThan(i);
  const start = src.lastIndexOf('const spinRow = {', i);
  expect(start, 'no spinRow object above the Spin marker').toBeGreaterThan(-1);
  return src.slice(start, end);
}

describe('a Spin is not priced like an MTT', () => {
  it('charges NO fee on top of the buy-in', () => {
    expect(spinInsertBlock(recurring)).toMatch(/buy_in_fee:\s*0\b/);
  });

  it('does not reintroduce config.rake on the Spin path', () => {
    expect(spinInsertBlock(recurring)).not.toMatch(/buy_in_fee:\s*config\.rake/);
  });

  it('leaves the SNG path alone — those ARE buy-in + rake', () => {
    const i = recurring.indexOf("tournament_type: 'SNG',");
    expect(i).toBeGreaterThan(-1);
    const end = recurring.indexOf('.select()', i);
    // 2026-08-20 (parallel agent): the SNG fee moved from a literal
    // `buy_in_fee: config.rake` into the shared buyInColumns() split. Either
    // shape satisfies this guard — what it pins is that an SNG CARRIES a fee
    // path at all, unlike a Spin which must not.
    expect(recurring.slice(i, end)).toMatch(/buy_in_fee:\s*config\.rake|\.\.\.buyInColumns\(/);
  });
});

describe('one multiplier table, in one place: the spec', () => {
  it('both server files import the canonical spec', () => {
    /* The `.js` is not optional: server/ is `"type": "module"` and Node's
       ESM resolver will not resolve a bare specifier at runtime. */
    expect(recurringRaw).toMatch(/from '\.\.\/config\/spinSpec\.js'/);
    expect(engineRaw).toMatch(/from '\.\.\/config\/spinSpec\.js'/);
  });

  it('no file — server OR client — declares its own weighted table', () => {
    // The shape that started all of this: { multiplier: N, weight: N } and
    // its client cousin { displayMultiplier: N, probability: N }.
    for (const [name, src] of [
      ['TournamentManagerBase', engine],
      ['TournamentRecurringService', recurring],
      ['HorseOrchestrator', orchestrator],
      ['TournamentService', tournamentService],
    ] as const) {
      const weighted = src.match(/\{\s*multiplier:\s*[\d.]+\s*,\s*weight:\s*[\d.]/g) ?? [];
      expect(weighted.length, `${name} declares a hardcoded weighted table`).toBe(0);
      const legacy = src.match(/displayMultiplier:\s*[\d.]/g) ?? [];
      expect(legacy.length, `${name} still carries the retired bonus-tier shape`).toBe(0);
      const probability = src.match(/\{\s*multiplier:\s*[\d.]+\s*,\s*probability:\s*[\d.]/g) ?? [];
      expect(probability.length, `${name} declares a hardcoded probability table`).toBe(0);
    }
  });

  it("the client's display ladder is DERIVED from SPIN_TIERS", () => {
    expect(tournamentService).toMatch(/SPIN_TIERS\.map\(/);
  });
});

describe('the draw happens at START, nowhere else', () => {
  it('the engine start path calls the reserve-gated RPC', () => {
    expect(engine).toMatch(/fn_spin_draw_multiplier/);
  });

  it('creation does NOT draw — not the recurring service, not the orchestrator', () => {
    // A creation-time multiplier is readable for a minute before start, and
    // prize_pool = buyIn x multiplier leaks it arithmetically even when
    // every label is hidden. See guard file header, mistake 5.
    expect(recurring).not.toMatch(/fn_spin_draw_multiplier/);
    expect(orchestrator).not.toMatch(/fn_spin_draw_multiplier/);
  });

  it('creation writes a NULL multiplier for the start path to key on', () => {
    expect(spinInsertBlock(recurring)).toMatch(/spin_multiplier:\s*null/);
  });

  /**
   * STRONGER THAN THE OLD PIN (2026-08-30 audit). This used to require the
   * ORCHESTRATOR's own Spin insert to write spin_multiplier: null. That
   * client insert is gone: HorseOrchestrator.launchSpin had no production
   * caller, registered horses instead of selling seats, and then overwrote
   * current_players with its own counter - the documented "0/3 with paid
   * seats" shape. A creation path that does not exist cannot leak a draw, so
   * the pin moved from "creates safely" to "does not create at all".
   */
  it('the client orchestrator does not create Spins at all', () => {
    expect(orchestratorRaw).not.toMatch(/tournament_type:\s*'SPIN'/);
    expect(orchestratorRaw).toMatch(/launchSpin is retired/);
  });

  it('creation does not put a multiplier-derived amount in prize_pool', () => {
    // The arithmetic spoiler: any buyIn x multiplier written pre-start.
    // Scoped to createSpin — MTT and SNG legitimately set their pools at
    // creation because their pools do not encode a secret.
    const i = recurring.indexOf('private async createSpin');
    expect(i, 'expected createSpin').toBeGreaterThan(-1);
    const next = recurring.indexOf('private async ', i + 10);
    const body = recurring.slice(i, next > i ? next : undefined);
    expect(body).not.toMatch(/prize_pool:\s*prizePool/);
    expect(body).not.toMatch(/buyIn\s*\*\s*multiplier/i);
    // (the orchestrator no longer has a Spin insert to check - see the pin above)
  });

  it('no client-side draw survives anywhere', () => {
    // Math.random deciding a real prize was engine audit A8; a client-side
    // roll of any kind is worse. TournamentService.spinMultiplier is gone.
    expect(tournamentService).not.toMatch(/spinMultiplier\(config/);
  });

  /* SUPERSEDED, AND LEFT RED ON main FOR AN HOUR (fixed 2026-08-25).
     This test asserted that the engine, unable to read the draw, resolves the
     player DOWN to SPIN_TIERS[0] - 2x. PR #794 removed exactly that line,
     because it was a money-facing lie: three players watched a real-looking
     wheel land on a tier the database had never said it drew, and
     fn_spin_settle_game then moved real money against it. That PR added
     server/src/tournament/SpinDrawIntegrity.guard.test.ts, which FORBIDS the
     line this one required - two tests in the same tree demanding opposite
     things, so main could not be green either way.

     House rule 8 says the test that pins replaced behaviour is updated in the
     commit that replaces it. It was not, so the assertion is inverted here to
     the rule that actually holds now: an unreadable draw is UNKNOWN, the
     start stands down and retries, and no tier is ever substituted. */
  it('the engine never substitutes a tier for a draw it could not read', () => {
    expect(engine).not.toMatch(/spinMultiplier\s*=\s*SPIN_TIERS\s*\[\s*0\s*\]/);
    // ...and the failure is explicit and retryable instead.
    expect(engine).toMatch(/drawFailure/);
    expect(engine).toMatch(/error:\s*drawErr/);
  });
});

describe('every game is booked', () => {
  it('settles through the ledger RPC', () => {
    expect(engine).toMatch(/fn_spin_settle_game/);
  });

  it('reports loudly rather than swallowing a failed settlement', () => {
    const i = engine.indexOf("supabase.rpc('fn_spin_settle_game'");
    expect(i, 'expected a call to fn_spin_settle_game').toBeGreaterThan(-1);
    const block = sliceEnclosingBlock(engine, "supabase.rpc('fn_spin_settle_game'", 0, 2);
    expect(block).toMatch(/reportError/);
    expect(block).toMatch(/spin_settle_failed/);
  });

  it('books the rake at the rate the stake actually implies', () => {
    expect(engine).toMatch(/p_rake_rate:\s*spinRakeRate\(buyIn\)/);
  });
});

describe('the draw sets the prize and the payout shape - never the stack', () => {
  /**
   * This used to require `starting_chips: tier?.startingStack`, which was the
   * wheel choosing how many chips the players had. Dan retired that on
   * 2026-09-01: the stack belongs to the board (Turbo 300, Deep Stack 1000),
   * so it is known at buy-in and the seat can hold it immediately. The other
   * three writes are unchanged - the prize, the blinds and the payout shape do
   * still come from the drawn tier.
   */
  it('start rewrites blinds, payouts and pool from the tier', () => {
    expect(engine).toMatch(/blind_structure:\s*spinBlinds/);
    expect(engine).toMatch(/payout_structure:/);
    expect(engine).toMatch(/prize_pool:\s*prizePool/);
  });

  it('and does NOT rewrite the stack from the tier', () => {
    expect(engine).not.toMatch(/starting_chips:\s*tier\?\.startingStack/);
    expect(engine).not.toMatch(/tournament\.starting_chips\s*=\s*tier\.startingStack/);
    // What it does write is the board's own number, unchanged.
    expect(engine).toMatch(/starting_chips:\s*tournament\.starting_chips/);
  });

  it('start updates the IN-MEMORY structure too, not just the row', () => {
    // The level timer and table creation read the in-memory object; a
    // DB-only write would leave this start running placeholder blinds.
    //
    // 2026-09-02: the direct `tournament.blind_structure = spinBlinds` assignment
    // was refactored into `applySpinDrawPatch(spinRowPatch, tournament, cache)`,
    // which generically copies EVERY key of spinRowPatch (including blind_structure)
    // onto both in-memory targets. `blind_structure: spinBlinds` is still in the
    // patch object (pinned by the test above), and SpinDrawIntegrity.guard.test.ts
    // pins that applySpinDrawPatch copies every key. Together they are the same
    // guarantee — this test now verifies the new wiring pattern.
    expect(engine).toMatch(/applySpinDrawPatch\s*\(/);
    expect(engine).toMatch(/applySpinDrawPatch\([^)]*spinRowPatch/);
  });

  it('creation writes an honest placeholder, not a fake tier', () => {
    expect(recurring).toMatch(/SPIN_TIERS\[0\]/);
  });
});
