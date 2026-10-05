/**
 * HORSE BRAIN PHASE 12, P12.1: a Short Deck, Crazy Pineapple, FLH or FLO8
 * proposal records the inputs it actually consumed.
 *
 * The Phase 11 template (OmahaVariantInputBinding.test.ts), applied to the
 * four remaining packs: positions from the blinds the engine posted (the
 * tournament dead button and the dead small blind, from real HandController
 * hands), the pack's own seat ceiling per mode, the named refusals, the
 * detached and frozen binding, the census with folded occupancy, Pineapple's
 * private discard recorded only as a count, and the fixed-limit street
 * geometry including a real short opening and its completion.
 */
import { describe, expect, it } from 'vitest';
import { HandController } from '../HandController.js';
import { deadButtonPositions } from '../deadButton.js';
import { seedFastRandom } from '../HorseEval.js';
import { HorseLogic } from '../HorseLogic.js';
import { horsePolicyOwnership } from '../HorsePolicyRegistry.js';
import { plo4CanonicalPosition, plo4Position } from '../plo4/Plo4LivePolicy.js';
import { drainFires, enableBrainTelemetry } from '../BrainTelemetry.js';
import { horseDecisionReceiptIsValid } from '../horseDecision/responseValidation.js';
import { occupiedButtonBlinds } from '../../benchmark/OmahaVariantPolicyEvidence.js';
import {
  remainingCards,
  remainingVariantSpot,
} from '../../benchmark/RemainingVariantPolicyEvidence.js';
import {
  evaluateRemainingVariantPolicy,
  remainingVariantInputBindingIsValid,
  remainingVariantInputBindingSha256,
  remainingVariantRangeProvenanceIsValid,
  remainingVariantReceiptBindingIsValid,
  type RemainingVariantReceipt,
} from './RemainingVariantLivePolicy.js';
import { REMAINING_VARIANT_PACKS, remainingVariantSeatCap } from './RemainingVariantPolicyPack.js';
import { sampleRemainingVariantEquity } from './RemainingVariantSampler.js';
import { controllerDecisionState } from './RemainingVariantControllerSpots.test-support.js';
import type { HandConfig, HorseDecision, SeatPlayer } from '../../types.js';

const variants = ['short_deck', 'pineapple', 'flh', 'flo8'] as const;
type Variant = (typeof variants)[number];
/** Pineapple tournaments are unavailable in the product and refused by name. */
const tournamentVariants = ['short_deck', 'flh', 'flo8'] as const;
const ownership = (variant: Variant, receipt: RemainingVariantReceipt) =>
  horsePolicyOwnership(
    variant,
    { action: receipt.baselineAction, thinkTime: 0, remainingVariantPolicy: receipt },
    true
  );
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const evaluate = (
  s: ReturnType<typeof remainingVariantSpot>,
  evidence: Parameters<typeof evaluateRemainingVariantPolicy>[3] = null
) => evaluateRemainingVariantPolicy(s.hero, s.state, s.baseline, evidence, 'shadow', () => 0);

/**
 * Real engine hands. The button and blind seats come from the engine's own
 * rules (deadButtonPositions for a tournament table of three or more, as
 * ServerTableEngineDealing applies them; HandController's own rotation
 * otherwise), and HandController posts and deals. Expected positions come
 * from what the engine did (who posted, who acts first), never from the
 * policy's arithmetic.
 */
function engineHand(
  variant: Variant,
  seatsNow: number[],
  table:
    | { mode: 'tournament'; last: { smallBlind: number; bigBlind: number } }
    | { mode: 'cash'; button: number },
  stacks: (seat: number) => number = () => (table.mode === 'cash' ? 200 : 2000)
) {
  const SB = table.mode === 'cash' ? 1 : 10;
  const BB = table.mode === 'cash' ? 2 : 20;
  const blinds = table.mode === 'tournament' ? deadButtonPositions(seatsNow, table.last)! : null;
  const players: SeatPlayer[] = seatsNow.map((seat) => ({
    seat,
    user_id: `p${seat}`,
    username: `P${seat}`,
    stack: stacks(seat),
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  }));
  const config: HandConfig = {
    tableId: `p12-1-${variant}`,
    handNumber: 7,
    gameVariant: variant,
    smallBlind: SB,
    bigBlind: BB,
    ante: 0,
    isTournament: table.mode === 'tournament',
    rakeConfig:
      table.mode === 'cash'
        ? { percent: 5, cap: 3, noFlopNoDrop: true }
        : { percent: 0, cap: 0, noFlopNoDrop: true },
    ...(blinds ? { blindSeats: { smallBlind: blinds.smallBlind, bigBlind: blinds.bigBlind } } : {}),
  };
  const controller = new HandController(
    config,
    players,
    blinds ? blinds.button : (table as { button: number }).button
  );
  controller.start();
  const view = () => {
    const spot = controllerDecisionState(controller, variant, table.mode, config)!;
    const result = evaluateRemainingVariantPolicy(
      spot.hero,
      spot.state,
      spot.baseline,
      null,
      'shadow',
      () => 0
    );
    return { ...spot, actor: spot.hero, s: spot.state, result };
  };
  const act = (action?: 'check' | 'call' | 'all_in' | 'fold') => {
    const state = controller.getState();
    const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
    const owed = controller.getAuthoritativeActionState(actor.user_id)!.toCall > 0;
    expect(
      controller.performAction(state.currentPlayerSeat, action ?? (owed ? 'call' : 'check'))
    ).toBe(true);
  };
  return { blinds, controller, view, act };
}
const posted = (controller: HandController) =>
  Object.fromEntries(
    controller
      .getState()
      .players.filter((p) => p.bet > 0)
      .map((p) => [p.seat, p.bet])
  );

