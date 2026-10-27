/** Separate future-plan admission. Empty registry means no heldout authority.
 * Stress populations are not calibrated human evidence. No seeds are dealt here. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FeatureAblationQualificationPlan } from './FeatureAblationQualification.js';
import {
  isIncrementalTarget,
  incrementalDevelopmentDesign,
  incrementalDevelopmentSpec,
  incrementalDevelopmentProfiles,
  incrementalHistoryVersion,
  type IncrementalTarget,
} from './IncrementalPressureDevelopment.js';
export const isIncrementalQualificationTarget = isIncrementalTarget;
export const INCREMENTAL_PLAN_PATH =
  'server/src/benchmark/IncrementalPressureQualificationPlans.json';
export const INCREMENTAL_FAMILY_PATH =
  'server/src/benchmark/IncrementalPressureQualificationFamilies.json';
export const TOURNAMENT_RESERVED_HOLDOUT_SEEDS = Object.freeze([53901101, 53902203, 53903307]);
const COUNTERS: Record<Exclude<IncrementalTarget, 'pressure_package'>, string> = {
  combo_draw_pressure: 'combo_draw_pressure_accepted',
  targeted_river_bluff: 'targeted_river_bluff_accepted',
  river_position_defense: 'river_position_defense_accepted',
  river_bluff_checkraise: 'river_bluff_checkraise_accepted',
  barrel_continuation_outlook: 'barrel_continuation_outlook_accepted',
};
export function incrementalComponentCoverage(target: IncrementalTarget, seats: number) {
  const targets =
    target === 'pressure_package' ? (Object.keys(COUNTERS) as (keyof typeof COUNTERS)[]) : [target];
  return targets.map((component) => ({
    component,
    applicable: component !== 'river_bluff_checkraise' || seats === 2,
    counter: COUNTERS[component],
  }));
}
export function incrementalQualificationRules(target: IncrementalTarget) {
  const design = incrementalDevelopmentDesign(target);
  const profile = incrementalDevelopmentProfiles(target, 'plo4')[0];
  const spec = incrementalDevelopmentSpec(target, 'plo4', profile.id, {
    id: 'identity-only',
    decide: () => {
      throw Error('Identity only');
    },
  });
  return {
    flags: { candidate: spec.candidate, reference: spec.reference },
    population: spec.population!,
    warmSeed: design.warmSeed,
    seeds: design.reservedHoldoutSeeds,
    historyVersion: incrementalHistoryVersion(target),
    shapes:
      target === 'river_bluff_checkraise'
        ? ['2:100']
        : ['2:100', '4:100', '6:40', '6:100', '6:200'],
    validate(plan: FeatureAblationQualificationPlan): string[] {
      const reasons: string[] = [];
      if (
        plan.profiles.some(
          (p) =>
            !incrementalDevelopmentProfiles(target, p.variant).some(
              (x) => x.id === p.id && x.seats === p.seats && x.stackBB === p.stackBB
            )
        )
      )
        reasons.push('incremental_physical_profile');
      const required = [
        'IncrementalPressureQualification.ts',
        'IncrementalPressureDevelopment.ts',
        'FeatureAblationHistory.ts',
        'FeatureAblationWorker.ts',
      ].map((x) => 'src/benchmark/' + x);
      if (!required.every((p) => /^[0-9a-f]{64}$/.test(plan.runtimeSourceFiles?.[p] ?? '')))
        reasons.push('incremental_source_closure');
      for (const profile of plan.profiles) {
        const expected = incrementalComponentCoverage(target, profile.seats)
          .filter((c) => c.applicable)
          .map((c) => c.counter)
          .sort();
        const actual = plan.coverage?.byProfile?.[profile.id]?.evaluationCounterMinimums;
        if (
          !actual ||
          JSON.stringify(Object.keys(actual).sort()) !== JSON.stringify(expected) ||
          Object.values(actual).some((n) => !Number.isSafeInteger(n) || n <= 0)
        )
          reasons.push('incremental_component_coverage:' + profile.id);
      }
      return reasons;
    },
  };
}
export function assertIncrementalWorkerFlags(
  target: IncrementalTarget,
  input: Record<string, unknown>
) {
  const rules = incrementalQualificationRules(target);
  const actual = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  const matches = (expected: Record<string, boolean>) =>
    Object.keys(actual).length === Object.keys(expected).length &&
    Object.entries(expected).every(([k, v]) => actual[k] === v);
  if (!matches(rules.flags.candidate) && !matches(rules.flags.reference))
    throw Error('Incremental actual worker flag contrast changed');
}
export function assertIncrementalPlanProvenance(
  operation: unknown,
  prs: unknown,
  commit: string,
  run: string
) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation))
    throw Error('Incremental provider shape');
  const o = operation as Record<string, unknown>;
  if (
    String(o.id) !== run ||
    o.path !== '.github/workflows/horse-feature-ablation-qualification.yml' ||
    o.event !== 'workflow_dispatch' ||
    o.head_branch !== 'main' ||
    !/^[0-9a-f]{40}$/.test(String(o.head_sha)) ||
    !Number.isFinite(Date.parse(String(o.created_at))) ||
    !Array.isArray(prs) ||
    !prs.some(
      (p) =>
        p &&
        typeof p === 'object' &&
        p.merged_at &&
        p.merge_commit_sha === commit &&
        p.base?.ref === 'main' &&
        p.base?.repo?.full_name === 'Smarter-Poker/Smarter-Poker-Club-Arena' &&
        Date.parse(p.merged_at) < Date.parse(String(o.created_at))
    )
  )
    throw Error('Incremental plan was not independently protected before operation');
  return o;
}
export function incrementalSeedFamily(target: IncrementalTarget): string {
  return target === 'pressure_package' || target === 'barrel_continuation_outlook' ? '284' : '283';
}
const digest = (value: unknown): string => {
  const canonical = (v: any): string =>
    Array.isArray(v)
      ? '[' + v.map(canonical).join(',') + ']'
      : v && typeof v === 'object'
        ? '{' +
          Object.keys(v)
            .sort()
            .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
            .join(',') +
          '}'
        : JSON.stringify(v);
  return createHash('sha256').update(canonical(value)).digest('hex');
};
/** A separately protected, immutable joint CRN family fixes every intended
 * target's complete plan before the first member exposes any shared deal. */
