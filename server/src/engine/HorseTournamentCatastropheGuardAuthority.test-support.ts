/** Synthetic in-memory qualification controls. Never production evidence or adoption. */
import { sha256, type HorseAuthorityAdmission } from './HorseQualifiedAuthority.js';
import { memoryReader } from './HorseQualifiedAuthority.test-support.js';
import { PHASE8_POLICY } from './HorseTournamentPostflop.js';
import { CATASTROPHE_GUARD_VERSION } from './HorseTournamentCatastropheGuard.js';
import {
  horseCatastropheGuardPolicyDigest,
  HORSE_CATASTROPHE_GUARD_POLICY_SOURCE_FILES,
} from './HorseCatastropheGuardPolicyDigest.js';
import {
  admitHorsePhase8GuardAuthority,
  GUARD_QUALIFICATION_SEEDS,
  GUARD_QUALIFICATION_OBJECTIVES,
  HORSE_CATASTROPHE_GUARD_DOMAIN,
  HORSE_CATASTROPHE_GUARD_PACK,
  HORSE_CATASTROPHE_GUARD_QUALIFICATION_SOURCE_FILES,
  type HorseCatastropheGuardSelection,
} from './HorseTournamentCatastropheGuardAuthority.js';

export const GUARD_TEST_NOW = Date.parse('2026-10-02T00:00:00.000Z');
export const GUARD_TEST_QUALIFICATION_PATH = 'docs/evidence/phase8/test-guard-qualification.json';
export const GUARD_TEST_STRENGTH_PATH = 'docs/evidence/phase8/strength-2026-10-01/strength.json';
export interface GuardTestEvidenceOptions {
  strength?: (value: any) => void;
  qualification?: (value: any) => void;
  selection?: Partial<HorseCatastropheGuardSelection>;
}
/** Hashes are recomputed after semantic mutations, so refusals exercise parsing. */
export function guardTestEvidence(options: GuardTestEvidenceOptions = {}) {
  const policyDigest = horseCatastropheGuardPolicyDigest();
  const qualificationSourceDigest = 'b'.repeat(64);
  const sourceSha = 'a'.repeat(40);
  const runs = GUARD_QUALIFICATION_SEEDS.flatMap((seed) =>
    GUARD_QUALIFICATION_OBJECTIVES.map((objective) => {
      const entrants = objective === 'spin' ? 3 : objective === 'sng' ? 6 : 18;
      const finish = Array.from({ length: entrants }, (_, i) => (i === 0 ? 1024 : 0));
      const key = `${objective}-${seed}`;
      return {
        run: key,
        objective,
        seed,
        phase8PolicyFamily: 'catastrophe_guard_v1',
        policyVersion: CATASTROPHE_GUARD_VERSION,
        workKind: 'phase7_candidate_guard',
        evidenceMode: 'promotion',
        candidateMode: 'candidate',
        completionSchemaVersion: 1,
        entrants,
        candidateFinish: finish,
        baselineFinish: [...finish],
        requestedPairs: 1024,
        pairs: 1024,
        complete: true,
        decisions: 100,
        eligible: 10,
        fired: 10,
        completed: 10,
        changed: 1,
        completionRefusals: {},
        completionDiagnosticsDropped: 0,
        completionDiagnostics: Array.from({ length: 10 }, () => ({
          completed: true,
          workKind: 'phase7_candidate_guard',
          guardWork: { assessmentCompleted: true, candidateCount: 2 },
        })),
        budgetExhaustions: 0,
        illegalActions: 0,
        conservationErrors: 0,
        truncatedHands: 0,
        candidateDeepOnePairCommitments: 0,
        baselineDeepOnePairCommitments: 1,
        candidateReturn: 0.6,
        baselineReturn: 0.5,
        meanDifference: 0.1,
        standardError: 0.01,
        confidence99: [0.1 - 2.59 * 0.01, 0.1 + 2.59 * 0.01],
        latencyMs: { p50: 1, p95: 2, p99: 5, max: 8 },
        promotable: true,
        baselineVerified: true,
        exitCode: 0,
        files: Object.fromEntries(
          [
            `${key}.json`,
            `${key}/manifest.json`,
            `${key}/summary.json`,
            `${key}/baseline-verification.json`,
          ].map((p) => [
            p,
            { sourceSha256: sha256('synthetic-' + p), committedSha256: sha256('synthetic-' + p) },
          ])
        ),
      };
    })
  );
  const strength = {
    schema: 'horse-phase8-guard-strength-v1',
    phase8PolicyFamily: 'catastrophe_guard_v1',
    mode: 'promotion',
    isolatedCandidate: true,
    activationAllowed: false,
    selection: 'not_selected',
    matrixComplete: true,
    contract: {
      seeds: [...GUARD_QUALIFICATION_SEEDS],
      objectives: [...GUARD_QUALIFICATION_OBJECTIVES],
      pairsPerRun: 1024,
      requiredRuns: 18,
      domain: HORSE_CATASTROPHE_GUARD_DOMAIN,
      limits: {
        latencyP99GateMs: 5,
        maxCandidates: 16,
        deepStackBB: PHASE8_POLICY.deepStackBB,
        deepCommitFraction: PHASE8_POLICY.deepCommitFraction,
      },
    },
    source: {
      head: sourceSha,
      dirty: false,
      sourceSha256: 'c'.repeat(64),
      sourceFiles: 2442,
      serverLockSha256: 'd'.repeat(64),
      policyVersion: CATASTROPHE_GUARD_VERSION,
      policyDigest,
      runtimePolicyDigest: policyDigest,
      qualificationSourceDigest,
      policySourceFiles: HORSE_CATASTROPHE_GUARD_POLICY_SOURCE_FILES.map((p) => 'server/' + p),
      qualificationSourceFiles: [...HORSE_CATASTROPHE_GUARD_QUALIFICATION_SOURCE_FILES],
      phase8PolicyFamily: 'catastrophe_guard_v1',
      workKind: 'phase7_candidate_guard',
    },
    runs,
    defectiveRuns: [],
    verdict: { promoted: true, reasons: [], promotableRuns: 18, baselineVerifiedRuns: 18 },
  };
  options.strength?.(strength);
  const strengthBytes = Buffer.from(JSON.stringify(strength));
  const qualification = {
    schema: 'horse-phase8-guard-qualification-v1',
    qualified: true,
    mode: 'promotion',
    phase8PolicyFamily: 'catastrophe_guard_v1',
    isolatedCandidate: true,
    activationAllowed: false,
    selection: 'not_selected',
    workKind: 'phase7_candidate_guard',
    sourceSha,
    policyVersion: CATASTROPHE_GUARD_VERSION,
    packId: HORSE_CATASTROPHE_GUARD_PACK,
    domain: HORSE_CATASTROPHE_GUARD_DOMAIN,
    policyDigest,
    qualificationSourceDigest,
    qualificationSourceFiles: [...HORSE_CATASTROPHE_GUARD_QUALIFICATION_SOURCE_FILES],
    evidencePath: GUARD_TEST_STRENGTH_PATH,
    evidenceSha256: sha256(strengthBytes),
    reasons: [],
  };
  options.qualification?.(qualification);
  const qualificationBytes = Buffer.from(JSON.stringify(qualification));
  const selection: HorseCatastropheGuardSelection = {
    schema: 'horse-catastrophe-guard-selection-v1',
    adoption: 'adopts_qualified_isolated_guard',
    policyFamily: 'catastrophe_guard_v1',
    policyVersion: CATASTROPHE_GUARD_VERSION,
    domain: HORSE_CATASTROPHE_GUARD_DOMAIN,
    packId: HORSE_CATASTROPHE_GUARD_PACK,
    sourceSha,
    policyDigest,
    qualificationSourceDigest,
    evidencePath: GUARD_TEST_QUALIFICATION_PATH,
    evidenceSha256: sha256(qualificationBytes),
    approvalGeneration: 1,
    issuedAt: '2026-10-01T00:00:00.000Z',
    expiresAt: null,
    withdrawn: null,
    ...options.selection,
  };
  const files = {
    [GUARD_TEST_QUALIFICATION_PATH]: qualificationBytes,
    [GUARD_TEST_STRENGTH_PATH]: strengthBytes,
  };
  return {
    selection,
    strength,
    qualification,
    files,
    reader: memoryReader(files),
    runningDigest: () => policyDigest,
    nowMs: GUARD_TEST_NOW,
  };
}
export function guardTestAdmission(approvalGeneration = 1): HorseAuthorityAdmission {
  const f = guardTestEvidence({ selection: { approvalGeneration } });
  return admitHorsePhase8GuardAuthority(f.nowMs, f.selection, f.reader, f.runningDigest);
}