describe('P12.1 defect: the tournament dead button (the P10.1 defect 3 class)', () => {
  // The production PLO4 record's shape: dealt seats 1, 2, 4, 6, 7, 8; last
  // hand seat 5 held the small blind and seat 6 the big blind; seat 5 busted.
  const PRODUCTION = { seats: [1, 2, 4, 6, 7, 8], last: { smallBlind: 5, bigBlind: 6 } };
  const EXPECTED: Record<number, [string, number]> = {
    6: ['small_blind', 1],
    7: ['big_blind', 2],
    8: ['early', 3],
    1: ['middle', 4],
    2: ['cutoff', 5],
    4: ['button', 0],
  };
  it.each(tournamentVariants)(
    '%s computes every preflop decision of a dead-button hand, positions from the posted blinds',
    (variant) => {
      const hand = engineHand(variant, PRODUCTION.seats, {
        mode: 'tournament',
        last: PRODUCTION.last,
      });
      expect(hand.blinds).toEqual({ button: 5, smallBlindSeat: 6, smallBlind: 6, bigBlind: 7 });
      expect(hand.controller.getState().dealerSeat).toBe(5);
      expect(posted(hand.controller)).toEqual({ 6: 10, 7: 20 });
      const order: number[] = [];
      for (let i = 0; i < 6; i++) {
        const { actor, baseline, result } = hand.view();
        order.push(actor.seat);
        const [position, offset] = EXPECTED[actor.seat];
        expect(result.receipt.reason).not.toBe('canonical_state_unavailable');
        expect(result.receipt).toMatchObject({ eligible: true, fired: true, position });
        expect(result.receipt.applied).toBe(false);
        expect(result.decision).toBe(baseline);
        expect(ownership(variant, result.receipt)).toMatchObject({ outcome: 'computed' });
        const inputs = result.receipt.inputs!;
        expect(remainingVariantInputBindingIsValid(clone(inputs))).toBe(true);
        expect(inputs.census).toMatchObject({
          dealerSeat: 5,
          dealtSeats: PRODUCTION.seats,
          blindSeats: { smallBlind: 6, bigBlind: 7 },
        });
        expect(inputs.positions).toMatchObject({ hero: position, heroOffset: offset });
        expect(inputs.mode).toBe('tournament');
        hand.act();
      }
      expect(order).toEqual([8, 1, 2, 4, 6, 7]);
    }
  );

  it.each(tournamentVariants)(
    '%s labels an occupied button with a dead small blind from the posted big blind',
    (variant) => {
      // Seat 3 posted the big blind last hand and busted: the small blind is
      // dead and the button (seat 2) is still occupied.
      const hand = engineHand(variant, [1, 2, 4, 5], {
        mode: 'tournament',
        last: { smallBlind: 2, bigBlind: 3 },
      });
      expect(hand.blinds).toEqual({ button: 2, smallBlindSeat: 3, smallBlind: null, bigBlind: 4 });
      expect(posted(hand.controller)).toEqual({ 4: 20 });
      const expected: Record<number, string> = {
        5: 'early',
        1: 'cutoff',
        2: 'button',
        4: 'big_blind',
      };
      const order: number[] = [];
      for (let i = 0; i < 4; i++) {
        const { actor, result } = hand.view();
        order.push(actor.seat);
        expect(result.receipt).toMatchObject({ eligible: true, position: expected[actor.seat] });
        expect(result.receipt.inputs!.census.blindSeats).toEqual({ smallBlind: null, bigBlind: 4 });
        expect(remainingVariantInputBindingIsValid(clone(result.receipt.inputs))).toBe(true);
        hand.act();
      }
      expect(order).toEqual([5, 1, 2, 4]);
    }
  );

  it('keeps the dealer-offset positions wherever the button is occupied and the small blind live', () => {
    let checked = 0;
    for (let mask = 0; mask < 1 << 10; mask++) {
      const dealt = Array.from({ length: 10 }, (_, i) => i + 1).filter((_, i) => mask & (1 << i));
      if (dealt.length < 2) continue;
      for (const dealer of dealt) {
        const blinds = occupiedButtonBlinds(dealer, dealt);
        const s = remainingVariantSpot('flh', 'preflop', 2, 'tournament');
        s.state.players = dealt.map((seat) => ({
          ...s.state.players[1],
          seat,
          user_id: `u${seat}`,
        }));
        s.state.dealerSeat = dealer;
        for (const seat of dealt) {
          expect(plo4CanonicalPosition(seat, dealer, dealt, blinds)).toBe(
            plo4Position(seat, s.state)
          );
          checked++;
        }
      }
    }
    expect(checked).toBe(28150);
  });

  it.each(variants)('%s still refuses an empty dealer at a cash table', (variant) => {
    const s = remainingVariantSpot(variant, 'preflop', 3, 'cash');
    s.state.dealerSeat = 4;
    s.state.blindSeats = { smallBlind: 1, bigBlind: 2 };
    expect(evaluate(s).receipt).toMatchObject({
      reason: 'canonical_state_unavailable',
      inputs: null,
    });
  });

  it.each(variants)(
    '%s cash hands keep the occupied-button positions they always had',
    (variant) => {
      const seats = [1, 2, 3, 4, 5];
      const hand = engineHand(variant, seats, { mode: 'cash', button: 3 });
      const first = hand.view();
      expect(first.s.blindSeats).toEqual({ smallBlind: 4, bigBlind: 5 });
      expect(first.actor.seat).toBe(1);
      expect(first.result.receipt).toMatchObject({ eligible: true, position: 'early' });
      // The legalizer's unit: whole chips at a whole big blind.
      expect(first.result.receipt.inputs!.geometry.chipUnit).toBe(1);
      expect(first.result.receipt.inputs!.mode).toBe('cash');
    }
  );

  it('still refuses a Pineapple tournament by name before any binding', () => {
    const s = remainingVariantSpot('pineapple', 'preflop', 3, 'tournament');
    expect(evaluate(s).receipt).toMatchObject({
      reason: 'pineapple_tournament_unapproved',
      eligible: false,
      inputs: null,
    });
  });
});

