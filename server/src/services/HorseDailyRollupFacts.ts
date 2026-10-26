import { accumulatePlayStats, freshPlay } from './HorsePlayStats.js';
import { allocateWeightedShareCents } from './rakeAllocation.js';
import type { HorseReviewInput, HorseNetRow, HorsePlayRow } from './HorseHandReview.js';

export interface HorseDailyRollupFacts {
  version: 1;
  nets: HorseNetRow[];
  play: HorsePlayRow[];
}

/** Capture once, before acceptance, alongside the hand's immutable stats.
 * Both denominators describe the same dealt horses, including forced-only
 * hands with no voluntary actions. No action replay is used to price nets. */
export function buildHorseDailyRollupFacts(input: HorseReviewInput): HorseDailyRollupFacts {
  const bb = input.bigBlind > 0 ? input.bigBlind : 1;
  const day = input.playedAt.slice(0, 10);
  const format =
    input.format ||
    (input.tournamentId
      ? 'tournament'
      : (input.holeCardsAll.size || input.roster.length) === 2
        ? 'hu_cash'
        : 'cash');
  const returned = new Map<string, number>();
  for (const w of input.winners) returned.set(w.userId, (returned.get(w.userId) ?? 0) + w.amount);
  const tracked = new Set(
    input.roster
      .filter(
        (p) =>
          p.isHorse &&
          p.userId &&
          (input.holeCardsAll.size
            ? input.holeCardsAll.has(p.userId)
            : (input.contributions.get(p.userId) ?? 0) !== 0 || (returned.get(p.userId) ?? 0) !== 0)
      )
      .map((p) => p.userId)
  );
  const contributions = [...input.contributions.entries()];
  const rake = allocateWeightedShareCents(input.rakeAmount ?? 0, contributions);
  const bbj = allocateWeightedShareCents(input.bbjAmount ?? 0, contributions);
  const stats = accumulatePlayStats(
    [
      {
        actions: input.actions,
        players: input.holeCardsAll.size
          ? [...input.holeCardsAll].map(([userId, p]) => ({ userId, seat: p.seat }))
          : input.roster.map((p) => ({ userId: p.userId })),
        winners: input.winners,
        big_blind: bb,
        button_seat: input.buttonSeat ?? null,
      },
    ],
    tracked,
    new Map()
  );
  const nets: HorseNetRow[] = [];
  const play: HorsePlayRow[] = [];
  // Shared horses at different tables take aggregate keys in one order.
  for (const horse of [...tracked].sort()) {
    const s = stats.get(horse) ?? freshPlay();
    nets.push({
      horse_user_id: horse,
      day,
      game_variant: input.gameVariant,
      format,
      hands: 1,
      net_bb: ((returned.get(horse) ?? 0) - (input.contributions.get(horse) ?? 0)) / bb,
      rake_bb: (rake.get(horse) ?? 0) / bb,
      bbj_bb: (bbj.get(horse) ?? 0) / bb,
    });
    play.push({
      horse_user_id: horse,
      day,
      format,
      floored: (input.vpipFloor ?? 0) > 0,
      hands: 1,
      vpip: s.vpip,
      pfr: s.pfr,
      three_bets: s.threeBets,
      three_bet_opps: s.threeBetOpps,
      open_raises: s.openRaises,
      faced_3bets: s.faced3Bets,
      fold_to_3bets: s.foldTo3Bets,
      saw_flop: s.sawFlop,
      won_when_saw_flop: s.wonWhenSawFlop,
      post_aggr: s.postAggr,
      post_passive: s.postPassive,
    });
  }
  return { version: 1, nets, play };
}
