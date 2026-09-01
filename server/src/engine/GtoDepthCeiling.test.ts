/**
 * THE WAREHOUSE DOES NOT KNOW HOW TO PLAY 800 BIG BLINDS (2026-09-01).
 *
 * MEASURED. `DEPTH_BUCKETS` stops at 150 and `snapDepthBucket` returns 150 for
 * ANY stack over 110, so every consult from a 400bb or an 800bb hero was
 * answered with 150bb strategy - silently, with no miss recorded, and
 * `gto_depth_fallback` firing only when the cell came from a non-primary
 * bucket, which this is not: 150 IS the primary for 800.
 *
 * `depthCandidates` already refuses the mirror image of this error and states
 * the principle: answering a 150bb hero from the 10 cell is "the one
 * substitution more dangerous than the texture substitution these files
 * explicitly refuse to make, because a 10bb solver jams and stacks off exactly
 * where a 150bb player must not." Serving 150bb strategy eight hundred blinds
 * deep is that same error with the sign flipped, and it had no guard.
 *
 * The ceiling sits at twice the deepest bucket because the buckets are
 * geometric: log(300/150) equals log(20/10), the widest substitution the depth
 * fallback already makes. Past it the consult declines rather than
 * extrapolates, and the heuristic layers - which scale continuously with stack
 * depth - play the spot.
 *
 * The related evidence, from the same day's audit: 4 of the 10 largest losses
 * were deep tournament preflop stackoffs (JJ in for 40,788, AKs for 40,000,
 * TT for 21,693) and `gto_depth_fallback` fired 874 times. This ceiling does
 * not by itself fix a preflop shove - these layers are postflop - but it
 * removes the extrapolation that made deep spots read like 150bb spots.
 */
import { describe, it, expect } from 'vitest';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';
import {
  GTO_MAX_DEPTH_BB,
  beyondGtoDepthCeiling,
  snapDepthBucket,
  depthCandidates,
} from './GtoPostflop.js';
import { sliceEnclosingBlock } from '../testHelpers/sourceWindow.js';

describe('GTO depth ceiling', () => {
  it('sits at twice the deepest bucket', () => {
    // The deepest cell the warehouse holds is 150bb.
    expect(snapDepthBucket(150)).toBe(150);
    expect(snapDepthBucket(10_000)).toBe(150);
    expect(GTO_MAX_DEPTH_BB).toBe(300);
  });

  it('is the same log distance the depth fallback already tolerates', () => {
    // The buckets are geometric, so this is the point of the number: the
    // ceiling is not a round figure, it is one bucket-width past the deepest
    // cell, measured the way depthCandidates measures nearness.
    const ceilingDistance = Math.log(GTO_MAX_DEPTH_BB / 150);
    const widestTolerated = Math.log(20 / 10);
    expect(ceilingDistance).toBeCloseTo(widestTolerated, 10);
    // And the fallback really does span that distance.
    expect(depthCandidates(10)).toContain(20);
  });

  it('admits every depth the warehouse can honestly answer', () => {
    for (const bb of [1, 10, 20, 40, 80, 110, 150, 200, 299, 300]) {
      expect(beyondGtoDepthCeiling(bb), `${bb}bb must still consult`).toBe(false);
    }
  });

  it('refuses the depths it cannot', () => {
    for (const bb of [301, 400, 800, 2000]) {
      expect(beyondGtoDepthCeiling(bb), `${bb}bb must decline`).toBe(true);
    }
  });

  it('never declines on a nonsense stack - that is a miss, not a ceiling', () => {
    // A bad input must fall through to the ordinary lookup path and be
    // recorded as whatever it really is. Declining here would hide a data
    // problem behind a strategy guard.
    for (const bb of [0, -5, NaN, Infinity]) {
      expect(beyondGtoDepthCeiling(bb as number)).toBe(false);
    }
  });
});

describe('the wiring in HorseLogic', () => {
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, 'HorseLogic.ts'),
    'utf8'
  );

  it('both consults are gated, and the flag defaults on', () => {
    expect(src).toContain('(opts.v33DepthCeiling ?? true) !== false && beyondGtoDepthCeiling');
    // Once for the open-node consult (V29/V30/V31), once for V32 facing.
    const gates = src.match(/beyondGtoDepthCeiling\(/g) ?? [];
    expect(gates.length).toBe(2);
  });

  it('a skip for depth is not counted as a coverage miss', () => {
    // This is the part that would quietly corrupt the number the whole
    // exercise exists to produce: if declining for depth incremented
    // v32_defend_no_range, the coverage figure would improve or worsen with
    // the fleet's stack depth rather than with the warehouse's contents.
    expect(src).toContain('} else if (!tooDeep32 && telemetryOn(opts)) {');
    expect(src).toContain("noteFire('gto_skip_too_deep')");
  });

  it('misses are recorded against a depth band and a street', () => {
    expect(src).toContain("noteGtoMiss('v31', street, stackBB29)");
    expect(src).toContain("noteGtoMiss('v32', street, stackBB32)");
  });

  it('the miss bands stay low-cardinality', () => {
    // Five bands and four streets per layer. The full
    // street x family x position x depth product would be ~432 rows a day and
    // nobody would read it.
    const fn = src.slice(src.indexOf('function missDepthBand'), src.indexOf('/** Record one miss'));
    const returns = fn.match(/return '/g) ?? [];
    expect(returns.length).toBeLessThanOrEqual(6);
  });
});

describe('the solver stack is measurable at all', () => {
  const league = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'benchmark', 'HorseLeague.ts'),
    'utf8'
  );

  it('every solver layer has an ablation matchup', () => {
    // Before 2026-09-01 none of them did: V29 through V32 shipped, displaced
    // the V15-V23 layers on the spots they answer, and nothing on the card
    // could say whether the trade was positive.
    for (const flag of [
      'v29GtoFlop',
      'v30GtoTurnRiver',
      'v31GtoSuitAware',
      'v32FacingDefense',
      'v33DepthCeiling',
    ]) {
      expect(league, `${flag} needs a league matchup`).toContain(`{ ${flag}: false }`);
    }
  });

  it('the depth-ceiling matchup is dealt deeper than the ceiling', () => {
    // Dealt at 100bb it would measure nothing and report 0.00 +/- 0.00
    // forever - exactly the inert-matchup shape the daily audit now flags.
    expect(league.indexOf('v33_depth_ceiling_400bb')).toBeGreaterThan(-1);
    // The matchup's own object literal, not 300 bytes from where its name
    // happens to sit. A byte window drifts off the end of the thing it guards
    // the moment a comment is added above it, and it can drift off it while
    // staying GREEN - which is how a fixed window took the whole estate's
    // publish down for 39 minutes on 2026-08-28. See
    // tests/unit/noFixedSizeSourceWindows.test.ts, which rejects this shape.
    const entry = sliceEnclosingBlock(league, 'v33_depth_ceiling_400bb');
    const stack = /stackBB: (\d+)/.exec(entry);
    expect(stack).not.toBeNull();
    expect(Number(stack![1])).toBeGreaterThan(GTO_MAX_DEPTH_BB);
  });
});
