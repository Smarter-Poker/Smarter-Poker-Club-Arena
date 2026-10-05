/**
 * P12.3 at the HorseLogic owner: Phase 7 keeps every Short Deck, FLH and FLO8
 * tournament objective decision (Crazy Pineapple has no tournament format),
 * and an authority-backed candidate the legalizer would rewrite is never
 * executed, live or offline. Expected actions come from the pack-off
 * reference run and from the Phase 7 receipt itself, not from the code under
 * test.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const forge = vi.hoisted(() => ({ amountDelta: 0 }));
vi.mock('./RemainingVariantLivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./RemainingVariantLivePolicy.js')>();
  return {
    ...actual,
    evaluateRemainingVariantPolicy: (
      ...args: Parameters<typeof actual.evaluateRemainingVariantPolicy>
    ) => {
      const result = actual.evaluateRemainingVariantPolicy(...args);
      if (!forge.amountDelta || typeof result.decision.amount !== 'number') return result;
      // An applied candidate whose wager is not a legal size.
      return {
        ...result,
        decision: { ...result.decision, amount: result.decision.amount + forge.amountDelta },
      };
    },
  };
});

import { remainingVariantSpot } from '../../benchmark/RemainingVariantPolicyEvidence.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { horsePhase12AdmittedMode } from '../HorsePhase12Authority.js';
import { horsePhase12SelectionIsValid } from '../horseDecision/responseValidation.js';
import { OMAHA_VARIANT_PACKS } from '../omaha/OmahaVariantPolicyPack.js';
import type { RemainingVariantMode } from './RemainingVariantLivePolicy.js';
import {
  REMAINING_VARIANT_PACKS,
  type RemainingPolicyVariant,
} from './RemainingVariantPolicyPack.js';

const decide = (
  input: ReturnType<typeof remainingVariantSpot>,
  phase12Remaining: RemainingVariantMode,
  evidenceMode = true
) => {
  seedFastRandom(100101);
  return HorseLogic.decide(
    input.hero,
    input.state,
    'balanced',
    {},
    {
      telemetry: false,
      mind: false,
      decisionTimeMs: 0,
      phase12Remaining,
      ...(evidenceMode ? { phase12EvidenceMode: true } : {}),
    }
  );
};
const act = (d: { action: string; amount?: number }) => ({
  action: d.action,
  amount: d.amount ?? null,
});
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

// Tournament spots where the pack's proposal differs from the reference
// (checked below). Pineapple is refused in tournaments before any proposal.
const CHANGED_TOURNAMENT_SPOTS = [
  ['short_deck', 'flop'],
  ['flh', 'flop'],
  ['flh', 'turn'],
  ['flo8', 'flop'],
] as const;

describe('P12.3 Phase 7 keeps tournament objective ownership', () => {
  it.each(CHANGED_TOURNAMENT_SPOTS)(
    'a %s %s tournament decision under usable Phase 12 authority is Phase 7’s decision',
    (variant, street) => {
      const mode = horsePhase12AdmittedMode({
        callerMode: undefined,
        gameMode: 'tournament',
        variant,
        packVariant: variant,
        verdict: 'usable',
      });
      expect(mode).toBe('shadow');
      const spot = () => remainingVariantSpot(variant, street, 2, 'tournament');
      const reference = decide(spot(), 'off');
      const admitted = decide(spot(), mode);
      expect(reference.tournamentUtility).toBeDefined();
      expect(act(admitted)).toEqual(act(reference));
      expect(admitted.tournamentUtility?.selectedAction).toBe(admitted.action);
      expect(admitted.tournamentUtility?.selectedAction).toBe(
        reference.tournamentUtility?.selectedAction
      );
      const receipt = admitted.remainingVariantPolicy!;
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
      const candidate = decide(remainingVariantSpot(variant, street, 2, 'tournament'), 'candidate');
      const receipt = candidate.remainingVariantPolicy!;
      expect(receipt.utilityOwner).toBe('phase7_evaluated');
      expect(candidate.tournamentUtility?.selectedAction).toBe(candidate.action);
      const forged = {
        ...receipt,
        mode: 'candidate',
        applied: true,
        changed: true,
        selection: 'selected',
        authority: usableAuthority(receipt.version),
        finalAction: receipt.proposalAction,
        finalAmount: receipt.proposalAmount,
      };
      const decision = { action: receipt.proposalAction, amount: receipt.proposalAmount };
      expect(horsePhase12SelectionIsValid(forged, decision)).toBe(false);
      expect(horsePhase12SelectionIsValid({ ...forged, utilityOwner: 'cash' }, decision)).toBe(
        true
      );
      // Another pack's authority, or a Phase 11 one, never backs this receipt.
      const other: RemainingPolicyVariant = variant === 'flh' ? 'flo8' : 'flh';
      for (const continuationVersion of [
        REMAINING_VARIANT_PACKS[other].version,
        OMAHA_VARIANT_PACKS.plo8.version,
      ])
        expect(
          horsePhase12SelectionIsValid(
            { ...forged, utilityOwner: 'cash', authority: usableAuthority(continuationVersion) },
            decision
          )
        ).toBe(false);
    }
  );

  it('a Pineapple tournament decision is refused by name before any proposal', () => {
    const s = remainingVariantSpot('pineapple', 'flop', 2, 'cash');
    s.state.gameMode = 'tournament';
    s.state.tournament = remainingVariantSpot('flh', 'flop', 2, 'tournament').state.tournament;
    const d = decide(s, 'shadow');
    expect(d.remainingVariantPolicy).toMatchObject({
      reason: 'pineapple_tournament_unapproved',
      eligible: false,
      applied: false,
      selection: 'none',
    });
  });
});

// Cash spots where the pack applies a different action than the reference.
const CHANGED_CASH_SPOTS = [
  ['short_deck', 'preflop'],
  ['pineapple', 'preflop'],
  ['flh', 'turn'],
  ['flo8', 'flop'],
] as const;

describe('P12.3 illegal candidate retention under live candidate admission', () => {
  it.each(CHANGED_CASH_SPOTS)(
    'an applied %s %s candidate the legalizer would rewrite is not selected; the reference is executed',
    (variant, street) => {
      // Live: the mode the worker admits from usable cash authority, on the
      // real policy clock (no offline evidence control).
      const mode = horsePhase12AdmittedMode({
        callerMode: undefined,
        gameMode: 'cash',
        variant,
        packVariant: variant,
        verdict: 'usable',
      });
      expect(mode).toBe('candidate');
      const spot = () => remainingVariantSpot(variant, street, 2, 'cash');
      // Wiring, not latency: the live budget is tested by the policy suites.
      const clock = vi.spyOn(performance, 'now').mockReturnValue(0);
      onTestFinished(() => clock.mockRestore());
      const honest = decide(spot(), mode, false);
      expect(honest.remainingVariantPolicy?.reason).not.toBe('work_budget');
      expect(honest.remainingVariantPolicy).toMatchObject({
        applied: true,
        selection: 'selected',
        selectionRefusal: null,
      });
      const reference = decide(spot(), 'off', false);
      expect(act(honest)).not.toEqual(act(reference));
      forge.amountDelta = 0.004;
      try {
        const forged = decide(spot(), mode, false);
        expect(act(forged)).toEqual(act(reference));
        const receipt = forged.remainingVariantPolicy!;
        expect(receipt).toMatchObject({
          mode: 'candidate',
          applied: false,
          selection: 'shadow_change',
          selectionRefusal: 'illegal_candidate',
          finalAction: reference.action,
          finalAmount: reference.amount ?? null,
        });
        // With the worker's usable authority bound, the refused candidate
        // crosses the boundary as what it is: not a selection.
        expect(
          horsePhase12SelectionIsValid(
            { ...receipt, authority: usableAuthority(receipt.version) },
            forged as unknown as Record<string, unknown>
          )
        ).toBe(true);
        expect(
          horsePhase12SelectionIsValid(
            { ...receipt, authority: usableAuthority(receipt.version), selection: 'selected' },
            forged as unknown as Record<string, unknown>
          )
        ).toBe(false);
      } finally {
        forge.amountDelta = 0;
      }
    }
  );
});
