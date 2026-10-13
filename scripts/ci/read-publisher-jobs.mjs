#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
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
  { request = requestPublisherJobs, now = Date.now, sleep: pause = sleep } = {}
) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[0-9]+$/.test(runId))
    throw new Error('Source repository or run identity is malformed.');
  const deadline = now() + 29_000;
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  readPublisherJobs(...process.argv.slice(2))
    .then((payload) => {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    })
    .catch((error) => {
      console.error(`[read-publisher-jobs] ${error.message}`);
      process.exitCode = 1;
    });
}
