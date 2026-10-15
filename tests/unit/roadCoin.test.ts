/**
 * DONKEY CROSS, CONTRACT 6: THE CLIENT VERIFIES A COIN ROAD EXACTLY LIKE THE
 * SERVER (owner request 2026-10-11).
 *
 * The receipts below are real: tests/fixtures/diamond-spins/crossing-coin-postgres-receipts.json
 * was captured from the installed migration
 * (20261012113806_donkey_cross_flips_a_fair_coin_every_street.sql) on the
 * isolated Postgres 17 fixture, playing paid rounds through fn_choice_start,
 * fn_choice_act and fn_diamond_bonus_replay, then rolled back. Every coin is
 * re-flipped here from the revealed seed, and one changed byte must fail.
 */
import { describe, expect, it } from 'vitest';
import receipts from '../fixtures/diamond-spins/crossing-coin-postgres-receipts.json';
import {
  ROAD_COIN_REFERENCE_CENTS,
  ROAD_COIN_V6 as ROAD_COIN_VERSION,
  roadCoin,
  roadCoinEnd,
  roadCoinPrizes,
  roadCoins,
} from '../../src/utils/roadCoin';
import {
  choiceRoundVerified,
  roadRoundLadder,
  verifyChoiceRoundDetailed,
} from '../../src/utils/diamondChoiceMath';
import { parseChoiceRound, parseChoiceState } from '../../src/services/DiamondChoiceService';
import { parseBonusReplay } from '../../src/services/DiamondReplayService';
import { choiceNextOdds } from '../../src/utils/choiceProgressiveGuarantee';
import { hmacSha256Hex } from '../../src/utils/wheelFairness';

type Rec = Record<string, unknown>;
const of = (kind: string) =>
  structuredClone((receipts as { kind: string; value: Rec }[]).find((r) => r.kind === kind)!.value);
const FINISHED = ['cashed_ran_on', 'cashed_next_hit', 'lost_street_one', 'lost_later'];

describe('a contract-6 road verifies on this device exactly as the server dealt it', () => {
  it.each(FINISHED)('%s: every check passes on the real receipt', async (kind) => {
    const round = parseChoiceRound(of(kind));
    expect(round.payout_version).toBe(ROAD_COIN_VERSION);
    const verdict = await verifyChoiceRoundDetailed(round);
    expect(verdict).toEqual({ seal: true, draw: true, prizes: true, payout: true });
    // The coins this device flips are the coins the server revealed.
    const proof = round.proof!;
    expect(
      await roadCoins(proof.server_seed, proof.client_seed, proof.nonce, round.max_steps, ROAD_COIN_VERSION)
    ).toEqual(proof.coins);
    expect(proof.road_end).toBe(roadCoinEnd(proof.coins!));
  });

  it('a coin is the first HMAC byte below 128, for street one too', async () => {
    const proof = parseChoiceRound(of('lost_street_one')).proof!;
    const hash = await hmacSha256Hex(
      proof.server_seed,
      `${proof.client_seed}:${proof.nonce}:street:1`
    );
    expect(Number.parseInt(hash.slice(0, 2), 16) < 128).toBe(false);
    expect(await roadCoin(proof.server_seed, proof.client_seed, proof.nonce, 1, ROAD_COIN_VERSION)).toBe(false);
    expect(proof.road_end).toBe(0);
  });

  it('a flipped coin, a moved road end or a wrong ladder fails its own check', async () => {
    const round = parseChoiceRound(of('cashed_ran_on'));
    const coins = [...round.proof!.coins!];
    coins[7] = !coins[7];
    const flipped = { ...round, proof: { ...round.proof!, coins } };
    expect((await verifyChoiceRoundDetailed(flipped)).draw).toBe(false);
    const moved = { ...round, proof: { ...round.proof!, road_end: round.proof!.road_end! + 1 } };
    expect((await verifyChoiceRoundDetailed(moved)).draw).toBe(false);
    const priced = { ...round, prizes: round.prizes.map((p, i) => (i === 1 ? p + 0.01 : p)) };
    expect((await verifyChoiceRoundDetailed(priced)).prizes).toBe(false);
    // The parser refuses the forged ladder and the forged road end before any page sees them.
    expect(() => parseChoiceRound({ ...of('cashed_ran_on'), prizes: priced.prizes })).toThrow();
    expect(() =>
      parseChoiceRound({ ...of('cashed_ran_on'), proof: { ...round.proof, road_end: 9 } })
    ).toThrow();
  });

  it('contract 6 is Donkey Cross alone: a Mines receipt claiming it is refused', () => {
    const forged = { ...of('cashed_ran_on'), game: 'mines', mode: '6' };
    expect(() => parseChoiceRound(forged)).toThrow();
  });

  it('a booked win reveals how far the donkey would have gone, from its coins', () => {
    const ranOn = parseChoiceRound(of('cashed_ran_on'));
    expect(ranOn.status).toBe('cashed');
    expect(ranOn.proof!.road_end).toBeGreaterThan(ranOn.picked.length);
    const nextHit = parseChoiceRound(of('cashed_next_hit'));
    expect(nextHit.proof!.road_end).toBe(nextHit.picked.length);
    // The losses keep half the last safe prize, or the floor on street one.
    expect(parseChoiceRound(of('lost_street_one')).payout_chips).toBe(12.5);
    const later = parseChoiceRound(of('lost_later'));
    expect(later.payout_chips).toBe(Math.max(12.5, Math.ceil(later.prizes[0] * 50) / 100));
  });

  it('an open contract-6 round reveals no coin, and its odds read 50% from street one', () => {
    const open = parseChoiceRound(of('open'));
    expect(open.status).toBe('open');
    expect(open.proof).toBeNull();
    expect(choiceNextOdds('crossing', 0, open.prizes, 12.5, ROAD_COIN_VERSION)).toEqual({
      safe: 50,
      loss: 50,
    });
  });

  it('the quote names contract 6 and its ladder is this floor’s own coin ladder', () => {
    const quote = of('quote');
    const state = parseChoiceState(
      { ...quote, history: [], open_round: null },
      String(of('open').club_id),
      'crossing'
    );
    expect(state.payout_version).toBe(ROAD_COIN_VERSION);
    expect(state.prizes).toEqual(roadCoinPrizes(25, 12.5, ROAD_COIN_VERSION).slice(0, state.max_steps));
    // The reference road a NEW round is quoted from is contract 7's (street one sure).
    expect(ROAD_COIN_REFERENCE_CENTS).toEqual([80, 110, 165, 247, 370, 555, 832, 1248, 1872, 2000]);
  });

  it('the scene paints the round’s own ladder', () => {
    const round = parseChoiceRound(of('cashed_ran_on'));
    expect(roadRoundLadder(round)?.slice(0, 3)).toEqual([110, 165, 247.48]);
  });

  it.each(FINISHED)(
    '%s: the replay agrees with the receipt on the coins and the street',
    (kind) => {
      const replay = parseBonusReplay(of(`${kind}_replay`));
      const round = parseChoiceRound(of(kind));
      if (replay.game !== 'crossing') throw new Error('not a road');
      expect(replay.data.coins).toEqual(round.proof!.coins);
      expect(replay.data.road_end).toBe(round.proof!.road_end);
      expect(replay.data.street_multipliers!.length).toBe(round.prizes.length);
    }
  );

  it('every receipt is genuinely verified, not merely parsed', async () => {
    for (const kind of FINISHED)
      expect(choiceRoundVerified(await verifyChoiceRoundDetailed(parseChoiceRound(of(kind))))).toBe(
        true
      );
  });
});
