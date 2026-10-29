#!/usr/bin/env node
// One explicit offline operation. The existing evaluator owns every receipt/gate.
import {isClubArenaRepository} from './repository-identity.mjs';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const HEALTH = 'https://engine.smarter.poker/health';
const DATABASE = 'https://kuklfnapbkmacvwxktbh.supabase.co';
const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function invocation({ eventName, ref, repository, repositoryId, inputs }) {
  if (eventName !== 'workflow_dispatch' || ref !== 'refs/heads/main' || !isClubArenaRepository(repository, repositoryId))
    throw new Error('Only an explicit dispatch on this repository protected main is admitted');
  if (!inputs || Object.keys(inputs).sort().join(',') !== 'dataset,operation' ||
      typeof inputs.dataset !== 'string' || !UUID.test(inputs.dataset) || !['evaluate', 'promote'].includes(inputs.operation))
    throw new Error('A canonical dataset UUID and explicit evaluate/promote operation are required');
  return { dataset: inputs.dataset, operation: inputs.operation };
}

export function servingIdentity(body) {
  if (body?.status !== 'ok' || body?.liveHorseDecision?.phase !== 'ready' ||
      typeof body.releaseSha !== 'string' || !SHA.test(body.releaseSha) || body.releaseSha === '0'.repeat(40))
    throw new Error('Healthy serving decision-worker source identity is unavailable');
  return { releaseSha: body.releaseSha };
}

export function promotionReady(dataset, id) {
  if (dataset?.dataset_id !== id || dataset.state !== 'candidate')
    throw new Error('Promotion requires the exact already-qualified candidate');
  const receipts = (dataset.evaluations ?? []).filter((r) => ['paired_replay', 'league'].includes(r.kind));
  const expected = new Set(['paired_replay', 'league'].flatMap((kind) =>
    ['cash', 'spin', 'tourney_ev', 'tourney_icm'].map((family) => `${kind}/${family}`)));
  for (const receipt of receipts) {
    if (!['win', 'tie'].includes(receipt.verdict) || !expected.delete(`${receipt.kind}/${receipt.game_family}`))
      throw new Error('Promotion requires eight distinct passing replay/league receipts');
  }
  if (receipts.length !== 8 || expected.size)
    throw new Error('Promotion requires eight distinct passing replay/league receipts');
}

export function receiptSourceMatches(dataset, sourceSha) {
  for (const receipt of dataset.evaluations ?? []) {
    if (['paired_replay', 'league'].includes(receipt.kind) &&
        receipt.metrics?.candidate_config?.evaluation_engine_commit !== sourceSha)
      throw new Error('Existing immutable evaluation evidence belongs to another or unproved engine source');
  }
}

export function evaluatorArguments(dataset, operation) {
  if (!UUID.test(dataset) || !['evaluate', 'promote'].includes(operation)) throw new Error('Invalid evaluator invocation');
  return ['node_modules/tsx/dist/cli.mjs', 'src/scripts/gtoV31Evaluate.ts', `--dataset=${dataset}`,
    ...(operation === 'promote' ? ['--promote'] : [])];
}

async function healthy() {
  const response = await fetch(`${HEALTH}?v31-qualification=${Date.now()}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Serving source read returned HTTP ${response.status}`);
  return servingIdentity(await response.json());
}

function git(runtime, args) {
  const result = spawnSync('git', ['-C', runtime, ...args], { encoding: 'utf8', timeout: 20000 });
  if (result.status !== 0) throw new Error(`Runtime Git proof failed: ${args[0]}`);
  return result.stdout.trim();
}

