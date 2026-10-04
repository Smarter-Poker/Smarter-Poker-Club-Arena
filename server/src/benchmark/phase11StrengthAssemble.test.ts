/**
 * P11.2 strength assembler (server/scripts/phase11-strength-assemble.mjs) and
 * the one-shard CLI's refusals (src/scripts/omahaVariantStrengthEvaluate.ts).
 *
 * Every synthetic attempt here is DEVELOPMENT mode, so it can never qualify:
 * a contract assembly refuses development runs, and a development assembly
 * always writes `qualified: false`. The scripts run as their own tsx
 * processes, the way the evidence is produced, so their verdict comes from the
 * real contract they import.
 */
import { execFile, execFileSync } from 'node:child_process';
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
  OMAHA_VARIANT_STRENGTH_CONTRACT,
  omahaVariantStrengthContractDigest,
  omahaVariantStrengthPack,
  omahaVariantStrengthRequiredShards,
} from './OmahaVariantStrengthContract.js';
import {
  HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
  HORSE_PHASE11_POLICY_SOURCE_FILES,
  horsePhase11PolicyDigest,
} from '../engine/HorsePhase11PolicyDigest.js';
import type { OmahaPolicyVariant } from '../engine/omaha/OmahaVariantPolicyPack.js';

const exec = promisify(execFile);
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const RUN_TIMEOUT_MS = 60_000;
const C = OMAHA_VARIANT_STRENGTH_CONTRACT;
const VARIANT: OmahaPolicyVariant = 'plo8';
const PACK = omahaVariantStrengthPack(VARIANT);
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

let root: string;
let runsDir: string;
let repo: string;
const outDir = (date = '2026-10-04', variant: string = VARIANT) =>
  path.join(repo, 'docs/evidence/phase11', `strength-${date}-${variant}`);
const required = omahaVariantStrengthRequiredShards(VARIANT);

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
  variant: OmahaPolicyVariant = VARIANT
) {
  const shards = omahaVariantStrengthRequiredShards(variant);
  const pack = omahaVariantStrengthPack(variant);
  const { key, profileId, seed, shard } = shards[index];
  const attempt = options.attempt ?? 1;
  const mode = options.mode ?? 'development';
  const dir = path.join(runsDir, `p112-${key}-a${attempt}`);
  if (options.runner !== false)
    write(path.join(dir, 'runner.json'), {
      schema: 'horse-phase11-strength-runner-v1',
      runner: `gh-${key}`,
      cpu: 'fixture',
      vcpu: 4,
      runAttempt: attempt,
      variant,
      shard: key,
    });
  write(path.join(dir, 'attempt.json'), {
    schema: 'horse-phase11-strength-attempt-v1',
    runAttempt: attempt,
    variant,
    startedAt: '2026-10-05T00:00:00Z',
    finishedAt: '2026-10-05T00:20:00Z',
    exitCode: 0,
  });
  write(path.join(dir, key, 'manifest.json'), {
    schema: 'horse-phase11-strength-manifest-v1',
    mode,
    variant,
    head: HEAD,
    dirty: false,
    sourceSha256: 'f'.repeat(64),
    sourceFiles: 1,
    serverLockSha256: 'e'.repeat(64),
    contractVersion: C.version,
    contractDigest: omahaVariantStrengthContractDigest(),
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
    schema: 'horse-phase11-strength-shard-v1',
    variant,
    contractVersion: C.version,
    contractDigest: omahaVariantStrengthContractDigest(),
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
    lowHalvesChecked: 0,
    durationMs: 1000,
    sourceUnchanged: true,
    cancelled: false,
    ...options.result,
  });
}

