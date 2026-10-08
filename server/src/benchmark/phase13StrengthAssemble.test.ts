/**
 * P13.2 joint strength assembler (server/scripts/phase13-strength-assemble.mjs)
 * and the one-shard CLI's refusals (src/scripts/jointStrengthEvaluate.ts).
 *
 * Every synthetic attempt here is DEVELOPMENT mode, so it can never qualify:
 * a contract assembly refuses development runs, and a development assembly
 * always writes `qualified: false`. The scripts run as their own tsx
 * processes, the way the evidence is produced, so their verdict comes from the
 * real contract they import.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  JOINT_STRENGTH_CONTRACT,
  jointStrengthContractDigest,
  jointStrengthPack,
  jointStrengthRequiredShards,
  type JointStrengthVariant,
} from './JointStrengthContract.js';
import {
  HORSE_PHASE13_POLICY_DIGEST_DEFINITION,
  HORSE_PHASE13_POLICY_SOURCE_FILES,
  horsePhase13PolicyDigest,
} from '../engine/HorsePhase13PolicyDigest.js';
// Phase 13 qualifications carry exactly the keys of the Phase 12 qualification
// (the Stage 2 interface agreement); the Phase 13 admission is P13.3's.
import {
  admitHorsePhase13QualifiedAuthority,
  HORSE_PHASE13_PACK_VERSION,
  HORSE_PHASE13_QUALIFICATION_KEYS,
} from '../engine/HorsePhase13Authority.js';
import {
  P13_TEST_CONTRACT_DIGEST,
  P13_TEST_NOW,
  p13CompletionBytes,
  p13CompletionPath,
  p13Selection,
} from '../engine/HorsePhase13Authority.test-support.js';
import { memoryReader } from '../engine/HorseQualifiedAuthority.test-support.js';
import { JOINT_LIVE_DOMAIN } from '../engine/multiway/JointSampleAcquisition.js';

const exec = promisify(execFile);
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const RUN_TIMEOUT_MS = 60_000;
const DEV_SHARD_TIMEOUT_MS = 240_000;
const C = JOINT_STRENGTH_CONTRACT;
const VARIANT: JointStrengthVariant = 'flh';
const PACK = jointStrengthPack(VARIANT);
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

let root: string;
let runsDir: string;
let repo: string;
const outDir = (date = '2026-10-05', variant: string = VARIANT) =>
  path.join(repo, 'docs/evidence/phase13', `strength-${date}-${variant}`);
const required = jointStrengthRequiredShards(VARIANT);

interface AttemptOptions {
  attempt?: number;
  mode?: 'contract' | 'development';
  manifest?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  runner?: boolean;
}
/** One attempt directory exactly as `gh run download` writes the workflow artifact. */
function writeAttempt(
  index: number,
  options: AttemptOptions = {},
  variant: JointStrengthVariant = VARIANT
) {
  const shards = jointStrengthRequiredShards(variant);
  const pack = jointStrengthPack(variant);
  const { key, profileId, seed, shard } = shards[index];
  const attempt = options.attempt ?? 1;
  const mode = options.mode ?? 'development';
  const dir = path.join(runsDir, `p132-${key}-a${attempt}`);
  if (options.runner !== false)
    write(path.join(dir, 'runner.json'), {
      schema: 'horse-phase13-strength-runner-v1',
      runner: `gh-${key}`,
      cpu: 'fixture',
      vcpu: 4,
      runAttempt: attempt,
      variant,
      shard: key,
    });
  write(path.join(dir, 'attempt.json'), {
    schema: 'horse-phase13-strength-attempt-v1',
    runAttempt: attempt,
    variant,
    startedAt: '2026-10-05T00:00:00Z',
    finishedAt: '2026-10-05T00:20:00Z',
    exitCode: 0,
  });
  write(path.join(dir, key, 'manifest.json'), {
    schema: 'horse-phase13-strength-manifest-v1',
    mode,
    variant,
    head: HEAD,
    dirty: false,
    sourceSha256: 'f'.repeat(64),
    sourceFiles: 1,
    serverLockSha256: 'e'.repeat(64),
    contractVersion: C.version,
    contractDigest: jointStrengthContractDigest(),
    packVersion: pack.candidate.packVersion,
    domainVersion: pack.candidate.domainVersion,
    rangePackVersion: pack.candidate.rangePackVersion,
    profileId,
    seed,
    shard,
    pairs: pack.matrix.pairsPerShard,
    createdAt: '2026-10-05T00:00:00.000Z',
    ...options.manifest,
  });
  if (options.result === null) return;
  write(path.join(dir, key, `${key}.json`), {
    schema: 'horse-phase13-strength-shard-v1',
    variant,
    contractVersion: C.version,
    contractDigest: jointStrengthContractDigest(),
    packVersion: pack.candidate.packVersion,
    domainVersion: pack.candidate.domainVersion,
    rangePackVersion: pack.candidate.rangePackVersion,
    evidenceMode: mode,
    profileId,
    seed,
    shard,
    firstPair: shard * pack.matrix.pairsPerShard,
    requestedPairs: pack.matrix.pairsPerShard,
    pairs: pack.matrix.pairsPerShard,
    complete: true,
    positionCoverageComplete: true,
    offsetCounts: [pack.matrix.pairsPerShard],
    strata: { '0|none': { n: pack.matrix.pairsPerShard, s1: '0', s2: '0', s3: '0', s4: '0' } },
    pairDigest: 'a'.repeat(64),
    eligible: 5,
    fired: 4,
    changed: 2,
    illegalCandidates: 0,
    earlierPhaseRefusals: 0,
    workBudgetRefusals: 0,
    responseBranchUnavailable: 1,
    insufficientSamples: 0,
    eligibleByBoards: { 1: 5 },
    discards: 0,
    lowHalvesChecked: 0,
    durationMs: 1000,
    sourceUnchanged: true,
    cancelled: false,
    ...options.result,
  });
}

