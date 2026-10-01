/**
 * P8.2 strength assembler (server/scripts/phase8-strength-assemble.mjs).
 *
 * Every synthetic run here is FIXTURE mode, so it can never qualify: the
 * assembler refuses fixture runs in a promotion assembly, and a fixture
 * assembly always writes `qualified: false`. The script runs as its own tsx
 * process, the way the evidence is produced, so the verdict it records comes
 * from the real league contract it imports.
 */
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  pairedConfidence99,
  summarizeTournamentPromotion,
  tournamentBaselineRunVerified,
  tournamentLeagueEntrants,
  tournamentRunCanPromote,
  TOURNAMENT_LEAGUE_OBJECTIVES,
  TOURNAMENT_PROMOTION_PAIRS,
  TOURNAMENT_PROMOTION_SEEDS,
  type TournamentLeagueObjective,
  type TournamentLeagueResult,
} from './HorseTournamentLeague.js';
import { PHASE8_POLICY } from '../engine/HorseTournamentPostflop.js';
import {
  admitHorseQualifiedAuthority,
  horsePhase8PolicyDigest,
  HORSE_PHASE8_DOMAIN,
} from '../engine/HorseQualifiedAuthority.js';
import { memoryReader, testSelection } from '../engine/HorseQualifiedAuthority.test-support.js';

const exec = promisify(execFile);
const HEAD = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const RUN_TIMEOUT_MS = 60_000;
const write = (file: string, value: unknown) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
};
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8'));
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

function fixtureResult(objective: TournamentLeagueObjective, seed: number): TournamentLeagueResult {
  const entrants = tournamentLeagueEntrants(objective);
  const finish = Array.from({ length: entrants }, (_, i) =>
    i === 0 ? TOURNAMENT_PROMOTION_PAIRS : 0
  );
  const result: TournamentLeagueResult = {
    completionSchemaVersion: 1,
    completed: 5,
    completionRefusals: { continuation_operation_budget: 5 },
    completionDiagnostics: [],
    completionDiagnosticsDropped: 0,
    version: PHASE8_POLICY.version,
    candidateMode: 'candidate',
    evidenceMode: 'fixture',
    objective,
    entrants,
    seed,
    requestedPairs: TOURNAMENT_PROMOTION_PAIRS,
    pairs: TOURNAMENT_PROMOTION_PAIRS,
    complete: true,
    primaryMetric: objective === 'satellite' ? 'seat_attainment' : 'funded_pool_return',
    meanDifference: 0,
    standardError: 0,
    confidence99: pairedConfidence99(0, 0, TOURNAMENT_PROMOTION_PAIRS),
    candidateReturn: 0.1,
    baselineReturn: 0.1,
    chipDifference: 0,
    bountyDifference: 0,
    candidateBustRate: 0,
    baselineBustRate: 0,
    candidateFinish: finish,
    baselineFinish: [...finish],
    decisions: 100,
    eligible: 10,
    fired: 5,
    changed: 1,
    illegalActions: 0,
    conservationErrors: 0,
    truncatedHands: 0,
    candidateDeepOnePairCommitments: 0,
    baselineDeepOnePairCommitments: 0,
    preventedCommitments: 0,
    budgetExhaustions: 5,
    referenceRegret: 0,
    reference: 'phase7_action_utility_not_external_solver',
    latencyMs: { p50: 1, p95: 2, p99: 3, max: 3 },
    durationMs: 1000,
    promotionEligible: false,
  };
  result.promotionEligible = tournamentRunCanPromote(result);
  return result;
}

/** One directory per run, exactly as horseTournamentEvaluate.ts writes them. */
function writeRun(runsDir: string, objective: TournamentLeagueObjective, seed: number) {
  const dir = path.join(runsDir, `${objective}-${seed}`);
  const result = fixtureResult(objective, seed);
  write(path.join(dir, 'manifest.json'), {
    mode: 'fixture',
    head: HEAD,
    dirty: false,
    trackedDiffSha256: sha256(''),
    sourceSha256: 'f'.repeat(64),
    sourceFiles: 1,
    serverLockSha256: 'e'.repeat(64),
    solverStores: { charts: 240, postflop: 7747, postflopV31: 0, postflopV31Dataset: null },
    seeds: [seed],
    pairs: TOURNAMENT_PROMOTION_PAIRS,
    objectives: [objective],
    requiredMatrix: {
      seeds: TOURNAMENT_PROMOTION_SEEDS,
      objectives: TOURNAMENT_LEAGUE_OBJECTIVES,
      pairs: TOURNAMENT_PROMOTION_PAIRS,
    },
    activation: 'never',
    equityGovernor: 'off_in_isolated_compute_process',
    createdAt: '2026-10-01T00:00:00.000Z',
  });
  write(path.join(dir, `${objective}-${seed}.json`), result);
  write(path.join(dir, 'summary.json'), summarizeTournamentPromotion([result]));
  write(path.join(dir, 'baseline-verification.json'), {
    version: result.version,
    complete: false,
    scope: 'software_baseline_not_strength_promotion',
    sourceUnchanged: true,
    runs: [
      {
        objective,
        seed,
        verified: tournamentBaselineRunVerified(result),
        eligible: result.eligible,
        fired: result.fired,
        budgetExhaustions: result.budgetExhaustions,
        p99: result.latencyMs.p99,
      },
    ],
  });
}

