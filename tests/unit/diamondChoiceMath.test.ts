import { describe, expect, it } from 'vitest';
import {
  choose,
  minePrize,
  MINE_COUNTS,
  RANDOM_SPACE,
  ROAD_LADDERS,
  roadSurvives,
  roundedMinePrize,
  verifyChoiceRound,
  verifyChoiceRoundDetailed,
} from '../../src/utils/diamondChoiceMath';
import fixtures from '../fixtures/diamond-spins/local-postgres-receipts.json';

describe('Diamond choice games keep the edge once per round', () => {
  it('every Mines stopping point returns exactly four fifths before cent rounding', () => {
    for (const mines of MINE_COUNTS) {
      for (let k = 1; k <= 25 - mines; k++) {
        for (const bet of [0.25, 0.26, 1, 1.01, 2, 5, 10, 50]) {
          const p = minePrize(bet, mines, k);
          expect(p.numerator * choose(25 - mines, k) * 5n).toBe(
            4n * BigInt(Math.round(bet * 100)) * choose(25, k) * p.denominator
          );
        }
      }
    }
  });
  it('every road ladder boundary has the same expected return within the RNG grain', () => {
    for (const ladder of Object.values(ROAD_LADDERS)) {
      for (const target of ladder) {
        const wins = (80n * RANDOM_SPACE) / BigInt(target);
        expect(roadSurvives(wins - 1n, target)).toBe(true);
        expect(roadSurvives(wins, target)).toBe(false);
        expect(80n * RANDOM_SPACE - wins * BigInt(target)).toBeLessThan(BigInt(target));
      }
    }
  });
  it('cent rounding cannot add a second edge', () => {
    const p = minePrize(1, 5, 2);
    const floor = p.numerator / p.denominator;
    const cutoff = ((p.numerator % p.denominator) * RANDOM_SPACE) / p.denominator;
    expect(roundedMinePrize(p.numerator, p.denominator, 0n)).toBe(floor + 1n);
    expect(roundedMinePrize(p.numerator, p.denominator, cutoff)).toBe(floor);
    expect(roundedMinePrize(200n, 1n, RANDOM_SPACE - 1n)).toBe(200n);
  });
  it('rejects unsupported mine counts, impossible reveals, and invalid RNG values', () => {
    expect(() => minePrize(1, 0, 1)).toThrow();
    expect(() => minePrize(1, 15, 11)).toThrow();
    expect(() => roadSurvives(-1n, 110)).toThrow();
    expect(() => roadSurvives(RANDOM_SPACE, 110)).toThrow();
  });
});

/**
 * EVERY FINISHED ROUND CAN CHECK ITSELF (2026-09-22). Proving a round meant
 * opening a collapsed panel, decoding an unlabelled 64-character hash and
 * pressing a button within the five seconds before the receipt left for the
 * wheel. The page checks every finished round in the background now, so the
 * verifier has to say WHICH of the four checks failed - and it must never
 * throw on numbers bad enough to break one of them, or the other three are
 * lost with it.
 */
describe('a finished round proves itself, check by check', () => {
  const all = { seal: true, draw: true, prizes: true, payout: true };
  const receipts = fixtures.receipts as Record<string, Record<string, unknown>>;
  const round = (game: 'crossing' | 'mines', change: Record<string, unknown> = {}) =>
    ({ ...receipts[game], ...change }) as unknown as Parameters<typeof verifyChoiceRound>[0];

  it.each(['crossing', 'mines'] as const)(
    'passes every check on a real %s receipt',
    async (game) => {
      expect(await verifyChoiceRoundDetailed(round(game))).toEqual(all);
      expect(await verifyChoiceRound(round(game))).toBe(true);
    }
  );

  it('fails the seal alone when the revealed seed is not the sealed one', async () => {
    const tampered = round('crossing', {
      proof: { ...receipts.crossing.proof, server_seed_hash: 'a'.repeat(64) },
    });
    expect(await verifyChoiceRoundDetailed(tampered)).toEqual({ ...all, seal: false });
    expect(await verifyChoiceRound(tampered)).toBe(false);
  });

  it('fails the draw alone when the road roll is not the one the seed makes', async () => {
    const tampered = round('crossing', {
      proof: { ...receipts.crossing.proof, road_roll: '1' },
    });
    expect(await verifyChoiceRoundDetailed(tampered)).toEqual({ ...all, draw: false });
  });

  it('fails the payout alone when the settled chips are not the sealed draw', async () => {
    const tampered = round('crossing', { payout_chips: 99 });
    expect(await verifyChoiceRoundDetailed(tampered)).toEqual({ ...all, payout: false });
  });

  it('fails the prizes alone when a rung of the ladder is not this stake', async () => {
    const prizes = [...(receipts.crossing.prizes as number[])];
    prizes[3] = 999;
    expect(await verifyChoiceRoundDetailed(round('crossing', { prizes }))).toEqual({
      ...all,
      prizes: false,
    });
  });

  it('says false rather than throwing on numbers no formula can take', async () => {
    // A stake of nothing makes roadSurvives, the ladder and the rounding draw
    // all throw. The seal is still checkable, and still says so.
    const broken = round('crossing', { bet_chips: 0 });
    await expect(verifyChoiceRoundDetailed(broken)).resolves.toEqual({
      seal: true,
      draw: false,
      prizes: false,
      payout: false,
    });
  });

  it('proves nothing about a round with no proof, or no pick', async () => {
    const none = { seal: false, draw: false, prizes: false, payout: false };
    expect(await verifyChoiceRoundDetailed(round('crossing', { proof: null }))).toEqual(none);
    expect(await verifyChoiceRoundDetailed(round('crossing', { picked: [] }))).toEqual(none);
  });
});