describe('P12.1 defect: a census above the pack ceiling is outside the domain', () => {
  const beyond = variants.flatMap((variant) =>
    (['cash', 'tournament'] as const)
      .filter((mode) => {
        const cap = remainingVariantSeatCap(variant, mode);
        return cap >= 2 && cap < 10;
      })
      .map((mode) => [variant, mode, remainingVariantSeatCap(variant, mode) + 1] as const)
  );
  it('has at least one pack ceiling below the ten-seat table', () => {
    expect(beyond.length).toBeGreaterThan(0);
  });
  it.each(beyond)('%s %s with %i dealt seats refuses by name', (variant, mode, seats) => {
    const s = remainingVariantSpot(variant, 'preflop', seats, mode);
    const r = evaluate(s);
    expect(r.receipt).toMatchObject({ reason: 'seat_count_outside_pack', inputs: null });
    expect(ownership(variant, r.receipt)).toMatchObject({ outcome: 'outside_domain' });
  });
  it.each(variants)('%s fires at exactly the ceiling for each available mode', (variant) => {
    for (const mode of ['cash', 'tournament'] as const) {
      const cap = remainingVariantSeatCap(variant, mode);
      if (cap < 2) continue;
      const r = evaluate(remainingVariantSpot(variant, 'preflop', cap, mode));
      expect(r.receipt.eligible).toBe(true);
      expect(r.receipt.inputs!.pack.seats).toEqual([2, cap]);
      expect(r.receipt.inputs!.pack.seatCapOwner).toBe(
        mode === 'cash' ? 'cash_table_seating' : 'tournament_deck_capacity'
      );
    }
  });
});

describe('P12.1 blind seats are required', () => {
  it.each(variants)('%s refuses a state without posted blind seats by name', (variant) => {
    const s = remainingVariantSpot(variant, 'river', 3);
    for (const value of [undefined, null]) {
      const state = { ...s.state, blindSeats: value };
      if (value === undefined) delete state.blindSeats;
      const r = evaluateRemainingVariantPolicy(s.hero, state, s.baseline, null, 'shadow', () => 0);
      expect(r.receipt).toMatchObject({ reason: 'blind_seats_unavailable', inputs: null });
      expect(ownership(variant, r.receipt)).toMatchObject({ outcome: 'unavailable' });
    }
  });
  it.each(variants)('%s refuses blind seats the engine could not have posted', (variant) => {
    const s = remainingVariantSpot(variant, 'river', 3);
    s.state.blindSeats = { smallBlind: 3, bigBlind: 2 };
    expect(evaluate(s).receipt).toMatchObject({
      reason: 'canonical_state_unavailable',
      inputs: null,
    });
  });
});

