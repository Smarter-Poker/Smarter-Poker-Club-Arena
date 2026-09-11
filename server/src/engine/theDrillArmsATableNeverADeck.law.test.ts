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
       that asked for a flat tier out of the reserve. */
    expect(drill).toMatch(/claim\.kind === 'mini' \? 'mini' : 'main'/);
    /* Anything unrecognised - including an arm written before the column
       existed - reads as 'main', which is what those rows are. */
    expect(drill).toMatch(/kind: 'main' \| 'mini'/);
    // and the mini branch takes the drill's verdict in place of its detection
    expect(settlement).toMatch(/drillKind === 'mini' && drillResult/);
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

  it('a mini arm is guarded on the MINI, so it cannot fire into a refusal', () => {
    /* Arming against a reserve that cannot pay would burn the operator's one
       arm and pay nothing - the failure the main arm's own "refuse before
       claiming, never after" comment was written about. */
    expect(migCode).toMatch(/'mini_is_off_for_this_pool'/);
    expect(migCode).toMatch(/'reserve_cannot_cover_a_mini_payout'/);
    expect(migCode).toMatch(/'no_mini_tier_is_enabled'/);
    // the reserve must cover a payout ABOVE its floor, not merely be non-zero
    expect(migCode).toMatch(
      /backup_balance, 0\) - COALESCE\(v_mini\.mini_reserve_floor, 0\) < v_largest/
    );
  });

  it('the tier bound is the LARGEST enabled, so no BB-to-tier map is duplicated in SQL', () => {
    /* The big-blind-to-tier mapping lives in the engine. Duplicating it here
       is how two halves of one rule drift apart; the largest enabled tier is
       conservative and needs no mapping at all. */
    expect(migCode).toMatch(/max\(mt\.amount\) FILTER \(WHERE mt\.enabled\)/);
    expect(migCode).not.toMatch(/big_blind/);
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
