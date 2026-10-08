/**
 * P13.3 at the HorseLogic owner and the worker boundary: a joint candidate
 * acts only as an authority-backed cash selection under usable Phase 13
 * authority for the decision's own variant. Phase 7 keeps every tournament
 * objective decision, no other variant's (or phase's) authority backs a joint
 * receipt, and a joint candidate never crosses the boundary on top of an
 * applied Phase 10/11/12 candidate. Expected actions come from the joint-off
 * reference run, not from the code under test.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import type { HorseDecision } from '../types.js';
import { seedFastRandom } from './HorseEval.js';
import { HorseLogic } from './HorseLogic.js';
import {
  HORSE_PHASE13_VARIANTS,
  horsePhase13AdmittedMode,
  horsePhase13ContinuationVersion,
} from './HorsePhase13Authority.js';
import type { HorseAuthorityVerdict } from './HorseQualifiedAuthority.js';
import {
  horseDecisionReceiptIsValid,
  horsePhase13SelectionIsValid,
} from './horseDecision/responseValidation.js';
import type { JointPolicyMode } from './multiway/JointLivePolicy.js';
import { evaluateJointLivePolicy } from './multiway/JointLivePolicy.js';
import { jointPolicyFixture } from './multiway/JointRangeFixture.test-support.js';
import { JOINT_LIVE_DOMAIN } from './multiway/JointSampleAcquisition.js';
import { OMAHA_VARIANT_PACKS } from './omaha/OmahaVariantPolicyPack.js';
import { REMAINING_VARIANT_PACKS } from './remainingVariants/RemainingVariantPolicyPack.js';

const usableAuthority = (continuationVersion: string) => ({
  version: 'horse-qualified-authority-receipt-v1',
  epoch: 'e',
  generation: 1,
  state: 'usable',
  reason: 'admitted',
  continuationVersion,
  approvalGeneration: 1,
  authorityKey: 'k',
  evidenceSha256: null,
  sourceSha: null,
  expiresAt: null,
  mainGeneration: null,
});
const act = (d: { action: string; amount?: number | null }) => ({
  action: d.action,
  amount: d.amount ?? null,
});

/** Round 3 changes a decision only where a wager's paired edge clears its
 * lower bound, so each variant's wiring spot is one where the candidate
 * acts: the street, board count and decision seed offset, found by sweeping
 * the fixture (street river, turn, flop; one to three boards; offsets 0 to
 * 39) for the first applied candidate. */
const SELECTED_SPOT: Record<
  (typeof HORSE_PHASE13_VARIANTS)[number],
  { street: 'flop' | 'turn' | 'river'; boards: number; k: number }
> = {
  nlh: { street: 'turn', boards: 1, k: 2 },
  plo4: { street: 'river', boards: 2, k: 0 },
  plo5: { street: 'turn', boards: 2, k: 1 },
  plo6: { street: 'turn', boards: 2, k: 6 },
  plo8: { street: 'river', boards: 1, k: 1 },
  flo8: { street: 'river', boards: 1, k: 4 },
  flh: { street: 'turn', boards: 1, k: 12 },
  pineapple: { street: 'river', boards: 1, k: 2 },
  short_deck: { street: 'river', boards: 2, k: 10 },
};

/** One live cash decision: the real policy clock is held at 0 (wiring, not
 * latency; the live budget is tested by the policy suites), every earlier
 * phase at its live shadow default. */
function decide(
  variant: (typeof HORSE_PHASE13_VARIANTS)[number],
  phase13Joint: JointPolicyMode
): HorseDecision {
  const spot = SELECTED_SPOT[variant];
  const s = jointPolicyFixture(variant, spot.boards, 'cash', spot.street);
  seedFastRandom(10_301_204 + spot.k);
  return structuredClone(
    HorseLogic.decide(
      s.hero,
      s.state,
      'balanced',
      {},
      {
        telemetry: false,
        mind: false,
        decisionTimeMs: 0,
        phase10Plo4: 'shadow',
        phase11Omaha: 'shadow',
        phase12Remaining: 'shadow',
        phase13Joint,
      }
    )
  );
}