async function runScript(script: string, args: string[]) {
  try {
    const { stdout } = await exec(process.execPath, ['--import', 'tsx', script, ...args], {
      cwd: process.cwd(),
      timeout: RUN_TIMEOUT_MS,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    const e = error as { code?: number; stderr?: string; stdout?: string };
    return { code: e.code ?? -1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}
async function assemble(...extra: string[]) {
  const hasVariant = extra.some((a) => a.startsWith('--variant='));
  const r = await runScript('scripts/phase11-strength-assemble.mjs', [
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
  root = mkdtempSync(path.join(tmpdir(), 'phase11-strength-assemble-'));
  runsDir = path.join(root, 'runs');
  repo = path.join(root, 'repo');
  for (let i = 0; i < required.length; i++) writeAttempt(i);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('phase11-strength-assemble', () => {
  it(
    'assembles one pack with the real verdict, binds its policy digest, and never qualifies development runs',
    async () => {
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual([]);
      expect(outcome.code).toBe(0);
      const strength = readJson(path.join(outDir(), 'strength.json'));
      const qualification = readJson(
        path.join(repo, 'docs/evidence/phase11/phase11-qualification-2026-10-04-plo8.json')
      );
      expect(strength.schema).toBe('horse-phase11-strength-v1');
      expect(strength.phase).toBe('P11.2');
      expect(strength.variant).toBe(VARIANT);
      expect(strength.contractDigest).toBe(omahaVariantStrengthContractDigest());
      expect(strength.domain).toBe(PACK.domain);
      expect(strength.shards).toHaveLength(PACK.matrix.requiredShards);
      expect(strength.attempts).toHaveLength(PACK.matrix.requiredShards);
      expect(strength.source.policyDigest).toBe(horsePhase11PolicyDigest(VARIANT));
      expect(strength.source.policyDigestDefinition).toBe(HORSE_PHASE11_POLICY_DIGEST_DEFINITION);
      expect(strength.source.policyDigestFiles).toEqual(
        HORSE_PHASE11_POLICY_SOURCE_FILES.map((file) => `server/${file}`)
      );
      expect(strength.verdict.qualified).toBe(false);
      expect(strength.verdict.reasons).toContain(`${required[0].key}:not_contract_mode`);
      expect(strength.verdict.streetFamiliesDiagnostic.gate).toBe(false);
      expect(qualification).toMatchObject({
        schema: 'horse-phase11-qualification-v1',
        qualified: false,
        mode: 'development',
        variant: VARIANT,
        sourceSha: HEAD,
        packVersion: PACK.candidate.packVersion,
        contractVersion: C.version,
        contractDigest: omahaVariantStrengthContractDigest(),
        domain: PACK.domain,
        policyDigest: horsePhase11PolicyDigest(VARIANT),
        policyDigestDefinition: HORSE_PHASE11_POLICY_DIGEST_DEFINITION,
        evidencePath: 'docs/evidence/phase11/strength-2026-10-04-plo8/strength.json',
      });
      expect(qualification.objectives.cash).toEqual({ qualified: false, status: 'measured' });
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
      // One digest per pack: a PLO8 file never carries the PLO5 or PLO6 digest.
      expect(horsePhase11PolicyDigest('plo5')).not.toBe(horsePhase11PolicyDigest(VARIANT));
      expect(horsePhase11PolicyDigest('plo6')).not.toBe(horsePhase11PolicyDigest(VARIANT));
    },
    RUN_TIMEOUT_MS
  );

  it(
    "refuses another pack's shards, an unknown variant, and an output that does not name the pack",
    async () => {
      writeAttempt(0, {}, 'plo5');
      const plo5Key = omahaVariantStrengthRequiredShards('plo5')[0].key;
      const foreign = await assemble(`--out=${outDir()}`, '--development');
      expect(foreign.code).toBe(2);
      expect(foreign.reasons).toEqual([`unexpected_shard:${plo5Key}`]);
      rmSync(path.join(runsDir, `p112-${plo5Key}-a1`), { recursive: true });
      const unknown = await assemble('--variant=plo4', `--out=${outDir()}`, '--development');
      expect(unknown.reasons).toEqual(['unknown_variant']);
      const undated = await assemble(
        `--out=${path.join(repo, 'docs/evidence/phase11/strength-2026-10-04')}`,
        '--development'
      );
      expect(undated.reasons).toEqual(['output_name_must_be_strength-YYYY-MM-DD-plo8']);
      const otherPack = await assemble(`--out=${outDir('2026-10-04', 'plo5')}`, '--development');
      expect(otherPack.reasons).toEqual(['output_name_must_be_strength-YYYY-MM-DD-plo8']);
      expect(existsSync(path.join(repo, 'docs'))).toBe(false);
    },
    RUN_TIMEOUT_MS * 4
  );

  it(
    'counts the earliest complete attempt, records the lost one and checks the replay',
    async () => {
      const key = required[4].key;
      rmSync(path.join(runsDir, `p112-${key}-a1`), { recursive: true });
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
      rmSync(path.join(runsDir, `p112-${key}-a1`), { recursive: true });
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
      rmSync(path.join(runsDir, `p112-${required[2].key}-a1`, 'runner.json'));
      mkdirSync(path.join(runsDir, 'stray'));
      mkdirSync(
        path.join(runsDir, `p112-p11c-plo8-6max-2dealt-100bb-${PACK.holdout.seeds[0]}-s9-a1`)
      );
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          `missing_runner_record:p112-${required[2].key}-a1`,
          'unexpected_run_directory:stray',
          `unexpected_shard:p11c-plo8-6max-2dealt-100bb-${PACK.holdout.seeds[0]}-s9`,
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
        `not_contract_mode:p112-${required[0].key}-a1:development`
      );
      writeAttempt(1, { attempt: 1, manifest: { contractDigest: '0'.repeat(64) } });
      writeAttempt(2, { attempt: 1, manifest: { dirty: true } });
      writeAttempt(3, { attempt: 1, manifest: { sourceSha256: '1'.repeat(64) } });
      writeAttempt(5, { attempt: 1, manifest: { seed: 1 } });
      writeAttempt(6, { attempt: 1, result: { sourceUnchanged: false } });
      writeAttempt(8, { attempt: 1, manifest: { variant: 'plo5' } });
      writeAttempt(9, { attempt: 1, result: { variant: 'plo6' } });
      writeAttempt(12, { attempt: 1, manifest: { packVersion: 'plo8-split-round0' } });
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          `contract_mismatch:p112-${required[1].key}-a1`,
          `dirty_checkout:p112-${required[2].key}-a1`,
          'identity_mismatch:sourceSha256',
          `manifest_scope_mismatch:p112-${required[5].key}-a1`,
          `source_changed_during_run:p112-${required[6].key}-a1`,
          `manifest_scope_mismatch:p112-${required[8].key}-a1`,
          `result_identity_mismatch:p112-${required[9].key}-a1`,
          `pack_version_mismatch:p112-${required[12].key}-a1`,
        ])
      );
    },
    RUN_TIMEOUT_MS * 2
  );

  it(
    'refuses to overwrite evidence or write it outside the Phase 11 evidence directory',
    async () => {
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([]);
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([
        'output_exists',
      ]);
      const outside = await assemble(
        `--out=${path.join(repo, 'docs/evidence/phase10/strength-2026-10-04-plo8')}`,
        '--development'
      );
      expect(outside.reasons).toEqual(['evidence_outside_docs/evidence/phase11/']);
    },
    RUN_TIMEOUT_MS * 3
  );

  it(
    "refuses to record a digest when a Phase 11 policy source differs from the runs' head",
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
      for (const file of HORSE_PHASE11_POLICY_SOURCE_FILES) {
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
            `import('./scripts/phase11-strength-assemble.mjs').then((m) => console.log(JSON.stringify(m.policySourceRefusal(${JSON.stringify(head)}, ${JSON.stringify(repo)}))))`,
          ],
          { cwd: process.cwd(), env, timeout: RUN_TIMEOUT_MS }
        );
        return JSON.parse(stdout.trim().split('\n').pop()!);
      };
      expect(await refusal()).toBeNull();
      writeFileSync(
        path.join(repo, 'server/src/engine/omaha/OmahaVariantSampler.ts'),
        '// edited\n'
      );
      expect(await refusal()).toBe('policy_source_changed');
    },
    RUN_TIMEOUT_MS * 2
  );
});

describe('omahaVariantStrengthEvaluate refusals', () => {
  it(
    'refuses an unknown variant or a profile of another pack before writing anything',
    async () => {
      const script = 'src/scripts/omahaVariantStrengthEvaluate.ts';
      const output = path.join(root, 'shard-out');
      const base = [`--output=${output}`, '--seed=11101101', '--shard=0', '--pairs=4'];
      const unknown = await runScript(script, [
        '--variant=plo4',
        '--profile=p10c-6max-100bb',
        ...base,
      ]);
      expect(unknown.code).toBe(1);
      expect(unknown.stderr).toContain('Unknown P11.2 variant');
      const foreign = await runScript(script, [
        '--variant=plo5',
        '--profile=p11c-plo6-6max-100bb',
        ...base,
      ]);
      expect(foreign.code).toBe(1);
      expect(foreign.stderr).toContain('Unknown plo5 contract profile');
      expect(existsSync(output)).toBe(false);
      expect(readdirSync(root).includes('shard-out')).toBe(false);
    },
    RUN_TIMEOUT_MS * 2
  );
});
