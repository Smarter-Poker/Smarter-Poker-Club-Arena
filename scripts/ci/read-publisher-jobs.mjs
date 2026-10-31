#!/usr/bin/env node
import { publisherJobKey } from './publisher-job-identity.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  mergePublisherReceipt,
  missingPublisherProofs,
  receiptName,
} from './publisher-verdict-receipt.mjs';
const execute = promisify(execFile);

/** Configured gh authentication stays inside gh; stdout contains metadata only. */
export async function requestPublisherJobs(path, timeoutMs) {
  try {
    const { stdout } = await execute('gh', ['api', '--method', 'GET', path], {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const status = Number(/\(HTTP (\d{3})\)/.exec(error.stderr ?? '')?.[1]);
    // Do not echo provider response bodies, headers, or credential diagnostics.
    throw Object.assign(
      new Error(
        Number.isInteger(status)
          ? `Source jobs read refused HTTP${status}.`
          : 'Source jobs read failed or returned malformed JSON.'
      ),
      { status }
    );
  }
}

/** GET-only bounded pagination; original workflow retains its30s outer guard. */
export async function readPublisherJobs(
  repository,
  runId,
  {
    request = requestPublisherJobs,
    now = Date.now,
    sleep: pause = sleep,
    deadline = now() + 29_000,
  } = {}
) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9]+$/.test(runId))
    throw new Error('Source repository or run identity is malformed.');
  const jobs = [],
    ids = new Set();
  let total;
  for (let page = 1; ; page++) {
    let payload;
    for (let attempt = 1; ; attempt++) {
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error('Source jobs read exhausted its admission budget.');
      try {
        payload = await request(
          `repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=30&page=${page}`,
          remaining
        );
        break;
      } catch (error) {
        if (!(error.status >= 500 && error.status <= 599) || attempt >= 3) throw error;
        const delay = attempt * 250;
        if (deadline - now() <= delay)
          throw new Error('Source jobs read exhausted its admission budget.');
        await pause(delay);
      }
    }
    if (now() >= deadline)
      throw new Error('Source jobs response arrived after its admission budget.');
    if (
      !Array.isArray(payload?.jobs) ||
      !Number.isSafeInteger(payload.total_count) ||
      payload.total_count < 0 ||
      (total !== undefined && total !== payload.total_count)
    )
      throw new Error('Source job metadata is malformed or changed during pagination.');
    total = payload.total_count;
    if (payload.jobs.length !== Math.min(30, total - jobs.length))
      throw new Error('Source job metadata is incomplete.');
    for (const job of payload.jobs) {
      if (!Number.isSafeInteger(job?.id) || job.id <= 0 || ids.has(job.id))
        throw new Error('Source job identities are missing or duplicated.');
      ids.add(job.id);
      jobs.push(job);
    }
    if (jobs.length === total) return { total_count: total, jobs };
  }
}

