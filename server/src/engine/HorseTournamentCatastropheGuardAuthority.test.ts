/** Genuine parser exercised with synthetic memory evidence, never live qualification. */
import { describe, expect, it } from 'vitest';
import {
  admitHorsePhase8GuardAuthority,
  catastropheGuardStrengthIsValid,
  GUARD_QUALIFICATION_SEEDS,
  GUARD_QUALIFICATION_OBJECTIVES,
  GUARD_QUALIFICATION_PAIRS,
} from './HorseTournamentCatastropheGuardAuthority.js';
import {
  guardTestAdmission,
  guardTestEvidence,
  GUARD_TEST_QUALIFICATION_PATH,
  GUARD_TEST_STRENGTH_PATH,
} from './HorseTournamentCatastropheGuardAuthority.test-support.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import {
  TOURNAMENT_PROMOTION_PAIRS,
  TOURNAMENT_PROMOTION_SEEDS,
  TOURNAMENT_LEAGUE_OBJECTIVES,
  pairedConfidence99,
} from '../benchmark/HorseTournamentLeague.js';
const admit = (f: ReturnType<typeof guardTestEvidence>) =>
  admitHorsePhase8GuardAuthority(f.nowMs, f.selection, f.reader, f.runningDigest);
describe('genuine-only catastrophe guard authority', () => {
  it('matches the maintained fixed contract and admits only explicit synthetic adoption', () => {
    expect(GUARD_QUALIFICATION_SEEDS).toEqual(TOURNAMENT_PROMOTION_SEEDS);
    expect(GUARD_QUALIFICATION_OBJECTIVES).toEqual(TOURNAMENT_LEAGUE_OBJECTIVES);
    expect(GUARD_QUALIFICATION_PAIRS).toBe(TOURNAMENT_PROMOTION_PAIRS);
    const f = guardTestEvidence();
    expect(f.strength.runs[0]!.confidence99).toEqual(pairedConfidence99(0.1, 0.01, 1024));
    expect(catastropheGuardStrengthIsValid(f.strength, f.selection)).toBe(true);
    expect(admit(f)).toMatchObject({
      status: 'admitted',
      authority: {
        phase: 'phase8',
        continuationVersion: f.selection.policyVersion,
        policyDigest: f.selection.policyDigest,
        approvalGeneration: 1,
      },
    });
    expect(guardTestAdmission(7)).toMatchObject({
      status: 'admitted',
      authority: { approvalGeneration: 7 },
    });
    // Production's separate protected selector is null; legacy owner-force is not consulted.
    expect(admitHorsePhase8GuardAuthority()).toMatchObject({
      status: 'refused',
      reason: 'unselected',
    });
  });
  it.each([
    [
      'seed_string',
      (v: any) => {
        v.runs[0].seed = String(v.runs[0].seed);
      },
    ],
    [
      'duplicate_seed',
      (v: any) => {
        v.runs[0] = { ...v.runs[1] };
      },
    ],
    [
      'missing_seed',
      (v: any) => {
        v.runs.pop();
      },
    ],
    [
      'family',
      (v: any) => {
        v.runs[0].phase8PolicyFamily = 'continuation_v2';
      },
    ],
    [
      'work',
      (v: any) => {
        v.runs[0].workKind = 'continuation';
      },
    ],
    [
      'version',
      (v: any) => {
        v.runs[0].policyVersion = 'foreign';
      },
    ],
    [
      'fixture',
      (v: any) => {
        v.runs[0].evidenceMode = 'fixture';
      },
    ],
    [
      'shadow',
      (v: any) => {
        v.runs[0].candidateMode = 'shadow';
      },
    ],
    [
      'schema',
      (v: any) => {
        v.runs[0].completionSchemaVersion = 0;
      },
    ],
    [
      'incomplete',
      (v: any) => {
        v.runs[0].complete = false;
      },
    ],
    [
      'pairs',
      (v: any) => {
        v.runs[0].pairs = 1023;
      },
    ],
    [
      'requested',
      (v: any) => {
        v.runs[0].requestedPairs = 1025;
      },
    ],
    [
      'entrants',
      (v: any) => {
        v.runs[0].entrants = 3;
      },
    ],
    [
      'finish_conservation',
      (v: any) => {
        v.runs[0].candidateFinish[0]--;
      },
    ],
    [
      'finish_negative',
      (v: any) => {
        v.runs[0].baselineFinish[0] = 1025;
        v.runs[0].baselineFinish[1] = -1;
      },
    ],
    [
      'decisions',
      (v: any) => {
        v.runs[0].decisions = 9;
      },
    ],
    [
      'eligible',
      (v: any) => {
        v.runs[0].eligible = 0;
      },
    ],
    [
      'fired',
      (v: any) => {
        v.runs[0].fired--;
      },
    ],
    [
      'completed',
      (v: any) => {
        v.runs[0].completed--;
      },
    ],
    [
      'unchanged',
      (v: any) => {
        v.runs[0].changed = 0;
      },
    ],
    [
      'changed_over_count',
      (v: any) => {
        v.runs[0].changed = 11;
      },
    ],
    [
      'partial_work',
      (v: any) => {
        v.runs[0].completionRefusals = { continuation_operation_budget: 1 };
      },
    ],
    [
      'guard_rows_missing',
      (v: any) => {
        delete v.runs[0].completionDiagnostics;
      },
    ],
    [
      'guard_rows_count',
      (v: any) => {
        v.runs[0].completionDiagnostics.pop();
      },
    ],
    [
      'guard_rows_dropped',
      (v: any) => {
        v.runs[0].completionDiagnosticsDropped = -1;
      },
    ],
    [
      'guard_incomplete',
      (v: any) => {
        v.runs[0].completionDiagnostics[0].completed = false;
      },
    ],
    [
      'guard_wrong_work',
      (v: any) => {
        v.runs[0].completionDiagnostics[0].workKind = 'continuation';
      },
    ],
    [
      'guard_not_assessed',
      (v: any) => {
        v.runs[0].completionDiagnostics[0].guardWork.assessmentCompleted = false;
      },
    ],
    [
      'guard_zero_candidates',
      (v: any) => {
        v.runs[0].completionDiagnostics[0].guardWork.candidateCount = 0;
      },
    ],
    [
      'guard_over_candidates',
      (v: any) => {
        v.runs[0].completionDiagnostics[0].guardWork.candidateCount = 17;
      },
    ],
    [
      'budget',
      (v: any) => {
        v.runs[0].budgetExhaustions = 1;
      },
    ],
    [
      'illegal',
      (v: any) => {
        v.runs[0].illegalActions = 1;
      },
    ],
    [
      'conservation',
      (v: any) => {
        v.runs[0].conservationErrors = 1;
      },
    ],
    [
      'truncated',
      (v: any) => {
        v.runs[0].truncatedHands = 1;
      },
    ],
    [
      'mean_inconsistent',
      (v: any) => {
        v.runs[0].meanDifference = 0.2;
      },
    ],
    [
      'nonpositive_lower',
      (v: any) => {
        v.runs[0].standardError = 0.1;
        v.runs[0].confidence99 = pairedConfidence99(0.1, 0.1, 1024);
      },
    ],
    [
      'fabricated_interval',
      (v: any) => {
        v.runs[0].confidence99 = [0.1, 0.1];
      },
    ],
    [
      'negative_se',
      (v: any) => {
        v.runs[0].standardError = -0.01;
      },
    ],
    [
      'latency',
      (v: any) => {
        v.runs[0].latencyMs.p99 = 5.00001;
      },
    ],
    [
      'negative_latency',
      (v: any) => {
        v.runs[0].latencyMs.p99 = -1;
      },
    ],
    [
      'more_catastrophes',
      (v: any) => {
        v.runs[0].candidateDeepOnePairCommitments = 2;
      },
    ],
    [
      'not_promotable',
      (v: any) => {
        v.runs[0].promotable = false;
      },
    ],
    [
      'baseline_unverified',
      (v: any) => {
        v.runs[0].baselineVerified = false;
      },
    ],
    [
      'exit_failure',
      (v: any) => {
        v.runs[0].exitCode = 1;
      },
    ],
    [
      'run_hash_missing',
      (v: any) => {
        delete v.runs[0].files;
      },
    ],
  ] as const)(
    'refuses per-seed %s despite promoted flags and correctly rebound hashes',
    (_name, change) => {
      expect(admit(guardTestEvidence({ strength: change }))).toMatchObject({
        status: 'refused',
        reason: 'evidence_mismatch',
      });
    }
  );
  it.each([
    [
      'dirty',
      (v: any) => {
        v.source.dirty = true;
      },
    ],
    [
      'foreign_head',
      (v: any) => {
        v.source.head = 'e'.repeat(40);
      },
    ],
    [
      'runtime_digest',
      (v: any) => {
        v.source.runtimePolicyDigest = 'e'.repeat(64);
      },
    ],
    [
      'qualification_digest',
      (v: any) => {
        v.source.qualificationSourceDigest = 'e'.repeat(64);
      },
    ],
    [
      'source_lock',
      (v: any) => {
        v.source.serverLockSha256 = null;
      },
    ],
    [
      'source_hash',
      (v: any) => {
        v.source.sourceSha256 = null;
      },
    ],
    [
      'runtime_closure',
      (v: any) => {
        v.source.policySourceFiles.pop();
      },
    ],
    [
      'qualification_closure',
      (v: any) => {
        v.source.qualificationSourceFiles.pop();
      },
    ],
    [
      'selector_in_closure',
      (v: any) => {
        v.source.qualificationSourceFiles.push(
          'server/src/engine/HorseTournamentCatastropheGuardSelection.ts'
        );
      },
    ],
    [
      'contract_domain',
      (v: any) => {
        v.contract.domain = 'foreign';
      },
    ],
    [
      'contract_gate',
      (v: any) => {
        v.contract.limits.latencyP99GateMs = 6;
      },
    ],
    [
      'contract_pairs',
      (v: any) => {
        v.contract.pairsPerRun = 512;
      },
    ],
    [
      'matrix_incomplete',
      (v: any) => {
        v.matrixComplete = false;
      },
    ],
    [
      'defective',
      (v: any) => {
        v.defectiveRuns = [{ reason: 'missing' }];
      },
    ],
    [
      'activated_claim',
      (v: any) => {
        v.activationAllowed = true;
      },
    ],
    [
      'selected_claim',
      (v: any) => {
        v.selection = 'selected';
      },
    ],
    [
      'not_isolated',
      (v: any) => {
        v.isolatedCandidate = false;
      },
    ],
    [
      'aggregate_count',
      (v: any) => {
        v.verdict.promotableRuns = 17;
      },
    ],
  ] as const)('refuses full evidence %s with hash chain intact', (_name, change) => {
    expect(admit(guardTestEvidence({ strength: change }))).toMatchObject({
      status: 'refused',
      reason: 'evidence_mismatch',
    });
  });
  it.each([
    [
      'unqualified',
      (q: any) => {
        q.qualified = false;
      },
    ],
    [
      'fixture',
      (q: any) => {
        q.mode = 'fixture';
      },
    ],
    [
      'legacy',
      (q: any) => {
        q.schema = 'horse-phase8-qualification-v1';
      },
    ],
    [
      'domain',
      (q: any) => {
        q.domain = 'foreign';
      },
    ],
    [
      'family',
      (q: any) => {
        q.phase8PolicyFamily = 'continuation_v2';
      },
    ],
    [
      'activation',
      (q: any) => {
        q.activationAllowed = true;
      },
    ],
    [
      'isolated',
      (q: any) => {
        q.isolatedCandidate = false;
      },
    ],
    [
      'reasons',
      (q: any) => {
        q.reasons = ['failed'];
      },
    ],
    [
      'qualification_closure',
      (q: any) => {
        q.qualificationSourceFiles.pop();
      },
    ],
  ] as const)('refuses qualification %s', (_name, change) => {
    expect(admit(guardTestEvidence({ qualification: change }))).toMatchObject({
      status: 'refused',
      reason: 'evidence_mismatch',
    });
  });
  it('refuses unselected, malformed, future, invalid time, expiry and withdrawal', () => {
    const f = guardTestEvidence();
    expect(admitHorsePhase8GuardAuthority(f.nowMs, null, f.reader, f.runningDigest)).toMatchObject({
      status: 'refused',
      reason: 'unselected',
    });
    for (const selection of [
      false,
      {},
      { ...f.selection, adoption: 'owner_forced' },
      { ...f.selection, approvalGeneration: 0 },
      { ...f.selection, issuedAt: '2026-10-03T00:00:00.000Z' },
      { ...f.selection, expiresAt: f.selection.issuedAt },
      { ...f.selection, evidencePath: 'docs/evidence/phase8/../foreign.json' },
    ])
      expect(
        admitHorsePhase8GuardAuthority(f.nowMs, selection as never, f.reader, f.runningDigest)
      ).toMatchObject({ status: 'refused', reason: 'invalid_selection' });
    expect(
      admitHorsePhase8GuardAuthority(NaN, f.selection, f.reader, f.runningDigest)
    ).toMatchObject({ status: 'refused', reason: 'invalid_selection' });
    expect(
      admit(guardTestEvidence({ selection: { expiresAt: '2026-10-02T00:00:00.000Z' } }))
    ).toMatchObject({ status: 'refused', reason: 'expired' });
    expect(
      admit(
        guardTestEvidence({
          selection: { withdrawn: { at: '2026-10-01T12:00:00.000Z', reason: 'owner_withdrawn' } },
        })
      )
    ).toMatchObject({ status: 'withdrawn', approvalGeneration: 1 });
  });
  it('refuses foreign running closure and both hash roots, preserving actual read failures', () => {
    const f = guardTestEvidence();
    expect(
      admitHorsePhase8GuardAuthority(f.nowMs, f.selection, f.reader, () => 'e'.repeat(64))
    ).toMatchObject({ status: 'refused', reason: 'continuation_mismatch' });
    for (const key of [GUARD_TEST_QUALIFICATION_PATH, GUARD_TEST_STRENGTH_PATH]) {
      const files = { ...f.files, [key]: Buffer.from('changed') };
      expect(
        admitHorsePhase8GuardAuthority(f.nowMs, f.selection, memoryReader(files), f.runningDigest)
      ).toMatchObject({ status: 'refused', reason: 'hash_mismatch' });
    }
    expect(
      admitHorsePhase8GuardAuthority(f.nowMs, f.selection, memoryReader({}), f.runningDigest)
    ).toMatchObject({ status: 'refused', reason: 'missing_evidence', transient: false });
    expect(
      admitHorsePhase8GuardAuthority(
        f.nowMs,
        f.selection,
        {
          read() {
            throw Error('unavailable');
          },
        },
        f.runningDigest
      )
    ).toMatchObject({ status: 'refused', reason: 'unreadable_evidence', transient: true });
  });
});
