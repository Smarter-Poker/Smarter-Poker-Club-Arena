import { describe, expect, it } from 'vitest';
import { HandController } from '../HandController.js';
import { deadButtonPositions } from '../deadButton.js';
import { calculateContestablePot } from '../PokerEngine.js';
import { seedFastRandom } from '../HorseEval.js';
import { HorseLogic, type HorseGameStateV2 } from '../HorseLogic.js';
import { horsePolicyOwnership } from '../HorsePolicyRegistry.js';
import { plo4CanonicalPosition, plo4Position } from '../plo4/Plo4LivePolicy.js';
import { drainFires, enableBrainTelemetry } from '../BrainTelemetry.js';
import { horseDecisionReceiptIsValid } from '../horseDecision/responseValidation.js';
import {
  occupiedButtonBlinds,
  omahaVariantSpot,
} from '../../benchmark/OmahaVariantPolicyEvidence.js';
import {
  evaluateOmahaVariantPolicy,
  omahaVariantInputBindingIsValid,
  omahaVariantInputBindingSha256,
  omahaVariantRangeProvenanceIsValid,
  omahaVariantReceiptBindingIsValid,
  type OmahaVariantReceipt,
} from './OmahaVariantLivePolicy.js';
import { OMAHA_VARIANT_PACKS, omahaVariantSeatCap } from './OmahaVariantPolicyPack.js';
import { sampleOmahaVariantEquity } from './OmahaVariantSampler.js';
import type { OmahaVariantEquityEvidence } from './OmahaVariantEquity.js';
import type { HandConfig, HorseDecision, SeatPlayer } from '../../types.js';

const variants = ['plo5', 'plo6', 'plo8'] as const;
const ownership = (variant: (typeof variants)[number], receipt: OmahaVariantReceipt) =>
  horsePolicyOwnership(
    variant,
    { action: receipt.baselineAction, thinkTime: 0, omahaVariantPolicy: receipt },
    true
  );
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * Real engine hands. The button and blind seats come from the engine's own
 * rules (deadButtonPositions for a tournament table of three or more, as
 * ServerTableEngineDealing applies them; HandController's own rotation
 * otherwise) and HandController posts and deals the hand. Expected positions
 * are derived from what the engine did (who posted, who acts first), never
 * from the policy's arithmetic.
 */
