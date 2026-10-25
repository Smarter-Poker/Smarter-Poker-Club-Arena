/**
 * V53 PRESSURE harness (2026-10-24): real HandController cash hands where five
 * horses play one seat modelled on WooWoo's measured PLO play against the
 * fleet (production, SELECT only, 849 PLO5 hands 2026-10-23..24):
 *
 *   - opens the pot with ~76% of hands, re-raises ~48% of opens, calls most of
 *     the rest, and never folds to a 3-bet (it 4-bets its best hands);
 *   - postflop bets ~3/4 pot when checked to with made hands, draws and a
 *     share of air; facing a bet it folds unless it holds two pair or a real
 *     draw, and raises sets and better;
 *   - on the river it bets value (straights and better) plus a few bluffs, and
 *     calls a river bet only with a flush or better.
 *
 * Each arm plays the SAME decks hand for hand (the shuffle is keyed by the
 * hand number) with stacks reset to 100bb every hand; arm A is production
 * (V53 on), arm B sets `v53Pressure: false`. The result is the horses' net in
 * big blinds per 100 hands plus the line counts Dan named: 3-bets of the
 * human's open, check-raises of the human's flop bet, and river bets made
 * first to act with the human still in.
 */
import type { Card, HandConfig, HorseStyle, SeatPlayer } from '../types.js';
import { HandController } from './HandController.js';
import { HorseLogic, type HorseDecideOpts } from './HorseLogic.js';
import { HorseMind, readScopeOf } from './HorseMind.js';
import {
  omahaPreflopPercentile,
  omahaQuickCategory,
  omahaStrongDrawShape,
  seedFastRandom,
} from './HorseEval.js';
import { Deck } from './PokerEngine.js';
import { drainFires, enableBrainTelemetry } from './BrainTelemetry.js';
import {
  controllerDecisionState,
  controllerSpotRandom,
} from './remainingVariants/RemainingVariantControllerSpots.test-support.js';
import type { RemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';

export const AGGRO_HUMAN = '30000000-0000-4000-8000-00000000a660';
const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const STYLES: readonly HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];

export interface PressureTally {
  hands: number;
  /** horses' combined net, in big blinds */
  horseNetBB: number;
  /** facing the human's single open, no callers: fold / flat / 3-bet */
  vsOpen: { fold: number; call: number; raise: number };
  /** checked, then faced the human's flop bet heads-up: fold / call / raise */
  vsFlopBet: { fold: number; call: number; raise: number };
  /** first to act on the river (no bet yet) with the human in, heads-up */
  riverFirst: { check: number; bet: number };
  /** the human's answer to a horse river bet */
  humanVsRiverBet: { fold: number; call: number };
  /** the horse 3-bet the human preflop, heads-up flop, horse to act with no bet: check / bet */
  threeBettorFlop: { check: number; bet: number };
  /** the same pot on the turn after the horse bet the flop and was called: check / bet */
  threeBettorTurn: { check: number; bet: number };
  /** V53 telemetry fires (the live worker decides with telemetry on too) */
  fires: Record<string, number>;
}

const fresh = (): PressureTally => ({
  hands: 0,
  horseNetBB: 0,
  vsOpen: { fold: 0, call: 0, raise: 0 },
  vsFlopBet: { fold: 0, call: 0, raise: 0 },
  riverFirst: { check: 0, bet: 0 },
  humanVsRiverBet: { fold: 0, call: 0 },
  threeBettorFlop: { check: 0, bet: 0 },
  threeBettorTurn: { check: 0, bet: 0 },
  fires: {},
});

type Menu = NonNullable<ReturnType<HandController['getAuthoritativeActionState']>>;

