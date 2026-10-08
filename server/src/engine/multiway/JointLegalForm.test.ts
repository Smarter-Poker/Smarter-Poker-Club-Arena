/**
 * P13.1 LEGAL FORM: every Phase 13 candidate is priced, ranked, recorded and
 * executed in the exact form HorseLogic.legalize produces.
 *
 * The audit of origin/main (22efa996) found the Phase 10/11 defect in the
 * joint owner: `evaluateJointActions` sized wagers to the settlement unit
 * (0.01 for cash chips) and ranked them at those amounts, while the legalizer
 * snaps to whole chips whenever the big blind is whole, turns a bet at 92% of
 * the stack or a raise at 95% into an all-in and a call that covers the stack
 * into the menu's all-in. HorseLogic legalized the proposal only AFTER the
 * ranking, so the receipt priced one action and the table would execute
 * another, and in candidate mode the rewritten proposal was applied silently
 * with no `illegal_candidate` guard.
 *
 * These cases run the REAL legalizer over natural spots from a real
 * HandController for every joint variant, in both objectives, through the
 * real HorseLogic joint node.
 */
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

/** Phase 13's earlier-phase law needs an applied Phase 12 change on a spot
 * where the joint policy fires. Round 3 changes Short Deck only in declared
 * preflop spots, so the test that needs it turns this on: an eligible
 * postflop Phase 12 proposal becomes the other legal passive action (a fold
 * against a bet, a check instead of a bet), as a pack that changed that
 * decision would. Off everywhere else. */
const p12PostflopChange = vi.hoisted(() => ({ on: false }));
vi.mock('../remainingVariants/RemainingVariantLivePolicy.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../remainingVariants/RemainingVariantLivePolicy.js')>();
  return {
    ...actual,
    evaluateRemainingVariantPolicy: (
      ...args: Parameters<typeof actual.evaluateRemainingVariantPolicy>
    ) => {
      const result = actual.evaluateRemainingVariantPolicy(...args);
      const [hero, state, baseline, , mode] = args;
      if (!p12PostflopChange.on || !result.receipt.fired || state.stage === 'preflop')
        return result;
      const owed = Math.max(0, state.currentBet - hero.bet);
      const alternative =
        owed > 0 && baseline.action !== 'fold' && state.legalActions?.includes('fold')
          ? { action: 'fold' as const, thinkTime: baseline.thinkTime }
          : owed === 0 &&
              (baseline.action === 'bet' || baseline.action === 'all_in') &&
              state.legalActions?.includes('check')
            ? { action: 'check' as const, thinkTime: baseline.thinkTime }
            : null;
      if (!alternative) return result;
      const applied = mode === 'candidate';
      return {
        ...result,
        proposal: alternative,
        decision: applied ? alternative : result.decision,
        receipt: Object.assign(result.receipt, {
          proposalAction: alternative.action,
          proposalAmount: null,
          changed: true,
          applied,
        }),
      };
    },
  };
});
import type { GameVariant, HorseDecision, SeatPlayer } from '../../types.js';
import { HorseLogic, type HorseDecideOpts, type HorseGameStateV2 } from '../HorseLogic.js';
import { seedFastRandom, variantInfo, type VariantInfo } from '../HorseEval.js';
import { controllerSpotRandom } from '../remainingVariants/RemainingVariantControllerSpots.test-support.js';
import { jointReceiptBindingIsValid, jointSelectedRow } from './JointLivePolicy.js';
import {
  JOINT_SPOT_VARIANTS,
  forEachJointControllerSpot,
} from './JointControllerSpots.test-support.js';

const legalize = (
  HorseLogic as unknown as {
    legalize(d: HorseDecision, p: SeatPlayer, gs: HorseGameStateV2, vi: VariantInfo): HorseDecision;
  }
).legalize.bind(HorseLogic);

const viOf = (variant: GameVariant, s: HorseGameStateV2): VariantInfo => ({
  ...variantInfo(variant),
  isPotLimit: s.bettingStructure === 'pot_limit',
  isFixedLimit: s.bettingStructure === 'fixed_limit',
});

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

