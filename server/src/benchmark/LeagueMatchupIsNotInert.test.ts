/**
 * A LEAGUE MATCHUP THAT MEASURES NOTHING SAYS SO (2026-09-21)
 *
 * From the 2026-09-20 horse audit: v16_deep_reads reported 0.00 bb/100 with
 * stderr 0.00 over 12,000 hands every night since 2026-09-13. That is not a
 * resolved zero. In a duplicate-deal harness the two arms differ ONLY in the
 * flag under test, so an exact zero with zero variance means the flag changed
 * no decision in 12,000 hands - the arms played byte-identical poker.
 *
 * Why it did: V45 scoped reads (2026-09-05). HorseLogic.decide sets a
 * ReadScope for every decision, so in the league sandbox each opponent's
 * scoped bucket filled past SCOPE_MIN_HANDS within a few hundred hands and
 * HorseMind.readStats began answering from it. But the harness settled hands
 * through observeHandComplete WITHOUT a scope, so the c-bet, 3-bet and big-bet
 * counters the V16 reads consume were only ever mirrored into the pooled
 * bucket. The scoped bucket that now answered every read held zero
 * opportunities, every V16 accessor returned null, and the layer never fired
 * in either arm. Production passes request.scope on the same call
 * (horseDecision/workerRuntime.ts); the league now does too.
 *
 * Two pins:
 *  1. v16_deep_reads diverges between its arms at a sample the suite can
 *     afford. If a future change makes the reads unreachable again, this
 *     fails instead of a nightly row quietly reading 0.00 +/- 0.00.
 *  2. runMatchup names an inert matchup as inert. A mirror (a === b) is the
 *     one matchup that is inert BY CONSTRUCTION, and it must be flagged; a
 *     matchup whose flag reaches code must not be.
 */

import { describe, it, expect } from 'vitest';
import {
  KNOWN_MATCHUP_NAMES,
  LEAGUE_MATCHUPS,
  UNMEASURABLE_MATCHUPS,
  runMatchup,
} from './HorseLeague.js';
import { horseLeagueComputeResponseIsValid } from './HorseLeagueComputeWorkerClient.js';

describe('a league matchup that measures nothing says so', { timeout: 120_000 }, () => {
  it('v16_deep_reads is on the card and its two arms do not play identical poker', async () => {
    const card = LEAGUE_MATCHUPS.find((m) => m.name === 'v16_deep_reads');
    expect(card, 'v16_deep_reads left the standing card').toBeDefined();
    expect(card!.a).toEqual({});
    expect(card!.b).toEqual({ v16Reads: false });
    // 1000 pairs = 2000 hands. The reads need SCOPE_MIN_HANDS (40) scoped
    // hands and a 10-opportunity c-bet / 8-opportunity 3-bet sample per
    // opponent before they return anything (measured: ~35 c-bet opportunities
    // per seat after 600 sandbox hands), and in a MIRROR the read they return
    // is the fleet's own middling frequency, so the layer moves a decision
    // rarely. Measured 2026-09-21 at 1,000 pairs: 4 divergent pairs at seed
    // 4242 and 2 at seed 20260921 once the scope reaches the settlement
    // observation, 0 at both seeds before it did (and 0.00 +/- 0.00 over
    // 12,000 hands in every nightly from 2026-09-13 to 2026-09-21).
    // Rare is a measurement; zero is not. The seed is fixed, so the count is
    // deterministic for a given strategy build.
    const r = await runMatchup(card!, 1000, 4242);
    expect(r.hands).toBe(2000);
    expect(r.divergentPairs).toBeGreaterThan(0);
    expect(r.inert).toBe(false);
    expect(r.stderr).toBeGreaterThan(0);
  });

  it('a mirror matchup is inert by construction and is named as such', async () => {
    const r = await runMatchup({ name: 'mirror', a: {}, b: {} }, 120, 20260921);
    expect(r.divergentPairs).toBe(0);
    expect(r.inert).toBe(true);
    expect(r.bb100).toBe(0);
    expect(r.stderr).toBe(0);
  });

  it('a matchup whose flag reaches code is not inert', async () => {
    const r = await runMatchup({ name: 'v11', a: {}, b: { v11: false } }, 120, 20260921);
    expect(r.divergentPairs).toBeGreaterThan(0);
    expect(r.inert).toBe(false);
  });

  it('an empty matchup is not called inert - it was not run', async () => {
    const r = await runMatchup({ name: 'never', a: {}, b: { v11: false } }, 5, 1, () => false);
    expect(r.hands).toBe(0);
    expect(r.inert).toBe(false);
  });

  /* Production runs every matchup in the compute worker, and the parent
     refuses any IPC result whose keys it does not know exactly. The first
     version of this change added the two evidence fields without teaching
     that boundary, and the worker's real-simulator test failed with
     "malformed IPC response": the whole nightly card would have been
     refused. The boundary now knows both shapes and checks the evidence
     agrees with itself. */
  it('the worker boundary accepts the divergence evidence and refuses it when it contradicts itself', async () => {
    const r = await runMatchup({ name: 'v11', a: {}, b: { v11: false } }, 20, 20260921);
    const wrap = (result: unknown) => ({ type: 'MATCHUP_RESULT', jobId: 1, result });
    expect(horseLeagueComputeResponseIsValid(wrap(r))).toBe(true);
    const { divergentPairs: _d, inert: _i, ...assembled } = r;
    expect(horseLeagueComputeResponseIsValid(wrap(assembled))).toBe(true);
    expect(horseLeagueComputeResponseIsValid(wrap({ ...r, inert: !r.inert }))).toBe(false);
    expect(horseLeagueComputeResponseIsValid(wrap({ ...r, divergentPairs: r.hands }))).toBe(false);
    expect(horseLeagueComputeResponseIsValid(wrap({ ...r, divergentPairs: -1 }))).toBe(false);
    expect(horseLeagueComputeResponseIsValid(wrap({ ...r, inert: undefined }))).toBe(false);
  });
});