describe('P12.1 what the proposal records', () => {
  it.each(variants)('%s binds the preflop facts it consumed', (variant) => {
    const s = remainingVariantSpot(variant, 'preflop', 3);
    const r = evaluate(s);
    const inputs = r.receipt.inputs!;
    const pack = REMAINING_VARIANT_PACKS[variant];
    const limit = pack.structure === 'fixed_limit';
    expect(Object.isFrozen(inputs)).toBe(true);
    expect(remainingVariantInputBindingIsValid(clone(inputs))).toBe(true);
    expect(remainingVariantReceiptBindingIsValid(clone(r.receipt))).toBe(true);
    expect(inputs).toMatchObject({
      version: 'remaining-variant-input-binding-v1',
      variant,
      mode: 'cash',
      pack: {
        version: pack.version,
        holes: pack.holes,
        deck: pack.deck,
        splitPot: pack.splitLow,
        bettingStructure: pack.structure,
        source: 'explicit_variant_heuristic',
        calibratedConfidence: null,
        seats: [2, remainingVariantSeatCap(variant, 'cash')],
        seatCapOwner: 'cash_table_seating',
        maxStackBB: limit ? 1000 : 250,
        maxAnteBB: 1,
        maxRakePercent: 10,
      },
      approximation: {
        status: 'explicit_variant_heuristic',
        solverInput: false,
        handShape: {
          cardsScored: pack.holes,
          kind: 'heuristic_entry_score',
          probability: false,
        },
      },
      privateCards: {
        heroHoleCards: pack.holes,
        heroKnownDeadCards: 0,
        postDiscard: false,
        cardValues: 'not_recorded',
      },
      census: {
        source: 'legacy_player_list',
        dealerSeat: 1,
        heroSeat: 1,
        dealtSeats: [1, 2, 3],
        blindSeats: { smallBlind: 2, bigBlind: 3 },
        contestingOpponentSeats: [2, 3],
        actingOpponentSeats: [2, 3],
        foldedSeats: [],
      },
      positions: { hero: 'button', heroOffset: 0, aggressor: null, straddle: 'none' },
      board: { street: 'preflop', cards: 0, paired: null, flushBoard: null, lowPossible: null },
      range: { status: 'not_consumed_preflop', equity: null, samples: null, provenance: null },
    });
    expect(inputs.board.features).toEqual(r.receipt.features);
    const g = inputs.geometry;
    const call = s.state.currentBet - s.hero.bet;
    expect(g).toMatchObject({
      bettingStructure: pack.structure,
      chipUnit: 1,
      callCost: call,
      stackRaiseTo: s.hero.bet + s.hero.stack,
      minRaiseTo: s.state.minRaiseTo,
      maxRaiseTo: s.state.maxRaiseTo,
      postflop: null,
    });
    if (limit) {
      expect(g.noLimit).toBeNull();
      // Preflop the street bet is the small bet (the big blind) and the
      // blind is the first counted wager; the canonical raise is one bet.
      expect(g.fixedLimit).toEqual({
        smallBet: 2,
        streetBet: 2,
        completionIncrement: 2,
        completion: false,
        wagersThisStreet: 1,
        maxWagers: 4,
        wagersCapped: false,
        wagerOpen: true,
        canonicalWagerTo: s.state.minRaiseTo,
      });
    } else {
      expect(g.fixedLimit).toBeNull();
      expect(g.noLimit).toEqual({
        wagerCap: Math.min(s.state.maxRaiseTo!, s.hero.bet + s.hero.stack),
      });
    }
    expect(g.rake).toEqual({
      percent: 5,
      cap: 10,
      noFlopNoDrop: true,
      playerCountCaps: null,
      dealtCount: 3,
    });
    // Hash stable through the journal's JSON round trip.
    expect(remainingVariantInputBindingSha256(clone(inputs))).toBe(
      remainingVariantInputBindingSha256(inputs)
    );
  });

  it.each(variants)(
    '%s binds the live variant sample: contesting population, dealt deck and work',
    (variant) => {
      const s = remainingVariantSpot(variant, 'river', 4);
      // Seat 4 folded: it still occupies cards in the deck but is not scored.
      s.state.players[3].is_folded = true;
      seedFastRandom(911);
      const r = evaluate(s);
      const inputs = r.receipt.inputs!;
      expect(remainingVariantInputBindingIsValid(clone(inputs))).toBe(true);
      expect(inputs.range.status).toBe('consumed');
      expect(inputs.approximation.status).toBe(
        'explicit_variant_heuristic_with_uncalibrated_range_sample'
      );
      const provenance = inputs.range.provenance!;
      expect(provenance).toMatchObject({
        version: 'remaining-variant-range-provenance-v1',
        source: 'variant_public_line_sequential_prior',
        calibration: 'uncalibrated',
        solverInput: false,
        reads: 'public_action_line_only',
        prior: { attemptsPerSeat: 3, finalAttempt: 'uniform_escape' },
        deck: {
          physical: 'single_deck_excluding_hero_known_and_board',
          size: variant === 'short_deck' ? 36 : 52,
          dealtOpponents: 3,
          heroKnownDeadCards: variant === 'pineapple' ? 1 : 0,
        },
        discard:
          variant === 'pineapple'
            ? {
                opponents: 'declared_flop_only_structural_prior',
                hero: 'accepted_private_discard',
                actualOpponentDiscardsRead: false,
              }
            : null,
      });
      expect(provenance.opponents.map((o) => [o.userId, o.seat])).toEqual([
        ['v3', 2],
        ['v4', 3],
      ]);
      // v3 bet the river in the fixture's public line.
      expect(provenance.opponents[0]).toMatchObject({ raises: 1, calls: 0 });
      expect(provenance.work.completedSamples).toBe(inputs.range.samples);
      expect(provenance.work.requestedSamples).toBeGreaterThanOrEqual(
        provenance.work.completedSamples
      );
      expect(provenance.prior.seatDraws).toBe(provenance.work.completedSamples * 3);
      expect(provenance.prior.uniformEscapes).toBeLessThanOrEqual(provenance.prior.seatDraws);
      expect(inputs.census).toMatchObject({ contestingOpponentSeats: [2, 3], foldedSeats: [4] });
      expect(inputs.range.pots).toBe(r.receipt.equity!.perPot.length);
      expect(inputs.range.equity).toBe(r.receipt.equity!.equity);
      expect(inputs.board).toMatchObject({
        street: 'river',
        cards: 5,
        lowPossible: variant === 'flo8' ? true : null,
      });
      expect(inputs.board.features).toEqual(r.receipt.features);
      expect(inputs.geometry.postflop!.callPrice).toBe(r.receipt.callPrice);
      expect(inputs.depth.effectiveBB).toBe(r.receipt.depthBB);
      expect(Object.isFrozen(r.receipt.equity)).toBe(true);
      expect(Object.isFrozen(r.receipt.equity!.perPot)).toBe(true);
      // The folded seat occupied the deck: draws count it, scoring does not.
      expect(provenance.deck.dealtOpponents).toBe(inputs.census.dealtSeats.length - 1);
    }
  );

  it('records Pineapple private knowledge only as counts, never a card value', () => {
    const s = remainingVariantSpot('pineapple', 'turn', 3);
    const dead = s.hero.knownDeadCards![0];
    seedFastRandom(4242);
    const r = evaluate(s);
    const inputs = r.receipt.inputs!;
    expect(inputs.privateCards).toEqual({
      heroHoleCards: 2,
      heroKnownDeadCards: 1,
      postDiscard: true,
      cardValues: 'not_recorded',
    });
    expect(inputs.approximation.handShape.cardsScored).toBe(2);
    expect(r.receipt.features).toContain('private_discard_excluded');
    // No card of any kind is listed in the binding or the consumed sample:
    // not the hero's private dead card, not its retained pair, not the board.
    for (const text of [JSON.stringify(inputs), JSON.stringify(r.receipt.equity)]) {
      expect(text).not.toMatch(/"rank"|"suit"/);
      expect(text).not.toContain(`${dead.rank}${dead.suit[0]}`);
    }
    // The sample excluded it from the deck, recorded as a count.
    expect(inputs.range.provenance!.deck.heroKnownDeadCards).toBe(1);
    // Without the accepted discard there is nothing to bind: refused by name.
    const withoutDiscard = remainingVariantSpot('pineapple', 'turn', 3);
    withoutDiscard.hero.knownDeadCards = [];
    const refused = evaluate(withoutDiscard);
    expect(refused.receipt).toMatchObject({ reason: 'known_discard_unavailable', inputs: null });
  });

  it.each(variants)('%s records an external sample as consumed but unattributed', (variant) => {
    const s = remainingVariantSpot(variant, 'river', 3);
    seedFastRandom(17);
    const evidence = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true)!;
    delete evidence.range;
    evidence.provenance = 'independent_offline_oracle';
    evidence.analysisMs = 0;
    const r = evaluateRemainingVariantPolicy(
      s.hero,
      s.state,
      s.baseline,
      evidence,
      'shadow',
      () => 0,
      1,
      false
    );
    expect(r.receipt.inputs!.range).toMatchObject({
      status: 'consumed_unattributed',
      provenance: null,
      equity: evidence.equity,
      samples: evidence.samples,
    });
    expect(remainingVariantInputBindingIsValid(clone(r.receipt.inputs))).toBe(true);
    // A copy, never the caller's object, and later mutation does not reach it.
    expect(r.receipt.equity).not.toBe(evidence);
    expect(r.receipt.equity).toEqual(evidence);
    const recorded = clone(r.receipt.equity);
    evidence.equity = 0.123;
    evidence.perPot[0].eligiblePlayers.push('someone-else');
    evidence.distribution[0].probability = 99;
    expect(clone(r.receipt.equity)).toEqual(recorded);
  });

  it.each(variants)(
    '%s never echoes caller evidence on a path that did not consume it',
    (variant) => {
      const river = remainingVariantSpot(variant, 'river', 3);
      seedFastRandom(17);
      const evidence = sampleRemainingVariantEquity(variant, river.hero, river.state, () => true)!;
      const preflop = remainingVariantSpot(variant, 'preflop', 3);
      const r = evaluateRemainingVariantPolicy(
        preflop.hero,
        preflop.state,
        preflop.baseline,
        evidence,
        'shadow',
        () => 0,
        1,
        false
      );
      expect(r.receipt.eligible).toBe(true);
      expect(r.receipt.equity).toBeNull();
      const refused = evaluateRemainingVariantPolicy(
        river.hero,
        { ...river.state, bettingStructure: 'pot_limit' },
        river.baseline,
        evidence,
        'shadow',
        () => 0
      );
      expect(refused.receipt).toMatchObject({ eligible: false, equity: null, inputs: null });
    }
  );

  it.each(variants)('%s refuses malformed evidence and records it as rejected', (variant) => {
    const s = remainingVariantSpot(variant, 'river', 3);
    seedFastRandom(17);
    const evidence = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true)!;
    evidence.analysisMs = 0;
    evidence.equity = Number.NaN;
    const r = evaluate(s, evidence);
    expect(r.receipt).toMatchObject({
      eligible: true,
      fired: false,
      reason: 'invalid_equity_evidence',
      equity: null,
    });
    expect(r.receipt.inputs!.range).toMatchObject({ status: 'rejected_malformed', equity: null });
    expect(r.receipt.inputs!.approximation.status).toBe('explicit_variant_heuristic');
    expect(remainingVariantInputBindingIsValid(clone(r.receipt.inputs))).toBe(true);
    expect(() => JSON.parse(JSON.stringify(r.receipt))).not.toThrow();
  });

  it.each(variants)('%s records an exhausted budget as unavailable', (variant) => {
    const s = remainingVariantSpot(variant, 'river', 3);
    // The sampler gets no time at all: no sample, so nothing is consumed.
    const r = evaluateRemainingVariantPolicy(
      s.hero,
      s.state,
      s.baseline,
      null,
      'shadow',
      (() => {
        let t = 0;
        return () => (t += 3);
      })()
    );
    expect(r.receipt.eligible).toBe(true);
    expect(r.receipt.fired).toBe(false);
    expect(['equity_budget_unavailable', 'work_budget']).toContain(r.receipt.reason);
    expect(r.receipt.inputs!.range.status).toBe('unavailable');
    expect(remainingVariantInputBindingIsValid(clone(r.receipt.inputs))).toBe(true);
  });

  const population = [
    [
      'a folded seat',
      (p: any) => (p.opponents = [{ ...p.opponents[0], userId: 'v5', seat: 4 }, p.opponents[1]]),
    ],
    ['a missing contesting opponent', (p: any) => (p.opponents = [p.opponents[0]])],
    [
      'a player from another table',
      (p: any) => (p.opponents = [{ ...p.opponents[0], userId: 'elsewhere' }, p.opponents[1]]),
    ],
    [
      'a deck without the folded seat',
      (p: any) => {
        p.deck = { ...p.deck, dealtOpponents: 2 };
        p.prior = { ...p.prior, seatDraws: p.work.completedSamples * 2 };
      },
    ],
  ] as const;
  it.each(
    variants.flatMap((v) => population.map(([label, corrupt]) => [v, label, corrupt] as const))
  )('refuses a %s sample drawn against %s', (variant, _label, corrupt) => {
    const s = remainingVariantSpot(variant, 'river', 4);
    s.state.players[3].is_folded = true;
    seedFastRandom(911);
    const evidence = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true)!;
    evidence.analysisMs = 0;
    const provenance = clone(evidence.range!);
    corrupt(provenance);
    expect(remainingVariantRangeProvenanceIsValid(provenance)).toBe(true);
    evidence.range = provenance;
    const r = evaluate(s, evidence);
    expect(r.receipt).toMatchObject({ reason: 'invalid_equity_evidence', equity: null });
    expect(r.receipt.inputs!.range.status).toBe('rejected_population');
  });

  const deckRefusals: Array<[string, Variant, (p: any) => void]> = [
    [
      'a Pineapple sample that never excluded the hero discard',
      'pineapple',
      (p: any) => {
        p.deck = { ...p.deck, heroKnownDeadCards: 0 };
        p.discard = { ...p.discard, hero: 'declared_flop_only_structural_prior' };
      },
    ],
    [
      'a Pineapple sample without the declared discard prior',
      'pineapple',
      (p: any) => {
        p.deck = { ...p.deck, heroKnownDeadCards: 0 };
        p.discard = null;
      },
    ],
    ['a Short Deck sample from a 52-card deck', 'short_deck', (p: any) => (p.deck.size = 52)],
    ['an FLH sample from a 36-card deck', 'flh', (p: any) => (p.deck.size = 36)],
    [
      'an FLO8 sample claiming a Pineapple discard prior',
      'flo8',
      (p: any) =>
        (p.discard = {
          opponents: 'declared_flop_only_structural_prior',
          hero: 'declared_flop_only_structural_prior',
          actualOpponentDiscardsRead: false,
        }),
    ],
  ];
  it.each(deckRefusals)('refuses %s', (_label, variant, corrupt) => {
    const s = remainingVariantSpot(variant, 'river', 3);
    seedFastRandom(911);
    const evidence = sampleRemainingVariantEquity(variant, s.hero, s.state, () => true)!;
    evidence.analysisMs = 0;
    const provenance = clone(evidence.range!);
    corrupt(provenance);
    expect(remainingVariantRangeProvenanceIsValid(provenance)).toBe(true);
    evidence.range = provenance;
    const r = evaluate(s, evidence);
    expect(r.receipt).toMatchObject({ reason: 'invalid_equity_evidence', equity: null });
    expect(r.receipt.inputs!.range.status).toBe('rejected_population');
  });

  it('refuses a Phase 11 provenance offered as a Phase 12 sample', () => {
    const s = remainingVariantSpot('short_deck', 'river', 3);
    seedFastRandom(911);
    const evidence = sampleRemainingVariantEquity('short_deck', s.hero, s.state, () => true)!;
    evidence.analysisMs = 0;
    const p = clone(evidence.range!) as any;
    evidence.range = {
      ...p,
      version: 'omaha-variant-range-provenance-v1',
      deck: { physical: 'single_deck_excluding_hero_and_board', dealtOpponents: 2 },
      discard: undefined,
    };
    delete (evidence.range as any).discard;
    const r = evaluate(s, evidence);
    expect(r.receipt.inputs!.range.status).toBe('rejected_population');
  });

  it.each(variants)('%s detaches and freezes the binding against later mutation', (variant) => {
    const s = remainingVariantSpot(variant, 'river', 3);
    s.state.rakeConfig = {
      percent: 5,
      cap: 10,
      noFlopNoDrop: true,
      playerCountCaps: [{ players: 3, cap: 2 }],
    };
    seedFastRandom(5);
    const r = evaluate(s);
    const recorded = clone(r.receipt.inputs);
    s.state.players[1].stack = 9999;
    s.state.players[2].is_folded = true;
    s.state.rakeConfig!.playerCountCaps![0].cap = 99;
    s.state.blindSeats!.bigBlind = 2;
    s.state.actionHistory!.push({
      userId: 'v4',
      seat: 3,
      action: 'raise',
      amount: 99,
      stage: 'river',
      timestamp: 9,
    });
    if (s.hero.knownDeadCards) s.hero.knownDeadCards.push(...remainingCards('2c'));
    expect(clone(r.receipt.inputs)).toEqual(recorded);
    expect(Object.isFrozen(r.receipt.inputs!.census.dealtSeats)).toBe(true);
    expect(Object.isFrozen(r.receipt.inputs!.geometry.rake.playerCountCaps)).toBe(true);
    expect(Object.isFrozen(r.receipt.inputs!.range.provenance!.opponents)).toBe(true);
    expect(Object.isFrozen(r.receipt.inputs!.privateCards)).toBe(true);
  });
});

