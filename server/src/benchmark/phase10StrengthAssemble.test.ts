/**
 * P10.2 strength assembler (server/scripts/phase10-strength-assemble.mjs).
 *
 * Every synthetic attempt here is DEVELOPMENT mode, so it can never qualify:
 * a contract assembly refuses development runs, and a development assembly
 * always writes `qualified: false`. The script runs as its own tsx process,
 * the way the evidence is produced, so its verdict comes from the real
 * contract it imports.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PLO4_STRENGTH_CONTRACT,
  plo4StrengthContractDigest,
  plo4StrengthRequiredShards,
} from './Plo4StrengthContract.js';
import { createHash } from 'node:crypto';
import {
  admitHorsePhase10QualifiedAuthority,
  HORSE_PHASE10_DOMAIN,
  HORSE_PHASE10_EVIDENCE_DIRECTORY,
  HORSE_PHASE10_QUALIFICATION_SCHEMA,
  type HorsePhase10AuthoritySelection,
} from '../engine/HorsePhase10Authority.js';

const exec = promisify(execFile);
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const RUN_TIMEOUT_MS = 60_000;
const C = PLO4_STRENGTH_CONTRACT;
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));

let root: string;
let runsDir: string;
let repo: string;
const outDir = (date = '2026-10-03') =>
  path.join(repo, 'docs/evidence/phase10', `strength-${date}`);
const required = plo4StrengthRequiredShards();

interface AttemptOptions {
  attempt?: number;
  mode?: 'contract' | 'development';
  manifest?: Record<string, unknown>;
  result?: Record<string, unknown> | null;
  runner?: boolean;
}
/** One attempt directory exactly as `gh run download` writes the workflow artifact. */
function writeAttempt(index: number, options: AttemptOptions = {}) {
  const { key, profileId, seed, shard } = required[index];
  const attempt = options.attempt ?? 1;
  const mode = options.mode ?? 'development';
  const dir = path.join(runsDir, `p102-${key}-a${attempt}`);
  if (options.runner !== false)
    write(path.join(dir, 'runner.json'), {
      schema: 'horse-phase10-strength-runner-v1',
      runner: `gh-${key}`,
      cpu: 'fixture',
      vcpu: 4,
      runAttempt: attempt,
      shard: key,
    });
  write(path.join(dir, 'attempt.json'), {
    schema: 'horse-phase10-strength-attempt-v1',
    runAttempt: attempt,
    startedAt: '2026-10-04T00:00:00Z',
    finishedAt: '2026-10-04T00:20:00Z',
    exitCode: 0,
  });
  write(path.join(dir, key, 'manifest.json'), {
    schema: 'horse-phase10-strength-manifest-v1',
    mode,
    head: HEAD,
    dirty: false,
    sourceSha256: 'f'.repeat(64),
    sourceFiles: 1,
    serverLockSha256: 'e'.repeat(64),
    contractVersion: C.version,
    contractDigest: plo4StrengthContractDigest(),
    packVersion: C.candidate.packVersion,
    profileId,
    seed,
    shard,
    pairs: C.matrix.pairsPerShard,
    createdAt: '2026-10-04T00:00:00.000Z',
    ...options.manifest,
  });
  if (options.result === null) return;
  write(path.join(dir, key, `${key}.json`), {
    schema: 'horse-phase10-strength-shard-v1',
    contractVersion: C.version,
    contractDigest: plo4StrengthContractDigest(),
    packVersion: C.candidate.packVersion,
    evidenceMode: mode,
    profileId,
    seed,
    shard,
    firstPair: shard * C.matrix.pairsPerShard,
    requestedPairs: C.matrix.pairsPerShard,
    pairs: C.matrix.pairsPerShard,
    complete: true,
    positionCoverageComplete: true,
    offsetCounts: [C.matrix.pairsPerShard],
    strata: { '0|none': { n: C.matrix.pairsPerShard, s1: '0', s2: '0', s3: '0', s4: '0' } },
    pairDigest: 'a'.repeat(64),
    durationMs: 1000,
    sourceUnchanged: true,
    cancelled: false,
    ...options.result,
  });
}

