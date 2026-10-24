/**
 * V53 TOURNAMENT FLAG CARDS (2026-10-24)
 *
 * The Omaha tournament pressure layer (v53PloTourneyIcm) is measured where it
 * acts: paired whole PLO4/PLO5/PLO6 tournaments, flag on against flag off,
 * through the real HandController, against the human-calibrated field.
 *
 * Pins:
 *  1. Six cards (three variants x MTT and Sit & Go), arm A = flag on, arm B
 *     = today's brain, three locked held-out seeds.
 *  2. A card is NOT inert: on a real short run the flag changes hero
 *     decisions (counted counterfactually in arm A), and the Omaha deal
 *     plays whole tournaments with no illegal action or chip error, against
 *     both the horse field and the human-calibrated Omaha field.
 *  3. The locked decision (summarizeTournamentFlagCard) needs every held-out
 *     seed's pairs covered exactly once and a 99% interval above zero.
 *  4. The worker boundary accepts a card result and refuses a forged one.
 */
import { describe, expect, it } from 'vitest';
import {
  TOURNAMENT_FLAG_CARDS,
  TOURNAMENT_FLAG_CARD_PAIRS,
  TOURNAMENT_FLAG_CARD_SEEDS,
  TOURNAMENT_PROMOTION_SEEDS,
  runTournamentLeague,
  summarizeTournamentFlagCard,
  tournamentRunCanPromote,
  type TournamentLeagueResult,
} from './HorseTournamentLeague.js';
import { horseLeagueComputeResponseIsValid } from './HorseLeagueComputeWorkerClient.js';
import { HUMAN_CALIBRATED_POPULATION_ID } from './HumanCalibratedPopulation.js';