export function validateIncrementalFamily(
  plan: FeatureAblationQualificationPlan,
  registry: any,
  families: any
) {
  if (!isIncrementalTarget(plan.target)) throw Error('Incremental family target');
  const family = families?.[incrementalSeedFamily(plan.target)];
  if (
    !family ||
    family.schema !== 'horse-incremental-crn-family-v1' ||
    Object.keys(family).sort().join(',') !== 'members,runtimeSourceDigest,schema' ||
    family.runtimeSourceDigest !== plan.runtimeSourceDigest ||
    !Array.isArray(family.members) ||
    !family.members.length ||
    family.members.length > 4 ||
    new Set(family.members.map((m: any) => m.target)).size !== family.members.length
  )
    throw Error('Incremental family is not locked');
  for (const member of family.members) {
    const p = registry?.[member.target];
    if (
      !member ||
      Object.keys(member).sort().join(',') !== 'planDigest,target' ||
      !isIncrementalTarget(member.target) ||
      incrementalSeedFamily(member.target) !== incrementalSeedFamily(plan.target) ||
      !p ||
      p.runtimeSourceDigest !== family.runtimeSourceDigest ||
      member.planDigest !== digest(p)
    )
      throw Error('Incremental family member changed');
  }
  if (!family.members.some((m: any) => m.target === plan.target && m.planDigest === digest(plan)))
    throw Error('Incremental family omits target');
  return family;
}
/** Complete provider inventory, never current-run-only. A fresh dispatch is
 * not a recovery. Same-family targets must belong to the original joint plan. */