export async function downloadPublisherReceipt(repository, artifactId, timeoutMs) {
  const parent = process.env.RUNNER_TEMP || process.env.TMPDIR || tmpdir();
  if (process.platform === 'darwin' && !parent.startsWith('/Volumes/SmarterWork/agent-work/'))
    throw new Error('Publisher receipt requires owned external SSD scratch.');
  const directory = await mkdtemp(join(parent, 'publisher-verdict-'));
  const deadline = Date.now() + timeoutMs;
  const remaining = () => {
    const budget = deadline - Date.now();
    if (budget <= 0) throw new Error('Publisher receipt download exhausted its admission budget.');
    return budget;
  };
  try {
    let bytes;
    for (let attempt = 1; ; attempt++) {
      try {
        ({ stdout: bytes } = await execute(
          'gh',
          ['api', '--method', 'GET', `repos/${repository}/actions/artifacts/${artifactId}/zip`],
          {
            timeout: remaining(),
            maxBuffer: 1024 * 1024,
            encoding: 'buffer',
          }
        ));
        break;
      } catch (error) {
        const status = Number(/\(HTTP (\d{3})\)/.exec(String(error.stderr ?? ''))?.[1]);
        if (!(status >= 500 && status <= 599) || attempt >= 3) throw error;
        const delay = attempt * 250;
        if (remaining() <= delay)
          throw new Error('Publisher receipt exhausted its admission budget.');
        await sleep(delay);
      }
    }
    const archive = join(directory, 'receipt.zip');
    await writeFile(archive, bytes, { flag: 'wx', mode: 0o600 });
    const { stdout: entries } = await execute('unzip', ['-Z1', archive], {
      timeout: remaining(),
      maxBuffer: 1024,
    });
    if (entries.trim() !== 'publisher-verdict.json')
      throw new Error('Publisher receipt archive must contain one exact proof file.');
    const { stdout: body } = await execute('unzip', ['-p', archive, 'publisher-verdict.json'], {
      timeout: remaining(),
      maxBuffer: 64 * 1024,
    });
    remaining();
    return JSON.parse(body);
  } catch {
    throw new Error('Publisher verdict receipt download is unavailable or malformed.');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Recover absent REST steps only from the original publisher's immutable proof. */
export async function hydratePublisherProofs(
  payload,
  repository,
  runId,
  repositoryId,
  triggerSha,
  {
    request = requestPublisherJobs,
    download = downloadPublisherReceipt,
    now = Date.now,
    sleep: pause = sleep,
    deadline = now() + 29_000,
  } = {}
) {
  if (!/^[1-9][0-9]*$/.test(String(repositoryId)) || !/^[0-9a-f]{40}$/.test(triggerSha))
    throw new Error('Publisher receipt source identity is malformed.');
  const missing = payload.jobs.filter(
    (job) =>
      publisherJobKey(job.name) !== null &&
      job.status === 'completed' &&
      job.conclusion === 'success' &&
      missingPublisherProofs(job.name, job.steps).length > 0
  );
  if (!missing.length) return payload;
  const remaining = () => {
    const budget = deadline - now();
    if (budget <= 0) throw new Error('Publisher receipt exhausted its admission budget.');
    return budget;
  };
  const read = async (path) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await request(path, remaining());
      } catch (error) {
        if (!(error.status >= 500 && error.status <= 599) || attempt >= 3) throw error;
        const delay = attempt * 250;
        if (remaining() <= delay)
          throw new Error('Publisher receipt exhausted its admission budget.');
        await pause(delay);
      }
    }
  };
  const run = await read(`repos/${repository}/actions/runs/${runId}`);
  if (
    String(run?.id) !== runId ||
    run.head_sha !== triggerSha ||
    run.head_branch !== 'main' ||
    run.status !== 'completed' ||
    run.path !== '.github/workflows/publish-club-arena.yml' ||
    String(run.repository?.id) !== String(repositoryId) ||
    run.repository?.full_name !== repository
  )
    throw new Error('Publisher receipt source run ownership is unverified.');
  const artifacts = [],
    ids = new Set();
  let total;
  for (let page = 1; ; page++) {
    const response = await read(
      `repos/${repository}/actions/runs/${runId}/artifacts?per_page=30&page=${page}`
    );
    if (
      !Array.isArray(response?.artifacts) ||
      !Number.isSafeInteger(response.total_count) ||
      response.total_count < 0 ||
      (total !== undefined && total !== response.total_count)
    )
      throw new Error('Publisher receipt artifact metadata is malformed or changed.');
    total = response.total_count;
    if (response.artifacts.length !== Math.min(30, total - artifacts.length))
      throw new Error('Publisher receipt artifact metadata is incomplete.');
    for (const artifact of response.artifacts) {
      if (!Number.isSafeInteger(artifact?.id) || artifact.id <= 0 || ids.has(artifact.id))
        throw new Error('Publisher receipt artifact identities are missing or duplicated.');
      ids.add(artifact.id);
      artifacts.push(artifact);
    }
    if (artifacts.length === total) break;
  }
  const replacements = new Map();
  for (const job of missing) {
    const name = receiptName(publisherJobKey(job.name), job.run_attempt);
    const matches = artifacts.filter((artifact) => artifact.name === name);
    if (matches.length !== 1) throw new Error('Publisher receipt is absent or ambiguous.');
    const artifact = matches[0];
    if (
      artifact.expired !== false ||
      String(artifact.workflow_run?.id) !== runId ||
      artifact.workflow_run?.head_sha !== triggerSha ||
      artifact.workflow_run?.head_branch !== 'main' ||
      String(artifact.workflow_run?.repository_id) !== String(repositoryId) ||
      String(artifact.workflow_run?.head_repository_id) !== String(repositoryId)
    )
      throw new Error('Publisher receipt artifact ownership is unverified.');
    const receipt = await download(repository, artifact.id, remaining());
    remaining();
    replacements.set(
      job.id,
      mergePublisherReceipt(receipt, {
        run,
        job,
        artifact: matches[0],
        repositoryId,
        triggerSha,
        workflowSha: triggerSha,
      })
    );
  }
  return { ...payload, jobs: payload.jobs.map((job) => replacements.get(job.id) ?? job) };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [repository, runId] = process.argv.slice(2);
  const deadline = Date.now() + 29_000;
  readPublisherJobs(repository, runId, { deadline })
    .then((payload) =>
      process.env.SOURCE_TRIGGER_SHA
        ? hydratePublisherProofs(
            payload,
            repository,
            runId,
            process.env.REPOSITORY_ID,
            process.env.SOURCE_TRIGGER_SHA,
            { deadline }
          )
        : payload
    )
    .then((payload) => {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    })
    .catch((error) => {
      console.error(`[read-publisher-jobs] ${error.message}`);
      process.exitCode = 1;
    });
}
