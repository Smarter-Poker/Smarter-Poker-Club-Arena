/**
 * P13.1 POSITIONS: the joint owner's players-behind set is the controller's
 * own preflop action order, read from the blinds the engine posted.
 *
 * `jointPlayersBehind` (JointActionModel.ts) located the preflop first actor
 * by a dealer offset (the third dealt seat clockwise of the button, the
 * fourth with a straddle). The P12.1 audit found exactly this class of defect
 * in the Phase 12 positions: with the tournament dead small blind (TDA Rule
 * 30) the engine posts only the big blind, the first dealt seat after the
 * button IS the big blind, and the dealer offset puts the first actor one
 * seat late. The response model and the Phase 7 bridge (`actsAfterHero`)
 * then treat the big blind, who still owes the option, as already closed.
 *
 * Every case is a real HandController hand: the button and blind seats come
 * from the engine's own rules (deadButtonPositions for a tournament of three
 * or more, the controller's own rotation otherwise), the controller posts
 * and acts, and the expected set is the seats the engine actually asked
 * after the hero in a limped lap. Nothing is derived from the helper's
 * arithmetic.
 */
import { describe, expect, it } from 'vitest';
import type { GameVariant, HandConfig, SeatPlayer } from '../../types.js';
import { HandController } from '../HandController.js';
import { deadButtonPositions } from '../deadButton.js';
import { controllerDecisionState } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { jointPlayersBehind } from './JointActionModel.js';
import { jointPreflopFirstSeat } from './JointResponseOrder.js';

function engineHand(
  variant: GameVariant,
  seatsNow: number[],
  table:
    | { mode: 'tournament'; last: { smallBlind: number; bigBlind: number } }
    | { mode: 'cash'; button: number; straddleSeat?: number }
) {
  const tournament = table.mode === 'tournament';
  const SB = tournament ? 10 : 1;
  const BB = tournament ? 20 : 2;
  const blinds = table.mode === 'tournament' ? deadButtonPositions(seatsNow, table.last) : null;
  const players: SeatPlayer[] = seatsNow.map((seat) => ({
    seat,
    user_id: `p${seat}`,
    username: `P${seat}`,
    stack: tournament ? 2000 : 200,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  }));
  const straddleSeat = table.mode === 'cash' ? table.straddleSeat : undefined;
  const config: HandConfig = {
    tableId: `p13-1-order-${variant}`,
    handNumber: 3,
    gameVariant: variant,
    smallBlind: SB,
    bigBlind: BB,
    ante: 0,
    isTournament: tournament,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
    ...(blinds ? { blindSeats: { smallBlind: blinds.smallBlind, bigBlind: blinds.bigBlind } } : {}),
    ...(straddleSeat ? { straddles: [{ seat: straddleSeat, amount: 2 * BB }] } : {}),
  };
  const controller = new HandController(
    config,
    players,
    blinds ? blinds.button : (table as { button: number }).button
  );
  controller.start();
  /** Every preflop decision of a limped lap: the state and who acted after. */
  const lap = () => {
    const spots: { hero: SeatPlayer; behind: string[]; first: number }[] = [];
    const order: number[] = [];
    const states: ReturnType<typeof controllerDecisionState>[] = [];
    while (controller.getState().stage === 'preflop') {
      const spot = controllerDecisionState(controller, variant as never, table.mode, config)!;
      if (!spot) break;
      if (straddleSeat) spot.state.straddleActive = true;
      states.push(spot);
      order.push(spot.hero.seat);
      const owed = controller.getAuthoritativeActionState(spot.hero.user_id)!.toCall > 0;
      expect(controller.performAction(spot.hero.seat, owed ? 'call' : 'check')).toBe(true);
    }
    states.forEach((spot, i) =>
      spots.push({
        hero: spot!.hero,
        behind: jointPlayersBehind(spot!.hero, spot!.state),
        first: jointPreflopFirstSeat(spot!.state, [...spot!.state.dealtSeatIds!]),
      })
    );
    return { order, spots };
  };
  return { blinds, controller, lap };
}