function engineHand(
  variant: (typeof variants)[number],
  seatsNow: number[],
  table:
    | { mode: 'tournament'; last: { smallBlind: number; bigBlind: number } }
    | { mode: 'cash'; button: number }
) {
  const SB = table.mode === 'cash' ? 1 : 10;
  const BB = table.mode === 'cash' ? 2 : 20;
  const blinds = table.mode === 'tournament' ? deadButtonPositions(seatsNow, table.last)! : null;
  const players: SeatPlayer[] = seatsNow.map((seat) => ({
    seat,
    user_id: `p${seat}`,
    username: `P${seat}`,
    stack: table.mode === 'cash' ? 200 : 2000,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  }));
  const rakeConfig =
    table.mode === 'cash'
      ? { percent: 5, cap: 3, noFlopNoDrop: true }
      : { percent: 0, cap: 0, noFlopNoDrop: true };
  const config: HandConfig = {
    tableId: `p11-1-${variant}`,
    handNumber: 7,
    gameVariant: variant,
    smallBlind: SB,
    bigBlind: BB,
    ante: 0,
    isTournament: table.mode === 'tournament',
    rakeConfig,
    ...(blinds ? { blindSeats: { smallBlind: blinds.smallBlind, bigBlind: blinds.bigBlind } } : {}),
  };
  const controller = new HandController(
    config,
    players,
    blinds ? blinds.button : (table as { button: number }).button
  );
  controller.start();
  const view = (evidence: OmahaVariantEquityEvidence | null = null) => {
    const state = controller.getState();
    const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
    const menu = controller.getAuthoritativeActionState(actor.user_id)!;
    const s: HorseGameStateV2 = {
      stateSchemaVersion: 1,
      dealtSeatIds: state.players
        .filter((p) => p.cards.length > 0)
        .map((p) => p.seat)
        .sort((a, b) => a - b),
      blindSeats: controller.getBlindSeatsSnapshot?.() ?? null,
      ...controller.getChipRulesSnapshot(),
      heroSeat: actor.seat,
      currentPlayerSeat: actor.seat,
      legalActions: [...menu.legalActions],
      toCall: menu.toCall,
      minRaiseTo: menu.minRaiseTo,
      maxRaiseTo: menu.maxRaiseTo,
      bettingStructure: menu.structure,
      pots: controller.computeLivePots(),
      contestablePot: calculateContestablePot(state.players, actor.user_id, menu.toCall),
      rakeConfig,
      players: state.players.map((p) => ({ ...p, cards: [] })),
      communityCards: [...state.communityCards],
      communityCards2: [],
      communityCards3: [],
      bombPot: false,
      boardCount: 1,
      pot: state.pot,
      currentBet: state.currentBet,
      minRaise: state.minRaise,
      stage: state.stage,
      gameVariant: variant,
      bigBlind: BB,
      dealerSeat: state.dealerSeat,
      lastRaise: state.lastRaise,
      actionHistory: state.actionHistory.map((a) => ({ ...a })),
      gameMode: table.mode,
      format: table.mode === 'cash' ? 'cash' : 'mtt',
      ante: 0,
      straddleActive: false,
    } as HorseGameStateV2;
    const hero = { ...actor, cards: [...actor.cards] };
    const baseline: HorseDecision = {
      action: menu.toCall > 0 ? 'call' : 'check',
      ...(menu.toCall > 0 ? { amount: menu.toCall } : {}),
      thinkTime: 0,
    };
    const result = evaluateOmahaVariantPolicy(hero, s, baseline, evidence, 'shadow', () => 0);
    return { state, actor, menu, s, hero, baseline, result };
  };
  /** Call, or check when nothing is owed (the big blind's option). */
  const act = () => {
    const state = controller.getState();
    const actor = state.players.find((p) => p.seat === state.currentPlayerSeat)!;
    const owed = controller.getAuthoritativeActionState(actor.user_id)!.toCall > 0;
    expect(controller.performAction(state.currentPlayerSeat, owed ? 'call' : 'check')).toBe(true);
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

describe('P11.1 defect: the tournament dead button (the P10.1 defect 3 class)', () => {
  // The production PLO4 record's shape: dealt seats 1, 2, 4, 6, 7, 8; last
  // hand seat 5 held the small blind and seat 6 the big blind; seat 5 busted.
  const PRODUCTION = { seats: [1, 2, 4, 6, 7, 8], last: { smallBlind: 5, bigBlind: 6 } };
  // From the engine's postings: 6 posts the small blind, 7 the big blind, 8
  // acts first, and 4 is the last to act, the button's slot.
  const EXPECTED: Record<number, [string, number]> = {
    6: ['small_blind', 1],
    7: ['big_blind', 2],
    8: ['early', 3],
    1: ['middle', 4],
    2: ['cutoff', 5],
    4: ['button', 0],
  };
  it.each(variants)(
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
        expect(omahaVariantInputBindingIsValid(clone(inputs))).toBe(true);
        expect(inputs.census).toMatchObject({
          dealerSeat: 5,
          dealtSeats: PRODUCTION.seats,
          blindSeats: { smallBlind: 6, bigBlind: 7 },
        });
        expect(inputs.positions).toMatchObject({ hero: position, heroOffset: offset });
        hand.act();
      }
      // The engine's own action order: first to act after the big blind,
      // the button's slot last before the blinds.
      expect(order).toEqual([8, 1, 2, 4, 6, 7]);
    }
  );

  it.each(variants)(
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
        expect(result.receipt).toMatchObject({
          eligible: true,
          position: expected[actor.seat],
        });
        expect(result.receipt.inputs!.census.blindSeats).toEqual({ smallBlind: null, bigBlind: 4 });
        expect(omahaVariantInputBindingIsValid(clone(result.receipt.inputs))).toBe(true);
        hand.act();
      }
      expect(order).toEqual([5, 1, 2, 4]);
    }
  );

  it('computes a nine-seat tournament table whose dead button is seat 9', () => {
    // Seat 9 held the small blind last hand and busted; seat 1 the big blind.
    const hand = engineHand('plo5', [1, 2, 3, 4, 5, 6, 7, 8], {
      mode: 'tournament',
      last: { smallBlind: 9, bigBlind: 1 },
    });
    expect(hand.blinds).toEqual({ button: 9, smallBlindSeat: 1, smallBlind: 1, bigBlind: 2 });
    const { actor, result } = hand.view();
    expect(actor.seat).toBe(3);
    expect(result.receipt).toMatchObject({ eligible: true, position: 'early' });
    expect(result.receipt.inputs!.positions.heroOffset).toBe(3);
  });

  it('keeps the dealer-offset positions wherever the button is occupied and the small blind live', () => {
    // Every dealt subset of a ten-seat table, every occupied button: the
    // canonical positions from the posted blinds equal the old offset labels.
    let checked = 0;
    for (let mask = 0; mask < 1 << 10; mask++) {
      const dealt = Array.from({ length: 10 }, (_, i) => i + 1).filter((_, i) => mask & (1 << i));
      if (dealt.length < 2) continue;
      for (const dealer of dealt) {
        const blinds = occupiedButtonBlinds(dealer, dealt);
        const s = omahaVariantSpot('plo8', 'preflop', 2, 'tournament');
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
    const s = omahaVariantSpot(variant, 'preflop', 3, 'cash');
    s.state.dealerSeat = 4;
    s.state.blindSeats = { smallBlind: 1, bigBlind: 2 };
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    expect(r.receipt).toMatchObject({ reason: 'canonical_state_unavailable', inputs: null });
  });

  it.each(variants)(
    '%s cash hands keep the occupied-button positions they always had',
    (variant) => {
      const seats = [1, 2, 3, 4, 5].slice(0, Math.min(5, omahaVariantSeatCap(variant, 'cash')));
      const hand = engineHand(variant, seats, { mode: 'cash', button: 3 });
      const first = hand.view();
      expect(first.s.blindSeats).toEqual({ smallBlind: 4, bigBlind: 5 });
      expect(first.actor.seat).toBe(1);
      expect(first.result.receipt).toMatchObject({ eligible: true, position: 'early' });
      expect(first.result.receipt.inputs!.geometry.chipUnit).toBe(0.01);
    }
  );
});