/**
 * A contract-shaped shard result the real verdict qualifies: every seat offset
 * equally covered, every pair scoring the same positive amount (zero variance,
 * zero skew, so the interval is trusted and its lower bound is the mean), no
 * validity failure, fixed work proven, no promotion claimed. A fixture for the
 * assembler-to-admission path, never evidence.
 */
function qualifyingResult(index: number): Record<string, unknown> {
  const { profileId } = required[index];
  const seats = PACK.matrix.profiles.find((p) => p.id === profileId)!.seats;
  const perOffset = PACK.matrix.pairsPerShard / seats;
  const cents = 100n;
  const n = BigInt(perOffset);
  const strata = Object.fromEntries(
    Array.from({ length: seats }, (_, offset) => [
      `${offset}|river`,
      {
        n: perOffset,
        s1: String(n * cents),
        s2: String(n * cents ** 2n),
        s3: String(n * cents ** 3n),
        s4: String(n * cents ** 4n),
      },
    ])
  );
  return {
    offsetCounts: Array.from({ length: seats }, () => perOffset),
    strata,
    illegalActions: 0,
    conservationErrors: 0,
    cardErrors: 0,
    truncatedHands: 0,
    settlementMismatches: 0,
    deductionMismatches: 0,
    pairedReplayMismatches: 0,
    fixedWork: { governor: 'off', scale: 1, moodClock: 'deal_seed_time_of_day' },
    promotionEligible: false,
  };
}

