import { prepareJointPots } from './multiway/JointPotDistribution.js';
import type { SeatPlayer } from '../types.js';
import type { HorseGameStateV2 } from './HorseLogic.js';
import { omahaBoatsAbove, omahaMadeClass } from './HorseEval.js';

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** Default-off structural candidate, not a calibrated continuing-range EV claim.
 * Only removes the value band's random call after its existing safety gates.
 * Ratios are conservative implementation choices awaiting qualification.
 * NLH is unsupported: this blocker pattern needs three distinct hole cards.
 */
export function smallPotNearNutRiverValue(hero: SeatPlayer, gs: HorseGameStateV2): boolean {
  const count = ({ plo4: 4, plo5: 5, plo6: 6 } as Record<string, number>)[gs.gameVariant];
  if (
    !count ||
    gs.stage !== 'river' ||
    gs.gameMode !== 'cash' ||
    !['chips', 'diamonds'].includes(gs.asset ?? '') ||
    gs.tournament ||
    gs.boardCount !== 1 ||
    gs.communityCards2?.length ||
    gs.communityCards3?.length ||
    gs.bombPot ||
    gs.allInOrFold ||
    gs.bettingStructure !== 'pot_limit' ||
    !Array.isArray(gs.pots) ||
    !gs.legalActions?.includes('raise') ||
    !finite(gs.minRaiseTo) ||
    !finite(gs.maxRaiseTo) ||
    gs.maxRaiseTo < gs.minRaiseTo ||
    !finite(gs.pot) ||
    !finite(gs.currentBet) ||
    gs.currentBet <= 0 ||
    !finite(gs.toCall) ||
    gs.toCall !== gs.currentBet ||
    gs.bbjConfig === undefined ||
    (gs.bbjConfig !== null &&
      (typeof gs.bbjConfig.enabled !== 'boolean' ||
        !finite(gs.bbjConfig.feeBB) ||
        gs.bbjConfig.feeBB < 0 ||
        !finite(gs.bbjConfig.minPotBB) ||
        gs.bbjConfig.minPotBB < 0 ||
        !Number.isInteger(gs.bbjConfig.minPlayersDealt) ||
        gs.bbjConfig.minPlayersDealt < 2 ||
        gs.bbjConfig.minPlayersDealt > 10)) ||
    !gs.rakeConfig ||
    !finite(gs.rakeConfig.percent) ||
    !finite(gs.rakeConfig.cap) ||
    gs.rakeConfig.percent < 0 ||
    gs.rakeConfig.percent > 100 ||
    gs.rakeConfig.cap < 0 ||
    hero.cards.length !== count ||
    gs.communityCards.length !== 5
  )
    return false;
  const ids = new Set<string>();
  const seats = new Set<number>();
  for (const p of gs.players) {
    if (
      !p.user_id ||
      ids.has(p.user_id) ||
      !Number.isInteger(p.seat) ||
      seats.has(p.seat) ||
      !finite(p.stack) ||
      p.stack < 0 ||
      !finite(p.bet) ||
      p.bet < 0 ||
      !finite(p.totalInvested) ||
      p.totalInvested < p.bet ||
      typeof p.is_folded !== 'boolean' ||
      typeof p.is_all_in !== 'boolean'
    )
      return false;
    ids.add(p.user_id);
    seats.add(p.seat);
  }
  const live = gs.players.filter((p) => !p.is_folded);
  const self = live.find((p) => p.user_id === hero.user_id);
  const opp = live.find((p) => p.user_id !== hero.user_id);
  if (
    live.length !== 2 ||
    !self ||
    self.seat !== hero.seat ||
    self.stack !== hero.stack ||
    self.bet !== hero.bet ||
    self.totalInvested !== hero.totalInvested ||
    !opp ||
    live.some((p) => p.is_all_in || p.stack <= 0) ||
    hero.bet !== 0 ||
    opp.bet !== gs.currentBet ||
    gs.players.some((p) => p.is_folded && p.bet !== 0)
  )
    return false;
  if (gs.chipUnit !== 0.01 && gs.chipUnit !== 1) return false;
  try {
    const prepared = prepareJointPots(gs.players, gs.chipUnit);
    // The settlement owner proves the only refund is the opening bet.
    if (
      prepared.refunds[opp.user_id] !== opp.bet ||
      Object.entries(prepared.refunds).some(([id, amount]) => id !== opp.user_id && amount !== 0) ||
      prepared.pots.some(
        (p) =>
          p.eligiblePlayers.length !== 2 ||
          !p.eligiblePlayers.includes(hero.user_id) ||
          !p.eligiblePlayers.includes(opp.user_id)
      ) ||
      Math.abs(gs.players.reduce((n, p) => n + p.totalInvested, 0) - gs.pot) > gs.chipUnit / 1e4
    )
      return false;
    // Supplied layers can include that proven refundable opening contribution,
    // but never a second contested eligibility set.
    if (
      gs.pots.some(
        (p) =>
          !finite(p.amount) ||
          p.amount < 0 ||
          !(
            (p.eligiblePlayers.length === 2 &&
              p.eligiblePlayers.includes(hero.user_id) &&
              p.eligiblePlayers.includes(opp.user_id)) ||
            (p.eligiblePlayers.length === 1 &&
              p.eligiblePlayers[0] === opp.user_id &&
              p.amount === opp.bet)
          )
      )
    )
      return false;
  } catch {
    return false;
  }
  const river = gs.actionHistory?.filter((a) => a.stage === 'river');
  if (!river?.length) return false;
  const last = river[river.length - 1];
  if (
    last.action !== 'bet' ||
    last.userId !== opp.user_id ||
    last.seat !== opp.seat ||
    last.amount !== opp.bet ||
    river
      .slice(0, -1)
      .some(
        (a) =>
          a.action !== 'check' || !live.some((p) => p.user_id === a.userId && p.seat === a.seat)
      )
  )
    return false;
  const known = [...hero.cards, ...gs.communityCards];
  if (
    new Set(known.map((c) => `${c.rank}:${c.suit}`)).size !== known.length ||
    known.some(
      (c) =>
        !'23456789TJQKA'.includes(c.rank) ||
        c.rank.length !== 1 ||
        !['clubs', 'diamonds', 'hearts', 'spades'].includes(c.suit)
    )
  )
    return false;
  const ranks = new Map<string, number>();
  for (const c of gs.communityCards) ranks.set(c.rank, (ranks.get(c.rank) ?? 0) + 1);
  if (
    [...ranks.values()].sort().join(',') !== '1,1,1,2' ||
    omahaMadeClass(hero.cards, gs.communityCards).category !== 7
  )
    return false;
  const above = omahaBoatsAbove(hero.cards, gs.communityCards);
  if (above.quads !== 0 || above.boats > 1) return false;
  const beforeBet = gs.pot - opp.bet;
  const effective = Math.min(hero.stack + hero.bet, opp.stack + opp.bet);
  return (
    beforeBet > 0 &&
    beforeBet <= 0.25 * effective &&
    opp.bet <= 0.1 * effective &&
    opp.bet <= 0.5 * beforeBet
  );
}
