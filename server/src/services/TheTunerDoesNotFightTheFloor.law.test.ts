/**
 * ═══════════════════════════════════════════════════════════════════════════
 * LAW: THE TUNER DOES NOT FIGHT THE FLOOR (2026-09-06)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The twin of TheTunerDoesNotFightTheRake, and the same class of defect: a
 * BLENDED number judged against an UNBLENDED band.
 *
 * A table with a VPIP floor (nit_game + maintain_percent_min) stands a seat
 * up after ten hands under the floor, horses included (CLAUDE.md 10.5), so
 * the brain widens toward it (HorseLogic.vpipFloorMul) and a horse there is
 * REQUIRED to play 40-70% of hands. Of the 72 cash tables the fleet played
 * on 2026-09-05, 15 were floored at a mean floor of 49.3%.
 *
 * horse_daily_play blended that play with ordinary play, the tuner judged the
 * blend against the 19-32% winning-player band, and `tightness` is a GLOBAL
 * dial - so the horse was tightened EVERYWHERE, re-widened by the floor at
 * the floored table, and played nittier at every ordinary table it sat at.
 * The loop is in the tuner's own log:
 *
 *   2026-09-03  104 of 429 tightened for "too loose", fleet VPIP .277
 *   2026-09-04  180 of 386                             fleet VPIP .312
 *   2026-09-05  216 of 383  (56%)                      fleet VPIP .338
 *
 * This law pins the whole chain, because every link is load-bearing and each
 * one is individually easy to "simplify" away:
 *
 *   1. settlement sends the table's floor with the hand;
 *   2. the hand-history writer carries it to the horse review;
 *   3. the review keys the frequency row by it, so floored and unfloored play
 *      are accumulated APART rather than summed;
 *   4. the tuner reads floored = false only;
 *   5. nothing widens the band instead - the bands are the published winning
 *      -player frequencies and moving them is the wrong fix.
 *
 * fn_audit_tuner_health is the production twin: more than 40% of tuned horses
 * tightened for "too loose" in one night is critical.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('./supabase/client.js', () => ({
  supabase: { rpc: vi.fn(async () => ({ data: 1, error: null })), from: vi.fn() },
}));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import {
  accumulateHorseNets,
  drainHorseNets,
  drainHorsePlay,
  type HorseReviewInput,
} from './HorseHandReview.js';
import { BENCH, FLOORED_TRUSTED_FROM_DAY, TUNER_STUDY_FORMAT } from './HorseSelfTuner.js';

const SRC = join(process.cwd(), 'src');
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8');

function input(over: Partial<HorseReviewInput> = {}): HorseReviewInput {
  return {
    handId: 'h-1',
    tableId: 't-1',
    tournamentId: null,
    clubId: null,
    gameVariant: 'nlh',
    bigBlind: 2,
    playedAt: '2026-09-06T12:00:00.000Z',
    potSize: 40,
    board: null,
    holeCardsAll: new Map([
      ['horse-a', { seat: 1, cards: [] }],
      ['horse-b', { seat: 2, cards: [] }],
    ]),
    contributions: new Map([
      ['horse-a', 10],
      ['horse-b', 6],
    ]),
    winners: [{ userId: 'horse-a', amount: 14 }],
    actions: [
      { seat: 1, userId: 'horse-a', action: 'raise', amount: 6, stage: 'preflop' },
      { seat: 2, userId: 'horse-b', action: 'call', amount: 6, stage: 'preflop' },
      { seat: 1, userId: 'horse-a', action: 'bet', amount: 4, stage: 'flop' },
      { seat: 2, userId: 'horse-b', action: 'fold', stage: 'flop' },
    ],
    roster: [
      { userId: 'horse-a', isHorse: true },
      { userId: 'horse-b', isHorse: true },
    ],
    rakeAmount: 0,
    buttonSeat: 2,
    ...over,
  };
}

describe('LAW: the tuner does not fight the floor', () => {
  it('floored play and free play are accumulated as separate rows, not summed', () => {
    drainHorseNets(10_000);
    drainHorsePlay(10_000);

    // Same horse, same day, same format - one hand at an ordinary table and
    // one at a table with a 60% floor.
    accumulateHorseNets(input({ handId: 'free-1', tableId: 't-free' }));
    accumulateHorseNets(input({ handId: 'floor-1', tableId: 't-floor', vpipFloor: 60 }));

    const rows = drainHorsePlay(10_000).filter((r) => r.horse_user_id === 'horse-a');
    expect(rows.length).toBe(2);
    const free = rows.find((r) => !r.floored);
    const floored = rows.find((r) => r.floored);
    expect(free, 'the unfloored hand must produce a floored = false row').toBeDefined();
    expect(floored, 'the floored hand must produce a floored = true row').toBeDefined();
    // Neither row absorbed the other: one hand each.
    expect(free!.hands).toBe(1);
    expect(floored!.hands).toBe(1);
    // Same day and format - only `floored` separates them, which is the
    // entire point: without it these two rows are one row.
    expect(free!.day).toBe(floored!.day);
    expect(free!.format).toBe(floored!.format);
  });

  it('a floor of zero, undefined or absent is free play - the old behaviour is unchanged', () => {
    drainHorseNets(10_000);
    drainHorsePlay(10_000);
    accumulateHorseNets(input({ handId: 'z-1', vpipFloor: 0 }));
    accumulateHorseNets(input({ handId: 'z-2', vpipFloor: undefined }));
    accumulateHorseNets(input({ handId: 'z-3' }));
    const rows = drainHorsePlay(10_000).filter((r) => r.horse_user_id === 'horse-a');
    expect(rows.length).toBe(1);
    expect(rows[0].floored).toBe(false);
    expect(rows[0].hands).toBe(3);
  });

  it('settlement sends the table floor with the hand, and handHistory carries it', () => {
    const settlement = read('engine/ServerTableEngineSettlement.ts');
    expect(
      settlement.includes('vpipFloor: this.vpipFloor(),'),
      'ServerTableEngineSettlement must pass the table floor into logHandHistory'
    ).toBe(true);

    const hh = read('services/supabase/handHistory.ts');
    expect(hh.includes('vpipFloor?: number;')).toBe(true);
    expect(
      hh.includes('vpipFloor: params.vpipFloor ?? 0,'),
      'logHandHistory must forward the floor to recordHorseHandReviews'
    ).toBe(true);
  });

  it('the review keys the frequency row by the floor rather than summing it away', () => {
    const review = read('services/HorseHandReview.ts');
    expect(
      review.includes('accumulateHorsePlay(input, day, format, Number(input.vpipFloor ?? 0) > 0)')
    ).toBe(true);
    expect(review.includes("`${horse}|${day}|${format}|${floored ? 'f' : 'n'}`")).toBe(true);
    expect(review.includes('floored: boolean;')).toBe(true);
  });

  it('the tuner reads unfloored rows only, and orders by the full key', () => {
    const tuner = read('services/HorseSelfTuner.ts');
    const load = tuner.slice(tuner.indexOf(".from('horse_daily_play')"));
    const block = load.slice(0, load.indexOf('.range('));
    expect(
      block.includes(".eq('floored', false)"),
      'loadPlayRows must exclude floored tables - the horse was required to be loose there'
    ).toBe(true);
    for (const col of ['horse_user_id', 'day', 'format', 'floored']) {
      expect(block.includes(`.order('${col}'`), `paged read must order by ${col}`).toBe(true);
    }
  });

  it('the fix is the input, not the band - the winning-player bands are unmoved', () => {
    // If a future change "fixes" a mass tightening by widening the VPIP band
    // instead of excluding floored play, this fails and says why.
    expect(BENCH.vpip.lo).toBeCloseTo(0.19, 5);
    expect(BENCH.vpip.hi).toBeCloseTo(0.32, 5);
  });

  /*
   * ── 2026-09-06: the same bug in two more inputs ──
   *
   * The first tuner run after the floor fix (08:01 UTC) still tightened 123
   * of 259 horses for "too loose". Two reasons, both the floor bug's shape - a
   * blended number judged against an unblended band:
   *
   *   1. hu_cash rows were loaded into the same accumulator as ring cash and
   *      judged by BENCH, whose first line says "6-max cash". Of the 123, 97
   *      had heads-up rows, 37 played more heads-up than ring, and 21 were
   *      inside the band on ring play alone.
   *   2. every horse_daily_play row written before the floor flag's first
   *      true row (03:03 UTC 2026-09-06) says floored = false for play at
   *      floored tables, and .eq('floored', false) cannot exclude play that
   *      was never labelled. Only the calendar can.
   */
  it('the bands are fed ring cash only - heads-up is not measured with the six-max ruler', () => {
    expect(TUNER_STUDY_FORMAT).toBe('cash');
    const tuner = read('services/HorseSelfTuner.ts');
    const load = tuner.slice(tuner.indexOf(".from('horse_daily_play')"));
    const block = load.slice(0, load.indexOf('.range('));
    expect(
      block.includes(".eq('format', TUNER_STUDY_FORMAT)"),
      'loadPlayRows must read one format, the ring-cash one the bands describe'
    ).toBe(true);
    expect(block.includes("'hu_cash'"), 'hu_cash must not reach the frequency bands').toBe(false);
    // The hand_history gap-filler obeys the same rule: two dealt in is heads-up.
    const stream = tuner.slice(tuner.indexOf(".from('hand_history')"));
    const streamBlock = stream.slice(0, stream.indexOf('accumulatePlayStats('));
    expect(
      streamBlock.includes('h.players.length >= 3'),
      'the hand_history fallback must drop heads-up hands before accumulating'
    ).toBe(true);
  });

  it('play rows from before the floor flag existed are not fed to the bands', () => {
    // The first floored = true row landed 2026-09-06 03:03 UTC; everything
    // earlier is unlabelled and must age out of the window unread.
    expect(FLOORED_TRUSTED_FROM_DAY).toBe('2026-09-06');
    const tuner = read('services/HorseSelfTuner.ts');
    const load = tuner.slice(tuner.indexOf('async function loadPlayRows'));
    const body = load.slice(0, load.indexOf('.range('));
    expect(
      body.includes('FLOORED_TRUSTED_FROM_DAY'),
      'the window start must be clamped to the day the floor flag became true'
    ).toBe(true);
    expect(body.includes(".gte('day', sinceDay)")).toBe(true);
  });
});