/** The WooWoo model's action, from its own cards only (no peeking). */
function humanAction(
  c: HandController,
  seat: number,
  menu: Menu,
  r: () => number
): { action: string; amount?: number } {
  const live = c.getState();
  const me = live.players.find((p) => p.seat === seat)!;
  const hist = live.actionHistory ?? [];
  const street = live.stage;
  const potTo = live.currentBet + live.pot + menu.toCall;
  const wager = menu.legalActions.includes('raise')
    ? 'raise'
    : menu.legalActions.includes('bet')
      ? 'bet'
      : null;
  const sized = (frac: number) => {
    if (!wager || menu.minRaiseTo === null || menu.maxRaiseTo === null) return null;
    const to =
      wager === 'bet'
        ? live.pot * frac
        : live.currentBet + (live.pot + menu.toCall) * frac;
    return {
      action: wager,
      amount:
        Math.round(Math.min(menu.maxRaiseTo, Math.max(menu.minRaiseTo, Math.min(to, potTo))) * 100) /
        100,
    };
  };
  const passive = () =>
    menu.legalActions.includes('check') ? { action: 'check' } : { action: 'fold' };
  const call = () => (menu.legalActions.includes('call') ? { action: 'call' } : passive());
  if (street === 'preflop') {
    const pct = omahaPreflopPercentile(me.cards, false); // 1 = best
    const raises = hist.filter(
      (a) =>
        a.stage === 'preflop' &&
        (a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise))
    ).length;
    const mine = hist.some(
      (a) => a.stage === 'preflop' && a.userId === me.user_id && a.action === 'raise'
    );
    if (raises === 0) return pct >= 0.24 ? (sized(1) ?? call()) : menu.toCall > 0 ? passive() : passive();
    if (raises === 1 && !mine) {
      if (pct >= 0.52) return sized(1) ?? call();
      return pct >= 0.25 ? call() : passive();
    }
    if (mine && raises === 2) return pct >= 0.88 ? (sized(1) ?? call()) : call(); // never folds to a 3-bet
    return pct >= 0.75 ? call() : passive();
  }
  const board = live.communityCards;
  const cat = omahaQuickCategory(me.cards, board);
  const draw = street !== 'river' && omahaStrongDrawShape(me.cards, board);
  const facing = menu.toCall > 0;
  if (!facing) {
    if (street === 'river') return cat >= 5 || r() < 0.12 ? (sized(0.75) ?? passive()) : passive();
    const opponents = live.players.filter((p) => !p.is_folded && p.seat !== seat).length;
    const airBet = (street === 'flop' ? 0.45 : 0.3) * (opponents >= 2 ? 0.3 : 1);
    return cat >= 3 || draw || r() < airBet ? (sized(0.78) ?? passive()) : passive();
  }
  if (street === 'river') return cat >= 6 ? call() : passive();
  if (cat >= 4) return sized(1) ?? call();
  const opponents = live.players.filter((p) => !p.is_folded && p.seat !== seat).length;
  if (cat >= 3 || (draw && opponents <= 2)) return call();
  return passive();
}

