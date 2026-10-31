/** One explicitly invoked provider owner. No automatic continuation or write retry. */
import {isClubArenaRepository} from '../ci/repository-identity.mjs';
import { pathToFileURL } from 'node:url';
const WORKFLOW = '.github/workflows/lightning-pilot-assignment.yml';
const PHASES = ['prepare', 'assign', 'withdraw', 'release', 'report'];
export function assertAssignmentRun({ phase, operationId, current, baseline, runs }) {
  const valid = (r, p) =>
    r &&
    r.event === 'workflow_dispatch' &&
    r.head_branch === 'main' &&
    r.path === WORKFLOW &&
    r.run_attempt === 1 &&
    Number.isFinite(Date.parse(r.created_at)) &&
    r.display_title === `Lightning Assignment ${p} ${operationId}`;
  if (
    !PHASES.includes(phase) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(operationId || '') ||
    !valid(current, phase)
  )
    throw new Error('Assignment Provider Identity Refused');
  if (phase !== 'withdraw') return;
  if (
    !valid(baseline, 'prepare') ||
    baseline.conclusion !== 'success' ||
    baseline.id === current.id ||
    Date.parse(baseline.created_at) >= Date.parse(current.created_at) ||
    !Array.isArray(runs) ||
    !runs.some((r) => r.id === current.id) ||
    runs.some(
      (r) =>
        r.id !== current.id && r.display_title === `Lightning Assignment withdraw ${operationId}`
    )
  )
    throw new Error('Assignment Withdrawal Already Owned Or Baseline Unverified');
}
export async function guardAssignmentRun(env = process.env, fetcher = fetch) {
  if (
    !isClubArenaRepository(env.GITHUB_REPOSITORY, env.GITHUB_REPOSITORY_ID) ||
    !env.GITHUB_TOKEN ||
    !/^\d+$/.test(env.GITHUB_RUN_ID || '')
  )
    throw new Error('Assignment Provider Required');
  const api = async (path) => {
    const r = await fetcher(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/${path}`, {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error('Assignment Provider Read Unavailable');
    return r.json();
  };
  const current = await api(`actions/runs/${env.GITHUB_RUN_ID}`);
  let baseline, runs;
  if (env.PILOT_ASSIGNMENT_PHASE === 'withdraw') {
    if (!/^\d+$/.test(env.PILOT_ASSIGNMENT_PREPARE_RUN || ''))
      throw new Error('Assignment Preparation Required');
    baseline = await api(`actions/runs/${env.PILOT_ASSIGNMENT_PREPARE_RUN}`);
    runs = [];
    for (let page = 1; page <= 20; page++) {
      const b = await api(
        `actions/workflows/lightning-pilot-assignment.yml/runs?event=workflow_dispatch&per_page=100&page=${page}`
      );
      if (!Array.isArray(b.workflow_runs) || !Number.isSafeInteger(b.total_count))
        throw new Error('Assignment Provider Inventory Unknown');
      runs.push(...b.workflow_runs);
      if (runs.length >= b.total_count) break;
      if (page === 20 || b.workflow_runs.length === 0)
        throw new Error('Assignment Provider Inventory Incomplete');
    }
  }
  assertAssignmentRun({
    phase: env.PILOT_ASSIGNMENT_PHASE,
    operationId: env.PILOT_ASSIGNMENT_OPERATION_ID,
    current,
    baseline,
    runs,
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  guardAssignmentRun().then(
    () => console.log('Assignment Provider Ownership Verified'),
    () => {
      console.error('Assignment Provider Ownership Refused');
      process.exitCode = 1;
    }
  );
