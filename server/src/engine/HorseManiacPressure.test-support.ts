/**
 * Harness for the maniac-pressure layer (2026-10-22): real HandController
 * hands where five horses play against one seat that either moves ALL IN
 * preflop every hand it can ("jammer") or raises the pot every time it can
 * and never folds ("potter", the 75%+ VPIP Omaha player Dan described).
 * The hands are played by the live brain, reads included, and every horse
 * decision is tallied in the spots Dan named:
 *   - facing the maniac's all-in preflop: call or fold, and with what;
 *   - raise-then-fold: a horse that put in a voluntary raise or bet and then
 *     folded later in the same hand to the maniac's aggression.
 */
import type { Card, HandConfig, HorseStyle, SeatPlayer } from '../types.js';
import { HandController } from './HandController.js';
import { HorseLogic } from './HorseLogic.js';
import { ploPairedBoardMustFold } from './HorsePloPairedBoardFold.js';
import { HorseMind, readScopeOf } from './HorseMind.js';
import {
  holdemPreflopScore,
  restoreFastRandom,
  saveFastRandom,
  seedFastRandom,
  simulateEquity,
  variantInfo,
} from './HorseEval.js';
import { Deck, calculateRake } from './PokerEngine.js';
import { isPostflopManiac, maniacRaiseWidth } from './HorseOpponentExploit.js';
import {
  controllerDecisionState,
  controllerSpotRandom,
} from './remainingVariants/RemainingVariantControllerSpots.test-support.js';
import type { RemainingPolicyVariant } from './remainingVariants/RemainingVariantPolicyPack.js';

/** jammer: shoves every hand preflop. potter: pots every street.
 *  limppotter (2026-10-22): calls or checks preflop, then pots every street.
 *  nit (2026-10-22): checks when it can, otherwise folds - the style a
 *  maniac switches to in a style-change run. */
export type ManiacKind = 'jammer' | 'potter' | 'limppotter' | 'nit';

export interface PressureOptions {
  /** from this hand on the seat plays `then` instead of `kind` */
  switchAt?: number;
  then?: ManiacKind;
  /** starting stacks in big blinds (default 100 cash / 60 tournament) */
  stackBB?: number;
  /** false ablates the 2026-10-25 paired-board fold, for read-speed pins */
  pairedBoardFold?: boolean;
}

export interface PressureTally {
  /** facing the maniac's preflop all-in, hero not yet in voluntarily */
  vsJam: { call: number; fold: number; callScores: number[]; foldScores: number[] };
  /** facing the maniac's shove with nobody else in yet: every fold, with
   *  hero's true equity against the shover's real holding (any hand) */
  jamFoldsAlone: { equity: number; price: number; hand: number; hole: Card[] }[];
  /** hands in which a horse raised/bet voluntarily and later folded */
  raiseThenFold: number;
  /** hands in which a horse raised/bet voluntarily against the maniac */
  horseAggressedHands: number;
  /** facing any maniac bet/raise (pre or post): call vs fold */
  facing: { call: number; fold: number; raise: number };
  hands: number;
  engagedFrom: number | null;
  /** raise-then-fold by street of the fold, and by street of the horse's last aggression */
  rtfByStreet: Record<string, number>;
  /**
   * Postflop, heads-up against the maniac's bet: every fold with hero's true
   * equity against a RANDOM holding (the jammer / potter plays every hand)
   * and the price. A fold with equity above the price is a fold the maniac
   * profits from.
   */
  /** pairedBoardRule: the fold Dan ordered on 2026-10-25 (HorsePloPairedBoardFold) */
  postflopFolds: { equity: number; price: number; pairedBoardRule: boolean }[];
  postflopCalls: number;
  /** 2026-10-22: per hand, at its start, is the seat read as a preflop maniac */
  maniacReadByHand: boolean[];
  /** ...and as a postflop maniac (isPostflopManiac) */
  postflopManiacByHand: boolean[];
  /** preflop opens a horse made first in while the maniac was still to act: shoves vs raises */
  firstInVsManiac: { jam: number; raise: number };
}