describe('P11.1 defect: a census above the pack ceiling is outside the domain', () => {
  it.each([
    ['plo6', 'cash', 7],
    ['plo6', 'tournament', 8],
    ['plo5', 'cash', 8],
  ] as const)('%s %s with %i dealt seats refuses by name', (variant, mode, seats) => {
    expect(seats).toBe(omahaVariantSeatCap(variant, mode) + 1);
    const s = omahaVariantSpot(variant, 'preflop', seats, mode);
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    expect(r.receipt).toMatchObject({ reason: 'seat_count_outside_pack', inputs: null });
    expect(ownership(variant, r.receipt)).toMatchObject({ outcome: 'outside_domain' });
  });
  it.each(variants)('%s fires at exactly the ceiling for both modes', (variant) => {
    for (const mode of ['cash', 'tournament'] as const) {
      const cap = omahaVariantSeatCap(variant, mode);
      const s = omahaVariantSpot(variant, 'preflop', cap, mode);
      const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
      expect(r.receipt.eligible).toBe(true);
      expect(r.receipt.inputs!.pack.seats).toEqual([2, cap]);
      expect(r.receipt.inputs!.pack.seatCapOwner).toBe(
        mode === 'cash' ? 'cash_table_seating' : 'tournament_deck_capacity'
      );
    }
  });
});

