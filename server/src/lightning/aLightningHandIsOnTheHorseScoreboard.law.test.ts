/**
 * LAW (2026-10-24): A SETTLED LIGHTNING HAND IS ON THE HORSE SCOREBOARD.
 *
 * Production, 2026-10-24: 7,535 Lightning hands in one hour and 0 horse hand
 * reviews - Lightning never called recordHorseHandReviews, so nothing said
 * whether the horses win in Lightning. Every settled Lightning hand now files
 * the same review input a physical table files, under its own per-stake bucket
 * `lightning_<bb>bb`:
 *
 *   1. one filing per settled hand, keyed by the committed hand id, with every
 *      participant (horse or human, CLAUDE.md 10.5) on the roster, settlement's
 *      exact contributions, the winners, the rake and the jackpot drop;
 *   2. nothing for a hand that never settled;
 *   3. the bucket keys the horse nets apart from cash, so the cash tuner (which
 *      reads only cash and hu_cash) is never moved by Lightning play;
 *   4. a Lightning host table is never touched as the horse's seat.
 */
import { describe, expect, it, vi } from 'vitest';
vi.mock('../services/supabase/client.js', () => ({
  supabase: {
    from: vi.fn(() => {
      throw Error('Unexpected database access in the Lightning law fixture');
    }),
    rpc: vi.fn(() => {
      throw Error('Unexpected database RPC in the Lightning law fixture');
    }),
  },
  maintenanceSupabase: {},
}));
vi.mock('../services/errorReporter.js', () => ({ reportError: vi.fn(), describeError: String }));
const { mulberry32 } = await import('../engine/HandFuzzer.js');
const kit = await import('../testing/lightningHostTestKit.js');
const review = await import('../services/HorseHandReview.js');

async function settledHand(base: number, horses: 'all' | 'none' | 'some' = 'some') {
  const formed = kit.formedHand(3, base);
  const set = new Set(
    horses === 'all' ? formed.players : horses === 'some' ? [formed.players[0]!] : []
  );
  const t = kit.buildHost(formed, [100, 100, 100], { horses: set });
  await t.host.start();
  await kit.playOut(t.host, mulberry32(base));
  await kit.flush(40);
  return { t, formed, set };
}

describe('LAW: a settled Lightning hand is on the horse scoreboard', () => {
  it('files exactly one review input, keyed by the committed hand, in its own stake bucket', async () => {
    const { t, formed, set } = await settledHand(9100);
    expect(t.host.lifecycle).toBe('complete');
    expect(t.scoreboard.length).toBe(1);
    const input = t.scoreboard[0]!;
    expect(input.handId).toBe(kit.uid(7777));
    expect(input.tournamentId).toBeNull();
    expect(input.format).toBe(review.lightningReviewFormat(input.bigBlind));
    expect(input.format).toMatch(/^lightning_[0-9.]+bb$/);
    expect(input.seatTouch).toBe(false);
    // Every participant, horse or human, with the horse flag as data only.
    expect(new Set(input.roster.map((r) => r.userId))).toEqual(new Set(formed.players));
    for (const r of input.roster) expect(r.isHorse).toBe(set.has(r.userId));
    // Settlement's exact money: contributions are what settlement recorded.
    const settled = t.calls.settle[0]!.results;
    for (const r of settled) expect(input.contributions.get(r.playerId)).toBe(r.contributed);
    expect(input.rakeAmount).toBe(t.calls.settle[0]!.rake);
    expect(input.bbjAmount).toBe(t.calls.settle[0]!.bbj);
    expect(input.holeCardsAll.size).toBe(formed.players.length);
    expect(input.actions.length).toBeGreaterThan(0);
  });

  it('files nothing for a hand that never settled', async () => {
    const lost = kit.buildHost(kit.formedHand(3, 9200), [100, 100, 100], { lease: () => null });
    await lost.host.start();
    await kit.flush(20);
    expect(lost.host.lifecycle).toBe('abandoned');
    expect(lost.scoreboard).toEqual([]);
  });

  it('keys the horse nets in the Lightning bucket, never in cash', async () => {
    const { t } = await settledHand(9300, 'all');
    review.drainHorseNets(100_000);
    review.drainHorsePlay(100_000);
    review.accumulateHorseNets(t.scoreboard[0]!);
    const nets = review.drainHorseNets(100_000);
    expect(nets.length).toBeGreaterThan(0);
    for (const row of nets) {
      expect(row.format).toBe(t.scoreboard[0]!.format);
      expect(['cash', 'hu_cash']).not.toContain(row.format);
    }
    // Zero-sum among an all-horse table except the rake and jackpot drop, to
    // the cent the weighted share allocator rounds each player's share to.
    const net = nets.reduce((a, r) => a + r.net_bb, 0);
    const drop = nets.reduce((a, r) => a + r.rake_bb + r.bbj_bb, 0);
    const oneCentBB = 0.01 / t.scoreboard[0]!.bigBlind;
    expect(Math.abs(net + drop)).toBeLessThanOrEqual(nets.length * oneCentBB + 1e-9);
    expect(review.drainSeatTouches(100_000)).toEqual([]);
  });

  it('the stake bucket is stable and readable', () => {
    expect(review.lightningReviewFormat(2)).toBe('lightning_2bb');
    expect(review.lightningReviewFormat(0.5)).toBe('lightning_0.5bb');
    expect(review.lightningReviewFormat(0.25)).toBe('lightning_0.25bb');
    expect(review.lightningReviewFormat(Number.NaN)).toBe('lightning_0bb');
  });
});