describe('P13.3 worker-owned Phase 13 mode', () => {
  const VERDICTS: HorseAuthorityVerdict[] = [
    'missing_receipt',
    'mismatched',
    'stale_generation',
    'restarted',
    'withdrawn',
    'refresh_failed',
  ];
  it.each(HORSE_PHASE13_VARIANTS)(
    '%s: candidate only from usable authority for its own variant on a cash decision',
    (variant) => {
      const mode = (over: Partial<Parameters<typeof horsePhase13AdmittedMode>[0]>) =>
        horsePhase13AdmittedMode({
          callerMode: undefined,
          gameMode: 'cash',
          variant,
          asset: undefined,
          packVariant: variant,
          verdict: 'usable',
          ...over,
        });
      expect(mode({})).toBe('candidate');
      expect(mode({ asset: 'chips' })).toBe('candidate');
      // Audit 2026-10-06: a Diamond decision is outside every Phase 13
      // qualified domain (P13.2 excludes Diamond NLH), so it stays shadow.
      expect(mode({ asset: 'diamonds' })).toBe('shadow');
      expect(mode({ asset: 'diamonds', callerMode: 'off' })).toBe('off');
      for (const verdict of VERDICTS) expect(mode({ verdict }), verdict).toBe('shadow');
      expect(mode({ gameMode: 'tournament' })).toBe('shadow');
      const other = HORSE_PHASE13_VARIANTS.find((v) => v !== variant)!;
      expect(mode({ packVariant: other })).toBe('shadow');
      expect(mode({ packVariant: null })).toBe('shadow');
      // The caller can only turn the owner off; its own candidate is ignored.
      expect(mode({ callerMode: 'off' })).toBe('off');
      expect(mode({ callerMode: 'candidate', verdict: 'missing_receipt' })).toBe('shadow');
      expect(mode({ callerMode: 'shadow' })).toBe('candidate');
    }
  );
  it('an unknown variant is never a candidate', () => {
    expect(
      horsePhase13AdmittedMode({
        callerMode: undefined,
        gameMode: 'cash',
        variant: 'stud',
        asset: undefined,
        packVariant: null,
        verdict: 'usable',
      })
    ).toBe('shadow');
  });
});

describe('P13.3 a live joint selection at the worker boundary', () => {
  it.each(HORSE_PHASE13_VARIANTS)(
    'a selected %s cash candidate crosses only with usable authority for its own variant',
    (variant) => {
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      onTestFinished(() => clock.mockRestore());
      const mode = horsePhase13AdmittedMode({
        callerMode: undefined,
        gameMode: 'cash',
        variant,
        asset: undefined,
        packVariant: variant,
        verdict: 'usable',
      });
      const selected = decide(variant, mode);
      const reference = decide(variant, 'off');
      const receipt = selected.jointPolicy!;
      expect(receipt).toMatchObject({
        variant,
        version: JOINT_LIVE_DOMAIN.version,
        mode: 'candidate',
        applied: true,
        changed: true,
        selection: 'selected',
        selectionRefusal: null,
        utilityOwner: 'cash',
      });
      // The joint baseline is what the table would have played without it.
      expect({ action: receipt.baselineAction, amount: receipt.baselineAmount }).toEqual(
        act(reference)
      );
      expect(act(selected)).not.toEqual(act(reference));
      expect(act(selected)).toEqual({
        action: receipt.proposalAction,
        amount: receipt.proposalAmount,
      });

      const decision = selected as unknown as Record<string, unknown>;
      const valid = (value: unknown, d: Record<string, unknown> = decision) =>
        horsePhase13SelectionIsValid(value, d);
      // No authority: candidate mode is not usable authority.
      expect(valid(receipt)).toBe(false);
      expect(horseDecisionReceiptIsValid(structuredClone(selected), variant)).toBe(false);
      const authority = usableAuthority(horsePhase13ContinuationVersion(variant));
      const backed = { ...receipt, authority };
      expect(valid(backed)).toBe(true);
      const bound = structuredClone(selected);
      bound.jointPolicy!.authority = authority as never;
      expect(horseDecisionReceiptIsValid(bound, variant)).toBe(true);

      // Another variant's joint authority, the bare joint domain, a Phase 12
      // pack or a Phase 11 pack never backs it.
      const other = HORSE_PHASE13_VARIANTS.find((v) => v !== variant)!;
      for (const continuationVersion of [
        horsePhase13ContinuationVersion(other),
        JOINT_LIVE_DOMAIN.version,
        REMAINING_VARIANT_PACKS.flo8.version,
        OMAHA_VARIANT_PACKS.plo8.version,
      ])
        expect(valid({ ...receipt, authority: usableAuthority(continuationVersion) })).toBe(false);
      expect(valid({ ...backed, authority: { ...authority, state: 'withdrawn' } })).toBe(false);

      // Relabels and acceptance-time fields the worker may not set.
      for (const [i, forged] of [
        { ...backed, selection: 'shadow_change' },
        { ...backed, selection: 'none' },
        { ...backed, selection: 'controller_accepted' },
        { ...backed, selection: 'withdrawn_before_acceptance' },
        { ...backed, authorityVerdict: 'usable' },
        { ...backed, utilityOwner: 'phase7_evaluated' },
        { ...backed, finalAction: receipt.baselineAction, finalAmount: receipt.baselineAmount },
        { ...backed, changed: false },
        { ...backed, mode: 'shadow' },
        { ...backed, selectionRefusal: 'illegal_candidate' },
        { ...backed, selectionRefusal: 'earlier_phase_applied' },
        { ...backed, selectionRefusal: 'busy' },
        { ...backed, version: 'joint-multiway-round1-v3' },
      ].entries())
        expect(valid(forged), `forgery ${i}`).toBe(false);
      // The action that leaves the worker must be the selection.
      expect(
        valid(backed, {
          ...decision,
          action: receipt.baselineAction,
          amount: receipt.baselineAmount ?? undefined,
        })
      ).toBe(false);

      // Never on top of an applied Phase 10/11/12 candidate.
      for (const prior of ['plo4Policy', 'omahaVariantPolicy', 'remainingVariantPolicy'])
        expect(valid(backed, { ...decision, [prior]: { applied: true } }), prior).toBe(false);

      // The shadow run of the same spot: a change that never acts.
      const shadow = decide(variant, 'shadow').jointPolicy!;
      expect(shadow).toMatchObject({ applied: false, changed: true, selection: 'shadow_change' });
      expect(valid(shadow)).toBe(true);
      expect(valid({ ...shadow, selection: 'selected' })).toBe(false);
      // The two named refusals are allowed on an unapplied receipt only.
      expect(valid({ ...shadow, selectionRefusal: 'earlier_phase_applied' })).toBe(true);
      expect(valid({ ...shadow, selectionRefusal: 'illegal_candidate' })).toBe(true);
      expect(valid({ ...shadow, selectionRefusal: 'busy' })).toBe(false);
    }
  );
});