describe('P11.1 blind seats are required', () => {
  it.each(variants)('%s refuses a state without posted blind seats by name', (variant) => {
    const s = omahaVariantSpot(variant, 'river', 3);
    for (const value of [undefined, null]) {
      const state = { ...s.state, blindSeats: value };
      if (value === undefined) delete state.blindSeats;
      const r = evaluateOmahaVariantPolicy(s.hero, state, s.baseline, null, 'shadow', () => 0);
      expect(r.receipt).toMatchObject({ reason: 'blind_seats_unavailable', inputs: null });
      expect(ownership(variant, r.receipt)).toMatchObject({ outcome: 'unavailable' });
    }
  });
  it.each(variants)('%s refuses blind seats the engine could not have posted', (variant) => {
    const s = omahaVariantSpot(variant, 'river', 3);
    s.state.blindSeats = { smallBlind: 3, bigBlind: 2 };
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    expect(r.receipt).toMatchObject({ reason: 'canonical_state_unavailable', inputs: null });
  });
});

describe('P11.1 what the proposal records', () => {
  it.each(variants)('%s binds the preflop facts it consumed', (variant) => {
    const s = omahaVariantSpot(variant, 'preflop', 3);
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    const inputs = r.receipt.inputs!;
    const pack = OMAHA_VARIANT_PACKS[variant];
    expect(Object.isFrozen(inputs)).toBe(true);
    expect(omahaVariantInputBindingIsValid(clone(inputs))).toBe(true);
    expect(omahaVariantReceiptBindingIsValid(clone(r.receipt))).toBe(true);
    expect(inputs).toMatchObject({
      version: 'omaha-variant-input-binding-v1',
      variant,
      pack: {
        version: pack.version,
        holes: pack.holes,
        splitPot: pack.splitPot,
        source: 'explicit_variant_heuristic',
        calibratedConfidence: null,
        seats: [2, omahaVariantSeatCap(variant, 'cash')],
        maxStackBB: 250,
        maxAnteBB: 1,
        maxRakePercent: 10,
      },
      approximation: {
        status: 'explicit_variant_heuristic',
        solverInput: false,
        handShape: { kind: 'heuristic_entry_score', probability: false },
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
      board: {
        street: 'preflop',
        cards: 0,
        paired: null,
        flushBoard: null,
        lowPossible: null,
        features: [],
      },
      range: { status: 'not_consumed_preflop', equity: null, samples: null, provenance: null },
    });
    expect(inputs.approximation.handShape.lowScore === null).toBe(!pack.splitPot);
    // Pot-limit geometry from the stated rule, not from the policy.
    const g = inputs.geometry;
    const call = s.state.currentBet - s.hero.bet;
    expect(g.callCost).toBe(call);
    expect(g.potLimitRaiseTo).toBe(s.state.currentBet + s.state.pot + call);
    expect(g.stackRaiseTo).toBe(s.hero.bet + s.hero.stack);
    expect(g.wagerCap).toBe(Math.min(s.state.maxRaiseTo!, g.stackRaiseTo, g.potLimitRaiseTo));
    expect(g.chipUnit).toBe(0.01);
    expect(g.rake).toEqual({
      percent: 5,
      cap: 10,
      noFlopNoDrop: true,
      playerCountCaps: null,
      dealtCount: 3,
    });
    // Hash stable through the journal's JSON round trip.
    expect(omahaVariantInputBindingSha256(clone(inputs))).toBe(
      omahaVariantInputBindingSha256(inputs)
    );
  });

  it.each(variants)(
    '%s binds the live variant sample: contesting population, dealt deck and work',
    (variant) => {
      const s = omahaVariantSpot(variant, 'river', 4);
      // Seat 4 folded: it still occupies cards in the deck but is not scored.
      s.state.players[3].is_folded = true;
      seedFastRandom(911);
      const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
      const inputs = r.receipt.inputs!;
      expect(omahaVariantInputBindingIsValid(clone(inputs))).toBe(true);
      expect(inputs.range.status).toBe('consumed');
      expect(inputs.approximation.status).toBe(
        'explicit_variant_heuristic_with_uncalibrated_range_sample'
      );
      const provenance = inputs.range.provenance!;
      expect(provenance).toMatchObject({
        version: 'omaha-variant-range-provenance-v1',
        source: 'variant_public_line_sequential_prior',
        calibration: 'uncalibrated',
        solverInput: false,
        reads: 'public_action_line_only',
        prior: { attemptsPerSeat: 3, finalAttempt: 'uniform_escape' },
        deck: { physical: 'single_deck_excluding_hero_and_board', dealtOpponents: 3 },
      });
      expect(provenance.opponents.map((o) => [o.userId, o.seat])).toEqual([
        ['v2', 2],
        ['v3', 3],
      ]);
      // v2 bet the river in the fixture's public line.
      expect(provenance.opponents[0]).toMatchObject({ raises: 1, calls: 0 });
      expect(provenance.work.completedSamples).toBe(inputs.range.samples);
      expect(provenance.prior.seatDraws).toBe(provenance.work.completedSamples * 3);
      expect(provenance.prior.uniformEscapes).toBeLessThanOrEqual(provenance.prior.seatDraws);
      expect(inputs.census).toMatchObject({ contestingOpponentSeats: [2, 3], foldedSeats: [4] });
      expect(inputs.range.pots).toBe(r.receipt.equity!.perPot.length);
      expect(inputs.range.equity).toBe(r.receipt.equity!.equity);
      expect(inputs.board).toMatchObject({
        street: 'river',
        cards: 5,
        lowPossible: variant === 'plo8' ? true : null,
      });
      // The inputs record what the proposal read. P11-A's tag is added after
      // the proposal is fixed, by the river pricing pass, and is not an input.
      expect(inputs.board.features).toEqual(
        r.receipt.features.filter((f) => f !== 'net_action_economics')
      );
      expect(inputs.geometry.postflop!.callPrice).toBe(r.receipt.callPrice);
      expect(Object.isFrozen(r.receipt.equity)).toBe(true);
      expect(Object.isFrozen(r.receipt.equity!.perPot)).toBe(true);
    }
  );

  it.each(variants)('%s records an external sample as consumed but unattributed', (variant) => {
    const s = omahaVariantSpot(variant, 'river', 3);
    seedFastRandom(17);
    const evidence = sampleOmahaVariantEquity(variant, s.hero, s.state, () => true)!;
    delete evidence.range;
    evidence.provenance = 'independent_offline_oracle';
    evidence.analysisMs = 0;
    const r = evaluateOmahaVariantPolicy(
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
    expect(omahaVariantInputBindingIsValid(clone(r.receipt.inputs))).toBe(true);
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
      const river = omahaVariantSpot(variant, 'river', 3);
      seedFastRandom(17);
      const evidence = sampleOmahaVariantEquity(variant, river.hero, river.state, () => true)!;
      const preflop = omahaVariantSpot(variant, 'preflop', 3);
      const r = evaluateOmahaVariantPolicy(
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
      const refused = evaluateOmahaVariantPolicy(
        river.hero,
        { ...river.state, bettingStructure: 'fixed_limit' },
        river.baseline,
        evidence,
        'shadow',
        () => 0
      );
      expect(refused.receipt).toMatchObject({ eligible: false, equity: null, inputs: null });
    }
  );

  it.each(variants)('%s refuses malformed evidence and records it as rejected', (variant) => {
    const s = omahaVariantSpot(variant, 'river', 3);
    seedFastRandom(17);
    const evidence = sampleOmahaVariantEquity(variant, s.hero, s.state, () => true)!;
    evidence.analysisMs = 0;
    evidence.equity = Number.NaN;
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, evidence, 'shadow', () => 0);
    expect(r.receipt).toMatchObject({
      eligible: true,
      fired: false,
      reason: 'invalid_equity_evidence',
      equity: null,
    });
    expect(r.receipt.inputs!.range).toMatchObject({ status: 'rejected_malformed', equity: null });
    expect(r.receipt.inputs!.approximation.status).toBe('explicit_variant_heuristic');
    expect(omahaVariantInputBindingIsValid(clone(r.receipt.inputs))).toBe(true);
    // The journal's JSON encoder accepts the receipt: no NaN is recorded.
    expect(JSON.stringify(r.receipt)).not.toContain('null,"highEquity":NaN');
    expect(() => JSON.parse(JSON.stringify(r.receipt))).not.toThrow();
  });

  it.each([
    [
      'a folded seat',
      (p: any) => (p.opponents = [{ ...p.opponents[0], userId: 'v4', seat: 4 }, p.opponents[1]]),
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
  ])('refuses a PLO8 sample drawn against %s', (_label, corrupt) => {
    const s = omahaVariantSpot('plo8', 'river', 4);
    s.state.players[3].is_folded = true;
    seedFastRandom(911);
    const evidence = sampleOmahaVariantEquity('plo8', s.hero, s.state, () => true)!;
    evidence.analysisMs = 0;
    const provenance = clone(evidence.range!);
    corrupt(provenance);
    expect(omahaVariantRangeProvenanceIsValid(provenance)).toBe(true);
    evidence.range = provenance;
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, evidence, 'shadow', () => 0);
    expect(r.receipt).toMatchObject({ reason: 'invalid_equity_evidence', equity: null });
    expect(r.receipt.inputs!.range.status).toBe('rejected_population');
  });

  it('detaches and freezes the binding against later asynchronous mutation', () => {
    const s = omahaVariantSpot('plo8', 'river', 3);
    s.state.rakeConfig = {
      percent: 5,
      cap: 10,
      noFlopNoDrop: true,
      playerCountCaps: [{ players: 3, cap: 2 }],
    };
    seedFastRandom(5);
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    const recorded = clone(r.receipt.inputs);
    s.state.players[1].stack = 9999;
    s.state.players[2].is_folded = true;
    s.state.rakeConfig!.playerCountCaps![0].cap = 99;
    s.state.blindSeats!.bigBlind = 2;
    s.state.actionHistory!.push({
      userId: 'v3',
      seat: 3,
      action: 'raise',
      amount: 99,
      stage: 'river',
      timestamp: 9,
    });
    expect(clone(r.receipt.inputs)).toEqual(recorded);
    expect(Object.isFrozen(r.receipt.inputs!.census.dealtSeats)).toBe(true);
    expect(Object.isFrozen(r.receipt.inputs!.geometry.rake.playerCountCaps)).toBe(true);
    expect(Object.isFrozen(r.receipt.inputs!.range.provenance!.opponents)).toBe(true);
  });
});

describe('P11.1 the binding validator refuses relabeling', () => {
  const base = () => {
    const s = omahaVariantSpot('plo8', 'river', 3);
    seedFastRandom(911);
    const r = evaluateOmahaVariantPolicy(s.hero, s.state, s.baseline, null, 'shadow', () => 0);
    return r.receipt;
  };
  it.each([
    ['calibrated confidence', (b: any) => (b.pack.calibratedConfidence = 0.9)],
    ['solver input', (b: any) => (b.approximation.solverInput = true)],
    [
      'a hand shape labelled a probability',
      (b: any) => (b.approximation.handShape.probability = true),
    ],
    ['another pack version', (b: any) => (b.pack.version = 'plo8-split-round1-v1')],
    ['a cash ceiling on a tournament unit', (b: any) => (b.geometry.chipUnit = 1)],
    ['a hero position that is not the posted blinds', (b: any) => (b.positions.hero = 'cutoff')],
    ['a wrong hero offset', (b: any) => (b.positions.heroOffset = 2)],
    [
      'blind seats the engine could not post',
      (b: any) => (b.census.blindSeats = { smallBlind: 3, bigBlind: 2 }),
    ],
    [
      'a pot limit that is not current bet + pot + call',
      (b: any) => (b.geometry.potLimitRaiseTo += 1),
    ],
    ['an effective depth that is not the shorter cover', (b: any) => (b.depth.effectiveBB += 1)],
    ['a calibrated range', (b: any) => (b.range.provenance.calibration = 'calibrated')],
    ['a HorseMind read claim', (b: any) => (b.range.provenance.reads = 'horse_mind_statistics')],
    [
      'draws that are not the completed samples',
      (b: any) => (b.range.provenance.prior.seatDraws += 1),
    ],
    [
      'more escapes than draws',
      (b: any) =>
        (b.range.provenance.prior.uniformEscapes = b.range.provenance.prior.seatDraws + 1),
    ],
    ['a provenance on another population', (b: any) => (b.range.provenance.opponents[0].seat = 9)],
    ['a consumed sample without its numbers', (b: any) => (b.range.equity = null)],
    ['another variant', (b: any) => (b.variant = 'plo5')],
    [
      'high plus low not equal to the total',
      (b: any) => (b.range.lowEquity = Math.min(1, b.range.lowEquity + 0.1)),
    ],
    ['a missing split board fact', (b: any) => (b.board.lowPossible = null)],
    ['an extra field', (b: any) => (b.census.extra = 1)],
  ])('refuses %s', (_label, corrupt) => {
    const receipt = base();
    expect(omahaVariantInputBindingIsValid(clone(receipt.inputs))).toBe(true);
    const inputs = clone(receipt.inputs) as any;
    corrupt(inputs);
    expect(omahaVariantInputBindingIsValid(inputs)).toBe(false);
  });
  it('binds the receipt to its own variant and pack', () => {
    const receipt = clone(base()) as any;
    expect(omahaVariantReceiptBindingIsValid(receipt)).toBe(true);
    expect(omahaVariantReceiptBindingIsValid({ ...receipt, variant: 'plo5' })).toBe(false);
    expect(omahaVariantReceiptBindingIsValid({ ...receipt, version: 'plo8-split-round1-v1' })).toBe(
      false
    );
    expect(omahaVariantReceiptBindingIsValid({ ...receipt, eligible: false })).toBe(false);
    expect(omahaVariantReceiptBindingIsValid({ ...receipt, inputs: null })).toBe(false);
    const legacy = { ...receipt };
    delete legacy.inputs;
    expect(omahaVariantReceiptBindingIsValid(legacy)).toBe(true);
    // An ineligible node is never priced (P11-A), so the ineligible receipt
    // carries no river net-action result either.
    const ineligible = { ...receipt, eligible: false, inputs: null };
    delete ineligible.netActionEconomics;
    ineligible.features = ineligible.features.filter((f: string) => f !== 'net_action_economics');
    expect(omahaVariantReceiptBindingIsValid(ineligible)).toBe(true);
    expect(
      omahaVariantReceiptBindingIsValid({
        ...ineligible,
        netActionEconomics: receipt.netActionEconomics,
      })
    ).toBe(false);
  });
});

describe('P11.1 through the real brain, witness and boundary', () => {
  it.each(variants)(
    '%s: HorseLogic carries the binding, telemetry and witness commitment',
    (variant) => {
      const s = omahaVariantSpot(variant, 'river', 3);
      enableBrainTelemetry();
      drainFires();
      seedFastRandom(4040);
      const decision = HorseLogic.decide(
        s.hero,
        s.state,
        'balanced',
        {},
        {
          telemetry: true,
          mind: false,
          decisionTimeMs: 0,
          phase11EvidenceMode: true,
        }
      );
      const receipt = decision.omahaVariantPolicy!;
      expect(receipt.inputs!.variant).toBe(variant);
      expect(omahaVariantReceiptBindingIsValid(clone(receipt))).toBe(true);
      expect(horseDecisionReceiptIsValid(clone(decision), variant)).toBe(true);
      const fires = drainFires().map((row) => row.feature);
      expect(fires).toContain(`phase11_range_${receipt.inputs!.range.status}`);
      // A forged binding is refused at the boundary.
      const forged = clone(decision) as any;
      forged.omahaVariantPolicy.inputs.approximation.solverInput = true;
      expect(horseDecisionReceiptIsValid(forged, variant)).toBe(false);
      // A retained receipt without the field claims nothing and stays readable.
      const legacy = clone(decision) as any;
      delete legacy.omahaVariantPolicy.inputs;
      expect(horseDecisionReceiptIsValid(legacy, variant)).toBe(false);
      for (const key of ['selection', 'selectionRefusal', 'authority', 'authorityVerdict'])
        delete legacy.omahaVariantPolicy[key];
      expect(horseDecisionReceiptIsValid(legacy, variant)).toBe(true);
    }
  );
});