export function playPressureArm(
  variant: 'plo4' | 'plo5' | 'plo6',
  hands: number,
  seed: number,
  arm: HorseDecideOpts
): PressureTally {
  const out = fresh();
  const secure = Deck.prototype.shuffle;
  let handSeed = 0;
  Deck.prototype.shuffle = function seeded(this: Deck) {
    const r = controllerSpotRandom(handSeed * 7919 + 13);
    const cards = (this as unknown as { cards: Card[] }).cards;
    for (let i = cards.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [cards[i], cards[j]] = [cards[j], cards[i]];
    }
  };
  HorseMind.reset();
  enableBrainTelemetry();
  drainFires();
  seedFastRandom(0x5eed + seed);
  const humanRandom = controllerSpotRandom(0xa660 + seed);
  try {
    const table = '40000000-0000-4000-8000-0000000000ab';
    const ids = [AGGRO_HUMAN, ...Array.from({ length: 5 }, (_, i) => uuid(i + 1))];
    const style = new Map(ids.map((id, i) => [id, STYLES[(i + 4) % 5]]));
    const bb = 2;
    const seats = 6;
    for (let hand = 0; hand < hands; hand++) {
      handSeed = hand + seed * 100_000;
      const players: SeatPlayer[] = ids.map((user_id, i) => ({
        seat: i + 1,
        user_id,
        username: `P${i + 1}`,
        stack: 100 * bb,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: user_id !== AGGRO_HUMAN,
      }));
      const config: HandConfig = {
        tableId: table,
        handNumber: hand + 1,
        gameVariant: variant as HandConfig['gameVariant'],
        smallBlind: 1,
        bigBlind: bb,
        ante: 0,
        isTournament: false,
        rakeConfig: { percent: 5, cap: 3 * bb, noFlopNoDrop: true },
      };
      const c = new HandController(config, players, 1 + (hand % seats));
      let complete: { rake?: number; bbjFee?: number } | null = null;
      c.onEvent((e) => {
        if (e.type === 'HAND_COMPLETE') complete = e as unknown as { rake?: number; bbjFee?: number };
      });
      c.start();
      const warm = hand >= 15;
      for (let step = 0; step < 240; step++) {
        const spot = controllerDecisionState(
          c,
          variant as unknown as RemainingPolicyVariant,
          'cash',
          config
        );
        if (!spot) break;
        const menu = c.getAuthoritativeActionState(spot.hero.user_id)!;
        const hist = spot.state.actionHistory ?? [];
        const street = spot.state.stage;
        const human = spot.state.players.find((p) => p.user_id === AGGRO_HUMAN)!;
        const live = spot.state.players.filter((p) => !p.is_folded);
        let chosen: { action: string; amount?: number };
        if (spot.hero.user_id === AGGRO_HUMAN) {
          chosen = humanAction(c, spot.hero.seat, menu, humanRandom);
          if (warm && street === 'river' && menu.toCall > 0) {
            const lastAggr = [...hist]
              .reverse()
              .find((a) => a.stage === 'river' && (a.action === 'bet' || a.action === 'raise'));
            if (lastAggr && lastAggr.userId !== AGGRO_HUMAN)
              chosen.action === 'fold' ? out.humanVsRiverBet.fold++ : out.humanVsRiverBet.call++;
          }
        } else {
          HorseMind.setDecisionScope(readScopeOf(variant, seats), variant, 'cash');
          const d = HorseLogic.decide(spot.hero, spot.state, style.get(spot.hero.user_id)!, {}, {
            telemetry: true,
            ...arm,
            decisionTimeMs: 1_792_000_000_000 + hand * 60_000 + step,
            mindObservationHand: { version: 1 as const, tableId: table, handNumber: hand + 1 },
          });
          HorseMind.setDecisionScope(null);
          chosen = d;
          if (warm) {
            const aggressive = d.action === 'bet' || d.action === 'raise' || d.action === 'all_in';
            const pre = hist.filter((a) => a.stage === 'preflop');
            const preRaises = pre.filter(
              (a) => a.action === 'raise' || (a.action === 'all_in' && a.isFullRaise)
            );
            if (
              street === 'preflop' &&
              preRaises.length === 1 &&
              preRaises[0].userId === AGGRO_HUMAN &&
              !pre.some(
                (a) => a.action === 'call' && a.userId !== AGGRO_HUMAN && a.stage === 'preflop'
              )
            ) {
              if (d.action === 'fold') out.vsOpen.fold++;
              else if (aggressive) out.vsOpen.raise++;
              else out.vsOpen.call++;
            }
            const streetActs = hist.filter((a) => a.stage === street);
            const heroChecked = streetActs.some(
              (a) => a.userId === spot.hero.user_id && a.action === 'check'
            );
            const lastAggr = [...streetActs]
              .reverse()
              .find((a) => a.action === 'bet' || a.action === 'raise' || a.action === 'all_in');
            if (
              street === 'flop' &&
              live.length === 2 &&
              heroChecked &&
              menu.toCall > 0 &&
              lastAggr?.userId === AGGRO_HUMAN
            ) {
              if (d.action === 'fold') out.vsFlopBet.fold++;
              else if (aggressive) out.vsFlopBet.raise++;
              else out.vsFlopBet.call++;
            }
            const lastPreRaiser = [...preRaises].reverse()[0];
            if (
              (street === 'flop' || street === 'turn') &&
              live.length === 2 &&
              !human.is_folded &&
              menu.toCall === 0 &&
              !lastAggr &&
              preRaises.length >= 2 &&
              lastPreRaiser?.userId === spot.hero.user_id
            ) {
              const flopBetByHero = hist.some(
                (a) => a.stage === 'flop' && a.userId === spot.hero.user_id && a.action === 'bet'
              );
              const t =
                street === 'flop' ? out.threeBettorFlop : flopBetByHero ? out.threeBettorTurn : null;
              if (t) aggressive ? t.bet++ : t.check++;
            }
            if (
              street === 'river' &&
              live.length === 2 &&
              !human.is_folded &&
              menu.toCall === 0 &&
              !lastAggr
            ) {
              aggressive ? out.riverFirst.bet++ : out.riverFirst.check++;
            }
          }
        }
        let done = false;
        if (
          (chosen.action === 'bet' || chosen.action === 'raise') &&
          menu.legalActions.includes(chosen.action as never)
        )
          done = c.performAction(spot.hero.seat, chosen.action as never, chosen.amount);
        else if (chosen.action === 'all_in' && menu.legalActions.includes('all_in'))
          done = c.performAction(spot.hero.seat, 'all_in');
        else if (
          menu.legalActions.includes(chosen.action as never) &&
          chosen.action !== 'bet' &&
          chosen.action !== 'raise'
        )
          done = c.performAction(spot.hero.seat, chosen.action as never);
        if (!done)
          done = c.performAction(
            spot.hero.seat,
            menu.legalActions.includes('check') ? 'check' : 'call'
          );
        if (!done) done = c.performAction(spot.hero.seat, 'fold');
        if (!done) break;
      }
      for (let guard = 0; guard < 40 && !complete; guard++) c.continueRunout();
      if (!complete) throw new Error(`pressure harness: hand ${hand + 1} did not complete`);
      const end = c.getState();
      const done = complete as { rake?: number; bbjFee?: number };
      const total =
        end.players.reduce((n, p) => n + p.stack, 0) + (done.rake ?? 0) + (done.bbjFee ?? 0);
      if (Math.abs(total - seats * 100 * bb) > 0.05)
        throw new Error(`pressure harness: hand ${hand + 1} chips ${total} != ${seats * 100 * bb}`);
      if (warm) {
        out.hands++;
        for (const p of end.players)
          if (p.user_id !== AGGRO_HUMAN) out.horseNetBB += (p.stack - 100 * bb) / bb;
      }
      HorseMind.observeHandComplete(
        `${table}:${hand + 1}`,
        end.actionHistory,
        bb,
        null,
        readScopeOf(variant, seats)
      );
    }
  } finally {
    for (const row of drainFires())
      if (row.feature.startsWith('v53_') || row.feature.startsWith('phase7_utility_override'))
        out.fires[row.feature] = (out.fires[row.feature] ?? 0) + row.fires;
    Deck.prototype.shuffle = secure;
    HorseMind.reset();
  }
  return out;
}

export const bbPer100 = (t: PressureTally) => (t.hands > 0 ? (t.horseNetBB / t.hands) * 100 : NaN);
