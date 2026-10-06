/**
 * P11.3 at the HorseLogic owner: Phase 7 keeps every PLO5/PLO6/PLO8
 * tournament objective decision, and an authority-backed candidate the
 * legalizer would rewrite is never executed. Expected actions come from the
 * pack-off reference run and from the Phase 7 receipt itself, not from the
 * code under test.
 */
import { describe, expect, it, vi } from 'vitest';

const forge = vi.hoisted(() => ({ amountDelta: 0 }));
vi.mock('./OmahaVariantLivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./OmahaVariantLivePolicy.js')>();
  return {
    ...actual,
    evaluateOmahaVariantPolicy: (...args: Parameters<typeof actual.evaluateOmahaVariantPolicy>) => {
      const result = actual.evaluateOmahaVariantPolicy(...args);
      if (!forge.amountDelta || typeof result.decision.amount !== 'number') return result;
      // An applied candidate whose wager is not a legal size.
      return {
        ...result,
        decision: { ...result.decision, amount: result.decision.amount + forge.amountDelta },
      };
    },
  };
});

import { omahaVariantSpot } from '../../benchmark/OmahaVariantPolicyEvidence.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { calculatePots } from '../PokerEngine.js';
import { horsePhase11AdmittedMode } from '../HorsePhase11Authority.js';
import { horsePhase11SelectionIsValid } from '../horseDecision/responseValidation.js';
import type { OmahaVariantMode } from './OmahaVariantLivePolicy.js';
import { OMAHA_VARIANT_PACKS, type OmahaPolicyVariant } from './OmahaVariantPolicyPack.js';

/** The complete SNG context the Phase 10 owner test uses for its Phase 7 case. */
const tournament = (input: ReturnType<typeof omahaVariantSpot>) => {
  input.state.gameMode = 'tournament';
  input.state.format = 'sng';
  input.state.pots = calculatePots(input.state.players);
  input.state.tournament = {
    schemaVersion: 1,
    contextStatus: 'complete',
    contextIssues: [],
    playersLeft: 2,
    spotsPaid: 1,
    payoutPct: [100],
    stacks: input.state.players.map((p) => p.stack + p.totalInvested),
    stackByUser: Object.fromEntries(
      input.state.players.map((p) => [p.user_id, p.stack + p.totalInvested])
    ),
    currentSmallBlind: 1,
    currentBigBlind: 2,
    currentAnte: 0,
    anteType: 'none',
    prizePoolCents: 10000,
    bountyPoolCents: 0,
    isPko: false,
    isBounty: false,
    isMysteryBounty: false,
    mysteryBountyStage: 'none',
    reentryOpen: false,
    rebuyOpen: false,
    addOnPeriodOpen: false,
    maxReentries: 0,
    maxRebuys: 0,
    reloadsUsed: 0,
    addOnTaken: false,
    rebuyAffordable: false,
    addOnAffordable: false,
  };
  return input;
};

const decide = (input: ReturnType<typeof omahaVariantSpot>, phase11Omaha: OmahaVariantMode) => {
  seedFastRandom(100101);
  return HorseLogic.decide(
    input.hero,
    input.state,
    'balanced',
    {},
    { telemetry: false, mind: false, decisionTimeMs: 0, phase11Omaha, phase11EvidenceMode: true }
  );
};
const act = (d: { action: string; amount?: number }) => ({
  action: d.action,
  amount: d.amount ?? null,
});

// Spots where the pack's proposal differs from the reference (checked below).
const CHANGED_TOURNAMENT_SPOTS = [
  ['plo5', 'preflop'],
  ['plo5', 'turn'],
  ['plo6', 'preflop'],
  ['plo6', 'turn'],
  ['plo8', 'preflop'],
] as const;