/**
 * A MATCHUP THE LEAGUE WILL NOT MEASURE SAYS SO OUT LOUD (2026-09-27)
 *
 * The sibling failure to an inert row. v16_ratio_rescale, v31_gto_suit_aware
 * and v18_exploit_size were each retired by COMMENTING THEM OUT, which removes
 * the row entirely - and `fn_audit_nightly_job_health` raises
 * `league_matchup_inert` only from rows WHERE hands > 0. A matchup with no row
 * is invisible to the detector built to catch exactly this.
 *
 * The cost was measurable in the audit: `league_card_stale` still advised
 * fixing the runner so v16_ratio_rescale could satisfy "any three-run gate",
 * 22 days after it left the card. Nothing could move that decision, because
 * nothing in the database admitted the experiment had been stopped.
 *
 * These pins make the silent removal impossible: the name has to live in one
 * of the two lists, and a registry entry has to carry its reasoning.
 */
describe('a matchup the league refuses to measure says so', () => {
  it('names every retired matchup, with the reasoning attached', () => {
    const retired = ['v16_ratio_rescale', 'v31_gto_suit_aware', 'v18_exploit_size'];
    for (const name of retired) {
      const entry = UNMEASURABLE_MATCHUPS.find((m) => m.name === name);
      expect(entry, `${name} vanished from both the card and the refusal registry`).toBeDefined();
      // Every field reaches the refusal row, so an empty one is a silent row.
      expect(entry!.reason.length).toBeGreaterThan(80);
      expect(entry!.lastMeasuredOnCard.length).toBeGreaterThan(10);
      expect(entry!.divergenceProbes.length).toBeGreaterThan(10);
      expect(entry!.whatWouldChangeIt.length).toBeGreaterThan(30);
    }
  });

  it('keeps the card and the refusal registry disjoint and complete', () => {
    const card = LEAGUE_MATCHUPS.map((m) => m.name);
    const refused = UNMEASURABLE_MATCHUPS.map((m) => m.name);
    for (const name of refused) {
      expect(card, `${name} is both measured and refused`).not.toContain(name);
    }
    expect(new Set(KNOWN_MATCHUP_NAMES).size).toBe(card.length + refused.length);
  });

  it('keeps the two watched matchups ON the card', () => {
    // v16_deep_reads measures again since #5052; shortdeck_v17 is under an
    // ablation watch. Either one leaving the card silently would strand its
    // verdict the way the three above were stranded.
    const card = LEAGUE_MATCHUPS.map((m) => m.name);
    expect(card).toContain('v16_deep_reads');
    expect(card).toContain('shortdeck_v17');
  });

  it('still cannot tell the two arms apart, which is why they are refused', async () => {
    // The registry claims these are inert. A claim nobody rechecks is how the
    // card went stale in the first place, so recheck it at the documented
    // seed. If either of these starts diverging the layer became REACHABLE:
    // put it back on the card rather than relaxing this pin.
    for (const name of ['v16_ratio_rescale', 'v31_gto_suit_aware']) {
      const entry = UNMEASURABLE_MATCHUPS.find((m) => m.name === name)!;
      const seats = name === 'v31_gto_suit_aware' ? 2 : undefined;
      const r = await runMatchup({ name: entry.name, seats, a: entry.a, b: entry.b }, 1000, 4242);
      expect(r.divergentPairs, `${name} now diverges - put it back on the card`).toBe(0);
      expect(r.inert).toBe(true);
    }
  }, 240_000);
});