describe('V53 tournament flag cards', { timeout: 900_000 }, () => {
  it('defines one card per PLO variant and payout format, flag on against today', () => {
    expect(TOURNAMENT_FLAG_CARDS.map((c) => c.name)).toEqual([
      'plo4_v53_icm_mtt',
      'plo4_v53_icm_sng',
      'plo5_v53_icm_mtt',
      'plo5_v53_icm_sng',
      'plo6_v53_icm_mtt',
      'plo6_v53_icm_sng',
    ]);
    for (const card of TOURNAMENT_FLAG_CARDS) {
      expect(card.a).toEqual({ v53PloTourneyIcm: true });
      expect(card.b).toEqual({});
    }
    // Held out: none of them is a Phase 8 promotion seed.
    expect(TOURNAMENT_FLAG_CARD_SEEDS).toHaveLength(3);
    for (const seed of TOURNAMENT_FLAG_CARD_SEEDS)
      expect(TOURNAMENT_PROMOTION_SEEDS).not.toContain(seed);
  });

  it('refuses an unknown card, a card on the wrong objective, and a shard past the locked range', async () => {
    await expect(
      runTournamentLeague({ objective: 'sng', pairs: 1, seed: 1, flagCard: 'nope' })
    ).rejects.toThrow('Unknown tournament flag card');
    await expect(
      runTournamentLeague({ objective: 'mtt', pairs: 1, seed: 1, flagCard: 'plo4_v53_icm_sng' })
    ).rejects.toThrow('Unknown tournament flag card');
    await expect(
      runTournamentLeague({
        objective: 'sng',
        pairs: 2,
        seed: 1,
        flagCard: 'plo4_v53_icm_sng',
        firstPair: TOURNAMENT_FLAG_CARD_PAIRS - 1,
      })
    ).rejects.toThrow('Invalid tournament flag card shard');
  });

  it('a PLO4 card plays whole tournaments and the flag changes hero decisions (not inert)', async () => {
    const r = await runTournamentLeague({
      objective: 'sng',
      pairs: 1,
      seed: 53_101_101,
      flagCard: 'plo4_v53_icm_sng',
    });
    expect(r.complete).toBe(true);
    expect(r.flagCard).toBe('plo4_v53_icm_sng');
    expect(r.gameVariant).toBe('plo4');
    expect(r.illegalActions).toBe(0);
    expect(r.conservationErrors).toBe(0);
    expect(r.truncatedHands).toBe(0);
    expect(r.cardDecisions).toBeGreaterThan(10);
    expect(r.cardChanged).toBeGreaterThan(0);
    expect(r.promotionEligible).toBe(false);
    expect(tournamentRunCanPromote({ ...r, evidenceMode: 'promotion' })).toBe(false);
    expect(
      horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result: r })
    ).toBe(true);
    // A forged card result is refused at the worker boundary.
    for (const forged of [
      { ...r, gameVariant: 'plo6' },
      { ...r, flagCard: 'plo4_v53_icm_mtt' },
      { ...r, cardChanged: (r.cardDecisions ?? 0) + 1 },
    ])
      expect(
        horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result: forged })
      ).toBe(false);
  });

  it('a PLO6 card plays against the human-calibrated Omaha field', async () => {
    const r = await runTournamentLeague({
      objective: 'sng',
      pairs: 1,
      seed: 53_102_203,
      flagCard: 'plo6_v53_icm_sng',
      opponentPopulation: HUMAN_CALIBRATED_POPULATION_ID,
    });
    expect(r.complete).toBe(true);
    expect(r.gameVariant).toBe('plo6');
    expect(r.opponentPopulation).toBe(HUMAN_CALIBRATED_POPULATION_ID);
    expect(r.illegalActions).toBe(0);
    expect(r.conservationErrors).toBe(0);
    expect(r.truncatedHands).toBe(0);
    const responses = Object.values(r.humanResponses ?? {}).flatMap((n) => Object.values(n));
    expect(responses.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
  });

  describe('the locked decision', () => {
    const shard = (
      seed: number,
      firstPair: number,
      pairs: number,
      mean: number,
      se: number,
      extra: Partial<TournamentLeagueResult> = {}
    ): TournamentLeagueResult =>
      ({
        flagCard: 'plo5_v53_icm_mtt',
        gameVariant: 'plo5',
        objective: 'mtt',
        seed,
        firstPair,
        pairs,
        requestedPairs: pairs,
        complete: true,
        meanDifference: mean,
        standardError: se,
        illegalActions: 0,
        conservationErrors: 0,
        truncatedHands: 0,
        cardDecisions: 1000,
        cardChanged: 40,
        ...extra,
      }) as TournamentLeagueResult;
    const full = (mean: number, se: number, extra: Partial<TournamentLeagueResult> = {}) =>
      TOURNAMENT_FLAG_CARD_SEEDS.flatMap((seed) =>
        [0, 512].map((from) => shard(seed, from, 512, mean, se, extra))
      );

    it('a card with a 99% interval above zero over every held-out pair wins', () => {
      const s = summarizeTournamentFlagCard('plo5_v53_icm_mtt', full(0.03, 0.01));
      expect(s.measured).toBe(true);
      expect(s.pairs).toBe(3 * TOURNAMENT_FLAG_CARD_PAIRS);
      expect(s.confidence99[0]).toBeGreaterThan(0);
      expect(s.wins).toBe(true);
    });

    it('a positive but unresolved card does not win', () => {
      const s = summarizeTournamentFlagCard('plo5_v53_icm_mtt', full(0.003, 0.2));
      expect(s.measured).toBe(true);
      expect(s.wins).toBe(false);
    });

    it('a missing shard, a doubled shard, an inert card or an integrity fault is not a measurement', () => {
      const runs = full(0.05, 0.01);
      expect(summarizeTournamentFlagCard('plo5_v53_icm_mtt', runs.slice(1)).reasons).toContain(
        `${TOURNAMENT_FLAG_CARD_SEEDS[0]}:pairs_not_covered_exactly_once`
      );
      expect(summarizeTournamentFlagCard('plo5_v53_icm_mtt', [...runs, runs[0]]).measured).toBe(
        false
      );
      expect(
        summarizeTournamentFlagCard('plo5_v53_icm_mtt', full(0.05, 0.01, { cardChanged: 0 }))
          .reasons
      ).toContain('inert');
      expect(
        summarizeTournamentFlagCard('plo5_v53_icm_mtt', full(0.05, 0.01, { illegalActions: 1 }))
          .wins
      ).toBe(false);
      expect(
        summarizeTournamentFlagCard('plo5_v53_icm_mtt', [
          ...runs.slice(1),
          shard(TOURNAMENT_FLAG_CARD_SEEDS[0], 0, 512, 0.05, 0.01, { seed: 999 }),
        ]).measured
      ).toBe(false);
    });
  });
});