async function status(id) {
  if (process.env.SUPABASE_URL !== DATABASE || !process.env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error('Configured evaluator identity for the canonical database is unavailable');
  const response = await fetch(`${DATABASE}/rest/v1/rpc/ca_gto_v31_certification_status`, {
    method: 'POST', signal: AbortSignal.timeout(30000),
    headers: { 'Content-Type': 'application/json', apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ p_dataset_id: id }),
  });
  if (!response.ok) throw new Error(`Certification status returned HTTP ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.datasets) || body.datasets.length !== 1 || body.datasets[0].dataset_id !== id)
    throw new Error('Certification status omitted the exact dataset');
  return body.datasets[0];
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const selected = invocation({ eventName: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
    repository: process.env.GITHUB_REPOSITORY, repositoryId: process.env.GITHUB_REPOSITORY_ID, inputs: event.inputs });
  if (!/^\d+$/.test(process.env.GITHUB_RUN_ID ?? '') || !/^\d+$/.test(process.env.GITHUB_RUN_ATTEMPT ?? ''))
    throw new Error('Provider operation identity is unavailable');
  const directory = join(process.env.RUNNER_TEMP, `gto-v31-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
  const contextPath = join(directory, 'context.json');
  if (process.argv[2] === 'resolve') {
    const serving = await healthy();
    mkdirSync(directory, { recursive: true });
    writeFileSync(contextPath, JSON.stringify({ ...selected, ...serving }) + '\n');
    appendFileSync(process.env.GITHUB_OUTPUT, `source_sha=${serving.releaseSha}\nreceipt_directory=${directory}\n`);
    console.log(`Selected serving protected source ${serving.releaseSha}; no database call made`);
    return;
  }
  if (process.argv[2] !== 'run') throw new Error('Unknown qualification phase');
  const context = JSON.parse(readFileSync(contextPath, 'utf8'));
  if (context.dataset !== selected.dataset || context.operation !== selected.operation || !SHA.test(context.releaseSha))
    throw new Error('Resolved operation identity differs');
  const receipt = { ...context, startedAt: new Date().toISOString(), outcome: 'unknown', evaluatorExit: null };
  let failure;
  try {
    const runtime = resolve(process.env.GITHUB_WORKSPACE, 'runtime');
    if (git(runtime, ['rev-parse', 'HEAD']) !== context.releaseSha || git(runtime, ['status', '--porcelain', '--untracked-files=all']))
      throw new Error('Runtime checkout does not exactly match the clean serving source');
    git(runtime, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
    if ((await healthy()).releaseSha !== context.releaseSha) throw new Error('Serving source changed before evaluation');
    const before = await status(selected.dataset);
    receipt.datasetChecksum = before.dataset_checksum;
    if (!/^[0-9a-f]{64}$/.test(before.dataset_checksum ?? '') || before.dataset_checksum === '0'.repeat(64) ||
        !['evaluating', 'candidate'].includes(before.state))
      throw new Error('A sealed evaluating/candidate dataset is required');
    receiptSourceMatches(before, context.releaseSha);
    if (selected.operation === 'promote') promotionReady(before, selected.dataset);
    const result = spawnSync(process.execPath, evaluatorArguments(selected.dataset, selected.operation), {
      cwd: join(runtime, 'server'), stdio: 'inherit',
      env: { ...process.env, GIT_COMMIT_SHA: context.releaseSha, EQUITY_GOVERNOR: 'off' },
    });
    receipt.evaluatorExit = result.status;
    if (result.status !== 0) throw new Error('Evaluator did not complete successfully; inspect durable partial evidence before resuming');
    const after = await status(selected.dataset);
    receipt.datasetState = after.state;
    receiptSourceMatches(after, context.releaseSha);
    if (after.dataset_checksum !== before.dataset_checksum ||
        after.state !== (selected.operation === 'promote' ? 'active' : 'candidate'))
      throw new Error('Evaluator returned without the expected durable dataset outcome');
    receipt.outcome = 'completed';
  } catch (error) {
    failure = error;
    receipt.outcome = 'incomplete-inspect-durable-state';
    receipt.error = error.message;
  } finally {
    try {
      receipt.servingAfter = await healthy();
      if (receipt.servingAfter.releaseSha !== context.releaseSha) throw new Error('Serving source changed during the operation');
    } catch (error) {
      failure = error; receipt.outcome = 'unknown-serving-identity'; receipt.error = error.message;
    }
    receipt.finishedAt = new Date().toISOString();
    writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY,
      `### Explicit V31 ${selected.operation}\n\n- Dataset: \`${selected.dataset}\`\n- Serving source: \`${context.releaseSha}\`\n- Outcome: **${receipt.outcome}**\n- Evaluator exit: \`${receipt.evaluatorExit}\`\n\nNo engine deployment or automatic retry was requested. Inspect durable dataset/evaluation state before any resumed operation.\n`);
  }
  if (failure) throw failure;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(`[gto-v31-qualification] ${error.message}`); process.exitCode = 1; });
}