let root: string;
let runsDir: string;
let hostsFile: string;
let repo: string;
const outDir = (date = '2026-10-02') => path.join(repo, 'docs/evidence/phase8', `strength-${date}`);

async function assemble(...extra: string[]) {
  try {
    const { stdout } = await exec(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/phase8-strength-assemble.mjs',
        `--runs=${runsDir}`,
        `--hosts=${hostsFile}`,
        `--repo-root=${repo}`,
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
  root = mkdtempSync(path.join(tmpdir(), 'phase8-strength-assemble-'));
  runsDir = path.join(root, 'runs');
  repo = path.join(root, 'repo');
  hostsFile = path.join(root, 'hosts.json');
  const runs: Record<string, string> = {};
  for (const seed of TOURNAMENT_PROMOTION_SEEDS)
    for (const objective of TOURNAMENT_LEAGUE_OBJECTIVES) {
      writeRun(runsDir, objective, seed);
      runs[`${objective}-${seed}`] = 'fixture-host';
    }
  write(hostsFile, { hosts: { 'fixture-host': { label: 'F' } }, runs });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('phase8-strength-assemble', () => {
  it(
    'assembles a complete fixture matrix deterministically and it can never qualify',
    async () => {
      const first = await assemble(`--out=${outDir()}`, '--fixture');
      expect(first.reasons).toEqual([]);
      expect(first.code).toBe(0);
      const strengthBytes = readFileSync(path.join(outDir(), 'strength.json'));
      const strength = JSON.parse(strengthBytes.toString('utf8'));
      expect(strength.mode).toBe('fixture');
      expect(strength.runs).toHaveLength(18);
      expect(strength.runs.map((r: { run: string }) => r.run)).toEqual(
        TOURNAMENT_PROMOTION_SEEDS.flatMap((s) =>
          TOURNAMENT_LEAGUE_OBJECTIVES.map((o) => `${o}-${s}`)
        )
      );
      // The real contract decided: fixture runs are never promotable.
      expect(strength.verdict.promoted).toBe(false);
      expect(strength.verdict.reasons).toContain('mtt:8101101:not_promotable');
      for (const r of strength.runs) {
        const source = readFileSync(path.join(runsDir, r.run, `${r.run}.json`));
        expect(readFileSync(path.join(outDir(), 'runs', `${r.run}.json`)).equals(source)).toBe(
          true
        );
        expect(r.resultSha256).toBe(sha256(source));
        expect(r.host).toBe('fixture-host');
      }

      const qualificationFile = path.join(
        repo,
        'docs/evidence/phase8/phase8-qualification-2026-10-02.json'
      );
      const qualificationBytes = readFileSync(qualificationFile);
      const qualification = JSON.parse(qualificationBytes.toString('utf8'));
      expect(qualification).toMatchObject({
        schema: 'horse-phase8-qualification-v1',
        qualified: false,
        mode: 'fixture',
        sourceSha: HEAD,
        continuationVersion: PHASE8_POLICY.version,
        packId: 'horse-tournament-postflop',
        domain: HORSE_PHASE8_DOMAIN,
        policyDigest: horsePhase8PolicyDigest(),
        evidencePath: 'docs/evidence/phase8/strength-2026-10-02/strength.json',
        evidenceSha256: sha256(strengthBytes),
      });
      expect(qualification.reasons[0]).toBe('fixture_mode_never_qualifies');

      // The authority admits only qualified evidence; this file is refused.
      const evidencePath = 'docs/evidence/phase8/phase8-qualification-2026-10-02.json';
      const admission = admitHorseQualifiedAuthority(
        testSelection(qualificationBytes, { sourceSha: HEAD, evidencePath }),
        memoryReader({ [evidencePath]: qualificationBytes }),
        Date.parse('2026-10-02T00:00:00.000Z')
      );
      expect(admission).toMatchObject({ status: 'refused', reason: 'evidence_mismatch' });

      // Same inputs, byte-identical record.
      const second = await assemble(`--out=${outDir('2026-10-03')}`, '--fixture');
      expect(second.code).toBe(0);
      expect(
        readFileSync(path.join(outDir('2026-10-03'), 'strength.json')).equals(strengthBytes)
      ).toBe(true);
      // An existing record is never overwritten.
      const again = await assemble(`--out=${outDir()}`, '--fixture');
      expect(again.code).toBe(2);
      expect(again.reasons).toContain('output_exists');
    },
    RUN_TIMEOUT_MS * 3
  );

  it(
    'refuses fixture runs in a promotion assembly',
    async () => {
      const outcome = await assemble(`--out=${outDir()}`);
      expect(outcome.code).toBe(2);
      expect(outcome.reasons.filter((r) => r.startsWith('not_promotion_mode:'))).toHaveLength(18);
      expect(existsSync(outDir())).toBe(false);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses an incomplete matrix by name and writes nothing',
    async () => {
      rmSync(path.join(runsDir, 'mystery-8103307', 'mystery-8103307.json'));
      rmSync(path.join(runsDir, 'pko-8102203'), { recursive: true });
      rmSync(path.join(runsDir, 'spin-8101101', 'summary.json'));
      const outcome = await assemble(`--out=${outDir()}`, '--fixture');
      expect(outcome.code).toBe(2);
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          'missing_result:mystery-8103307',
          'missing_run:pko-8102203',
          'missing_receipt:spin-8101101:summary.json',
        ])
      );
      expect(existsSync(outDir())).toBe(false);
      expect(
        existsSync(path.join(repo, 'docs/evidence/phase8/phase8-qualification-2026-10-02.json'))
      ).toBe(false);
    },
    RUN_TIMEOUT_MS
  );

  it(
    'keeps a run that stopped short of its requested pairs as an unpromotable result',
    async () => {
      const file = path.join(runsDir, 'mystery-8101101', 'mystery-8101101.json');
      const stopped = {
        ...readJson(file),
        pairs: 212,
        complete: false,
        conservationErrors: 2,
        confidence99: pairedConfidence99(0, 0, 212),
      };
      stopped.promotionEligible = tournamentRunCanPromote(stopped);
      write(file, stopped);
      write(
        path.join(runsDir, 'mystery-8101101', 'summary.json'),
        summarizeTournamentPromotion([stopped])
      );
      const baselineFile = path.join(runsDir, 'mystery-8101101', 'baseline-verification.json');
      const baseline = readJson(baselineFile);
      baseline.runs[0].verified = tournamentBaselineRunVerified(stopped);
      write(baselineFile, baseline);
      const outcome = await assemble(`--out=${outDir()}`, '--fixture');
      expect(outcome.reasons).toEqual([]);
      const strength = readJson(path.join(outDir(), 'strength.json'));
      const run = strength.runs.find((r: { run: string }) => r.run === 'mystery-8101101');
      expect(run).toMatchObject({
        pairs: 212,
        requestedPairs: 1024,
        pairsShortOfRequest: 812,
        complete: false,
        conservationErrors: 2,
        promotable: false,
      });
      expect(strength.verdict.promoted).toBe(false);
      expect(strength.verdict.reasons).toContain('mystery:8101101:not_promotable');
    },
    RUN_TIMEOUT_MS
  );

  it(
    'refuses duplicate, mixed-source, shrunk and unhosted runs',
    async () => {
      // A second directory and a result that claims another run's identity.
      writeRun(path.join(root, 'extra'), 'mtt', 8101101);
      execFileSync('cp', [
        '-R',
        path.join(root, 'extra', 'mtt-8101101'),
        path.join(runsDir, 'mtt-8101101-copy'),
      ]);
      const sng = path.join(runsDir, 'sng-8101101', 'sng-8101101.json');
      write(sng, { ...readJson(sng), objective: 'mtt' });
      // A different source head on a later run.
      const manifest = path.join(runsDir, 'pko-8103307', 'manifest.json');
      write(manifest, { ...readJson(manifest), head: '0'.repeat(40) });
      // A shrunk contract: the run asked for fewer pairs than 1,024.
      const shrunk = path.join(runsDir, 'spin-8102203', 'manifest.json');
      write(shrunk, { ...readJson(shrunk), pairs: 512 });
      // No host record.
      const hosts = readJson(hostsFile);
      delete hosts.runs['satellite-8103307'];
      write(hostsFile, hosts);
      const outcome = await assemble(`--out=${outDir()}`, '--fixture');
      expect(outcome.code).toBe(2);
      expect(outcome.reasons).toEqual(
        expect.arrayContaining([
          'unexpected_run_directory:mtt-8101101-copy',
          'result_identity_mismatch:sng-8101101:mtt-8101101',
          'duplicate_run:mtt-8101101',
          'identity_mismatch:head',
          'pairs_below_contract:spin-8102203:manifest=512',
          'missing_host_record:satellite-8103307',
        ])
      );
      expect(existsSync(outDir())).toBe(false);
    },
    RUN_TIMEOUT_MS
  );
});