describe('P12.1 fixed-limit geometry is the controller street geometry', () => {
  /**
   * Three seats at 1/2 fixed limit (a 2 small bet). The small blind calls
   * preflop with a stack that leaves `short` behind and opens the flop all in
   * for it. The big blind, who has not acted on the flop, then faces that
   * opening: below half a bet it is completed to one full bet; at half or
   * more it is itself a wager and the next raise is a full bet on top of it.
   * (A player who had already checked would not be reopened by the short
   * opening: the controller's menu then offers no wager, and the binding
   * records that too.)
   */
  function shortOpening(variant: 'flh' | 'flo8', short: number) {
    const hand = engineHand(variant, [1, 2, 3], { mode: 'cash', button: 1 }, (seat) =>
      seat === 2 ? 2 + short : 200
    );
    hand.act('call'); // button
    hand.act('call'); // small blind completes, leaving `short`
    hand.act('check'); // big blind
    expect(hand.controller.getState().stage).toBe('flop');
    hand.act('all_in'); // small blind opens short
    const view = hand.view();
    expect(view.actor.seat).toBe(3);
    return view;
  }

  it.each(['flh', 'flo8'] as const)(
    '%s binds a real short opening below half a bet as a completion',
    (variant) => {
      const { s, result } = shortOpening(variant, 0.5);
      expect(s.currentBet).toBe(0.5);
      const f = result.receipt.inputs!.geometry.fixedLimit!;
      expect(f).toMatchObject({
        smallBet: 2,
        streetBet: 2,
        completionIncrement: 1.5,
        completion: true,
        wagersThisStreet: 0,
        wagersCapped: false,
      });
      expect(s.legalActions).toContain('raise');
      expect(f).toMatchObject({ wagerOpen: true, canonicalWagerTo: 2 });
      expect(s.minRaiseTo).toBe(2);
      expect(remainingVariantInputBindingIsValid(clone(result.receipt.inputs))).toBe(true);
      const p = result.proposal;
      if (p.action === 'raise') expect(p.amount).toBe(f.canonicalWagerTo);
    }
  );

  it.each(['flh', 'flo8'] as const)(
    '%s binds the closed menu of a player who checked before a short opening',
    (variant) => {
      // Seat 3 checks the flop; the button then opens short (0.5) and seat 2,
      // who also checked, is not reopened: call or fold only.
      const hand = engineHand(variant, [1, 2, 3], { mode: 'cash', button: 1 }, (seat) =>
        seat === 1 ? 2.5 : 200
      );
      hand.act('call');
      hand.act('call');
      hand.act('check');
      hand.act('check');
      hand.act('check');
      hand.act('all_in');
      const { actor, s, result } = hand.view();
      expect(actor.seat).toBe(2);
      expect(s.legalActions).not.toContain('raise');
      expect(result.receipt.inputs!.geometry.fixedLimit).toMatchObject({
        completionIncrement: 1.5,
        completion: true,
        wagerOpen: false,
        canonicalWagerTo: null,
      });
      expect(['call', 'fold']).toContain(result.proposal.action);
      expect(remainingVariantInputBindingIsValid(clone(result.receipt.inputs))).toBe(true);
    }
  );

  it.each(['flh', 'flo8'] as const)(
    '%s binds a real short opening of half a bet or more as a counted wager',
    (variant) => {
      const { s, result } = shortOpening(variant, 1.2);
      expect(s.currentBet).toBe(1.2);
      const f = result.receipt.inputs!.geometry.fixedLimit!;
      expect(f).toMatchObject({
        streetBet: 2,
        completionIncrement: 2,
        completion: false,
        wagersThisStreet: 1,
      });
      expect(f).toMatchObject({ wagerOpen: true, canonicalWagerTo: 3.2 });
      expect(s.minRaiseTo).toBe(3.2);
      expect(remainingVariantInputBindingIsValid(clone(result.receipt.inputs))).toBe(true);
    }
  );

  it.each(['flh', 'flo8'] as const)(
    '%s binds the big bet on the turn and a capped street as closed',
    (variant) => {
      const turn = remainingVariantSpot(variant, 'turn', 3);
      const open = evaluate(turn).receipt.inputs!.geometry.fixedLimit!;
      expect(open).toMatchObject({
        smallBet: 2,
        streetBet: 4,
        completionIncrement: 4,
        wagerOpen: true,
        canonicalWagerTo: 8,
      });
      const capped = remainingVariantSpot(variant, 'turn', 3);
      capped.state.wagersCapped = true;
      capped.state.legalActions = ['fold', 'call'];
      capped.state.minRaiseTo = null;
      capped.state.maxRaiseTo = null;
      const closed = evaluate(capped).receipt.inputs!;
      expect(closed.geometry.fixedLimit).toMatchObject({
        wagersCapped: true,
        wagerOpen: false,
        canonicalWagerTo: null,
      });
      expect(remainingVariantInputBindingIsValid(clone(closed))).toBe(true);
    }
  );

  it('binds a kill hand from its own small bet', () => {
    const s = remainingVariantSpot('flh', 'turn', 3);
    // A kill hand doubles the small bet: the turn bet is twice that.
    s.state.fixedLimitSmallBet = 4;
    s.state.fixedBetSize = 8;
    s.state.minRaiseTo = s.state.currentBet + 8;
    s.state.maxRaiseTo = s.state.currentBet + 8;
    const r = evaluate(s);
    expect(r.receipt.inputs!.geometry.fixedLimit).toMatchObject({
      smallBet: 4,
      streetBet: 8,
      canonicalWagerTo: s.state.currentBet + 8,
    });
    expect(remainingVariantInputBindingIsValid(clone(r.receipt.inputs))).toBe(true);
  });
});

