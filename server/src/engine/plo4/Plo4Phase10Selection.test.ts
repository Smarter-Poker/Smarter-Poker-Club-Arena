/**
 * P10.3 at the HorseLogic owner: Phase 7 keeps every tournament objective
 * decision, and an authority-backed candidate the legalizer would rewrite is
 * never executed. Expected actions come from the pack-off reference run and
 * from the Phase 7 receipt itself, not from the code under test.
 */
import { describe, expect, it, vi } from 'vitest';

const forge = vi.hoisted(() => ({ amountDelta: 0 }));
vi.mock('./Plo4LivePolicy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./Plo4LivePolicy.js')>();
  return {
    ...actual,
    evaluatePlo4LivePolicy: (...args: Parameters<typeof actual.evaluatePlo4LivePolicy>) => {
      const result = actual.evaluatePlo4LivePolicy(...args);
      if (!forge.amountDelta || typeof result.decision.amount !== 'number') return result;
      // An applied candidate whose wager is not a legal size.
      return {
        ...result,
        decision: { ...result.decision, amount: result.decision.amount + forge.amountDelta },
      };
    },
  };
});

import { plo4Cards, plo4ReferenceSpot } from '../../benchmark/Plo4PolicyEvidence.js';
import { HorseLogic } from '../HorseLogic.js';
import { seedFastRandom } from '../HorseEval.js';
import { calculatePots } from '../PokerEngine.js';
import { horsePhase10AdmittedMode } from '../HorsePhase10Authority.js';
import { horsePhase10SelectionIsValid } from '../horseDecision/responseValidation.js';
import type { Plo4LiveMode } from './Plo4LivePolicy.js';

/** The complete SNG context Plo4LivePolicy.test.ts uses for its Phase 7 case. */
const tournament = (input: ReturnType<typeof plo4ReferenceSpot>) => {
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

const decide = (input: ReturnType<typeof plo4ReferenceSpot>, phase10Plo4: Plo4LiveMode) => {
  seedFastRandom(100101);
  return HorseLogic.decide(
    input.hero,
    input.state,
    'balanced',
    {},
    { telemetry: false, mind: false, decisionTimeMs: 0, phase10Plo4, phase10EvidenceMode: true }
  );
};

describe('P10.3 Phase 7 keeps tournament objective ownership', () => {
  it.each(['royal_flush', 'non_nut_flush'] as const)(
    'a %s tournament decision under usable Phase 10 authority is Phase 7’s decision',
    (spot) => {
      const mode = horsePhase10AdmittedMode({
        callerMode: undefined,
        gameMode: 'tournament',
        verdict: 'usable',
      });
      expect(mode).toBe('shadow');
      const reference = decide(tournament(plo4ReferenceSpot(spot)), 'off');
      const admitted = decide(tournament(plo4ReferenceSpot(spot)), mode);
      expect(reference.tournamentUtility).toBeDefined();
      expect({ action: admitted.action, amount: admitted.amount }).toEqual({
        action: reference.action,
        amount: reference.amount,
      });
      expect(admitted.tournamentUtility?.selectedAction).toBe(admitted.action);
      expect(admitted.tournamentUtility?.selectedAction).toBe(
        reference.tournamentUtility?.selectedAction
      );
      expect(admitted.plo4Policy).toMatchObject({
        mode: 'shadow',
        applied: false,
        utilityOwner: 'phase7_evaluated',
      });
      expect(admitted.plo4Policy?.selection).not.toBe('selected');
    }
  );

  it('even the offline candidate control cannot make the pack own a tournament decision', () => {
    // The live worker never passes this; it is the defence behind the worker rule.
    const input = tournament(plo4ReferenceSpot('royal_flush'));
    const candidate = decide(input, 'candidate');
    const receipt = candidate.plo4Policy!;
    expect(receipt.utilityOwner).toBe('phase7_evaluated');
    // Phase 7 ran last and chose the executed action.
    expect(candidate.tournamentUtility?.selectedAction).toBe(candidate.action);
    if (
      receipt.proposalAction !== candidate.action ||
      receipt.proposalAmount !== (candidate.amount ?? null)
    )
      expect(receipt.selection).toBe('shadow_change');
    // Whatever HorseLogic produced, the worker boundary refuses an applied
    // PLO4 receipt that is not a cash decision.
    const forged = {
      ...receipt,
      mode: 'candidate',
      applied: true,
      changed: true,
      selection: 'selected',
      authority: {
        version: 'horse-qualified-authority-receipt-v1',
        epoch: 'e',
        generation: 1,
        state: 'usable',
        reason: 'admitted',
        continuationVersion: 'plo4-policy-round3-v1',
        approvalGeneration: 1,
        authorityKey: 'k',
        evidenceSha256: null,
        sourceSha: null,
        expiresAt: null,
        mainGeneration: null,
      },
      finalAction: receipt.proposalAction,
      finalAmount: receipt.proposalAmount,
    };
    const decision = { action: receipt.proposalAction, amount: receipt.proposalAmount };
    expect(horsePhase10SelectionIsValid(forged, decision)).toBe(false);
    expect(horsePhase10SelectionIsValid({ ...forged, utilityOwner: 'cash' }, decision)).toBe(true);
  });
});

/** Round 3: the heads-up button with a hand the reference folds, which the
 * pack opens at the minimum raise (a real applied candidate). */
const trashOpen = () => {
  const input = plo4ReferenceSpot('premium_open');
  input.hero.cards = plo4Cards('2c 7d 3h 8s');
  input.state.players[0] = { ...input.hero, cards: [] };
  return input;
};

describe('P10.3 illegal candidate retention', () => {
  it('an applied candidate the legalizer would rewrite is not selected; the reference is executed', () => {
    const honest = decide(trashOpen(), 'candidate');
    expect(honest.plo4Policy).toMatchObject({ applied: true, selection: 'selected' });
    const reference = decide(trashOpen(), 'off');
    forge.amountDelta = 0.004;
    try {
      const forged = decide(trashOpen(), 'candidate');
      expect({ action: forged.action, amount: forged.amount }).toEqual({
        action: reference.action,
        amount: reference.amount,
      });
      expect(forged.plo4Policy).toMatchObject({
        applied: false,
        selection: 'shadow_change',
        selectionRefusal: 'illegal_candidate',
        finalAction: reference.action,
      });
    } finally {
      forge.amountDelta = 0;
    }
  });
});