export function assertIncrementalFamilyRuns(
  runs: any[],
  operation: Record<string, unknown>,
  target: IncrementalTarget,
  source: string,
  family: ReturnType<typeof validateIncrementalFamily>
) {
  if (
    !Array.isArray(runs) ||
    !runs.length ||
    runs.length > 1000 ||
    new Set(runs.map((r) => String(r?.id))).size !== runs.length ||
    !runs.some((r) => String(r.id) === String(operation.id))
  )
    throw Error('Incremental inventory incomplete');
  const prior: { run: any; source: string }[] = [];
  for (const run of runs) {
    if (
      run.path !== '.github/workflows/horse-feature-ablation-qualification.yml' ||
      run.event !== 'workflow_dispatch' ||
      run.head_branch !== 'main' ||
      !Number.isFinite(Date.parse(run.created_at)) ||
      !/^[0-9a-f]{40}$/.test(run.head_sha)
    )
      throw Error('Incremental prior operation unknown');
    const title = /^Held-out ([a-z0-9_]+) at ([0-9a-f]{40})$/.exec(run.display_title ?? '');
    if (
      !title ||
      (!isIncrementalTarget(title[1]) && !['plo6_v24', 'v53_pressure'].includes(title[1]))
    )
      throw Error('Incremental prior partition unknown');
    if (String(run.id) === String(operation.id)) {
      if (title[1] !== target || title[2] !== source)
        throw Error('Incremental current partition changed');
      continue;
    }
    if (
      !isIncrementalTarget(title[1]) ||
      incrementalSeedFamily(title[1]) !== incrementalSeedFamily(target)
    )
      continue;
    // Provider queue order is not guaranteed. A later-created operation must
    // refuse the earlier reservation at its own admission; it cannot replace
    // the original. Equal timestamps provide no ordering and refuse both.
    if (Date.parse(run.created_at) === Date.parse(String(operation.created_at)))
      throw Error('Incremental reservation ordering ambiguous');
    if (Date.parse(run.created_at) > Date.parse(String(operation.created_at))) continue;
    if (title[1] === target) throw Error('Incremental partition already reserved by original run');
    if (title[2] !== source || !family.members.some((m: any) => m.target === title[1]))
      throw Error('Incremental exposed family source or membership changed');
    prior.push({ run, source: title[2] });
  }
  return prior;
}
/** Recovery only for the original operation and cells with affirmative
 * provider evidence that evaluation never started. Failed/unknown starts burn
 * the partition; no replacement run or result-dependent replay is admitted. */
export function assertIncrementalUnconsumedRecovery(jobs: any[], attempt: number, cell?: string) {
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > 10)
    throw Error('Incremental attempt unknown');
  if (attempt === 1) return;
  if (!Array.isArray(jobs)) throw Error('Incremental recovery custody missing');
  for (let a = 1; a < attempt; a++) {
    const prior = jobs.filter(
      (j) => j.run_attempt === a && typeof j.name === 'string' && j.name.startsWith('Cell ')
    );
    if (!prior.length || (cell && !prior.some((j) => j.name === 'Cell ' + cell)))
      throw Error('Incremental recovery partition unknown');
    for (const job of prior.filter((j) => !cell || j.name === 'Cell ' + cell)) {
      const step = job.steps?.find(
        (s: any) => s.name === 'Execute the one registered cell without retry'
      );
      if (
        job.status !== 'completed' ||
        !step ||
        step.status !== 'completed' ||
        step.conclusion !== 'skipped' ||
        (step.started_at && !step.started_at.startsWith('0001-'))
      )
        throw Error('Incremental recovery would replay exposed partition');
    }
  }
}
/** Actual provider/PR provenance, not a caller's JSON approval. Must complete
 * before warm histories or contract deals. Existing v1 admission is untouched. */