describe('P11.3 Phase 7 keeps tournament objective ownership', () => {
  it.each(CHANGED_TOURNAMENT_SPOTS)(
    'a %s %s tournament decision under usable Phase 11 authority is Phase 7’s decision',
    (variant, street) => {
      const mode = horsePhase11AdmittedMode({
        callerMode: undefined,
        gameMode: 'tournament',
        variant,
        packVariant: variant,
        verdict: 'usable',
      });
      expect(mode).toBe('shadow');
      const spot = () => tournament(omahaVariantSpot(variant, street, 2, 'tournament'));
      const reference = decide(spot(), 'off');
      const admitted = decide(spot(), mode);
      expect(reference.tournamentUtility).toBeDefined();
      expect(act(admitted)).toEqual(act(reference));
      expect(admitted.tournamentUtility?.selectedAction).toBe(admitted.action);
      expect(admitted.tournamentUtility?.selectedAction).toBe(
        reference.tournamentUtility?.selectedAction
      );
      const receipt = admitted.omahaVariantPolicy!;
      expect(receipt).toMatchObject({
        mode: 'shadow',
        applied: false,
        changed: true,
        selection: 'shadow_change',
        utilityOwner: 'phase7_evaluated',
      });
      // The proposal is not what was executed: the spot is a real test.
      expect({ action: receipt.proposalAction, amount: receipt.proposalAmount }).not.toEqual(
        act(reference)
      );
    }
  );

  it.each(CHANGED_TOURNAMENT_SPOTS)(
    'even the offline candidate control cannot carry a %s %s tournament selection across the worker boundary',
    (variant, street) => {
      // The live worker never passes this; it is the defence behind the worker rule.
      const candidate = decide(
        tournament(omahaVariantSpot(variant, street, 2, 'tournament')),
        'candidate'
      );
      const receipt = candidate.omahaVariantPolicy!;
      expect(receipt.utilityOwner).toBe('phase7_evaluated');
      // Phase 7 ran last and chose the executed action.
      expect(candidate.tournamentUtility?.selectedAction).toBe(candidate.action);
      const forgedAuthority = {
        version: 'horse-qualified-authority-receipt-v1',
        epoch: 'e',
        generation: 1,
        state: 'usable',
        reason: 'admitted',
        continuationVersion: receipt.version,
        approvalGeneration: 1,
        authorityKey: 'k',
        evidenceSha256: null,
        sourceSha: null,
        expiresAt: null,
        mainGeneration: null,
      };
      const forged = {
        ...receipt,
        mode: 'candidate',
        applied: true,
        changed: true,
        selection: 'selected',
        authority: forgedAuthority,
        finalAction: receipt.proposalAction,
        finalAmount: receipt.proposalAmount,
      };
      const decision = { action: receipt.proposalAction, amount: receipt.proposalAmount };
      // Whatever HorseLogic produced, the worker boundary refuses an applied
      // Phase 11 receipt that is not a cash decision.
      expect(horsePhase11SelectionIsValid(forged, decision)).toBe(false);
      expect(horsePhase11SelectionIsValid({ ...forged, utilityOwner: 'cash' }, decision)).toBe(
        true
      );
      // A PLO5 authority never backs another pack's receipt.
      const other: OmahaPolicyVariant = variant === 'plo5' ? 'plo6' : 'plo5';
      expect(
        horsePhase11SelectionIsValid(
          {
            ...forged,
            utilityOwner: 'cash',
            authority: {
              ...forgedAuthority,
              continuationVersion: OMAHA_VARIANT_PACKS[other].version,
            },
          },
          decision
        )
      ).toBe(false);
    }
  );
});

describe('P11.3 illegal candidate retention', () => {
  it.each(['plo5', 'plo6', 'plo8'] as const)(
    'an applied %s candidate the legalizer would rewrite is not selected; the reference is executed',
    (variant) => {
      const spot = () => omahaVariantSpot(variant, 'preflop', 2, 'cash');
      const honest = decide(spot(), 'candidate');
      expect(honest.omahaVariantPolicy).toMatchObject({ applied: true, selection: 'selected' });
      const reference = decide(spot(), 'off');
      expect(act(honest)).not.toEqual(act(reference));
      forge.amountDelta = 0.004;
      try {
        const forged = decide(spot(), 'candidate');
        expect(act(forged)).toEqual(act(reference));
        expect(forged.omahaVariantPolicy).toMatchObject({
          applied: false,
          selection: 'shadow_change',
          selectionRefusal: 'illegal_candidate',
          finalAction: reference.action,
          finalAmount: reference.amount ?? null,
        });
      } finally {
        forge.amountDelta = 0;
      }
    }
  );
});