function pinDeckEntropy(seed: number) {
  const random = controllerSpotRandom(seed);
  vi.stubGlobal('crypto', {
    getRandomValues(target: Uint32Array) {
      for (let i = 0; i < target.length; i++) target[i] = Math.floor(random() * 0x100000000) >>> 0;
      return target;
    },
  });
}
afterEach(() => vi.unstubAllGlobals());

type Row = { action: HorseDecision['action']; amount: number | null };
const rowOf = (d: HorseDecision): Row => ({ action: d.action, amount: d.amount ?? null });
const sameRow = (a: Row, b: Row) => a.action === b.action && a.amount === b.amount;

const cases = JOINT_SPOT_VARIANTS.flatMap((variant) =>
  (['cash', 'tournament'] as const)
    .filter((mode) => !(variant === 'pineapple' && mode === 'tournament'))
    .map((mode) => [variant, mode] as const)
);

describe('P13.1 every Phase 13 candidate is in the legalizer form', () => {
  it.each(cases)(
    '%s %s: ranked, recorded and applied candidates are legal-form fixed points',
    (variant, mode) => {
      pinDeckEntropy(0x13c00000 ^ variant.length ^ (mode.length << 8));
      const tally = {
        spots: 0,
        receipts: 0,
        invalidBindings: 0,
        treeFired: 0,
        fired: 0,
        candidates: 0,
        candidateRewrites: 0,
        proposalRewrites: 0,
        rankedNotExecuted: 0,
        applied: 0,
        illegal: 0,
      };
      const examples: unknown[] = [];
      forEachJointControllerSpot(variant, mode, 14, 0x1311 + variant.length * 7, (spot) => {
        tally.spots++;
        const vi = viOf(variant, spot.state);
        seedFastRandom(0x7a13 + tally.spots);
        const shadow = HorseLogic.decide(
          spot.hero,
          spot.state,
          'balanced',
          {},
          { ...opts, phase13Joint: 'shadow' }
        );
        const receipt = shadow.jointPolicy;
        // P13.1 binding: every natural receipt carries a binding exactly when
        // eligible, and it survives the worker boundary's strict validator.
        if (receipt) {
          tally.receipts++;
          expect((receipt.inputs === null) === !receipt.eligible).toBe(true);
          if (!jointReceiptBindingIsValid(JSON.parse(JSON.stringify(receipt)))) {
            tally.invalidBindings++;
            if (examples.length < 3)
              examples.push({ invalid: receipt.inputs, reason: receipt.reason });
          }
          if (receipt.inputs && receipt.actionModel)
            expect(receipt.inputs.positions.playersBehindSeats).toEqual(
              receipt.actionModel.playersBehind.map(
                (id) => spot.state.players.find((p) => p.user_id === id)!.seat
              )
            );
        }
        if (!receipt?.fired || !receipt.actionModel) return;
        tally.fired++;
        // P13-A: turn and river decisions are priced by the round-2 tree.
        if (receipt.responseModel === 'bounded_raise_tree') tally.treeFired++;
        // Every priced candidate is already what the legalizer would execute.
        for (const c of receipt.actionModel.candidates) {
          tally.candidates++;
          const priced: Row = {
            action: c.action,
            amount: c.action === 'bet' || c.action === 'raise' ? c.amount : null,
          };
          const legal = rowOf(
            legalize(
              { action: c.action, amount: c.amount ?? undefined, thinkTime: 0 },
              spot.hero,
              spot.state,
              vi
            )
          );
          const legalPriced = {
            action: legal.action,
            amount: legal.action === 'bet' || legal.action === 'raise' ? legal.amount : null,
          };
          if (!sameRow(priced, legalPriced)) {
            tally.candidateRewrites++;
            if (examples.length < 3) examples.push({ priced, legal, stage: spot.state.stage });
          }
        }
        // The recorded proposal is the legal form (amount included).
        const proposal: Row = { action: receipt.proposalAction, amount: receipt.proposalAmount };
        const legal = rowOf(
          legalize(
            {
              action: proposal.action,
              amount: proposal.amount ?? undefined,
              thinkTime: 0,
            },
            spot.hero,
            spot.state,
            vi
          )
        );
        if (receipt.utilityOwner === 'cash' && !sameRow(proposal, legal)) tally.proposalRewrites++;
        // The ranked winner is the action recorded and executed (cash: the
        // joint model is the objective; tournaments hand it to Phase 7).
        if (receipt.reason === 'joint_cash_action_distribution') {
          const top = jointSelectedRow(receipt.actionModel, spot.hero, spot.state)!;
          const ranked: Row = {
            action: top.action,
            amount: top.action === 'bet' || top.action === 'raise' ? top.amount : null,
          };
          const recorded: Row = {
            action: proposal.action,
            amount:
              proposal.action === 'bet' || proposal.action === 'raise' ? proposal.amount : null,
          };
          if (!sameRow(ranked, recorded)) {
            tally.rankedNotExecuted++;
            if (examples.length < 3) examples.push({ ranked, recorded, stage: spot.state.stage });
          }
        }
        // Candidate mode: an applied candidate is executed exactly as ranked.
        seedFastRandom(0x7a13 + tally.spots);
        const candidate = HorseLogic.decide(
          spot.hero,
          spot.state,
          'balanced',
          {},
          { ...opts, phase13Joint: 'candidate' }
        );
        const r = candidate.jointPolicy!;
        if (r.applied) {
          tally.applied++;
          expect(rowOf(candidate)).toEqual(
            rowOf(legalize({ ...candidate }, spot.hero, spot.state, vi))
          );
        }
        if ((r as { selectionRefusal?: string | null }).selectionRefusal === 'illegal_candidate')
          tally.illegal++;
      });
      if (process.env.P13_1_TALLY)
        console.log(JSON.stringify({ variant, mode, ...tally, examples }));
      expect(examples).toEqual([]);
      expect(tally.candidateRewrites).toBe(0);
      expect(tally.proposalRewrites).toBe(0);
      expect(tally.rankedNotExecuted).toBe(0);
      expect(tally.illegal).toBe(0);
      expect(tally.invalidBindings).toBe(0);
      expect(tally.fired).toBeGreaterThan(10);
      expect(tally.treeFired).toBeGreaterThan(0);
    },
    120_000
  );
});

