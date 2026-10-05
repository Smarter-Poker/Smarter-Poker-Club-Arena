/**
 * P12.2 strength assembler (server/scripts/phase12-strength-assemble.mjs) and
 * the one-shard CLI's refusals (src/scripts/remainingVariantStrengthEvaluate.ts).
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
  REMAINING_VARIANT_STRENGTH_CONTRACT,
  remainingVariantStrengthContractDigest,
  remainingVariantStrengthPack,
  remainingVariantStrengthRequiredShards,
} from './RemainingVariantStrengthContract.js';
import {
  HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
  HORSE_PHASE12_POLICY_SOURCE_FILES,
  horsePhase12PolicyDigest,
} from '../engine/HorsePhase12PolicyDigest.js';
import type { RemainingPolicyVariant } from '../engine/remainingVariants/RemainingVariantPolicyPack.js';
import {
  admitHorsePhase12QualifiedAuthority,
  HORSE_PHASE12_EVIDENCE_DIRECTORY,
  HORSE_PHASE12_QUALIFICATION_KEYS,
  HORSE_PHASE12_QUALIFICATION_SCHEMA,
  type HorsePhase12AuthoritySelection,
} from '../engine/HorsePhase12Authority.js';
import { p12CompletionBytes } from '../engine/HorsePhase12Authority.test-support.js';

const exec = promisify(execFile);
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const RUN_TIMEOUT_MS = 60_000;
const DEV_SHARD_TIMEOUT_MS = 240_000;
const C = REMAINING_VARIANT_STRENGTH_CONTRACT;
const VARIANT: RemainingPolicyVariant = 'flh';
const PACK = remainingVariantStrengthPack(VARIANT);
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

let root: string;
let runsDir: string;
let repo: string;
const outDir = (date = '2026-10-05', variant: string = VARIANT) =>
  path.join(repo, 'docs/evidence/phase12', `strength-${date}-${variant}`);
const required = remainingVariantStrengthRequiredShards(VARIANT);

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
  variant: RemainingPolicyVariant = VARIANT
) {
  const shards = remainingVariantStrengthRequiredShards(variant);
  const pack = remainingVariantStrengthPack(variant);
  const { key, profileId, seed, shard } = shards[index];
  const attempt = options.attempt ?? 1;
  const mode = options.mode ?? 'development';
  const dir = path.join(runsDir, `p122-${key}-a${attempt}`);
  if (options.runner !== false)
    write(path.join(dir, 'runner.json'), {
      schema: 'horse-phase12-strength-runner-v1',
      runner: `gh-${key}`,
      cpu: 'fixture',
      vcpu: 4,
      runAttempt: attempt,
      variant,
      shard: key,
    });
  write(path.join(dir, 'attempt.json'), {
    schema: 'horse-phase12-strength-attempt-v1',
    runAttempt: attempt,
    variant,
    startedAt: '2026-10-05T00:00:00Z',
    finishedAt: '2026-10-05T00:20:00Z',
    exitCode: 0,
  });
  write(path.join(dir, key, 'manifest.json'), {
    schema: 'horse-phase12-strength-manifest-v1',
    mode,
    variant,
    head: HEAD,
    dirty: false,
    sourceSha256: 'f'.repeat(64),
    sourceFiles: 1,
    serverLockSha256: 'e'.repeat(64),
    contractVersion: C.version,
    contractDigest: remainingVariantStrengthContractDigest(),
    packVersion: pack.candidate.packVersion,
    profileId,
    seed,
    shard,
    pairs: pack.matrix.pairsPerShard,
    createdAt: '2026-10-05T00:00:00.000Z',
    ...options.manifest,
  });
  if (options.result === null) return;
  write(path.join(dir, key, `${key}.json`), {
    schema: 'horse-phase12-strength-shard-v1',
    variant,
    contractVersion: C.version,
    contractDigest: remainingVariantStrengthContractDigest(),
    packVersion: pack.candidate.packVersion,
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
    changed: 2,
    illegalCandidates: 1,
    discards: 0,
    lowHalvesChecked: 0,
    durationMs: 1000,
    sourceUnchanged: true,
    cancelled: false,
    ...options.result,
  });
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
  const r = await runScript('scripts/phase12-strength-assemble.mjs', [
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
  root = mkdtempSync(path.join(tmpdir(), 'phase12-strength-assemble-'));
  runsDir = path.join(root, 'runs');
  repo = path.join(root, 'repo');
  for (let i = 0; i < required.length; i++) writeAttempt(i);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('phase12-strength-assemble', () => {
  it(
    'assembles one pack with the real verdict, binds its policy digest, and never qualifies development runs',
    async () => {
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual([]);
      expect(outcome.code).toBe(0);
      const strength = readJson(path.join(outDir(), 'strength.json'));
      const qualification = readJson(
        path.join(repo, 'docs/evidence/phase12/phase12-qualification-2026-10-05-flh.json')
      );
      expect(strength.schema).toBe('horse-phase12-strength-v1');
      expect(strength.phase).toBe('P12.2');
      expect(strength.variant).toBe(VARIANT);
      expect(strength.contractDigest).toBe(remainingVariantStrengthContractDigest());
      expect(strength.domain).toBe(PACK.domain);
      expect(strength.shards).toHaveLength(PACK.matrix.requiredShards);
      expect(strength.attempts).toHaveLength(PACK.matrix.requiredShards);
      expect(strength.source.policyDigest).toBe(horsePhase12PolicyDigest(VARIANT));
      expect(strength.source.policyDigestDefinition).toBe(HORSE_PHASE12_POLICY_DIGEST_DEFINITION);
      expect(strength.source.policyDigestFiles).toEqual(
        HORSE_PHASE12_POLICY_SOURCE_FILES.map((file) => `server/${file}`)
      );
      // The guard refusals are reported beside changed, per shard and in total, never gated.
      expect(strength.shards[0]).toMatchObject({ changed: 2, illegalCandidates: 1, discards: 0 });
      expect(strength.selectionGuard).toEqual({
        gate: false,
        changed: 2 * PACK.matrix.requiredShards,
        illegalCandidates: PACK.matrix.requiredShards,
        discards: 0,
      });
      expect(strength.verdict.selectionGuard.illegalCandidates).toBe(PACK.matrix.requiredShards);
      expect(strength.verdict.qualified).toBe(false);
      expect(strength.verdict.reasons).toContain(`${required[0].key}:not_contract_mode`);
      expect(strength.verdict.streetFamiliesDiagnostic.gate).toBe(false);
      expect(qualification).toMatchObject({
        schema: 'horse-phase12-qualification-v1',
        qualified: false,
        mode: 'development',
        variant: VARIANT,
        sourceSha: HEAD,
        packVersion: PACK.candidate.packVersion,
        contractVersion: C.version,
        contractDigest: remainingVariantStrengthContractDigest(),
        domain: PACK.domain,
        policyDigest: horsePhase12PolicyDigest(VARIANT),
        policyDigestDefinition: HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
        evidencePath: 'docs/evidence/phase12/strength-2026-10-05-flh/strength.json',
      });
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
      // One digest per pack: an FLH file never carries another pack's digest.
      for (const other of ['short_deck', 'pineapple', 'flo8'] as const)
        expect(horsePhase12PolicyDigest(other)).not.toBe(horsePhase12PolicyDigest(VARIANT));
    },
    RUN_TIMEOUT_MS
  );

  it(
    'P12.3: the Phase 12 admission reads the real assembler output and never selects a development assembly',
    async () => {
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual([]);
      const qualificationPath = `docs/evidence/phase12/phase12-qualification-2026-10-05-${VARIANT}.json`;
      const completionPath = `docs/evidence/phase12/phase12-completion-2026-10-05-${VARIANT}.json`;
      const bytes = readFileSync(path.join(repo, qualificationPath));
      const file = JSON.parse(bytes.toString('utf8'));
      expect(file.schema).toBe(HORSE_PHASE12_QUALIFICATION_SCHEMA);
      // Admission requires exactly the keys the real assembler wrote.
      expect(Object.keys(file).sort()).toEqual([...HORSE_PHASE12_QUALIFICATION_KEYS].sort());
      expect(file.domain).toBe(PACK.domain);
      expect(file.evidencePath.startsWith(HORSE_PHASE12_EVIDENCE_DIRECTORY)).toBe(true);
      // A completion record for the same pack and policy, in this temporary directory only.
      const completion = p12CompletionBytes(VARIANT);
      writeFileSync(path.join(repo, completionPath), completion);
      const reader = { read: (relative: string) => readFileSync(path.join(repo, relative)) };
      const now = Date.parse('2026-10-20T01:00:00.000Z');
      const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
      const selectionFor = (
        qualification: Buffer,
        overrides: Partial<HorsePhase12AuthoritySelection> = {}
      ): HorsePhase12AuthoritySelection => ({
        schema: 'horse-qualified-authority-selection-v1',
        phase: 'phase12',
        variant: VARIANT,
        sourceSha: HEAD,
        packVersion: file.packVersion,
        contractVersion: file.contractVersion,
        contractDigest: file.contractDigest,
        domain: file.domain,
        qualificationPath,
        qualificationSha256: sha(qualification),
        completionPath,
        completionSha256: sha(completion),
        approvalGeneration: 1,
        issuedAt: '2026-10-20T00:00:00.000Z',
        expiresAt: null,
        withdrawn: null,
        ...overrides,
      });
      const digest = remainingVariantStrengthContractDigest();
      const admitAs = (
        variant: RemainingPolicyVariant,
        selection: HorsePhase12AuthoritySelection
      ) => admitHorsePhase12QualifiedAuthority(variant, selection, reader, now, digest);
      // The assembler's own development file: refused, whatever selects it.
      expect(admitAs(VARIANT, selectionFor(bytes))).toMatchObject({
        status: 'refused',
        reason: 'not_qualified',
      });
      // Shape compatibility, in this temporary directory only (never committed):
      // the same real file relabelled as a contract-mode cash qualification with
      // no failure reason is read field for field, bound to its digests,
      // source, strength record and the completion record.
      const relabelled = Buffer.from(
        JSON.stringify({
          ...file,
          qualified: true,
          mode: 'contract',
          objectives: { ...file.objectives, cash: { ...file.objectives.cash, qualified: true } },
          reasons: [],
        })
      );
      writeFileSync(path.join(repo, qualificationPath), relabelled);
      expect(admitAs(VARIANT, selectionFor(relabelled))).toMatchObject({
        status: 'admitted',
        authority: {
          phase: 'phase12',
          variant: VARIANT,
          sourceSha: HEAD,
          contractDigest: digest,
          policyDigest: horsePhase12PolicyDigest(VARIANT),
          completionPath,
        },
      });
      // It never admits another pack.
      expect(admitAs('flo8', selectionFor(relabelled))).toMatchObject({
        status: 'refused',
        reason: 'continuation_mismatch',
      });
      expect(
        admitAs(VARIANT, selectionFor(relabelled, { sourceSha: 'c'.repeat(40) }))
      ).toMatchObject({ status: 'refused', reason: 'source_mismatch' });
      writeFileSync(path.join(outDir(), 'strength.json'), '{}\n');
      expect(admitAs(VARIANT, selectionFor(relabelled))).toMatchObject({
        status: 'refused',
        reason: 'hash_mismatch',
      });
    },
    RUN_TIMEOUT_MS
  );

  it(
    "refuses another pack's shards, an unknown variant, and an output that does not name the pack",
    async () => {
      writeAttempt(0, {}, 'flo8');
      const flo8Key = remainingVariantStrengthRequiredShards('flo8')[0].key;
      const foreign = await assemble(`--out=${outDir()}`, '--development');
      expect(foreign.code).toBe(2);
      expect(foreign.reasons).toEqual([`unexpected_shard:${flo8Key}`]);
      rmSync(path.join(runsDir, `p122-${flo8Key}-a1`), { recursive: true });
      const unknown = await assemble('--variant=plo5', `--out=${outDir()}`, '--development');
      expect(unknown.reasons).toEqual(['unknown_variant']);
      const undated = await assemble(
        `--out=${path.join(repo, 'docs/evidence/phase12/strength-2026-10-05')}`,
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
      rmSync(path.join(runsDir, `p122-${key}-a1`), { recursive: true });
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
      rmSync(path.join(runsDir, `p122-${key}-a1`), { recursive: true });
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
      rmSync(path.join(runsDir, `p122-${required[2].key}-a1`, 'runner.json'));
      mkdirSync(path.join(runsDir, 'stray'));
      mkdirSync(
        path.join(runsDir, `p122-p12c-flh-6max-2dealt-100bb-${PACK.holdout.seeds[0]}-s9-a1`)
      );
      // A Phase 11 attempt directory is not a Phase 12 attempt.
      mkdirSync(path.join(runsDir, `p112-${required[3].key}-a1`));
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          `missing_runner_record:p122-${required[2].key}-a1`,
          'unexpected_run_directory:stray',
          `unexpected_run_directory:p112-${required[3].key}-a1`,
          `unexpected_shard:p12c-flh-6max-2dealt-100bb-${PACK.holdout.seeds[0]}-s9`,
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
        `not_contract_mode:p122-${required[0].key}-a1:development`
      );
      writeAttempt(1, { attempt: 1, manifest: { contractDigest: '0'.repeat(64) } });
      writeAttempt(2, { attempt: 1, manifest: { dirty: true } });
      writeAttempt(3, { attempt: 1, manifest: { sourceSha256: '1'.repeat(64) } });
      writeAttempt(5, { attempt: 1, manifest: { seed: 1 } });
      writeAttempt(6, { attempt: 1, result: { sourceUnchanged: false } });
      writeAttempt(8, { attempt: 1, manifest: { variant: 'flo8' } });
      writeAttempt(9, { attempt: 1, result: { variant: 'short_deck' } });
      writeAttempt(12, { attempt: 1, manifest: { packVersion: 'fixed-limit-holdem-round0' } });
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          `contract_mismatch:p122-${required[1].key}-a1`,
          `dirty_checkout:p122-${required[2].key}-a1`,
          'identity_mismatch:sourceSha256',
          `manifest_scope_mismatch:p122-${required[5].key}-a1`,
          `source_changed_during_run:p122-${required[6].key}-a1`,
          `manifest_scope_mismatch:p122-${required[8].key}-a1`,
          `result_identity_mismatch:p122-${required[9].key}-a1`,
          `pack_version_mismatch:p122-${required[12].key}-a1`,
        ])
      );
    },
    RUN_TIMEOUT_MS * 2
  );

  it(
    'refuses to overwrite evidence or write it outside the Phase 12 evidence directory',
    async () => {
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([]);
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([
        'output_exists',
      ]);
      const outside = await assemble(
        `--out=${path.join(repo, 'docs/evidence/phase11/strength-2026-10-05-flh')}`,
        '--development'
      );
      expect(outside.reasons).toEqual(['evidence_outside_docs/evidence/phase12/']);
    },
    RUN_TIMEOUT_MS * 3
  );

  it(
    "refuses to record a digest when a Phase 12 policy source differs from the runs' head",
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
      for (const file of HORSE_PHASE12_POLICY_SOURCE_FILES) {
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
            `import('./scripts/phase12-strength-assemble.mjs').then((m) => console.log(JSON.stringify(m.policySourceRefusal(${JSON.stringify(head)}, ${JSON.stringify(repo)}))))`,
          ],
          { cwd: process.cwd(), env, timeout: RUN_TIMEOUT_MS }
        );
        return JSON.parse(stdout.trim().split('\n').pop()!);
      };
      expect(await refusal()).toBeNull();
      writeFileSync(
        path.join(repo, 'server/src/engine/remainingVariants/RemainingVariantSampler.ts'),
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

describe('remainingVariantStrengthEvaluate refusals', () => {
  it(
    'refuses an unknown variant or a profile of another pack before writing anything',
    async () => {
      const script = 'src/scripts/remainingVariantStrengthEvaluate.ts';
      const output = path.join(root, 'shard-out');
      const base = [`--output=${output}`, '--seed=12101101', '--shard=0', '--pairs=4'];
      const unknown = await runScript(script, [
        '--variant=plo5',
        '--profile=p11c-plo5-6max-100bb',
        ...base,
      ]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('Unknown P12.2 variant');
      const foreign = await runScript(script, [
        '--variant=flh',
        '--profile=p12c-flo8-6max-100bb',
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
      const script = 'src/scripts/remainingVariantStrengthEvaluate.ts';
      const output = path.join(root, 'dev-out');
      const r = await runScript(
        script,
        [
          '--variant=pineapple',
          '--profile=p12c-pineapple-6max-2dealt-100bb',
          `--output=${output}`,
          '--seed=12101101',
          '--shard=0',
          '--pairs=8',
        ],
        // This one loads and plays the engine (the refusals above exit before
        // it loads); on a loaded two-CPU host inside the full suite the load
        // alone has exceeded a minute.
        DEV_SHARD_TIMEOUT_MS
      );
      if (r.code !== 0 && !existsSync(path.join(output, 'manifest.json')))
        throw new Error(`development shard did not start: ${r.code} ${r.stderr}`);
      const key = 'p12c-pineapple-6max-2dealt-100bb-12101101-s0';
      const manifest = readJson(path.join(output, 'manifest.json'));
      expect(manifest).toMatchObject({
        schema: 'horse-phase12-strength-manifest-v1',
        mode: 'development',
        variant: 'pineapple',
        contractDigest: remainingVariantStrengthContractDigest(),
        equityGovernor: 'off',
        activation: 'never',
      });
      const result = readJson(path.join(output, `${key}.json`));
      expect(result).toMatchObject({
        schema: 'horse-phase12-strength-shard-v1',
        complete: true,
        pairs: 8,
        cancelled: false,
      });
      // The CLI fingerprints every tracked and untracked file under src before
      // and after the run and exits 1 when anything moved. Other suites running
      // beside this one (the pre-push hook runs them in parallel) can write a
      // scratch file there, so the exit code is checked against the recorded
      // fingerprint verdict rather than assumed to be 0.
      expect(typeof result.sourceUnchanged).toBe('boolean');
      expect(r.code).toBe(result.sourceUnchanged ? 0 : 1);
      expect(result.discards).toBeGreaterThan(0);
      expect(Number.isInteger(result.illegalCandidates)).toBe(true);
      expect(JSON.parse(r.stdout.trim().split('\n').pop()!).reasons).toEqual(
        expect.arrayContaining([`${key}:not_contract_mode`, `${key}:not_holdout_seed`])
      );
    },
    DEV_SHARD_TIMEOUT_MS + 30_000
  );
});
