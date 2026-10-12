/**
 * P12.3 at the HorseLogic owner: Phase 7 keeps every Short Deck, FLH and FLO8
 * tournament objective decision (Crazy Pineapple has no tournament format),
 * and an authority-backed candidate the legalizer would rewrite is never
 * executed, live or offline. Expected actions come from the pack-off
 * reference run and from the Phase 7 receipt itself, not from the code under
 * test.
 */
import { describe, expect, it, onTestFinished, vi } from 'vitest';

const forge = vi.hoisted(() => ({ on: false }));
vi.mock('./RemainingVariantLivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./RemainingVariantLivePolicy.js')>();
  return {
    ...actual,
    evaluateRemainingVariantPolicy: (
      ...args: Parameters<typeof actual.evaluateRemainingVariantPolicy>
    ) => {
      const result = actual.evaluateRemainingVariantPolicy(...args);
      if (!forge.on || !result.receipt.applied) return result;
      // An applied candidate the legalizer would rewrite: a wager off the
      // legal size, or the passive action of the other kind.
      const d = result.decision;
      const decision =
        typeof d.amount === 'number' && (d.action === 'bet' || d.action === 'raise')
          ? { ...d, amount: d.amount + 0.004 }
          : d.action === 'check'
            ? { ...d, action: 'fold' as const }
            : d.action === 'fold'
              ? { ...d, action: 'check' as const }
              : d;
      return { ...result, decision };
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
import {
  round3ChangedSpot,
  round3ChangedStreet,
  type Round3Spot,
} from './RemainingVariantRound3Spots.test-support.js';

const decide = (input: Round3Spot, phase12Remaining: RemainingVariantMode, evidenceMode = true) => {
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

// Round 3 changes the reference only in its declared preflop spots (here the
// heads-up button first in); these are found over fixed holdings where the
// shadow proposal differs from the reference (checked below). Pineapple is refused in tournaments before any
// proposal.
const TOURNAMENT_VARIANTS = ['short_deck', 'flh', 'flo8'] as const;
const changedSpot = (variant: RemainingPolicyVariant, mode: 'cash' | 'tournament') =>
  round3ChangedSpot(
    variant,
    mode,
    (spot) => decide(spot, 'shadow').remainingVariantPolicy?.changed === true
  );

describe('P12.3 Phase 7 keeps tournament objective ownership', () => {
  it.each(TOURNAMENT_VARIANTS)(
    'a %s tournament decision under usable Phase 12 authority is Phase 7’s decision',
    (variant) => {
      const mode = horsePhase12AdmittedMode({
        callerMode: undefined,
        gameMode: 'tournament',
        variant,
        packVariant: variant,
        verdict: 'usable',
      });
      expect(mode).toBe('shadow');
      const spot = changedSpot(variant, 'tournament');
      expect(spot().state.stage).toBe(round3ChangedStreet(variant));
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

  it.each(TOURNAMENT_VARIANTS)(
    'even the offline candidate control cannot carry a %s tournament selection across the worker boundary',
    (variant) => {
      const candidate = decide(changedSpot(variant, 'tournament')(), 'candidate');
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

const CASH_VARIANTS = ['short_deck', 'pineapple', 'flh', 'flo8'] as const;

describe('P12.3 illegal candidate retention under live candidate admission', () => {
  it.each(CASH_VARIANTS)(
    'an applied %s candidate the legalizer would rewrite is not selected; the reference is executed',
    (variant) => {
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
      const spot = changedSpot(variant, 'cash');
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
      forge.on = true;
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
        forge.on = false;
      }
    }
  );
});