const STYLES: readonly HorseStyle[] = ['tag', 'lag', 'balanced', 'tricky', 'grinder'];
export const PRESSURE_MANIAC = '30000000-0000-4000-8000-0000000faced';
const uuid = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function playManiacPressure(
  variant: string,
  mode: 'cash' | 'tournament',
  kind: ManiacKind,
  hands: number,
  seed = 11,
  warm = 15,
  options: PressureOptions = {}
): PressureTally {
  const tally: PressureTally = {
    vsJam: { call: 0, fold: 0, callScores: [], foldScores: [] },
    jamFoldsAlone: [],
    raiseThenFold: 0,
    horseAggressedHands: 0,
    facing: { call: 0, fold: 0, raise: 0 },
    hands: 0,
    engagedFrom: null,
    rtfByStreet: {},
    postflopFolds: [],
    postflopCalls: 0,
    maniacReadByHand: [],
    postflopManiacByHand: [],
    firstInVsManiac: { jam: 0, raise: 0 },
  };
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
  seedFastRandom(0x5eed + seed);
  try {
    const table = '40000000-0000-4000-8000-0000000000ab';
    const ids = [PRESSURE_MANIAC, ...Array.from({ length: 5 }, (_, i) => uuid(i + 1))];
    const style = new Map(ids.map((id, i) => [id, STYLES[(i + 4) % 5]]));
    const [sb, bb] = mode === 'cash' ? [1, 2] : [50, 100];
    const seats = 6;
    for (let hand = 0; hand < hands; hand++) {
      handSeed = hand + seed * 100_000;
      const players: SeatPlayer[] = ids.map((user_id, i) => ({
        seat: i + 1,
        user_id,
        username: `P${i + 1}`,
        stack: (options.stackBB ?? (mode === 'cash' ? 100 : 60)) * bb,
        bet: 0,
        totalInvested: 0,
        cards: [],
        is_folded: false,
        is_all_in: false,
        is_sitting_out: false,
        is_horse: user_id !== PRESSURE_MANIAC,
      }));
      const config: HandConfig = {
        tableId: table,
        handNumber: hand + 1,
        gameVariant: variant as HandConfig['gameVariant'],
        smallBlind: sb,
        bigBlind: bb,
        ante: 0,
        isTournament: mode === 'tournament',
        rakeConfig:
          mode === 'cash'
            ? { percent: 5, cap: 3 * bb, noFlopNoDrop: true }
            : { percent: 0, cap: 0, noFlopNoDrop: true },
      };
      const c = new HandController(config, players, 1 + (hand % seats));
      c.start();
      const aggressed = new Set<string>();
      const foldedAfterAggr = new Set<string>();
      const aggrStreet = new Map<string, string>();
      const counted = hand >= warm;
      if (counted) tally.hands++;
      const seatStyle =
        options.switchAt !== undefined && hand >= options.switchAt ? (options.then ?? kind) : kind;
      HorseMind.setDecisionScope(readScopeOf(variant, seats), variant);
      const startRead = HorseMind.opponentRead(PRESSURE_MANIAC);
      HorseMind.setDecisionScope(null);
      tally.maniacReadByHand.push(maniacRaiseWidth(startRead) !== null);
      tally.postflopManiacByHand.push(isPostflopManiac(startRead));
      for (let step = 0; step < 200; step++) {
        const live = c.getState();
        if (live.stage === 'pineapple_discard') {
          for (const p of live.players.filter((x) => !x.is_folded && x.cards.length === 3))
            c.performDiscard(
              p.seat,
              HorseLogic.decideDiscard(p.cards, live.communityCards, variant)
            );
          c.flushPineappleSettle();
          continue;
        }
        const spot = controllerDecisionState(c, variant as RemainingPolicyVariant, mode, config);
        if (!spot) break;
        const menu = c.getAuthoritativeActionState(spot.hero.user_id)!;
        if (spot.hero.user_id === PRESSURE_MANIAC) {
          let done = false;
          if (seatStyle === 'nit') {
            done = c.performAction(
              spot.hero.seat,
              menu.legalActions.includes('check') ? 'check' : 'fold'
            );
            if (!done) break;
            continue;
          }
          if (seatStyle === 'limppotter' && live.stage === 'preflop') {
            done = c.performAction(
              spot.hero.seat,
              menu.legalActions.includes('check') ? 'check' : 'call'
            );
            if (!done) break;
            continue;
          }
          if (seatStyle === 'jammer') {
            if (live.stage === 'preflop' && menu.legalActions.includes('all_in'))
              done = c.performAction(spot.hero.seat, 'all_in');
          } else {
            const wager = menu.legalActions.includes('raise')
              ? 'raise'
              : menu.legalActions.includes('bet')
                ? 'bet'
                : null;
            if (wager && menu.minRaiseTo !== null && menu.maxRaiseTo !== null) {
              const potTo = live.currentBet + live.pot + menu.toCall;
              const to = Math.min(menu.maxRaiseTo, Math.max(menu.minRaiseTo, potTo));
              done = c.performAction(spot.hero.seat, wager, Math.round(to * 100) / 100);
            }
          }
          if (!done && menu.legalActions.includes('all_in') && !menu.legalActions.includes('call'))
            done = c.performAction(spot.hero.seat, 'all_in');
          if (!done)
            done = c.performAction(
              spot.hero.seat,
              menu.legalActions.includes('check') ? 'check' : 'call'
            );
          if (!done) break;
          continue;
        }
        const hist = spot.state.actionHistory ?? [];
        const street = spot.state.stage;
        const pre = hist.filter((a) => a.stage === 'preflop');
        const maniacJam = pre.find((a) => a.userId === PRESSURE_MANIAC && a.action === 'all_in');
        const heroInVol = pre.some(
          (a) => a.userId === spot.hero.user_id && a.action !== 'fold' && a.action !== 'check'
        );
        const facingJam = street === 'preflop' && !!maniacJam && !heroInVol && menu.toCall > 0;
        const streetActs = hist.filter((a) => a.stage === street);
        const lastAggr = [...streetActs]
          .reverse()
          .find(
            (a) =>
              a.action === 'bet' ||
              a.action === 'raise' ||
              (a.action === 'all_in' && a.isFullRaise !== undefined)
          );
        HorseMind.setDecisionScope(readScopeOf(variant, seats), variant);
        const engaged = HorseMind.opponentRead(PRESSURE_MANIAC) !== null;
        HorseMind.setDecisionScope(null);
        if (engaged && tally.engagedFrom === null) tally.engagedFrom = hand;
        const decision = HorseLogic.decide(
          spot.hero,
          spot.state,
          style.get(spot.hero.user_id)!,
          {},
          {
            decisionTimeMs: 1_792_000_000_000 + hand * 60_000 + step,
            mindObservationHand: { version: 1 as const, tableId: table, handNumber: hand + 1 },
            ...(options.pairedBoardFold === false ? { ploPairedBoardFold: false } : {}),
          }
        );
        const act = decision.action;
        const aggressive = act === 'bet' || act === 'raise' || act === 'all_in';
        if (
          counted &&
          street === 'preflop' &&
          aggressive &&
          !pre.some((a) => a.action === 'raise' || a.action === 'all_in') &&
          !pre.some((a) => a.userId === PRESSURE_MANIAC)
        ) {
          if (act === 'all_in') tally.firstInVsManiac.jam++;
          else tally.firstInVsManiac.raise++;
        }
        if (counted) {
          if (facingJam) {
            const score =
              spot.hero.cards.length === 2
                ? holdemPreflopScore(spot.hero.cards[0], spot.hero.cards[1], false)
                : NaN;
            if (act === 'fold') {
              const alone = !pre.some(
                (a) =>
                  a.userId !== PRESSURE_MANIAC &&
                  a.userId !== spot.hero.user_id &&
                  a.action !== 'fold'
              );
              if (alone) {
                const saved = saveFastRandom();
                const eq = simulateEquity(spot.hero.cards, [], 1, variantInfo(variant), 1500);
                restoreFastRandom(saved);
                const call = Math.min(menu.toCall, spot.hero.stack);
                // This fixture's equal starting stacks have no side pots.
                // Independently price the award using its controller config;
                // the cap remains charged even when marginal rake is zero.
                const gross = spot.state.pot + call;
                const rake =
                  mode === 'cash' ? calculateRake(gross, true, config.rakeConfig!, seats) : 0;
                tally.jamFoldsAlone.push({
                  equity: eq,
                  price: call / (gross - rake),
                  hand,
                  hole: spot.hero.cards,
                });
              }
              tally.vsJam.fold++;
              tally.vsJam.foldScores.push(score);
            } else {
              tally.vsJam.call++;
              tally.vsJam.callScores.push(score);
            }
          }
          const liveOpps = spot.state.players.filter(
            (p) => !p.is_folded && p.user_id !== spot.hero.user_id
          );
          if (
            street !== 'preflop' &&
            menu.toCall > 0 &&
            lastAggr?.userId === PRESSURE_MANIAC &&
            liveOpps.length === 1
          ) {
            if (act === 'fold') {
              const saved = saveFastRandom();
              const eq = simulateEquity(
                spot.hero.cards,
                spot.state.communityCards,
                1,
                variantInfo(variant),
                1500
              );
              restoreFastRandom(saved);
              const call = Math.min(menu.toCall, spot.hero.stack);
              const pairedBoardRule =
                options.pairedBoardFold !== false &&
                ploPairedBoardMustFold({
                  gameVariant: variant,
                  hiLo: variantInfo(variant).isHiLo,
                  multiBoard: false,
                  board: spot.state.communityCards,
                  hero: spot.hero,
                  players: spot.state.players,
                  currentBet: spot.state.currentBet,
                  toCall: menu.toCall,
                  pot: spot.state.pot,
                });
              tally.postflopFolds.push({
                equity: eq,
                price:
                  call /
                  (spot.state.pot +
                    call -
                    (mode === 'cash'
                      ? calculateRake(spot.state.pot + call, true, config.rakeConfig!, seats)
                      : 0)),
                pairedBoardRule,
              });
            } else tally.postflopCalls++;
          }
          if (menu.toCall > 0 && lastAggr?.userId === PRESSURE_MANIAC) {
            if (act === 'fold') tally.facing.fold++;
            else if (aggressive && !(act === 'all_in' && menu.toCall >= spot.hero.stack))
              tally.facing.raise++;
            else tally.facing.call++;
          }
        }
        if (aggressive) {
          aggressed.add(spot.hero.user_id);
          aggrStreet.set(spot.hero.user_id, street);
        }
        if (
          act === 'fold' &&
          aggressed.has(spot.hero.user_id) &&
          lastAggr?.userId === PRESSURE_MANIAC
        ) {
          foldedAfterAggr.add(spot.hero.user_id);
          if (counted) {
            const k = `${aggrStreet.get(spot.hero.user_id)}->${street}`;
            tally.rtfByStreet[k] = (tally.rtfByStreet[k] ?? 0) + 1;
          }
        }
        let done = false;
        if ((act === 'bet' || act === 'raise') && menu.legalActions.includes(act))
          done = c.performAction(spot.hero.seat, act, decision.amount);
        else if (act === 'all_in' && menu.legalActions.includes('all_in'))
          done = c.performAction(spot.hero.seat, 'all_in');
        else if (menu.legalActions.includes(act) && act !== 'bet' && act !== 'raise')
          done = c.performAction(spot.hero.seat, act);
        if (!done)
          done = c.performAction(
            spot.hero.seat,
            menu.legalActions.includes('check') ? 'check' : 'call'
          );
        if (!done) done = c.performAction(spot.hero.seat, 'fold');
        if (!done) break;
      }
      const maniacPlayed = c
        .getState()
        .actionHistory.some((a) => a.userId === PRESSURE_MANIAC && a.action !== 'fold');
      if (counted && maniacPlayed) {
        tally.horseAggressedHands += aggressed.size;
        tally.raiseThenFold += foldedAfterAggr.size;
      }
      HorseMind.observeHandComplete(
        `${table}:${hand + 1}`,
        c.getState().actionHistory,
        bb,
        null,
        readScopeOf(variant, seats)
      );
    }
  } finally {
    Deck.prototype.shuffle = secure;
    HorseMind.reset();
  }
  return tally;
}
