/** Genuine-only guard adoption. Owner-forced continuation admission is never consulted. */
import { posix } from 'node:path';
import {
  canonical,
  sha256,
  isoMs,
  repositoryEvidenceReader,
  HorsePhase8AuthorityGate,
  type HorseAuthorityAdmission,
  type HorseAuthorityEvidenceReader,
} from './HorseQualifiedAuthority.js';
import { CATASTROPHE_GUARD_VERSION } from './HorseTournamentCatastropheGuard.js';
import { PHASE8_POLICY } from './HorseTournamentPostflop.js';
import {
  HORSE_CATASTROPHE_GUARD_POLICY_SOURCE_FILES,
  horseCatastropheGuardPolicyDigest,
} from './HorseCatastropheGuardPolicyDigest.js';
import { PHASE8_GUARD_PROTECTED_RELEASE_SELECTION } from './HorseTournamentCatastropheGuardSelection.js';

export const HORSE_CATASTROPHE_GUARD_DOMAIN = 'nlh-single-board-tournament-phase7-candidate-guard';
export const HORSE_CATASTROPHE_GUARD_PACK = 'horse-tournament-catastrophe-guard';
export interface HorseCatastropheGuardSelection {
  schema: 'horse-catastrophe-guard-selection-v1';
  adoption: 'adopts_qualified_isolated_guard';
  policyFamily: 'catastrophe_guard_v1';
  policyVersion: typeof CATASTROPHE_GUARD_VERSION;
  domain: typeof HORSE_CATASTROPHE_GUARD_DOMAIN;
  packId: typeof HORSE_CATASTROPHE_GUARD_PACK;
  sourceSha: string;
  policyDigest: string;
  qualificationSourceDigest: string;
  evidencePath: string;
  evidenceSha256: string;
  approvalGeneration: number;
  issuedAt: string;
  expiresAt: string | null;
  withdrawn: { at: string; reason: string } | null;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const hex = (v: unknown, n: number): v is string =>
  typeof v === 'string' && new RegExp(`^[a-f0-9]{${n}}$`).test(v);
const pathOK = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.startsWith('docs/evidence/phase8/') &&
  posix.normalize(v) === v &&
  !v.includes('\\') &&
  !v.includes('\0') &&
  v.endsWith('.json');
// Frozen promotion contract; runtime admission must not import the benchmark runner.
export const GUARD_QUALIFICATION_SEEDS = [8101101, 8102203, 8103307] as const;
export const GUARD_QUALIFICATION_OBJECTIVES = [
  'mtt',
  'sng',
  'spin',
  'satellite',
  'pko',
  'mystery',
] as const;
export const GUARD_QUALIFICATION_PAIRS = 1024;
export const HORSE_CATASTROPHE_GUARD_QUALIFICATION_SOURCE_FILES = [
  ...new Set([
    ...HORSE_CATASTROPHE_GUARD_POLICY_SOURCE_FILES.map((p) => 'server/' + p),
    'server/src/benchmark/HorseTournamentLeague.ts',
    'server/src/benchmark/HorseLeagueComputeWorkerClient.ts',
    'server/src/scripts/horseTournamentEvaluate.ts',
    'server/src/benchmark/HorseLeagueComputeProtocol.ts',
    'server/src/benchmark/HorseLeagueComputeWorker.ts',
    'server/scripts/phase8-strength-assemble.mjs',
    '.github/workflows/horse-phase8-strength-league.yml',
  ]),
];
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sourceFilesMatch = (v: unknown, expected: readonly string[]) =>
  Array.isArray(v) &&
  v.length === expected.length &&
  v.every((p) => typeof p === 'string') &&
  same([...v].sort(), [...expected].sort());
const finishValid = (v: unknown, n: number) =>
  Array.isArray(v) &&
  v.length === n &&
  v.every(integer) &&
  v.reduce((a, b) => a + b, 0) === GUARD_QUALIFICATION_PAIRS;
function guardRowsValid(r: Record<string, unknown>): boolean {
  const rows = r.completionDiagnostics;
  if (
    !Array.isArray(rows) ||
    !integer(r.completionDiagnosticsDropped) ||
    rows.length + r.completionDiagnosticsDropped !== r.eligible
  )
    return false;
  return rows.every(
    (row) =>
      record(row) &&
      row.completed === true &&
      row.workKind === 'phase7_candidate_guard' &&
      record(row.guardWork) &&
      row.guardWork.assessmentCompleted === true &&
      integer(row.guardWork.candidateCount) &&
      row.guardWork.candidateCount >= 1 &&
      row.guardWork.candidateCount <= 16
  );
}
function runHashesValid(r: Record<string, unknown>): boolean {
  if (!record(r.files)) return false;
  const expected = [
    `${r.run}.json`,
    `${r.run}/manifest.json`,
    `${r.run}/summary.json`,
    `${r.run}/baseline-verification.json`,
  ];
  return (
    same(Object.keys(r.files).sort(), expected.sort()) &&
    Object.values(r.files).every(
      (v) => record(v) && hex(v.sourceSha256, 64) && hex(v.committedSha256, 64)
    )
  );
}
/** Independently check the actual fixed per-seed gates in assembler output.
 * Hashes/protected adoption authenticate supplied evidence, not provider origin. */
export function catastropheGuardStrengthIsValid(
  v: unknown,
  s: HorseCatastropheGuardSelection
): boolean {
  if (
    !record(v) ||
    v.schema !== 'horse-phase8-guard-strength-v1' ||
    v.phase8PolicyFamily !== 'catastrophe_guard_v1' ||
    v.mode !== 'promotion' ||
    v.matrixComplete !== true ||
    v.isolatedCandidate !== true ||
    v.activationAllowed !== false ||
    v.selection !== 'not_selected' ||
    !record(v.source) ||
    v.source.head !== s.sourceSha ||
    v.source.dirty !== false ||
    !hex(v.source.sourceSha256, 64) ||
    !integer(v.source.sourceFiles) ||
    v.source.sourceFiles < 1 ||
    !hex(v.source.serverLockSha256, 64) ||
    v.source.policyVersion !== CATASTROPHE_GUARD_VERSION ||
    v.source.phase8PolicyFamily !== 'catastrophe_guard_v1' ||
    v.source.workKind !== 'phase7_candidate_guard' ||
    v.source.policyDigest !== s.policyDigest ||
    v.source.runtimePolicyDigest !== s.policyDigest ||
    v.source.qualificationSourceDigest !== s.qualificationSourceDigest ||
    !sourceFilesMatch(
      v.source.policySourceFiles,
      HORSE_CATASTROPHE_GUARD_POLICY_SOURCE_FILES.map((p) => 'server/' + p)
    ) ||
    !sourceFilesMatch(
      v.source.qualificationSourceFiles,
      HORSE_CATASTROPHE_GUARD_QUALIFICATION_SOURCE_FILES
    ) ||
    !record(v.contract) ||
    !same(v.contract.seeds, GUARD_QUALIFICATION_SEEDS) ||
    !same(v.contract.objectives, GUARD_QUALIFICATION_OBJECTIVES) ||
    v.contract.domain !== s.domain ||
    v.contract.pairsPerRun !== GUARD_QUALIFICATION_PAIRS ||
    v.contract.requiredRuns !== 18 ||
    !record(v.contract.limits) ||
    v.contract.limits.latencyP99GateMs !== 5 ||
    v.contract.limits.maxCandidates !== 16 ||
    v.contract.limits.deepStackBB !== PHASE8_POLICY.deepStackBB ||
    v.contract.limits.deepCommitFraction !== PHASE8_POLICY.deepCommitFraction ||
    !Array.isArray(v.runs) ||
    v.runs.length !== 18 ||
    !Array.isArray(v.defectiveRuns) ||
    v.defectiveRuns.length !== 0 ||
    !record(v.verdict) ||
    v.verdict.promoted !== true ||
    v.verdict.promotableRuns !== 18 ||
    v.verdict.baselineVerifiedRuns !== 18 ||
    !Array.isArray(v.verdict.reasons) ||
    v.verdict.reasons.length !== 0
  )
    return false;
  const keys = new Set<string>();
  for (const r of v.runs) {
    if (
      !record(r) ||
      typeof r.seed !== 'number' ||
      !(GUARD_QUALIFICATION_SEEDS as readonly number[]).includes(r.seed) ||
      typeof r.objective !== 'string' ||
      !(GUARD_QUALIFICATION_OBJECTIVES as readonly string[]).includes(r.objective)
    )
      return false;
    const entrants = r.objective === 'spin' ? 3 : r.objective === 'sng' ? 6 : 18;
    if (
      r.run !== `${r.objective}-${r.seed}` ||
      !runHashesValid(r) ||
      !guardRowsValid(r) ||
      r.phase8PolicyFamily !== 'catastrophe_guard_v1' ||
      r.policyVersion !== CATASTROPHE_GUARD_VERSION ||
      r.workKind !== 'phase7_candidate_guard' ||
      r.evidenceMode !== 'promotion' ||
      r.candidateMode !== 'candidate' ||
      r.completionSchemaVersion !== 1 ||
      r.entrants !== entrants ||
      !finishValid(r.candidateFinish, entrants) ||
      !finishValid(r.baselineFinish, entrants) ||
      r.complete !== true ||
      r.pairs !== GUARD_QUALIFICATION_PAIRS ||
      r.requestedPairs !== GUARD_QUALIFICATION_PAIRS ||
      !integer(r.decisions) ||
      !integer(r.eligible) ||
      r.eligible < 1 ||
      r.decisions < r.eligible ||
      r.fired !== r.eligible ||
      r.completed !== r.eligible ||
      !integer(r.changed) ||
      r.changed < 1 ||
      r.changed > r.completed ||
      !record(r.completionRefusals) ||
      Object.keys(r.completionRefusals).length !== 0 ||
      r.budgetExhaustions !== 0 ||
      r.illegalActions !== 0 ||
      r.conservationErrors !== 0 ||
      r.truncatedHands !== 0 ||
      !finite(r.meanDifference) ||
      Math.abs(r.meanDifference) > 1 ||
      !finite(r.standardError) ||
      r.standardError < 0 ||
      !finite(r.candidateReturn) ||
      !finite(r.baselineReturn) ||
      Math.abs(r.meanDifference - r.candidateReturn + r.baselineReturn) >= 1e-8 ||
      !Array.isArray(r.confidence99) ||
      r.confidence99.length !== 2 ||
      !finite(r.confidence99[0]) ||
      !finite(r.confidence99[1]) ||
      r.confidence99[0] <= 0 ||
      Math.abs(r.confidence99[0] - Math.max(-1, r.meanDifference - 2.59 * r.standardError)) >=
        1e-8 ||
      Math.abs(r.confidence99[1] - Math.min(1, r.meanDifference + 2.59 * r.standardError)) >=
        1e-8 ||
      !record(r.latencyMs) ||
      !finite(r.latencyMs.p99) ||
      r.latencyMs.p99 < 0 ||
      r.latencyMs.p99 > 5 ||
      !integer(r.candidateDeepOnePairCommitments) ||
      !integer(r.baselineDeepOnePairCommitments) ||
      r.candidateDeepOnePairCommitments > r.baselineDeepOnePairCommitments ||
      r.promotable !== true ||
      r.baselineVerified !== true ||
      r.exitCode !== 0
    )
      return false;
    const key = `${r.objective}-${r.seed}`;
    if (keys.has(key)) return false;
    keys.add(key);
  }
  return keys.size === 18;
}
export function admitHorsePhase8GuardAuthority(
  nowMs = Date.now(),
  selection: HorseCatastropheGuardSelection | null = PHASE8_GUARD_PROTECTED_RELEASE_SELECTION,
  reader: HorseAuthorityEvidenceReader = repositoryEvidenceReader,
  runningDigest: () => string = horseCatastropheGuardPolicyDigest
): HorseAuthorityAdmission {
  const refuse = (
    reason:
      | 'unselected'
      | 'invalid_selection'
      | 'expired'
      | 'missing_evidence'
      | 'unreadable_evidence'
      | 'hash_mismatch'
      | 'evidence_mismatch'
      | 'continuation_mismatch',
    transient = false
  ): HorseAuthorityAdmission => ({ status: 'refused', reason, transient });
  if (selection === null) return refuse('unselected');
  if (!record(selection) || !finite(nowMs)) return refuse('invalid_selection');
  const s = selection;
  if (
    s.schema !== 'horse-catastrophe-guard-selection-v1' ||
    s.adoption !== 'adopts_qualified_isolated_guard' ||
    s.policyFamily !== 'catastrophe_guard_v1' ||
    s.policyVersion !== CATASTROPHE_GUARD_VERSION ||
    s.domain !== HORSE_CATASTROPHE_GUARD_DOMAIN ||
    s.packId !== HORSE_CATASTROPHE_GUARD_PACK ||
    !hex(s.sourceSha, 40) ||
    !hex(s.policyDigest, 64) ||
    !hex(s.qualificationSourceDigest, 64) ||
    !pathOK(s.evidencePath) ||
    !hex(s.evidenceSha256, 64) ||
    !integer(s.approvalGeneration) ||
    s.approvalGeneration < 1 ||
    isoMs(s.issuedAt) === null ||
    (isoMs(s.issuedAt) ?? Infinity) > nowMs ||
    (s.expiresAt !== null &&
      (isoMs(s.expiresAt) === null ||
        (isoMs(s.expiresAt) ?? -Infinity) <= (isoMs(s.issuedAt) ?? Infinity)))
  )
    return refuse('invalid_selection');
  if (s.withdrawn !== null) {
    if (
      !record(s.withdrawn) ||
      isoMs(s.withdrawn.at) === null ||
      typeof s.withdrawn.reason !== 'string' ||
      !s.withdrawn.reason
    )
      return refuse('invalid_selection');
    return {
      status: 'withdrawn',
      approvalGeneration: s.approvalGeneration,
      reason: `release_${s.withdrawn.reason}`,
    };
  }
  if (s.expiresAt !== null && nowMs >= (isoMs(s.expiresAt) ?? -Infinity)) return refuse('expired');
  try {
    const bytes = reader.read(s.evidencePath);
    if (sha256(bytes) !== s.evidenceSha256) return refuse('hash_mismatch');
    const evidence: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !record(evidence) ||
      evidence.schema !== 'horse-phase8-guard-qualification-v1' ||
      evidence.qualified !== true ||
      evidence.mode !== 'promotion' ||
      (evidence.policyFamily !== undefined && evidence.policyFamily !== 'catastrophe_guard_v1') ||
      evidence.phase8PolicyFamily !== 'catastrophe_guard_v1' ||
      evidence.policyVersion !== s.policyVersion ||
      evidence.workKind !== 'phase7_candidate_guard' ||
      evidence.isolatedCandidate !== true ||
      evidence.activationAllowed !== false ||
      evidence.selection !== 'not_selected' ||
      evidence.sourceSha !== s.sourceSha ||
      evidence.policyDigest !== s.policyDigest ||
      evidence.qualificationSourceDigest !== s.qualificationSourceDigest ||
      !sourceFilesMatch(
        evidence.qualificationSourceFiles,
        HORSE_CATASTROPHE_GUARD_QUALIFICATION_SOURCE_FILES
      ) ||
      !Array.isArray(evidence.reasons) ||
      evidence.reasons.length !== 0 ||
      evidence.packId !== s.packId ||
      evidence.domain !== s.domain ||
      !pathOK(evidence.evidencePath) ||
      !hex(evidence.evidenceSha256, 64)
    )
      return refuse('evidence_mismatch');
    if (runningDigest() !== s.policyDigest) return refuse('continuation_mismatch');
    const strength = reader.read(evidence.evidencePath);
    if (sha256(strength) !== evidence.evidenceSha256) return refuse('hash_mismatch');
    if (!catastropheGuardStrengthIsValid(JSON.parse(strength.toString('utf8')), s))
      return refuse('evidence_mismatch');
    const identity = {
      schema: 'horse-qualified-authority-v1' as const,
      phase: 'phase8' as const,
      sourceSha: s.sourceSha,
      continuationVersion: s.policyVersion,
      policyDigest: s.policyDigest,
      packId: s.packId,
      domain: s.domain,
      evidencePath: s.evidencePath,
      evidenceSha256: s.evidenceSha256,
      approvalGeneration: s.approvalGeneration,
      issuedAt: s.issuedAt,
      expiresAt: s.expiresAt,
    };
    return {
      status: 'admitted',
      authority: Object.freeze({
        ...identity,
        authorityKey: sha256(JSON.stringify(canonical(identity))),
      }),
    };
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? refuse('missing_evidence')
      : error instanceof SyntaxError
        ? refuse('evidence_mismatch')
        : refuse('unreadable_evidence', true);
  }
}
export const liveHorsePhase8GuardAuthority = new HorsePhase8AuthorityGate(
  () => admitHorsePhase8GuardAuthority(),
  undefined,
  CATASTROPHE_GUARD_VERSION
);
