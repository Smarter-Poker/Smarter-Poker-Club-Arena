/** Provider ownership checks for one manually invoked, non-retryable roster execution. */
import {isClubArenaRepository} from '../ci/repository-identity.mjs';
import { pathToFileURL } from 'node:url';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WORKFLOW = '.github/workflows/lightning-pilot-roster.yml';
/** The same provider ownership rules serve the 2026-10-23 roster expansion
 * workflow; it passes its own workflow path and run-name prefix. */
export function assertRosterRun({
  phase,
  operationId,
  current,
  baseline,
  runs,
  workflow = WORKFLOW,
  title = 'Lightning Roster',
}) {
  if (
    !['prepare', 'execute'].includes(phase) ||
    !UUID.test(operationId) ||
    !current ||
    current.event !== 'workflow_dispatch' ||
    current.head_branch !== 'main' ||
    current.path !== workflow ||
    current.run_attempt !== 1 ||
    !Number.isFinite(Date.parse(current.created_at)) ||
    current.display_title !== `${title} ${phase} ${operationId}`
  )
    throw new Error('Roster Run Identity Refused');
  if (phase === 'prepare') return;
  if (
    !baseline ||
    baseline.id === current.id ||
    baseline.event !== 'workflow_dispatch' ||
    baseline.run_attempt !== 1 ||
    baseline.head_branch !== 'main' ||
    baseline.path !== workflow ||
    baseline.conclusion !== 'success' ||
    baseline.display_title !== `${title} prepare ${operationId}` ||
    !Number.isFinite(Date.parse(baseline.created_at)) ||
    Date.parse(baseline.created_at) >= Date.parse(current.created_at) ||
    !Array.isArray(runs) ||
    !runs.some((r) => r.id === current.id) ||
    runs.some((r) => r.id !== current.id && r.display_title === `${title} execute ${operationId}`)
  )
    throw new Error('Roster Execution Already Owned Or Baseline Unverified');
}
export async function guardRosterRun(
  env = process.env,
  fetcher = fetch,
  { workflow = WORKFLOW, title = 'Lightning Roster' } = {}
) {
  const repo = env.GITHUB_REPOSITORY,
    token = env.GITHUB_TOKEN;
  if (
    !isClubArenaRepository(repo, env.GITHUB_REPOSITORY_ID) ||
    !token ||
    !/^\d+$/.test(env.GITHUB_RUN_ID || '')
  )
    throw new Error('Roster Provider Identity Required');
  const api = async (path) => {
    const response = await fetcher(`https://api.github.com/repos/${repo}/${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error('Roster Provider Read Unavailable');
    return response.json();
  };
  const current = await api(`actions/runs/${env.GITHUB_RUN_ID}`);
  let baseline, runs;
  if (env.PILOT_ROSTER_PHASE === 'execute') {
    if (!/^\d+$/.test(env.PILOT_ROSTER_PREPARE_RUN || ''))
      throw new Error('Roster Baseline Run Required');
    baseline = await api(`actions/runs/${env.PILOT_ROSTER_PREPARE_RUN}`);
    runs = [];
    // Exact operation titles are searched across the whole retained workflow history.
    // This finite cap refuses an incomplete provider inventory rather than assuming no earlier write.
    for (let page = 1; page <= 20; page++) {
      const body = await api(
        `actions/workflows/${workflow.split('/').pop()}/runs?event=workflow_dispatch&per_page=100&page=${page}`
      );
      if (!Array.isArray(body.workflow_runs) || !Number.isSafeInteger(body.total_count))
        throw new Error('Roster Run Inventory Unknown');
      runs.push(...body.workflow_runs);
      if (runs.length >= body.total_count) break;
      if (page === 20 || body.workflow_runs.length === 0)
        throw new Error('Roster Run Inventory Incomplete');
    }
  }
  assertRosterRun({
    phase: env.PILOT_ROSTER_PHASE,
    operationId: env.PILOT_ROSTER_OPERATION_ID,
    current,
    baseline,
    runs,
    workflow,
    title,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  guardRosterRun().then(
    () => console.log('Roster Provider Ownership Verified'),
    () => {
      console.error('Roster Provider Ownership Refused');
      process.exitCode = 1;
    }
  );
