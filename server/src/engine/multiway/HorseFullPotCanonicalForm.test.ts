import { describe, expect, it } from 'vitest';
import { HandController } from '../HandController.js';
import { HorseLogic, type HorseDecideOpts, type HorseGameStateV2 } from '../HorseLogic.js';
import { variantInfo, seedFastRandom, type VariantInfo } from '../HorseEval.js';
import { fullPotNearPotWager } from '../HorseRiverNuts.js';
import { controllerDecisionState } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { jointLegalCandidates } from './JointLivePolicy.js';
import type { GameVariant, HandConfig, HorseDecision, SeatPlayer } from '../../types.js';

const variants: GameVariant[] = ['nlh', 'plo4', 'plo5', 'plo6', 'plo8'];
const legalize = (
  HorseLogic as unknown as {
    legalize(d: HorseDecision, p: SeatPlayer, s: HorseGameStateV2, v: VariantInfo): HorseDecision;
  }
).legalize.bind(HorseLogic);
const row = (d: HorseDecision) => ({ action: d.action, amount: d.amount ?? null });

/** No controller state overwrite: four calls make pot40, then a flop bet20
 * leaves the next seat with100, a20 call and an exact100 pot-limit raise ceiling. */
function controllerSpot(variant: GameVariant) {
  const config: HandConfig = {
    tableId: `full-pot-canonical-${variant}`,
    handNumber: 1,
    gameVariant: variant,
    smallBlind: 5,
    bigBlind: 10,
    ante: 0,
    isTournament: false,
    rakeConfig: { percent: 0, cap: 0, noFlopNoDrop: true },
  };
  const players = [1, 2, 3, 4].map((seat) => ({
    seat,
    user_id: `full-pot-${seat}`,
    username: `Seat ${seat}`,
    stack: 110,
    bet: 0,
    totalInvested: 0,
    cards: [],
    is_folded: false,
    is_all_in: false,
    is_sitting_out: false,
    is_horse: true,
  })) as SeatPlayer[];
  const controller = new HandController(config, players, 1);
  controller.start();
  for (let n = 0; n < 12 && controller.getState().stage === 'preflop'; n++) {
    const s = controller.getState(),
      p = s.players.find((p) => p.seat === s.currentPlayerSeat)!;
    const menu = controller.getAuthoritativeActionState(p.user_id)!;
    expect(
      controller.performAction(p.seat, menu.legalActions.includes('check') ? 'check' : 'call')
    ).toBe(true);
  }
  expect(controller.getState().stage).toBe('flop');
  expect(controller.getState().pot).toBe(40);
  expect(controller.performAction(controller.getState().currentPlayerSeat!, 'bet', 20)).toBe(true);
  const spot = controllerDecisionState(controller, variant as never, 'cash', config)!;
  expect(spot).not.toBeNull();
  return { ...spot, controller };
}

