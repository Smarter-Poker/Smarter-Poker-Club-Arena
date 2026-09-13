/**
 * THE DRILL ARMS A TABLE, NEVER A DECK
 * ═══════════════════════════════════════════════════════════════════════════
 * BBJ build plan phase 4.1 (docs/BBJ-BUILD-PLAN.md), 2026-09-07.
 *
 * Dan asked for a "staff-only rigged deck" so the jackpot path could be
 * watched in minutes instead of the fortnight between real hits, and agreed to
 * this instead when the case was put to him:
 *
 *   `detectBBJHit` is a PURE FUNCTION with 32 tests over every qualifying
 *   rule, every variant and every rejection reason. Dealing one lucky hand
 *   proves a single case those already prove. What it costs is code inside a
 *   real-money poker engine that can choose a player's hole cards, and there
 *   is no ring-fence worth that.
 *
 * So the drill injects the VERDICT, not the cards. The showdown it rules on is
 * the real one: real players, real board, real pot. Everything downstream then
 * runs for real, because it is real.
 *
 * THIS LAW IS THE PROMISE. It is not a style rule and it is not about tidiness:
 * every pin below is a way the drill could grow into a card-rigger, or a way
 * it could arm itself without a person. If one of them turns red, read the
 * whole file before changing anything.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { sliceMethod } from '../testHelpers/sourceWindow.js';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
const settlement = read('./ServerTableEngineSettlement.ts');
const deck = read('./PokerEngine.ts');
const handController = read('./HandController.ts');

/** The drill's own method, bounded by its signature rather than a byte count. */
const drill = sliceMethod(settlement, 'private async claimBBJDrill(');