export async function authenticateIncrementalPlan(
  plan: FeatureAblationQualificationPlan,
  cell?: string,
  assembling = false
) {
  if (!isIncrementalTarget(plan.target)) return;
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))
  );
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, env, encoding: 'utf8' }).trim();
  const repo = process.env.GITHUB_REPOSITORY,
    run = process.env.GITHUB_RUN_ID,
    token = process.env.GITHUB_TOKEN;
  if (
    repo !== 'Smarter-Poker/Smarter-Poker-Club-Arena' ||
    !/^\d+$/.test(run ?? '') ||
    !token ||
    process.env.GITHUB_REF !== 'refs/heads/main' ||
    process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  )
    throw Error('Incremental protected provider unavailable');
  const head = git('rev-parse', 'HEAD');
  if (git('status', '--porcelain', '--untracked-files=no')) throw Error('Incremental source dirty');
  git('merge-base', '--is-ancestor', head, 'origin/main');
  // Authenticate the most recent registry bytes, not its initially empty introduction.
  const commit = git('log', '-1', '--format=%H', '--', INCREMENTAL_PLAN_PATH);
  const bytes = readFileSync(
    fileURLToPath(new URL('./IncrementalPressureQualificationPlans.json', import.meta.url)),
    'utf8'
  );
  if (
    git('show', `${commit}:${INCREMENTAL_PLAN_PATH}`) !== bytes.trim() ||
    JSON.stringify(JSON.parse(bytes)[plan.target]) !== JSON.stringify(plan)
  )
    throw Error('Incremental plan bytes changed');
  const registry = JSON.parse(bytes);
  const familyBytes = readFileSync(
    fileURLToPath(new URL('./IncrementalPressureQualificationFamilies.json', import.meta.url)),
    'utf8'
  );
  const family = validateIncrementalFamily(plan, registry, JSON.parse(familyBytes));
  const { validateLockedFeatureAblationPlan } = await import('./FeatureAblationQualification.js');
  for (const member of family.members)
    if (validateLockedFeatureAblationPlan(registry[member.target]).length)
      throw Error('Incremental family member plan invalid');
  const familyCommit = git('log', '-1', '--format=%H', '--', INCREMENTAL_FAMILY_PATH);
  if (git('show', `${familyCommit}:${INCREMENTAL_FAMILY_PATH}`) !== familyBytes.trim())
    throw Error('Incremental family bytes changed');
  const get = async (suffix: string) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error('Incremental provider provenance unavailable');
    const value: unknown = await response.json();
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      // The commit-to-PR endpoint alone returns an array.
      if (suffix.endsWith('/pulls') && Array.isArray(value)) return value as any;
      throw Error('Incremental provider shape unavailable');
    }
    return value as Record<string, any>;
  };
  const [operationValue, prs] = await Promise.all([
    get(`/actions/runs/${run}`),
    get(`/commits/${commit}/pulls`),
  ]);
  const operation = assertIncrementalPlanProvenance(operationValue, prs, commit, run!);
  const familyPrs = await get(`/commits/${familyCommit}/pulls`);
  assertIncrementalPlanProvenance(operationValue, familyPrs, familyCommit, run!);
  const controlPaths = [
    '.github/workflows/horse-feature-ablation-qualification.yml',
    'server/scripts/feature-ablation-assemble.mjs',
    'server/scripts/feature-ablation-artifact-custody.mjs',
    'server/src/benchmark/IncrementalPressureQualification.ts',
  ];
  const runs: any[] = [];
  let total: number | undefined;
  for (let page = 1; page <= 10; page++) {
    const result = await get(
      `/actions/workflows/horse-feature-ablation-qualification.yml/runs?per_page=100&page=${page}`
    );
    if (
      !Array.isArray(result.workflow_runs) ||
      !Number.isSafeInteger(result.total_count) ||
      result.total_count > 1000 ||
      (total !== undefined && total !== result.total_count)
    )
      throw Error('Incremental inventory unreadable or changed');
    total = result.total_count;
    runs.push(...result.workflow_runs);
    if (runs.length === total) break;
  }
  if (runs.length !== total) throw Error('Incremental inventory page bound');
  const prior = assertIncrementalFamilyRuns(
    runs,
    operation,
    plan.target as IncrementalTarget,
    head,
    family
  );
  for (const previous of prior) {
    if (
      git('show', `${previous.source}:${INCREMENTAL_FAMILY_PATH}`) !== familyBytes.trim() ||
      git('show', `${previous.source}:${INCREMENTAL_PLAN_PATH}`) !== bytes.trim()
    )
      throw Error('Incremental original family binding changed');
    // Retain and authenticate original operation identity; failed outcomes are
    // not omitted or replaced by a newer run. Missing custody refuses admission.
    const original = await get(`/actions/runs/${previous.run.id}`);
    if (
      original.id !== previous.run.id ||
      original.head_sha !== previous.run.head_sha ||
      original.display_title !== previous.run.display_title ||
      original.status !== 'completed'
    )
      throw Error('Incremental prior outcome unavailable');
    assertIncrementalPlanProvenance(original, prs, commit, String(original.id));
    assertIncrementalPlanProvenance(original, familyPrs, familyCommit, String(original.id));
    for (const path of controlPaths)
      if (git('show', `${original.head_sha}:${path}`) !== git('show', `${head}:${path}`))
        throw Error('Incremental original operation control changed');
    previous.run = original;
  }
  const attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  if (operation.run_attempt !== attempt) throw Error('Incremental original attempt changed');
  if (!assembling && attempt > 1) {
    const jobs: any[] = [];
    for (let a = 1; a < attempt; a++)
      for (let page = 1; page <= 20; page++) {
        const result = await get(
          `/actions/runs/${run}/attempts/${a}/jobs?per_page=100&page=${page}`
        );
        if (!Array.isArray(result.jobs)) throw Error('Incremental recovery inventory unavailable');
        jobs.push(...result.jobs);
        if (result.jobs.length < 100) break;
        if (page === 20) throw Error('Incremental recovery inventory bound');
      }
    assertIncrementalUnconsumedRecovery(jobs, attempt, cell);
  } else if (!Number.isSafeInteger(attempt) || attempt < 1)
    throw Error('Incremental attempt unknown');
  for (const path of controlPaths) {
    if (git('show', `${operation.head_sha}:${path}`) !== git('show', `${head}:${path}`))
      throw Error('Incremental workflow control changed');
  }
  if (
    git(
      'ls-files',
      '--others',
      '--exclude-standard',
      'server/src',
      'server/scripts',
      '.github/workflows'
    )
  )
    throw Error('Incremental untracked executable source');
  // Full executable source closure prevents a plan from omitting a changed helper.
  const sourceFiles = git('ls-files', 'server/src')
    .split('\n')
    .filter(
      (p) =>
        /\.(?:ts|json)$/.test(p) &&
        !/\.(?:test|spec)\.ts$/.test(p) &&
        !/Qualification(?:Plans|Families)\.json$/.test(p)
    );
  for (const path of sourceFiles) {
    const relative = path.slice('server/'.length);
    if (
      createHash('sha256')
        .update(readFileSync(fileURLToPath(new URL('../../../' + path, import.meta.url))))
        .digest('hex') !== plan.runtimeSourceFiles[relative]
    )
      throw Error('Incremental full source closure changed');
  }
  return {
    protectedPlanCommit: commit,
    protectedFamilyCommit: familyCommit,
    familyDigest: digest(family),
    providerRunId: String(operation.id),
    priorFamilyRuns: prior.map((p) => ({
      id: String(p.run.id),
      source: p.source,
      status: p.run.status,
      conclusion: p.run.conclusion,
    })),
  };
}