/** P13.1 requires pricing, recording and execution in one canonical legal form. */
describe('full-pot final snap preserves canonical controller wagers', () => {
  it.each(variants)(
    '%s prices and executes the same full-stack form on the first pass',
    (variant) => {
      const { controller, hero, state } = controllerSpot(variant);
      expect({
        stack: hero.stack,
        bet: hero.bet,
        pot: state.pot,
        currentBet: state.currentBet,
        toCall: state.toCall,
        minRaiseTo: state.minRaiseTo,
        maxRaiseTo: state.maxRaiseTo,
      }).toEqual({
        stack: 100,
        bet: 0,
        pot: 60,
        currentBet: 20,
        toCall: 20,
        minRaiseTo: 40,
        maxRaiseTo: 100,
      });
      expect(state.legalActions).toContain('all_in');
      const info = {
        ...variantInfo(variant),
        isPotLimit: state.bettingStructure === 'pot_limit',
        isFixedLimit: state.bettingStructure === 'fixed_limit',
      };
      const form = (d: HorseDecision) => legalize(d, hero, state, info);
      const first = form({ action: 'raise', amount: 92, thinkTime: 0 });
      expect(row(first)).toEqual({ action: 'all_in', amount: null });
      expect(row(form({ ...first }))).toEqual(row(first));
      const priced = jointLegalCandidates(
        [{ id: 'raw-92', kind: 'raise', action: 'raise', amount: 92, investment: 92 }],
        hero,
        state,
        form
      );
      expect(priced.candidates).toMatchObject([
        { action: 'all_in', amount: null, investment: 100 },
      ]);
      expect(controller.performAction(hero.seat, first.action, first.amount)).toBe(true);
      expect(
        [...controller.getState().actionHistory]
          .reverse()
          .find((r) => r.seat === hero.seat && r.stage === 'flop')
      ).toMatchObject({ action: 'all_in', amount: 100 });
    }
  );

  it.each(variants)(
    '%s facing-wager chooser remains its reference; this is no selected-P13 proof',
    (variant) => {
      const { hero, state } = controllerSpot(variant);
      const opts: HorseDecideOpts = {
        telemetry: false,
        mind: false,
        decisionTimeMs: 0,
        phase8Postflop: 'off',
        phase10Plo4: 'off',
        phase11Omaha: 'off',
        phase12Remaining: 'off',
        phase13EvidenceMode: true,
      };
      seedFastRandom(501);
      const baseline = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        { ...opts, phase13Joint: 'off' }
      );
      seedFastRandom(501);
      const actual = HorseLogic.decide(
        hero,
        state,
        'balanced',
        {},
        { ...opts, phase13Joint: 'candidate' }
      );
      expect(row(actual)).toEqual(row(baseline));
      expect(actual.jointPolicy).toMatchObject({
        reason: 'joint_cash_facing_wager_baseline',
        fired: true,
        applied: false,
        selection: 'none',
        selectionRefusal: null,
      });
    }
  );

  it('keeps a cap-bounded pot raise sized, with no extra physical exposure', () => {
    const { hero, state } = controllerSpot('plo6');
    const capped = { ...state, pot: 40, maxRaiseTo: 80 };
    expect(
      row(fullPotNearPotWager({ action: 'raise', amount: 74, thinkTime: 0 }, hero, capped))
    ).toEqual({ action: 'raise', amount: 80 });
  });
  it('uses controller cent precision for the physical total', () => {
    const { hero, state } = controllerSpot('plo5');
    expect(
      row(
        fullPotNearPotWager(
          { action: 'raise', amount: 92, thinkTime: 0 },
          { ...hero, stack: 100.004 },
          state
        )
      )
    ).toEqual({ action: 'all_in', amount: null });
    expect(
      row(
        fullPotNearPotWager(
          { action: 'raise', amount: 92, thinkTime: 0 },
          { ...hero, stack: 100.01 },
          state
        )
      )
    ).toEqual({ action: 'raise', amount: 100 });
  });
  it('does not invent a menu all-in when only sized raises are admitted', () => {
    const { hero, state } = controllerSpot('plo4');
    const sized = { ...state, legalActions: state.legalActions!.filter((a) => a !== 'all_in') };
    expect(
      row(fullPotNearPotWager({ action: 'raise', amount: 92, thinkTime: 0 }, hero, sized))
    ).toEqual({ action: 'raise', amount: 100 });
  });
  it('preserves an already-canonical all-in', () => {
    const { hero, state } = controllerSpot('plo8');
    const wager: HorseDecision = { action: 'all_in', thinkTime: 7 };
    expect(fullPotNearPotWager(wager, hero, state)).toBe(wager);
  });
  it.each([
    ['above ceiling', { maxRaiseTo: 99 }],
    ['below minimum', { minRaiseTo: 101 }],
    ['fixed structure', { bettingStructure: 'fixed_limit' }],
    ['capped street', { wagersCapped: true }],
    ['missing schema', { stateSchemaVersion: undefined }],
    ['missing menu', { legalActions: undefined }],
    ['missing bound', { maxRaiseTo: undefined }],
    ['missing call', { toCall: undefined }],
  ] as const)('preserves the existing %s refusal', (_name, overrides) => {
    const { hero, state } = controllerSpot('plo6');
    const wager: HorseDecision = { action: 'raise', amount: 92, thinkTime: 7 };
    expect(fullPotNearPotWager(wager, hero, { ...state, ...overrides } as HorseGameStateV2)).toBe(
      wager
    );
  });
  it('keeps a fixed-limit variant excluded even with a misleading structure', () => {
    const { hero, state } = controllerSpot('nlh');
    const wager: HorseDecision = { action: 'raise', amount: 92, thinkTime: 7 };
    expect(fullPotNearPotWager(wager, hero, { ...state, gameVariant: 'flh' })).toBe(wager);
  });
});
