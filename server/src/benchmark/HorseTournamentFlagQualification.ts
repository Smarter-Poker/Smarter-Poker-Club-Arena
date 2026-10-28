/** Fail-closed qualification custody for the separately reserved tournament cards. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  TOURNAMENT_FLAG_DESIGN,
  tournamentFlagHash,
  tournamentFlagCells,
  tournamentFlagResultValid,
  TOURNAMENT_FLAG_HOLDOUT_SEEDS,
} from './HorseTournamentFlagContract.js';
import { horseLeagueComputeResponseIsValid } from './HorseLeagueComputeWorkerClient.js';
import type { TournamentLeagueResult, TournamentLeagueRequest } from './HorseTournamentLeague.js';

export const FLAG_WORKFLOW = '.github/workflows/horse-tournament-flag-cards.yml';
export const FLAG_REPOSITORY = 'Smarter-Poker/Smarter-Poker-Club-Arena';
export interface TournamentFlagPlan {
  schema: 'horse-tournament-flag-plan-v1';
  state: 'awaiting_protected_source_lock' | 'heldout_locked';
  designDigest: string;
  runtimeSourceDigest: string | null;
  dependencyDigest: string | null;
  workflowDigest: string | null;
  baselineReferenceRevision: string;
}
export interface FlagReporter {
  repository: string;
  workflow: string;
  runId: number;
  runAttempt: number;
  jobId: number;
  workflowControlSha: string;
}
export interface FlagEnvelope {
  schema: 'horse-tournament-flag-result-v1';
  sourceSha: string;
  sourceDigest: string;
  dependencyDigest: string;
  workflowDigest: string;
  planDigest: string;
  designDigest: string;
  field: string;
  card: string;
  cell: ReturnType<typeof tournamentFlagCells>[number];
  reporter: FlagReporter;
  result: TournamentLeagueResult;
  resultDigest: string;
  originalExitCode: number;
}
const root = fileURLToPath(new URL('../../../', import.meta.url));
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
const hashBytes = (x: string | Buffer) => createHash('sha256').update(x).digest('hex');
export function tournamentFlagSourceIdentity() {
  const paths = git(
    'ls-files',
    '--cached',
    '--others',
    '--exclude-standard',
    '-z',
    'server/src',
    'server/scripts'
  )
    .split('\0')
    .filter((p) => p && !p.endsWith('/HorseTournamentFlagPlan.json'))
    .sort();
  const files = Object.fromEntries(
    paths.map((p) => [p, hashBytes(readFileSync(resolve(root, p)))])
  );
  return {
    runtimeSourceDigest: tournamentFlagHash(files),
    dependencyDigest: tournamentFlagHash({
      root: hashBytes(readFileSync(resolve(root, 'package-lock.json'))),
      server: hashBytes(readFileSync(resolve(root, 'server/package-lock.json'))),
    }),
    workflowDigest: hashBytes(readFileSync(resolve(root, FLAG_WORKFLOW))),
  };
}
export function assertTournamentFlagPlan(plan: TournamentFlagPlan) {
  if (
    plan.schema !== 'horse-tournament-flag-plan-v1' ||
    plan.state !== 'heldout_locked' ||
    plan.designDigest !== tournamentFlagHash(TOURNAMENT_FLAG_DESIGN) ||
    ![plan.runtimeSourceDigest, plan.dependencyDigest, plan.workflowDigest].every(
      (x) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)
    ) ||
    !/^[a-f0-9]{40}$/.test(plan.baselineReferenceRevision)
  )
    throw Error('Tournament flag plan is not protected-source locked');
}
export function assertTournamentFlagSource(plan: TournamentFlagPlan, sha: string) {
  assertTournamentFlagPlan(plan);
  if (
    !/^[a-f0-9]{40}$/.test(sha) ||
    git('rev-parse', 'HEAD') !== sha ||
    git('status', '--porcelain')
  )
    throw Error('Exact clean source required');
  git('merge-base', '--is-ancestor', sha, 'origin/main');
  git('merge-base', '--is-ancestor', plan.baselineReferenceRevision, sha);
  const actual = tournamentFlagSourceIdentity();
  for (const k of ['runtimeSourceDigest', 'dependencyDigest', 'workflowDigest'] as const)
    if (actual[k] !== plan[k]) throw Error(`Tournament source changed: ${k}`);
  return actual;
}
export async function tournamentFlagProvider(card: string, cellKey?: string) {
  const env = process.env;
  const id = Number(env.GITHUB_RUN_ID),
    attempt = Number(env.GITHUB_RUN_ATTEMPT);
  if (
    env.GITHUB_REPOSITORY !== FLAG_REPOSITORY ||
    env.GITHUB_REF !== 'refs/heads/main' ||
    env.GITHUB_EVENT_NAME !== 'workflow_dispatch' ||
    !Number.isSafeInteger(id) ||
    id < 1 ||
    attempt !== 1 ||
    !env.GITHUB_TOKEN
  )
    throw Error('Manual first-attempt provider admission required');
  const api = async (path: string) => {
    const r = await fetch(`https://api.github.com/repos/${FLAG_REPOSITORY}${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw Error(`Provider evidence unavailable ${r.status}`);
    return (await r.json()) as any;
  };
  const run = await api(`/actions/runs/${id}`);
  if (
    run.event !== 'workflow_dispatch' ||
    run.head_branch !== 'main' ||
    run.path !== FLAG_WORKFLOW ||
    run.run_attempt !== 1 ||
    !/^[a-f0-9]{40}$/.test(run.head_sha)
  )
    throw Error('Wrong provider workflow authority');
  if (
    hashBytes(
      execFileSync('git', ['show', `${run.head_sha}:${FLAG_WORKFLOW}`], {
        cwd: root,
        maxBuffer: 1024 * 1024,
      })
    ) !== hashBytes(readFileSync(resolve(root, FLAG_WORKFLOW)))
  )
    throw Error('Workflow control differs from locked source');
  // A fresh workflow run is not permission to reuse the reserved card seeds.
  // Keep failed/incomplete original runs visible rather than selecting a rerun.
  for (let page = 1; page <= 10; page++) {
    const previous = await api(
      `/actions/workflows/horse-tournament-flag-cards.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`
    );
    if (!Array.isArray(previous.workflow_runs)) throw Error('Unknown reservation custody');
    if (
      previous.workflow_runs.some(
        (r: any) => r.id < id && String(r.display_title).startsWith(`Tournament card ${card} at `)
      )
    )
      throw Error('Reserved card has a prior original operation');
    if (previous.workflow_runs.length < 100) break;
    if (page === 10) throw Error('Reservation history exceeds bound');
  }
  const jobs: any[] = [];
  for (let page = 1; page <= 10; page++) {
    const p = await api(`/actions/runs/${id}/attempts/1/jobs?per_page=100&page=${page}`);
    if (!Array.isArray(p.jobs)) throw Error('Unknown jobs');
    jobs.push(...p.jobs);
    if (p.jobs.length < 100) break;
    if (page === 10) throw Error('Provider jobs exceed bound');
  }
  const expected = tournamentFlagCells(card);
  const cardJobs = jobs.filter((j) => String(j.name).startsWith('Card '));
  const allowed = new Set(expected.map((c) => 'Card ' + c.key));
  if (
    cardJobs.some((j) => !allowed.has(j.name)) ||
    new Set(cardJobs.map((j) => j.name)).size !== cardJobs.length
  )
    throw Error('Foreign or duplicate card jobs');
  if (cellKey) {
    const matching = cardJobs.filter((j) => j.name === 'Card ' + cellKey);
    if (matching.length !== 1 || matching[0].status !== 'in_progress')
      throw Error('Original active card job missing');
    return {
      run,
      jobs,
      reporter: {
        repository: FLAG_REPOSITORY,
        workflow: FLAG_WORKFLOW,
        runId: id,
        runAttempt: 1,
        jobId: matching[0].id,
        workflowControlSha: run.head_sha,
      } as FlagReporter,
    };
  }
  if (
    cardJobs.length !== expected.length ||
    cardJobs.some((j) => j.status !== 'completed' || j.conclusion !== 'success')
  )
    throw Error('Incomplete or failed original card jobs');
  const response = await api(`/actions/runs/${id}/artifacts?per_page=100`);
  if (!Array.isArray(response.artifacts) || response.total_count > 100)
    throw Error('Unknown artifact inventory');
  const artifacts = response.artifacts.filter((a: any) =>
    String(a.name).startsWith(`tfc-${card}-`)
  );
  if (
    artifacts.length !== expected.length ||
    new Set(artifacts.map((a: any) => a.name)).size !== expected.length ||
    artifacts.some(
      (a: any) =>
        a.expired ||
        !/^sha256:[a-f0-9]{64}$/.test(a.digest) ||
        a.workflow_run?.id !== id ||
        a.workflow_run?.head_sha !== run.head_sha ||
        !expected.some((c) => a.name === `tfc-${c.key}-a1`)
    )
  )
    throw Error('Original artifact inventory differs');
  return { run, jobs, artifacts, reporter: null };
}
/** Recompute scientific values from each original pair; no pooled cross-card rescue. */
export function assembleTournamentFlag(
  plan: TournamentFlagPlan,
  sourceSha: string,
  card: string,
  envelopes: FlagEnvelope[],
  provider: { run: any; jobs: any[]; artifacts: any[] }
) {
  assertTournamentFlagPlan(plan);
  if (
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    provider.run.event !== 'workflow_dispatch' ||
    provider.run.head_branch !== 'main' ||
    provider.run.path !== FLAG_WORKFLOW ||
    provider.run.run_attempt !== 1
  )
    throw Error('Original provider authority required');
  const expected = tournamentFlagCells(card),
    reasons: string[] = [];
  const byKey = new Map<string, FlagEnvelope>();
  for (const e of envelopes) {
    if (!e || e.schema !== 'horse-tournament-flag-result-v1' || !e.cell || byKey.has(e.cell.key)) {
      reasons.push('duplicate_or_malformed_envelope');
      continue;
    }
    byKey.set(e.cell.key, e);
    const cell = expected.find((c) => c.key === e.cell.key),
      j = provider.jobs.find((j) => j.id === e.reporter?.jobId);
    if (
      !cell ||
      tournamentFlagHash(cell) !== tournamentFlagHash(e.cell) ||
      e.card !== card ||
      e.sourceSha !== sourceSha ||
      e.sourceDigest !== plan.runtimeSourceDigest ||
      e.dependencyDigest !== plan.dependencyDigest ||
      e.workflowDigest !== plan.workflowDigest ||
      e.planDigest !== tournamentFlagHash(plan) ||
      e.designDigest !== plan.designDigest ||
      e.field !== TOURNAMENT_FLAG_DESIGN.field
    )
      reasons.push('source_field_or_plan_mismatch');
    if (
      !e.reporter ||
      e.reporter.repository !== FLAG_REPOSITORY ||
      e.reporter.workflow !== FLAG_WORKFLOW ||
      e.reporter.runId !== provider.run.id ||
      e.reporter.runAttempt !== 1 ||
      e.reporter.workflowControlSha !== provider.run.head_sha ||
      !j ||
      j.name !== 'Card ' + e.cell.key ||
      j.status !== 'completed' ||
      j.conclusion !== 'success'
    )
      reasons.push('reporter_mismatch');
    const artifact = provider.artifacts.filter((a) => a.name === `tfc-${e.cell.key}-a1`);
    if (
      artifact.length !== 1 ||
      artifact[0].expired ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact[0].digest) ||
      artifact[0].workflow_run?.id !== provider.run.id ||
      artifact[0].workflow_run?.head_sha !== provider.run.head_sha
    )
      reasons.push('artifact_origin_mismatch');
    const r = e.result;
    if (
      !r ||
      !horseLeagueComputeResponseIsValid({ type: 'TOURNAMENT_RESULT', jobId: 1, result: r }) ||
      !tournamentFlagResultValid(r) ||
      r.flagCard !== card ||
      r.seed !== e.cell.seed ||
      r.firstPair !== e.cell.firstPair ||
      r.requestedPairs !== e.cell.pairs ||
      r.pairs !== e.cell.pairs ||
      !r.complete ||
      r.opponentPopulation !== e.field ||
      r.illegalActions !== 0 ||
      r.conservationErrors !== 0 ||
      r.truncatedHands !== 0 ||
      e.originalExitCode !== 0 ||
      e.resultDigest !== tournamentFlagHash(r)
    )
      reasons.push('invalid_original_result');
  }
  if (byKey.size !== expected.length || expected.some((c) => !byKey.has(c.key)))
    reasons.push('missing_or_foreign_partition');
  if (reasons.length)
    return { measured: false, wins: false, reasons: [...new Set(reasons)], activation: false };
  const statistic = (values: number[]) => {
    const n = values.length,
      mean = values.reduce((a, b) => a + b, 0) / n,
      se = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1) / n);
    return {
      pairs: n,
      mean,
      standardError: se,
      confidence99: [mean - 2.59 * se, mean + 2.59 * se],
    };
  };
  const seeds = TOURNAMENT_FLAG_HOLDOUT_SEEDS.map((seed) => ({
    seed,
    ...statistic(
      expected
        .filter((c) => c.seed === seed)
        .flatMap((c) => byKey.get(c.key)!.result.cardPairs!.map((p) => p.candidate - p.reference))
    ),
  }));
  const pooled = statistic(
    expected.flatMap((c) =>
      byKey.get(c.key)!.result.cardPairs!.map((p) => p.candidate - p.reference)
    )
  );
  const changed = envelopes.reduce((n, e) => n + e.result.cardChanged!, 0);
  if (changed < 1) reasons.push('inert');
  if (!seeds.every((s) => s.mean > 0)) reasons.push('nonpositive_seed');
  if (!(pooled.confidence99[0] > 0)) reasons.push('nonpositive_pooled_lower_bound');
  return {
    measured: true,
    wins: reasons.length === 0,
    reasons,
    seeds,
    pooled,
    changed,
    activation: false,
    scope: 'declared six-seat standard MTT/SNG model only; no universal horse certificate',
  };
}