describe('the drill cannot choose a card', () => {
  it('never touches a deck, a shuffle, or a seed', () => {
    /* The single most dangerous thing that could exist in this engine is a
       path that decides what a player is dealt. The drill runs AFTER the
       showdown; it has no business naming any of these. */
    for (const forbidden of [
      /new Deck\(/,
      /\bshuffle\b/i,
      /\bseed\b/i,
      /removeCardsBelow/,
      /\.deal\(/,
      /getRemainingCards/,
    ]) {
      expect(drill, `the drill must not mention ${forbidden}`).not.toMatch(forbidden);
    }
  });

  it('never writes a player hand, hole card or board', () => {
    expect(drill).not.toMatch(/\.cards\s*=/);
    expect(drill).not.toMatch(/holeCards\s*=/);
    expect(drill).not.toMatch(/communityCards\s*=/);
    expect(drill).not.toMatch(/currentHandCommunityCards\s*=/);
  });

  it('reads the loser and the winner out of the real showdown', () => {
    /* Whoever actually sat down and actually showed down. If this ever became
       a constructed pair rather than a lookup, the drill would be inventing
       players as well as a verdict. */
    expect(drill).toMatch(/this\.currentHandShowdownResults\.find\(/);
    expect(drill).toMatch(/this\.currentHandWinnerIds\[0\]/);
  });

  it('the live deck is still crypto-shuffled and takes no injected order', () => {
    /* The other half of the promise: nothing was quietly added to the deck to
       make a drill easier. `Deck` shuffles through secureShuffle and
       HandController constructs its own - no deck, rng or seed parameter. */
    expect(deck).toMatch(/secureShuffle\(this\.cards\)/);
    expect(deck).not.toMatch(/Math\.random/);
    expect(handController).toMatch(/const deck = new Deck\(\)/);
    expect(handController).not.toMatch(/constructor\([^)]*\bdeck\b[^)]*\)/);
  });
});

describe('the drill cannot arm itself', () => {
  it('fires only on a claim the DATABASE granted', () => {
    /* Not an env var, not a config flag, not a build. A deploy cannot turn
       this on, and - the half that matters more - a deploy cannot leave it on. */
    expect(drill).toMatch(/supabase\.rpc\('fn_bbj_claim_drill'/);
    expect(drill).toMatch(/if \(!claim\?\.claimed\) return null;/);
  });

  it('reads no environment and no local flag', () => {
    expect(drill).not.toMatch(/process\.env/);
    expect(drill).not.toMatch(/NODE_ENV/);
    expect(drill).not.toMatch(/isDev|devOnly|DEV_|__DEV__/);
  });

  it('is only ever consulted when the real detector said no', () => {
    /* A drill must never overwrite a genuine bad beat: the real verdict is
       authoritative and the drill only fills a silence.

       MOVED 2026-09-11 (rule 8: a pin follows its mechanism, never weakened).
       The claim gained a KIND, so it is destructured rather than assigned
       straight into `drillResult`, and `effectiveBbjResult` now takes the
       drill's verdict only for a MAIN arm - a mini arm falls through to the
       mini's own branch instead of being paid as a share of the pool. Both
       properties below are the same ones as before, stated against the new
       shape: the drill is reached only when `bbjResult.hit` is false, and a
       real hit still wins over any drill. */
    expect(settlement).toMatch(
      /if \(!bbjResult\.hit\) \{[\s\S]{0,200}?await this\.claimBBJDrill\(/
    );
    expect(settlement).toMatch(
      /const effectiveBbjResult = drillKind === 'main' \? \(drillResult \?\? bbjResult\) : bbjResult;/
    );
  });

  it('a MINI arm is never paid as a main jackpot', () => {
    /* The arm row says which jackpot it asked for and the claim hands that
       back, because the engine cannot read the row and must not guess. A mini
       drill taking the main branch would pay a SHARE OF THE POOL for an arm
       that asked for a flat tier out of the reserve.

       ON THE RUNTIME DEFAULT, not the type annotation. The first cut asserted
       `kind: 'main' | 'mini'` beside a comment claiming it pinned "anything
       unrecognised reads as main" - it pinned neither, and would have survived
       the default being changed to 'mini'. The ternary below is the default. */
    expect(drill).toMatch(/claim\.kind === 'mini' \? 'mini' : 'main'/);
    // and the mini branch takes the drill's verdict in place of its detection
    expect(settlement).toMatch(/drillKind === 'mini' && drillResult/);
  });

  it('each family counts its own drills, so detected minus drills holds for both', () => {
    /* `bbjDrillsFiredTotal` is documented in engineInstruments AND in the
       runbook as the subtrahend in `detected - drills = genuine bad beats`.
       The first cut of the mini drill incremented it while incrementing the
       MINI's detected counter, so that subtraction under-counted genuine MAIN
       bad beats by one per mini drill and could go negative. */
    expect(drill).toMatch(/if \(kind === 'mini'\)/);
    expect(drill).toMatch(/bbjMiniDrillsFiredTotal\.inc\(1\)/);
    expect(drill).toMatch(/bbjDrillsFiredTotal\.inc\(1\)/);
    const instruments = read('../observability/engineInstruments.ts');
    expect(instruments).toContain('poker_bbj_mini_drills_fired_total');
    // seeded at zero from boot, like every counter beside it
    expect(instruments).toContain('bbjMiniDrillsFiredTotal.inc(0);');
  });

  it('a database it cannot reach means no drill, never a drill', () => {
    /* "I could not tell" is not "yes" (CLAUDE.md 10.86). Both the error and
       the throw return null, so an unreachable database settles the hand
       exactly as it would have. */
    expect(drill).toMatch(/bbj_drill_claim_failed/);
    expect(drill).toMatch(/bbj_drill_claim_threw/);
    const returns = drill.match(/return null;/g) || [];
    expect(returns.length, 'every refusal path returns null').toBeGreaterThanOrEqual(5);
  });

  it('does not ask the database on every showdown', () => {
    /* THE DEFECT THIS PINS, caught in the phase-4 deep dive before it shipped.
       The claim RPC sat on the settlement path of every contested showdown:
       137,923 round trips in twenty-four hours, measured on production, every
       one answering "no" - on an engine that is ONE core and where horse Monte
       Carlo is already 90% of it. The registry is one query a minute per
       process and this is a Set lookup; it can only delay a drill, never cause
       one, because the atomic claim is still the only thing that fires one. */
    const gateAt = drill.indexOf('await maybeArmed(this.tableId)');
    const claimAt = drill.indexOf("supabase.rpc('fn_bbj_claim_drill'");
    expect(gateAt, 'the cheap question is asked at all').toBeGreaterThan(0);
    expect(gateAt, 'and it is asked BEFORE the round trip').toBeLessThan(claimAt);
  });

  it('refuses BEFORE it claims, so an arm is never burned on a hand that cannot pay', () => {
    const claimAt = drill.indexOf("supabase.rpc('fn_bbj_claim_drill'");
    const guardAt = drill.indexOf('this.currentHandShowdownResults.length < 2');
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(claimAt);
  });
});

describe('a drill is never mistaken for a jackpot', () => {
  it('is counted on its own, so detected minus drills is the real number', () => {
    const instruments = read('../observability/engineInstruments.ts');
    expect(instruments).toContain('poker_bbj_drills_fired_total');
    expect(drill).toMatch(/bbjDrillsFiredTotal\.inc\(/);
  });

  it('says in the log which drill fired, and that the chips are real', () => {
    /* MOVED 2026-09-11 with the mechanism (rule 8). This read
       `/BBJ DRILL FIRED/` as a literal; the line now names the kind, because
       "a drill fired" is not enough when there are two jackpots and they pay
       out of different banks. The property is stronger, not weaker: the log
       must still say a drill fired and that the chips are real, AND it must
       say which one. */
    expect(drill).toMatch(/BBJ \$\{kind\.toUpperCase\(\)\} DRILL FIRED/);
    expect(drill).toMatch(/not a real bad beat/);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE MINI CAN BE DRILLED TOO (2026-09-11)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The drill above proves the MAIN payout end to end. The mini - a separate
 * product with its own reserve, its own flat tiers, its own payout RPC and its
 * own refusal reasons - could not be exercised at all: the only way to watch
 * one pay was to wait for a real one, and there have been twenty-one in its
 * whole life.
 *
 * The drill also HID it. `claimBBJDrill` is tried when the main rule refused,
 * which is exactly the case the mini exists to catch, and the drill's verdict
 * then took the main branch - so on a drill table a hand that genuinely
 * qualified for the mini never reached mini detection.
 *
 * An arm now says which jackpot it is drilling, and a mini arm is guarded on
 * the MINI's preconditions rather than the main's, so an arm cannot fire into
 * a refusal.
 */
describe('the mini drill is the mini, not a second main', () => {
  const MIG = resolve(here, '..', '..', '..', 'supabase/migrations');
  const migFile = readdirSync(MIG).find((n) => /^\d{14}_the_mini_can_be_drilled_too\.sql$/.test(n));
  if (!migFile) throw new Error('the mini drill migration is not in the tree');
  const mig = readFileSync(resolve(MIG, migFile), 'utf8');
  /* On the SQL, not the prose: the migration explains at length what the main
     arm's guards are and why the mini's differ, and asserting on raw text
     would make that explanation illegal. */
  const migCode = mig.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');

  it('an arm carries a kind, and an old row still means main', () => {
    expect(migCode).toMatch(/ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'main'/);
    expect(migCode).toMatch(/CHECK \(kind IN \('main', 'mini'\)\)/);
    // and the claim hands it back, defaulting the same way
    expect(migCode).toMatch(/COALESCE\(v_arm\.kind, 'main'\)/);
  });

  /** The corrective pass that made the arm's guard the payout's guard. */
  const fixFile = readdirSync(MIG).find((n) =>
    /^\d{14}_the_arm_asks_what_the_payout_asks\.sql$/.test(n)
  );
  if (!fixFile) throw new Error('the corrective arm migration is not in the tree');
  const fixCode = readFileSync(resolve(MIG, fixFile), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*--.*$/gm, '');

  it('the arm asks EXACTLY what the payout asks', () => {
    /* THE DEFECT THIS PINS, found by an adversarial review of the first cut.
       The guard was `backup - floor < largest_enabled_tier`; the payout asks
       `backup - parked - THIS tier's amount < floor`. Three holes, each of
       which fires the arm and then refuses the payout - the exact failure the
       guard exists to prevent. */
    // 1. the parked reserve: chips in backup_balance already owed to somebody
    expect(fixCode).toMatch(/fn_bbj_parked_reserve\(v_pool\.pool_id, 'backup'\)/);
    // 2. THIS table's tier and ITS enabled bit, not the largest tier's amount
    expect(fixCode).toMatch(/FROM public\.bbj_stakes_tiers st/);
    expect(fixCode).toMatch(/'mini_disabled_for_this_tier'/);
    // 3. the variant, which a mini drill bypasses detectMiniBBJHit to reach
    expect(fixCode).toMatch(/FROM public\.bbj_qualifying_hands q/);
    expect(fixCode).toMatch(/'variant_is_not_eligible_for_the_jackpot'/);
    /* The largest-tier bound was the defect, not a simplification of it, and
       the reasoning that justified it ("the BB-to-tier map would be duplicated
       in SQL") was wrong about the facts: bbj_stakes_tiers already carries it. */
    expect(fixCode).not.toMatch(/max\(mt\.amount\) FILTER \(WHERE mt\.enabled\)/);
  });

  it('the arm records the bank it is armed AGAINST', () => {
    /* It stored `main_balance` for a MINI arm - the one number a mini arm has
       nothing to do with - and handed it back as confirmation.

       SCOPED TO THE FUNCTION BODIES. The migration's own DO block asserts the
       same absence at apply time and therefore QUOTES the forbidden string, so
       an absence assertion over the whole file matches the check that exists
       to forbid it. A guard that trips on its own guard is the fourth
       appearance of this trap in this programme; slicing is the answer, not
       deleting the runtime assertion. */
    const bodies = fixCode.slice(0, fixCode.indexOf('DO $$'));
    expect(bodies).toMatch(/pool_balance_at_arm, note, armed_by, kind\)[\s\S]{0,140}v_armed/);
    expect(bodies).not.toMatch(/v_pool\.main_balance, p_note/);
    expect(bodies).toMatch(/v_bank\s*:=\s*'backup'/);
    expect(bodies).toMatch(/v_bank\s*:=\s*'main'/);
    // and the migration proves it again at apply time, against the live body
    expect(fixCode).toMatch(/RAISE EXCEPTION 'the arm still records the MAIN balance/);
  });

  it('already_armed is asked before any balance is read, so it cannot be masked', () => {
    /* It was LAST, so an operator with an open arm was told the pool was above
       the ceiling and went to chase a balance. The mini kinds had widened the
       set of masking refusals from two to five. */
    const armedAt = fixCode.indexOf("'already_armed'");
    const poolAt = fixCode.indexOf('fn_bbj_pool_for_club');
    expect(armedAt).toBeGreaterThan(-1);
    expect(poolAt).toBeGreaterThan(-1);
    expect(armedAt).toBeLessThan(poolAt);
  });

  it('the arms listing can tell a mini arm from a main one', () => {
    /* The surface the runbook sends an operator to for "what is armed".
       Without `kind` the two are indistinguishable - beside a balance that
       meant a different bank for each. */
    expect(fixCode).toMatch(/a\.kind,/);
    expect(fixCode).toMatch(/RETURNS TABLE\([\s\S]{0,220}kind text/);
  });

  it('a union pool is out of reach for BOTH kinds', () => {
    /* The mini pays out of the same pool's reserve, so the reason the main
       drill may never target a union pool applies unchanged. */
    expect(migCode).toMatch(/'union_pool_is_never_a_drill_target'/);
    const unionAt = migCode.indexOf("'union_pool_is_never_a_drill_target'");
    const kindSplitAt = migCode.indexOf("IF v_kind = 'main' THEN");
    expect(unionAt).toBeGreaterThan(-1);
    expect(kindSplitAt).toBeGreaterThan(-1);
    // refused BEFORE the kinds diverge, so neither branch can miss it
    expect(unionAt).toBeLessThan(kindSplitAt);
  });

  it('the main arm keeps every guard it had', () => {
    expect(migCode).toMatch(/'not_platform_admin'/);
    expect(migCode).toMatch(/'pool_above_drill_ceiling'/);
    expect(migCode).toMatch(/'pool_is_empty_nothing_to_pay'/);
    expect(migCode).toMatch(/'already_armed'/);
    expect(migCode).toMatch(/v_ceiling\s+constant numeric := 1000\.00;/);
  });

  it('a mini drill records itself as a drill, never as a real mini rule', () => {
    /* Every downstream reader of `miniRule` - the near-miss table, the
       settlement log, the notification - would otherwise record a synthetic
       verdict under a real rule's name and make a drill indistinguishable
       from the thing it drills. */
    expect(settlement).toMatch(/miniRule: 'drill' as const/);
  });
});
