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
import { readFileSync } from 'node:fs';
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
       authoritative and the drill only fills a silence. */
    expect(settlement).toMatch(
      /if \(!bbjResult\.hit\) \{\s*\n\s*drillResult = await this\.claimBBJDrill\(/
    );
    expect(settlement).toMatch(/const effectiveBbjResult = drillResult \?\? bbjResult;/);
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

  it('says in the log that the chips are real', () => {
    expect(drill).toMatch(/BBJ DRILL FIRED/);
    expect(drill).toMatch(/not a real bad beat/);
  });
});