describe('P13.1 a Phase 13 candidate never acts on top of an applied earlier-phase candidate', () => {
  it.each(['short_deck', 'flo8'] as const)(
    '%s cash: an applied Phase 12 candidate keeps the action; Phase 13 is refused by name',
    (variant) => {
      pinDeckEntropy(0x13e00000 ^ variant.length);
      let refused = 0;
      // Round 3 changes Short Deck only in declared preflop spots, where no
      // Short Deck joint decision fires, so its applied Phase 12 change is
      // made on postflop spots here (p12PostflopChange above).
      p12PostflopChange.on = variant === 'short_deck';
      onTestFinished(() => {
        p12PostflopChange.on = false;
      });
      forEachJointControllerSpot(variant, 'cash', 20, 0x13e1 + variant.length, (spot) => {
        seedFastRandom(0x13e2);
        const phase12Only = HorseLogic.decide(
          spot.hero,
          spot.state,
          'balanced',
          {},
          { ...opts, phase12EvidenceMode: true, phase12Remaining: 'candidate', phase13Joint: 'off' }
        );
        if (!phase12Only.remainingVariantPolicy?.applied) return;
        seedFastRandom(0x13e2);
        const both = HorseLogic.decide(
          spot.hero,
          spot.state,
          'balanced',
          {},
          {
            ...opts,
            phase12EvidenceMode: true,
            phase12Remaining: 'candidate',
            phase13Joint: 'candidate',
          }
        );
        const r = both.jointPolicy;
        if (!r?.fired) return;
        expect(r.applied).toBe(false);
        expect({ action: both.action, amount: both.amount ?? null }).toEqual({
          action: phase12Only.action,
          amount: phase12Only.amount ?? null,
        });
        if (r.selectionRefusal === 'earlier_phase_applied') {
          refused++;
          expect(r.changed).toBe(true);
        } else expect(r.changed).toBe(false);
      });
      expect(refused).toBeGreaterThan(0);
    },
    120_000
  );
});