describe('P13.3 Phase 7 keeps tournament objective ownership', () => {
  it.each(HORSE_PHASE13_VARIANTS.filter((v) => v !== 'pineapple'))(
    'even an offline candidate %s tournament receipt cannot cross as a selection',
    (variant) => {
      const s = jointPolicyFixture(variant, 1, 'tournament', 'river');
      const r = evaluateJointLivePolicy(s.hero, s.state, s.baseline, 'candidate', () => 0);
      const receipt = JSON.parse(JSON.stringify(r.receipt)) as Record<string, unknown>;
      // The wrapper alone (no HorseLogic node, no worker) prices the
      // candidate for Phase 7; it is the offline control this test forges.
      expect(String(receipt.utilityOwner)).toMatch(/^phase7_/);
      const forged = {
        ...receipt,
        mode: 'candidate',
        applied: true,
        changed: true,
        selection: 'selected',
        authority: usableAuthority(horsePhase13ContinuationVersion(variant)),
        finalAction: receipt.proposalAction,
        finalAmount: receipt.proposalAmount,
      };
      const decision = { action: receipt.proposalAction, amount: receipt.proposalAmount };
      expect(horsePhase13SelectionIsValid(forged, decision)).toBe(false);
      // The tournament objective is the only thing refusing it.
      expect(horsePhase13SelectionIsValid({ ...forged, utilityOwner: 'cash' }, decision)).toBe(
        true
      );
    }
  );
});

describe('P13.3 a Diamond decision never crosses as a Phase 13 selection (audit 2026-10-06)', () => {
  it('even an offline candidate Diamond NLH cash receipt is refused at the worker boundary', () => {
    const s = jointPolicyFixture('nlh', 2, 'cash', 'flop');
    Object.assign(s.state, { asset: 'diamonds', chipUnit: 1 });
    s.state.rakeConfig!.percent = 0;
    s.state.rakeConfig!.cap = 0;
    const r = evaluateJointLivePolicy(s.hero, s.state, s.baseline, 'candidate', () => 0);
    const receipt = JSON.parse(JSON.stringify(r.receipt)) as Record<string, any>;
    expect(receipt).toMatchObject({ eligible: true, fired: true, utilityOwner: 'cash' });
    expect(receipt.inputs.objective.asset).toBe('diamonds');
    const forged = {
      ...receipt,
      mode: 'candidate',
      applied: true,
      changed: true,
      selection: 'selected',
      authority: usableAuthority(horsePhase13ContinuationVersion('nlh')),
      finalAction: receipt.proposalAction,
      finalAmount: receipt.proposalAmount,
    };
    const decision = { action: receipt.proposalAction, amount: receipt.proposalAmount };
    expect(horsePhase13SelectionIsValid(forged, decision)).toBe(false);
    // Candidate mode alone, unapplied, is refused as well: the worker never
    // runs a Diamond decision in candidate mode.
    expect(
      horsePhase13SelectionIsValid(
        {
          ...forged,
          applied: false,
          selection: 'shadow_change',
          finalAction: receipt.baselineAction,
          finalAmount: receipt.baselineAmount,
        },
        { action: receipt.baselineAction, amount: receipt.baselineAmount }
      )
    ).toBe(false);
    // The Diamond asset is the only thing refusing it.
    const chips = {
      ...forged,
      inputs: { ...receipt.inputs, objective: { ...receipt.inputs.objective, asset: 'chips' } },
    };
    expect(horsePhase13SelectionIsValid(chips, decision)).toBe(true);
    // An applied receipt without a bound chip objective is refused too.
    expect(horsePhase13SelectionIsValid({ ...forged, inputs: null }, decision)).toBe(false);
  });
});