async function assemble(...extra: string[]) {
  try {
    const { stdout } = await exec(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/phase10-strength-assemble.mjs',
        `--runs=${runsDir}`,
        `--repo-root=${repo}`,
        '--no-format',
        ...extra,
      ],
      { cwd: process.cwd(), timeout: RUN_TIMEOUT_MS }
    );
    return { code: 0, stdout, reasons: [] as string[] };
  } catch (error) {
    const e = error as { code?: number; stderr?: string; stdout?: string };
    let reasons: string[] = [];
    try {
      reasons = JSON.parse(e.stderr ?? '').reasons;
    } catch {
      reasons = [`unparsed:${e.stderr}`];
    }
    return { code: e.code ?? -1, stdout: e.stdout ?? '', reasons };
  }
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'phase10-strength-assemble-'));
  runsDir = path.join(root, 'runs');
  repo = path.join(root, 'repo');
  for (let i = 0; i < required.length; i++) writeAttempt(i);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('phase10-strength-assemble', () => {
  it(
    'P10.3: the Phase 10 admission reads the real assembler output and never selects a development assembly',
    async () => {
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.code).toBe(0);
      const qualificationPath = 'docs/evidence/phase10/phase10-qualification-2026-10-03.json';
      const bytes = readFileSync(path.join(repo, qualificationPath));
      const file = JSON.parse(bytes.toString('utf8'));
      expect(file.schema).toBe(HORSE_PHASE10_QUALIFICATION_SCHEMA);
      expect(file.domain).toBe(HORSE_PHASE10_DOMAIN);
      expect(file.evidencePath.startsWith(HORSE_PHASE10_EVIDENCE_DIRECTORY)).toBe(true);
      expect(qualificationPath.startsWith(HORSE_PHASE10_EVIDENCE_DIRECTORY)).toBe(true);
      const reader = { read: (relative: string) => readFileSync(path.join(repo, relative)) };
      const now = Date.parse('2026-10-04T01:00:00.000Z');
      const selectionFor = (
        qualification: Buffer,
        overrides: Partial<HorsePhase10AuthoritySelection> = {}
      ): HorsePhase10AuthoritySelection => ({
        schema: 'horse-qualified-authority-selection-v1',
        phase: 'phase10',
        sourceSha: HEAD,
        packVersion: file.packVersion,
        contractVersion: file.contractVersion,
        contractDigest: file.contractDigest,
        domain: file.domain,
        qualificationPath,
        qualificationSha256: createHash('sha256').update(qualification).digest('hex'),
        approvalGeneration: 1,
        issuedAt: '2026-10-04T00:00:00.000Z',
        expiresAt: null,
        withdrawn: null,
        ...overrides,
      });
      const digest = plo4StrengthContractDigest();
      // The assembler's own development file: refused, whatever selects it.
      expect(
        admitHorsePhase10QualifiedAuthority(selectionFor(bytes), reader, now, digest)
      ).toMatchObject({ status: 'refused', reason: 'not_qualified' });
      // Shape compatibility, in this temporary directory only (never committed):
      // the same real file relabelled as a contract-mode cash qualification is
      // read field for field, bound to its digest, source and strength record.
      const relabelled = Buffer.from(
        JSON.stringify({
          ...file,
          qualified: true,
          mode: 'contract',
          objectives: { ...file.objectives, cash: { qualified: true, status: 'measured' } },
        })
      );
      writeFileSync(path.join(repo, qualificationPath), relabelled);
      const admitted = admitHorsePhase10QualifiedAuthority(
        selectionFor(relabelled),
        reader,
        now,
        digest
      );
      expect(admitted).toMatchObject({
        status: 'admitted',
        authority: {
          phase: 'phase10',
          sourceSha: HEAD,
          contractDigest: digest,
          policyDigest: file.policyDigest,
        },
      });
      expect(
        admitHorsePhase10QualifiedAuthority(
          selectionFor(relabelled, { sourceSha: 'c'.repeat(40) }),
          reader,
          now,
          digest
        )
      ).toMatchObject({ status: 'refused', reason: 'source_mismatch' });
      writeFileSync(path.join(outDir(), 'strength.json'), '{}\n');
      expect(
        admitHorsePhase10QualifiedAuthority(selectionFor(relabelled), reader, now, digest)
      ).toMatchObject({ status: 'refused', reason: 'hash_mismatch' });
    },
    RUN_TIMEOUT_MS
  );

  it(
    'assembles a development matrix with the real verdict and never qualifies it',
    async () => {
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual([]);
      expect(outcome.code).toBe(0);
      const strength = readJson(path.join(outDir(), 'strength.json'));
      const qualification = readJson(
        path.join(repo, 'docs/evidence/phase10/phase10-qualification-2026-10-03.json')
      );
      expect(strength.schema).toBe('horse-phase10-strength-v1');
      expect(strength.contractDigest).toBe(plo4StrengthContractDigest());
      expect(strength.shards).toHaveLength(111);
      expect(strength.attempts).toHaveLength(111);
      expect(strength.source.policyDigest).toMatch(/^[0-9a-f]{64}$/);
      expect(strength.verdict.qualified).toBe(false);
      expect(strength.verdict.reasons).toContain(`${required[0].key}:not_contract_mode`);
      expect(qualification).toMatchObject({
        schema: 'horse-phase10-qualification-v1',
        qualified: false,
        mode: 'development',
        sourceSha: HEAD,
        contractVersion: C.version,
        evidencePath: 'docs/evidence/phase10/strength-2026-10-03/strength.json',
      });
      expect(qualification.objectives.tournament.status).toBe('unavailable dependency');
      expect(qualification.reasons[0]).toBe('development_mode_never_qualifies');
      expect(
        existsSync(path.join(outDir(), 'runs', `p102-${required[0].key}-a1`, 'runner.json'))
      ).toBe(true);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'counts the earliest complete attempt, records the lost one and checks the replay',
    async () => {
      const key = required[4].key;
      rmSync(path.join(runsDir, `p102-${key}-a1`), { recursive: true });
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
      rmSync(path.join(runsDir, `p102-${key}-a1`), { recursive: true });
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
      rmSync(path.join(runsDir, `p102-${required[2].key}-a1`, 'runner.json'));
      mkdirSync(path.join(runsDir, 'stray'));
      mkdirSync(path.join(runsDir, `p102-p10c-6max-2dealt-100bb-${C.holdout.seeds[0]}-s9-a1`));
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          `missing_runner_record:p102-${required[2].key}-a1`,
          'unexpected_run_directory:stray',
          `unexpected_shard:p10c-6max-2dealt-100bb-${C.holdout.seeds[0]}-s9`,
        ])
      );
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses development runs in a contract assembly and any identity or contract mismatch',
    async () => {
      const contractRun = await assemble(`--out=${outDir()}`);
      expect(contractRun.reasons).toContain(
        `not_contract_mode:p102-${required[0].key}-a1:development`
      );
      writeAttempt(1, { attempt: 1, manifest: { contractDigest: '0'.repeat(64) } });
      writeAttempt(2, { attempt: 1, manifest: { dirty: true } });
      writeAttempt(3, { attempt: 1, manifest: { sourceSha256: '1'.repeat(64) } });
      writeAttempt(5, { attempt: 1, manifest: { seed: 1 } });
      writeAttempt(6, { attempt: 1, result: { sourceUnchanged: false } });
      const outcome = await assemble(`--out=${outDir()}`, '--development');
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          `contract_mismatch:p102-${required[1].key}-a1`,
          `dirty_checkout:p102-${required[2].key}-a1`,
          'identity_mismatch:sourceSha256',
          `manifest_scope_mismatch:p102-${required[5].key}-a1`,
          `source_changed_during_run:p102-${required[6].key}-a1`,
        ])
      );
    },
    RUN_TIMEOUT_MS * 2
  );

  it(
    'refuses to overwrite evidence or write it outside the Phase 10 evidence directory',
    async () => {
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([]);
      expect((await assemble(`--out=${outDir()}`, '--development')).reasons).toEqual([
        'output_exists',
      ]);
      const outside = await assemble(
        `--out=${path.join(repo, 'docs/evidence/phase8/strength-2026-10-03')}`,
        '--development'
      );
      expect(outside.reasons).toEqual(['evidence_outside_docs/evidence/phase10/']);
    },
    RUN_TIMEOUT_MS * 3
  );
});