const expectEngineOrder = (hand: ReturnType<typeof engineHand>, expectedOrder: number[]) => {
  const { order, spots } = hand.lap();
  expect(order).toEqual(expectedOrder);
  spots.forEach((spot, i) => {
    expect(spot.first).toBe(order[0]);
    expect(spot.behind, `hero seat ${spot.hero.seat}`).toEqual(
      order.slice(i + 1).map((seat) => `p${seat}`)
    );
  });
};

describe('P13.1 the joint preflop action order is the engine order', () => {
  it.each(['nlh', 'plo4', 'flh'] as GameVariant[])(
    '%s: an occupied button with a dead small blind (the engine posts the big blind alone)',
    (variant) => {
      // Seat 3 posted the big blind last hand and busted: the small blind is
      // dead and the button (seat 2) is still occupied.
      const hand = engineHand(variant, [1, 2, 4, 5], {
        mode: 'tournament',
        last: { smallBlind: 2, bigBlind: 3 },
      });
      expect(hand.blinds).toEqual({ button: 2, smallBlindSeat: 3, smallBlind: null, bigBlind: 4 });
      expect(hand.controller.getBlindSeatsSnapshot()).toEqual({ smallBlind: null, bigBlind: 4 });
      expectEngineOrder(hand, [5, 1, 2, 4]);
    }
  );

  it.each(['nlh', 'plo5', 'flo8'] as GameVariant[])(
    '%s: a dead button on an empty seat (the production shape)',
    (variant) => {
      const hand = engineHand(variant, [1, 2, 4, 6, 7, 8], {
        mode: 'tournament',
        last: { smallBlind: 5, bigBlind: 6 },
      });
      expect(hand.blinds).toEqual({ button: 5, smallBlindSeat: 6, smallBlind: 6, bigBlind: 7 });
      expectEngineOrder(hand, [8, 1, 2, 4, 6, 7]);
    }
  );

  it.each(['nlh', 'short_deck', 'pineapple'] as GameVariant[])(
    '%s: an ordinary cash hand keeps the order it always had',
    (variant) => {
      const hand = engineHand(variant, [1, 2, 3, 4, 5], { mode: 'cash', button: 3 });
      expectEngineOrder(hand, [1, 2, 3, 4, 5]);
    }
  );

  it('a cash UTG straddle moves the first actor one seat past the straddler', () => {
    // Button 3, blinds 4 and 5, seat 1 straddles: seat 2 acts first, the
    // straddler last.
    const hand = engineHand('nlh', [1, 2, 3, 4, 5], { mode: 'cash', button: 3, straddleSeat: 1 });
    expectEngineOrder(hand, [2, 3, 4, 5, 1]);
  });

  it('heads-up: the button posts the small blind and acts first', () => {
    const hand = engineHand('nlh', [3, 7], { mode: 'cash', button: 7 });
    expectEngineOrder(hand, [7, 3]);
  });

  it('refuses blind seats the engine could not have posted, and a tournament without them', () => {
    const hand = engineHand('nlh', [1, 2, 4, 5], {
      mode: 'tournament',
      last: { smallBlind: 2, bigBlind: 3 },
    });
    const spot = controllerDecisionState(
      hand.controller,
      'nlh' as never,
      'tournament',
      {} as HandConfig
    )!;
    const dealt = [...spot.state.dealtSeatIds!];
    expect(() =>
      jointPreflopFirstSeat({ ...spot.state, blindSeats: { smallBlind: 5, bigBlind: 1 } }, dealt)
    ).toThrow('joint_action_blind_seats_invalid');
    expect(() => jointPreflopFirstSeat({ ...spot.state, blindSeats: null }, dealt)).toThrow(
      'joint_action_blind_seats_unavailable'
    );
    // A cash table that was not told its blinds walks them as the controller does.
    expect(
      jointPreflopFirstSeat(
        { ...spot.state, gameMode: 'cash', dealerSeat: 2, blindSeats: undefined },
        dealt
      )
    ).toBe(1);
  });
});