async function runScript(script: string, args: string[], timeout = RUN_TIMEOUT_MS) {
  try {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: process.cwd(),
      timeout,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { code?: number; stderr?: string; stdout?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
async function assemble(...extra: string[]) {
  const hasVariant = extra.some((a) => a.startsWith('--variant='));
  const r = await runScript('scripts/phase13-strength-assemble.mjs', [
    ...(hasVariant ? [] : [`--variant=${VARIANT}`]),
    `--runs=${runsDir}`,
    `--repo-root=${repo}`,
    '--no-format',
    ...extra,
  ]);
  if (r.code === 0) return { code: 0, stdout: r.stdout, reasons: [] as string[] };
  let reasons: string[] = [];
  try {
    reasons = JSON.parse(r.stderr).reasons;
  } catch {
    reasons = [`unparsed:${r.stderr}`];
  }
  return { code: r.code, stdout: r.stdout, reasons };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'phase13-strength-assemble-'));
  runsDir = path.join(root, 'runs');
  repo = path.join(root, 'repo');
  for (let i = 0; i < required.length; i++) writeAttempt(i);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('phase13-strength-assemble', () => {
  it(
    'assembles one variant with the real verdict, binds its policy digest, and never qualifies development runs',
    async () => {
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual([]);
      expect(outcome.code).toBe(0);
      const strength = readJson(path.join(outDir(), 'strength.json'));
      const qualification = readJson(
        path.join(repo, 'docs/evidence/phase13/phase13-qualification-2026-10-05-flh.json')
      );
      expect(strength.schema).toBe('horse-phase13-strength-v1');
      expect(strength.phase).toBe('P13.2');
      expect(strength.variant).toBe(VARIANT);
      expect(strength.contractDigest).toBe(jointStrengthContractDigest());
      expect(strength.domain).toBe(PACK.domain);
      expect(strength.domain).toBe('flh-cash-joint-multiway-after-rake-horse-population');
      expect(strength.shards).toHaveLength(PACK.matrix.requiredShards);
      expect(strength.attempts).toHaveLength(PACK.matrix.requiredShards);
      expect(strength.source.policyDigest).toBe(horsePhase13PolicyDigest(VARIANT));
      expect(strength.source.policyDigestDefinition).toBe(HORSE_PHASE13_POLICY_DIGEST_DEFINITION);
      expect(strength.source.policyDigestFiles).toEqual(
        HORSE_PHASE13_POLICY_SOURCE_FILES.map((file) => `server/${file}`)
      );
      expect(strength.source.domainVersion).toBe('joint-multiway-round1-v4');
      expect(strength.source.packVersion).toBe('joint-action-response-round3-v1');
      // Guard refusals are software validity (refused per shard), not a
      // strength gate; the named refusals are reported beside them.
      expect(strength.shards[0]).toMatchObject({
        changed: 2,
        illegalCandidates: 0,
        earlierPhaseRefusals: 0,
        responseBranchUnavailable: 1,
      });
      expect(strength.selectionGuard).toEqual({
        gate: false,
        validity: 'illegalCandidates and earlierPhaseRefusals must be 0 in every counted shard',
        changed: 2 * PACK.matrix.requiredShards,
        illegalCandidates: 0,
        earlierPhaseRefusals: 0,
      });
      expect(strength.diagnostics).toMatchObject({
        gate: false,
        eligible: 5 * PACK.matrix.requiredShards,
        responseBranchUnavailable: PACK.matrix.requiredShards,
      });
      expect(strength.verdict.qualified).toBe(false);
      expect(strength.verdict.reasons).toContain(`${required[0].key}:not_contract_mode`);
      expect(strength.verdict.streetFamiliesDiagnostic.gate).toBe(false);
      expect(qualification).toMatchObject({
        schema: 'horse-phase13-qualification-v1',
        qualified: false,
        mode: 'development',
        variant: VARIANT,
        sourceSha: HEAD,
        // The joint domain (receipt) version admission compares, never the
        // response pack version; the response identity is bound by the policy
        // digest, which hashes the domain, range and response versions.
        packVersion: HORSE_PHASE13_PACK_VERSION,
        contractVersion: C.version,
        contractDigest: jointStrengthContractDigest(),
        domain: PACK.domain,
        policyDigest: horsePhase13PolicyDigest(VARIANT),
        policyDigestDefinition: 'horse-phase13-policy-digest-v1',
        evidencePath: 'docs/evidence/phase13/strength-2026-10-05-flh/strength.json',
      });
      // Exactly the sixteen keys of the Phase 12 qualification.
      expect(Object.keys(qualification).sort()).toEqual(
        [...HORSE_PHASE13_QUALIFICATION_KEYS].sort()
      );
      expect(Object.keys(qualification)).toHaveLength(16);
      expect(qualification.objectives.cash).toEqual({
        qualified: false,
        status: 'measured',
        regressionMarginBbPer100: -4,
      });
      expect(qualification.objectives.tournament).toEqual({
        status: 'unavailable dependency',
        qualified: false,
        reasons: PACK.tournament.refusals,
      });
      expect(qualification.reasons.some((r: string) => r.startsWith('tournament:'))).toBe(false);
      expect(qualification.admissionAlsoRequires).toEqual([
        ...C.liveConditions.admissionAlsoRequires,
      ]);
      expect(qualification.reasons[0]).toBe('development_mode_never_qualifies');
      // The evidence hash binds the strength record the qualification names.
      expect(qualification.evidenceSha256).toBe(
        createHash('sha256')
          .update(readFileSync(path.join(outDir(), 'strength.json')))
          .digest('hex')
      );
      // One digest per variant.
      for (const other of ['nlh', 'flo8', 'plo4'] as const)
        expect(horsePhase13PolicyDigest(other)).not.toBe(horsePhase13PolicyDigest(VARIANT));
    },
    RUN_TIMEOUT_MS
  );

  it(
    "the assembler's real contract-mode qualification is the file admission reads",
    async () => {
      // Every shard in contract mode: the assembler's own verdict, its own
      // qualification bytes and the strength record it names, read by the
      // real admission with a non-null selection of that file.
      rmSync(runsDir, { recursive: true });
      for (let i = 0; i < required.length; i++)
        writeAttempt(i, { mode: 'contract', result: qualifyingResult(i) });
      const outcome = await assemble(`--out=${outDir()}`);
      expect(outcome.reasons).toEqual([]);
      const qualificationPath = 'docs/evidence/phase13/phase13-qualification-2026-10-05-flh.json';
      const qualificationBytes = readFileSync(path.join(repo, qualificationPath));
      const qualification = JSON.parse(qualificationBytes.toString('utf8'));
      expect(qualification.mode).toBe('contract');
      const strengthBytes = readFileSync(path.join(repo, qualification.evidencePath));
      const completion = p13CompletionBytes(VARIANT);
      const admit = (bytes: Buffer) =>
        admitHorsePhase13QualifiedAuthority(
          VARIANT,
          p13Selection(VARIANT, bytes, completion, {
            sourceSha: HEAD,
            qualificationPath,
          }),
          memoryReader({
            [qualificationPath]: bytes,
            [qualification.evidencePath]: strengthBytes,
            [p13CompletionPath(VARIANT)]: completion,
          }),
          P13_TEST_NOW,
          P13_TEST_CONTRACT_DIGEST
        );
      // The synthetic matrix is a null result (every pair scores zero), which
      // clears the -4 BB/100 regression margin, so the assembler qualifies it
      // and admission accepts it past the qualification, contract, policy,
      // source, pack, domain and strength checks and the completion record.
      expect(qualification.qualified, JSON.stringify(qualification.reasons)).toBe(true);
      const admitted = admit(qualificationBytes);
      expect(admitted.status === 'refused' ? admitted.reason : null).toBeNull();
      expect(admitted).toMatchObject({ status: 'admitted' });
      expect(qualification.packVersion).toBe(JOINT_LIVE_DOMAIN.version);
      expect(admitted.status === 'admitted' && admitted.authority.packId).toBe(
        JOINT_LIVE_DOMAIN.version
      );
      // The same file carrying the response pack version (the pre-fix
      // assembler output) is a different continuation and is refused by name.
      const responseVersioned = Buffer.from(
        JSON.stringify({ ...qualification, packVersion: PACK.candidate.packVersion }, null, 2) +
          '\n'
      );
      expect(PACK.candidate.packVersion).toBe('joint-action-response-round3-v1');
      expect(admit(responseVersioned)).toMatchObject({
        status: 'refused',
        reason: 'continuation_mismatch',
      });
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses a nonzero guard refusal by name in the verdict it writes',
    async () => {
      const key = required[3].key;
      rmSync(path.join(runsDir, `p132-${key}-a1`), { recursive: true });
      writeAttempt(3, { result: { illegalCandidates: 2 } });
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual([]);
      const strength = readJson(path.join(outDir(), 'strength.json'));
      expect(strength.verdict.reasons).toContain(`${key}:illegalCandidates`);
      expect(strength.selectionGuard.illegalCandidates).toBe(2);
    },
    RUN_TIMEOUT_MS
  );

  it(
    "refuses another variant's shards, an unknown variant, and an output that does not name the variant",
    async () => {
      writeAttempt(0, {}, 'flo8');
      const flo8Key = jointStrengthRequiredShards('flo8')[0].key;
      const foreign = await assemble(`--out=${outDir()}`, '--development');
      expect(foreign.code).toBe(2);
      expect(foreign.reasons).toEqual([`unexpected_shard:${flo8Key}`]);
      rmSync(path.join(runsDir, `p132-${flo8Key}-a1`), { recursive: true });
      const unknown = await assemble('--variant=stud', `--out=${outDir()}`, '--development');
      expect(unknown.reasons).toEqual(['unknown_variant']);
      const undated = await assemble(
        `--out=${path.join(repo, 'docs/evidence/phase13/strength-2026-10-05')}`,
        '--development'
      );
      expect(undated.reasons).toEqual(['output_name_must_be_strength-YYYY-MM-DD-flh']);
      const otherPack = await assemble(`--out=${outDir('2026-10-05', 'flo8')}`, '--development');
      expect(otherPack.reasons).toEqual(['output_name_must_be_strength-YYYY-MM-DD-flh']);
      expect(existsSync(path.join(repo, 'docs'))).toBe(false);
    },
    RUN_TIMEOUT_MS * 4
  );

  it(
    'counts the earliest complete attempt, records the lost one and checks the replay',
    async () => {
      const key = required[4].key;
      rmSync(path.join(runsDir, `p132-${key}-a1`), { recursive: true });
      writeAttempt(4, { attempt: 1, result: { complete: false, cancelled: true, pairs: 9000 } });
      writeAttempt(4, { attempt: 2 });
      writeAttempt(4, { attempt: 3 });
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual([]);
      const strength = readJson(path.join(outDir(), 'strength.json'));
      const shard = strength.shards.find((s: { shard: string }) => s.shard === key);
      expect(shard.attempt).toBe(2);
      expect(shard.replayedBy).toEqual([3]);
      expect(
        strength.attempts
          .filter((a: { shard: string }) => a.shard === key)
          .map((a: { status: string }) => a.status)
      ).toEqual(['cancelled', 'complete', 'complete']);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses a replay that does not reproduce the counted attempt',
    async () => {
      writeAttempt(7, { attempt: 2, result: { pairDigest: 'b'.repeat(64) } });
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.code).toBe(2);
      expect(outcome.reasons).toEqual([`nondeterministic_replay:${required[7].key}:a1/a2`]);
      expect(existsSync(path.join(outDir(), 'strength.json'))).toBe(false);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses a shard with no complete attempt unless it is declared defective, and keeps it missing',
    async () => {
      const key = required[10].key;
      rmSync(path.join(runsDir, `p132-${key}-a1`), { recursive: true });
      writeAttempt(10, { result: null });
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([
        `missing_complete_result:${key}`,
      ]);
      const defective = path.join(root, 'defective.json');
      write(defective, {
        [key]: { status: 'defective', reason: 'runner lost twice before any result' },
      });
      const outcome = await assemble(
        `--out=${outDir()}`,
        '--development',
        `--defective=${defective}`
      );
      expect(outcome.reasons).toEqual([]);
      const strength = readJson(path.join(outDir(), 'strength.json'));
      expect(strength.matrixComplete).toBe(false);
      expect(strength.verdict.reasons).toContain(`${key}:missing_shard`);
      write(defective, { [required[11].key]: { status: 'defective', reason: 'not really' } });
      rmSync(outDir(), { recursive: true });
      const declared = await assemble(
        `--out=${outDir()}`,
        '--development',
        `--defective=${defective}`
      );
      expect(declared.reasons).toEqual(
        expect.arrayContaining([
          `declared_defective_but_has_result:${required[11].key}`,
          `missing_complete_result:${key}`,
        ])
      );
    },
    RUN_TIMEOUT_MS * 2
  );

  it(
    'refuses an attempt without its runner record and any directory or shard outside the matrix',
    async () => {
      rmSync(path.join(runsDir, `p132-${required[2].key}-a1`, 'runner.json'));
      mkdirSync(path.join(runsDir, 'stray'));
      mkdirSync(path.join(runsDir, `p132-p13c-flh-3dealt-100bb-${PACK.holdout.seeds[0]}-s99-a1`));
      // A Phase 12 attempt directory is not a Phase 13 attempt.
      mkdirSync(path.join(runsDir, `p122-${required[3].key}-a1`));
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          `missing_runner_record:p132-${required[2].key}-a1`,
          'unexpected_run_directory:stray',
          `unexpected_run_directory:p122-${required[3].key}-a1`,
          `unexpected_shard:p13c-flh-3dealt-100bb-${PACK.holdout.seeds[0]}-s99`,
        ])
      );
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses development runs in a contract assembly and any identity, variant or contract mismatch',
    async () => {
      const contractRun = await assemble(`--out=${outDir()}`);
      expect(contractRun.reasons).toContain(
        `not_contract_mode:p132-${required[0].key}-a1:development`
      );
      writeAttempt(1, { attempt: 1, manifest: { contractDigest: '0'.repeat(64) } });
      writeAttempt(2, { attempt: 1, manifest: { dirty: true } });
      writeAttempt(3, { attempt: 1, manifest: { sourceSha256: '1'.repeat(64) } });
      writeAttempt(5, { attempt: 1, manifest: { seed: 1 } });
      writeAttempt(6, { attempt: 1, result: { sourceUnchanged: false } });
      writeAttempt(8, { attempt: 1, manifest: { variant: 'flo8' } });
      writeAttempt(9, { attempt: 1, result: { variant: 'short_deck' } });
      writeAttempt(12, {
        attempt: 1,
        manifest: { packVersion: 'joint-action-response-round1-v2' },
      });
      writeAttempt(11, { attempt: 1, manifest: { domainVersion: 'joint-multiway-round1-v3' } });
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          `contract_mismatch:p132-${required[1].key}-a1`,
          `dirty_checkout:p132-${required[2].key}-a1`,
          'identity_mismatch:sourceSha256',
          `manifest_scope_mismatch:p132-${required[5].key}-a1`,
          `source_changed_during_run:p132-${required[6].key}-a1`,
          `manifest_scope_mismatch:p132-${required[8].key}-a1`,
          `result_identity_mismatch:p132-${required[9].key}-a1`,
          `pack_version_mismatch:p132-${required[12].key}-a1`,
          `domain_version_mismatch:p132-${required[11].key}-a1`,
        ])
      );
    },
    RUN_TIMEOUT_MS * 2
  );

  it(
    'refuses to overwrite evidence or write it outside the Phase 13 evidence directory',
    async () => {
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([]);
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([
        'output_exists',
      ]);
      const outside = await assemble(
        `--out=${path.join(repo, 'docs/evidence/phase12/strength-2026-10-05-flh')}`,
        '--development'
      );
      expect(outside.reasons).toEqual(['evidence_outside_docs/evidence/phase13/']);
    },
    RUN_TIMEOUT_MS * 3
  );

  it(
    "refuses to record a digest when a Phase 13 policy source differs from the runs' head",
    async () => {
      // A throwaway repository holding every hashed path; the real checkout is never touched.
      // Git hooks export GIT_DIR (and friends): inherited, they would point
      // `git init` and every command below at the checkout running the hook.
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
      );
      const git = (...args: string[]) =>
        execFileSync('git', args, { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }).trim();
      mkdirSync(repo, { recursive: true });
      git('init', '-q');
      expect(realpathSync(git('rev-parse', '--show-toplevel'))).toBe(realpathSync(repo));
      for (const file of HORSE_PHASE13_POLICY_SOURCE_FILES) {
        mkdirSync(path.dirname(path.join(repo, 'server', file)), { recursive: true });
        writeFileSync(path.join(repo, 'server', file), `// ${file}\n`);
      }
      git('add', '-A');
      git(
        '-c',
        'user.name=t',
        '-c',
        'user.email=t@t',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--no-verify',
        '-m',
        'policy'
      );
      const head = git('rev-parse', 'HEAD');
      const refusal = async () => {
        const { stdout } = await exec(
          process.execPath,
          [
            '--import',
            'tsx',
            '-e',
            `import('./scripts/phase13-strength-assemble.mjs').then((m) => console.log(JSON.stringify(m.policySourceRefusal(${JSON.stringify(head)}, ${JSON.stringify(repo)}))))`,
          ],
          { cwd: process.cwd(), env, timeout: RUN_TIMEOUT_MS }
        );
        return JSON.parse(stdout.trim().split('\n').pop()!);
      };
      expect(await refusal()).toBeNull();
      writeFileSync(
        path.join(repo, 'server/src/engine/multiway/JointResponseTree.ts'),
        '// edited\n'
      );
      expect(await refusal()).toBe('policy_source_changed');
      git('checkout', '--', '.');
      writeFileSync(path.join(repo, 'server/src/engine/BettingStructure.ts'), '// edited\n');
      expect(await refusal()).toBe('policy_source_changed');
    },
    RUN_TIMEOUT_MS * 3
  );
});