describe('P12.1 the binding validator refuses relabeling', () => {
  const base = (variant: Variant = 'flo8', street: 'preflop' | 'river' = 'river') => {
    const s = remainingVariantSpot(variant, street, 3);
    seedFastRandom(911);
    return evaluate(s).receipt;
  };
  const relabelings: Array<[string, Variant, (b: any) => void]> = [
    ['calibrated confidence', 'flo8', (b: any) => (b.pack.calibratedConfidence = 0.9)],
    ['solver input', 'flo8', (b: any) => (b.approximation.solverInput = true)],
    [
      'a hand shape labelled a probability',
      'flh',
      (b: any) => (b.approximation.handShape.probability = true),
    ],
    ['another pack version', 'flo8', (b: any) => (b.pack.version = 'fixed-limit-omaha8-round1-v2')],
    ['a pot-limit structure', 'short_deck', (b: any) => (b.pack.bettingStructure = 'pot_limit')],
    ['a 52-card Short Deck', 'short_deck', (b: any) => (b.pack.deck = 52)],
    ['a Pineapple tournament', 'pineapple', (b: any) => (b.mode = 'tournament')],
    ['a tournament ceiling on a cash table', 'flh', (b: any) => (b.pack.seats = [2, 10])],
    [
      'a hero position that is not the posted blinds',
      'flo8',
      (b: any) => (b.positions.hero = 'cutoff'),
    ],
    ['a wrong hero offset', 'flh', (b: any) => (b.positions.heroOffset = 2)],
    [
      'blind seats the engine could not post',
      'short_deck',
      (b: any) => (b.census.blindSeats = { smallBlind: 3, bigBlind: 2 }),
    ],
    ['a no-limit reshove role in fixed limit', 'flh', (b: any) => (b.positions.role = 'reshove')],
    [
      'a wager cap that is not the controller interval',
      'short_deck',
      (b: any) => (b.geometry.noLimit.wagerCap += 1),
    ],
    ['a fixed-limit geometry in no limit', 'pineapple', (b: any) => (b.geometry.fixedLimit = {})],
    [
      'a fixed wager that is not the canonical amount',
      'flo8',
      (b: any) => (b.geometry.fixedLimit.canonicalWagerTo += 4),
    ],
    ['a completion flag lie', 'flh', (b: any) => (b.geometry.fixedLimit.completion = true)],
    [
      'a river bet that is not twice the small bet',
      'flo8',
      (b: any) => (b.geometry.fixedLimit.streetBet = 2),
    ],
    [
      'an open wager on a capped street',
      'flh',
      (b: any) => (b.geometry.fixedLimit.wagersCapped = true),
    ],
    ['cents at a whole-chip big blind', 'short_deck', (b: any) => (b.geometry.chipUnit = 0.01)],
    [
      'an effective depth that is not the shorter cover',
      'flo8',
      (b: any) => (b.depth.effectiveBB += 1),
    ],
    [
      'a no-limit depth past 250 big blinds',
      'short_deck',
      (b: any) => {
        b.depth.effectiveBB = 300;
        b.depth.deepestOpponentCoverBB = 300;
        b.depth.heroCoverBB = 300;
        b.geometry.heroStack = 600 - b.geometry.heroBet;
        b.geometry.stackRaiseTo = 600;
      },
    ],
    ['a calibrated range', 'flo8', (b: any) => (b.range.provenance.calibration = 'calibrated')],
    [
      'a HorseMind read claim',
      'flh',
      (b: any) => (b.range.provenance.reads = 'horse_mind_statistics'),
    ],
    [
      'draws that are not the completed samples',
      'flo8',
      (b: any) => (b.range.provenance.prior.seatDraws += 1),
    ],
    [
      'more escapes than draws',
      'flo8',
      (b: any) =>
        (b.range.provenance.prior.uniformEscapes = b.range.provenance.prior.seatDraws + 1),
    ],
    [
      'a provenance on another population',
      'flo8',
      (b: any) => (b.range.provenance.opponents[0].seat = 9),
    ],
    ['a consumed sample without its numbers', 'flo8', (b: any) => (b.range.equity = null)],
    ['another variant', 'flo8', (b: any) => (b.variant = 'flh')],
    [
      'high plus low not equal to the total',
      'flo8',
      (b: any) => (b.range.lowEquity = Math.min(1, b.range.lowEquity + 0.1)),
    ],
    [
      'a low share in a high-only game',
      'flh',
      (b: any) => {
        b.range.lowEquity = 0.1;
        b.range.highEquity -= 0.1;
      },
    ],
    ['a missing split board fact', 'flo8', (b: any) => (b.board.lowPossible = null)],
    ['a recorded card value', 'pineapple', (b: any) => (b.privateCards.cardValues = 'Qc')],
    ['a hidden hero discard', 'pineapple', (b: any) => (b.privateCards.heroKnownDeadCards = 0)],
    [
      'a discard prior that read actual opponent discards',
      'pineapple',
      (b: any) => (b.range.provenance.discard.actualOpponentDiscardsRead = true),
    ],
    [
      'a Pineapple sample that kept the hero discard in the deck',
      'pineapple',
      (b: any) => (b.range.provenance.deck.heroKnownDeadCards = 0),
    ],
    [
      'a three-card Pineapple hand on the river',
      'pineapple',
      (b: any) => {
        b.privateCards.heroHoleCards = 3;
        b.approximation.handShape.cardsScored = 3;
      },
    ],
    ['an extra field', 'flo8', (b: any) => (b.census.extra = 1)],
  ];
  it.each(relabelings)('refuses %s', (_label, variant, corrupt) => {
    const receipt = base(variant);
    expect(remainingVariantInputBindingIsValid(clone(receipt.inputs))).toBe(true);
    const inputs = clone(receipt.inputs) as any;
    corrupt(inputs);
    expect(remainingVariantInputBindingIsValid(inputs)).toBe(false);
  });
  it.each(variants)('%s binds the receipt to its own variant and pack', (variant) => {
    const receipt = clone(base(variant)) as any;
    const other = variants.find((v) => v !== variant)!;
    expect(remainingVariantReceiptBindingIsValid(receipt)).toBe(true);
    expect(remainingVariantReceiptBindingIsValid({ ...receipt, variant: other })).toBe(false);
    expect(
      remainingVariantReceiptBindingIsValid({
        ...receipt,
        version: REMAINING_VARIANT_PACKS[other].version,
      })
    ).toBe(false);
    expect(remainingVariantReceiptBindingIsValid({ ...receipt, eligible: false })).toBe(false);
    expect(remainingVariantReceiptBindingIsValid({ ...receipt, inputs: null })).toBe(false);
    const legacy = { ...receipt };
    delete legacy.inputs;
    expect(remainingVariantReceiptBindingIsValid(legacy)).toBe(true);
    expect(
      remainingVariantReceiptBindingIsValid({ ...receipt, eligible: false, inputs: null })
    ).toBe(true);
  });
});

