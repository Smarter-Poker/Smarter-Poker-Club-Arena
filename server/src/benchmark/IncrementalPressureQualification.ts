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
export const TOURNAMENT_RESERVED_HOLDOUT_SEEDS = Object.freeze([53901101, 53902203, 53903307]);
const COUNTERS: Record<Exclude<IncrementalTarget, 'pressure_package'>, string> = {
  combo_draw_pressure: 'combo_draw_pressure_raise',
  targeted_river_bluff: 'v54_river_bluff',
  river_position_defense: 'river_position_defense_call',
  river_bluff_checkraise: 'river_bluff_checkraise_selected',
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
/** Actual provider/PR provenance, not a caller's JSON approval. Must complete
 * before warm histories or contract deals. Existing v1 admission is untouched. */
export async function authenticateIncrementalPlan(plan: FeatureAblationQualificationPlan) {
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
  const get = async (suffix: string) => {
    const response = await fetch(`https://api.github.com/repos/${repo}${suffix}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw Error('Incremental provider provenance unavailable');
    return response.json();
  };
  const [operationValue, prs] = await Promise.all([
    get(`/actions/runs/${run}`),
    get(`/commits/${commit}/pulls`),
  ]);
  const operation = assertIncrementalPlanProvenance(operationValue, prs, commit, run!);
  for (const path of [
    '.github/workflows/horse-feature-ablation-qualification.yml',
    'server/scripts/feature-ablation-assemble.mjs',
    'server/scripts/feature-ablation-artifact-custody.mjs',
    'server/src/benchmark/IncrementalPressureQualification.ts',
  ]) {
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
        !/QualificationPlans\.json$/.test(p)
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
  return { protectedPlanCommit: commit, providerRunId: String(operation.id) };
}