describe('jointStrengthEvaluate refusals', () => {
  it(
    'refuses an unknown variant or a profile of another variant before writing anything',
    async () => {
      const script = 'src/scripts/jointStrengthEvaluate.ts';
      const output = path.join(root, 'shard-out');
      const base = [`--output=${output}`, '--seed=13101101', '--shard=0', '--pairs=3'];
      const unknown = await runScript(script, [
        '--variant=stud',
        '--profile=p13c-nlh-3dealt-100bb',
        ...base,
      ]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('Unknown P13.2 variant');
      const foreign = await runScript(script, [
        '--variant=flh',
        '--profile=p13c-flo8-3dealt-100bb',
        ...base,
      ]);
      expect(foreign.code).toBe(1);
      expect(foreign.stderr).toContain('Unknown flh contract profile');
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(root).includes('shard-out')).toBe(false);
    },
    RUN_TIMEOUT_MS * 2
  );

  it(
    'a development shard writes a manifest and a result that the contract refuses by name',
    async () => {
      const script = 'src/scripts/jointStrengthEvaluate.ts';
      const output = path.join(root, 'dev-out');
      const r = await runScript(
        script,
        [
          '--variant=nlh',
          '--profile=p13c-nlh-3dealt-100bb',
          `--output=${output}`,
          '--seed=13101101',
          '--shard=0',
          '--pairs=3',
        ],
        DEV_SHARD_TIMEOUT_MS
      );
      if (r.code !== 0 && !existsSync(path.join(output, 'manifest.json')))
        throw new Error(`development shard did not start: ${r.code} ${r.stderr}`);
      const key = 'p13c-nlh-3dealt-100bb-13101101-s0';
      const manifest = readJson(path.join(output, 'manifest.json'));
      expect(manifest).toMatchObject({
        schema: 'horse-phase13-strength-manifest-v1',
        mode: 'development',
        variant: 'nlh',
        contractDigest: jointStrengthContractDigest(),
        packVersion: 'joint-action-response-round3-v1',
        domainVersion: 'joint-multiway-round1-v4',
        rangePackVersion: 'joint-public-range-round1-v1',
        equityGovernor: 'off',
        activation: 'never',
      });
      const result = readJson(path.join(output, `${key}.json`));
      expect(result).toMatchObject({
        schema: 'horse-phase13-strength-shard-v1',
        complete: true,
        pairs: 3,
        cancelled: false,
        illegalCandidates: 0,
      });
      // The CLI fingerprints every tracked and untracked file under src before
      // and after the run and exits 1 when anything moved (other suites may
      // write a scratch file there), so the exit code is checked against the
      // recorded fingerprint verdict rather than assumed to be 0.
      expect(typeof result.sourceUnchanged).toBe('boolean');
      expect(r.code).toBe(result.sourceUnchanged ? 0 : 1);
      expect(JSON.parse(r.stdout.trim().split('\n').pop()!).reasons).toEqual(
        expect.arrayContaining([`${key}:not_contract_mode`, `${key}:not_holdout_seed`])
      );
    },
    DEV_SHARD_TIMEOUT_MS + 30_000
  );
});