describe('P12.1 through the real brain, witness and boundary', () => {
  it.each(variants)(
    '%s: HorseLogic carries the binding, telemetry and a valid boundary receipt',
    (variant) => {
      const s = remainingVariantSpot(variant, 'river', 3);
      enableBrainTelemetry();
      drainFires();
      seedFastRandom(4040);
      const decision: HorseDecision = HorseLogic.decide(
        s.hero,
        s.state,
        'balanced',
        {},
        { telemetry: true, mind: false, decisionTimeMs: 0, phase12EvidenceMode: true }
      );
      const receipt = decision.remainingVariantPolicy!;
      expect(receipt.inputs!.variant).toBe(variant);
      expect(remainingVariantReceiptBindingIsValid(clone(receipt))).toBe(true);
      expect(horseDecisionReceiptIsValid(clone(decision), variant)).toBe(true);
      const fires = drainFires().map((row) => row.feature);
      expect(fires).toContain(`phase12_range_${receipt.inputs!.range.status}`);
      // A forged binding is refused at the boundary.
      const forged = clone(decision) as any;
      forged.remainingVariantPolicy.inputs.approximation.solverInput = true;
      expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
      // A retained receipt without the field claims nothing and stays readable.
      const legacy = clone(decision) as any;
      delete legacy.remainingVariantPolicy.inputs;
      // A receipt that carries a selection must carry the field (audit
      // 2026-10-05); one without either stays readable.
      expect(horseDecisionReceiptIsValid(legacy, variant)).toBe(
        !Object.hasOwn(legacy.remainingVariantPolicy, 'selection')
      );
      for (const key of ['selection', 'selectionRefusal', 'authority', 'authorityVerdict'])
        delete legacy.remainingVariantPolicy[key];
      expect(horseDecisionReceiptIsValid(legacy, variant)).toBe(true);
    }
  );
});