/** Runs inside the actual compute process before dealing, never trusts request metadata. */
export async function authenticateTournamentFlagExecution(request: TournamentLeagueRequest) {
  const admission = request.flagQualification;
  if (!admission || !request.flagCard) throw Error('Missing protected admission');
  const plan = JSON.parse(
    readFileSync(resolve(root, 'server/src/benchmark/HorseTournamentFlagPlan.json'), 'utf8')
  ) as TournamentFlagPlan;
  assertTournamentFlagSource(plan, admission.sourceSha);
  if (admission.planDigest !== tournamentFlagHash(plan)) throw Error('Wrong protected plan');
  const cell = tournamentFlagCells(request.flagCard).find(
    (c) =>
      c.seed === request.seed &&
      c.firstPair === (request.firstPair ?? 0) &&
      c.pairs === request.pairs
  );
  if (!cell) throw Error('Unknown protected cell');
  const provider = await tournamentFlagProvider(request.flagCard, cell.key);
  if (
    !provider.reporter ||
    provider.reporter.runId !== admission.providerRunId ||
    provider.reporter.jobId !== admission.providerJobId ||
    provider.reporter.runAttempt !== admission.runAttempt
  )
    throw Error('Supplied admission does not match actual provider');
}
export function verifyTournamentFlagArchive(bytes: Buffer, digest: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest) || 'sha256:' + hashBytes(bytes) !== digest)
    throw Error('Original artifact archive digest mismatch');
}
