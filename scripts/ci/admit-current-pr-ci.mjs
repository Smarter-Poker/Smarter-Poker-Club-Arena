#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const repository = 'Smarter-Poker/Smarter-Poker-Club-Arena';
const repositoryId = 1132369872;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const ensure = (condition, code) => {
  if (!condition) throw new Error(code);
};
const validRepo = (value) =>
  positiveId(value?.id) &&
  typeof value.full_name === 'string' &&
  /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(value.full_name);
const sameRepo = (a, b) =>
  validRepo(a) && validRepo(b) && a.id === b.id && a.full_name === b.full_name;
const authorityRepo = (value) =>
  validRepo(value) && value.id === repositoryId && value.full_name === repository;

function sourcePr(event) {
  const pr = event?.pull_request;
  ensure(authorityRepo(event?.repository), 'PR_CI_EVENT_REPOSITORY_INVALID');
  ensure(
    positiveId(pr?.id) && positiveId(pr.number) && event.number === pr.number,
    'PR_CI_EVENT_IDENTITY_INVALID'
  );
  ensure(authorityRepo(pr.base?.repo) && pr.base.ref === 'main', 'PR_CI_EVENT_BASE_INVALID');
  ensure(
    validRepo(pr.head?.repo) &&
      sha(pr.head.sha) &&
      typeof pr.head.ref === 'string' &&
      pr.head.ref.length > 0,
    'PR_CI_EVENT_HEAD_INVALID'
  );
  return pr;
}

/** Read-only admission. No old run is cancelled and no untested job succeeds. */
export async function admitCurrentPrCi({ eventName, event, repositoryName, readPr }) {
  ensure(repositoryName === repository, 'PR_CI_REPOSITORY_INVALID');
  // The existing whole-main schedules have no PR head to supersede.
  if (eventName === 'schedule') return { admitted: true, reason: 'scheduled-full-check' };
  ensure(eventName === 'pull_request', 'PR_CI_EVENT_UNSUPPORTED');
  const source = sourcePr(event);
  let live;
  try {
    live = await readPr(source.number);
  } catch {
    throw new Error('PR_CI_HEAD_UNREADABLE');
  }
  ensure(
    live?.id === source.id && live.number === source.number && live.state === 'open',
    'PR_CI_LIVE_IDENTITY_INVALID'
  );
  ensure(authorityRepo(live.base?.repo) && live.base.ref === 'main', 'PR_CI_LIVE_BASE_INVALID');
  ensure(
    sameRepo(live.head?.repo, source.head.repo) &&
      live.head.ref === source.head.ref &&
      sha(live.head.sha),
    'PR_CI_LIVE_HEAD_INVALID'
  );
  // A -> B -> A is admitted again when A is actually current. No historical
  // stale-head cache or cancellation list can suppress the returning head.
  ensure(live.head.sha === source.head.sha, 'PR_CI_HEAD_SUPERSEDED');
  return { admitted: true, reason: 'current-pr-head' };
}

export function githubPrReader(token, fetchImpl = fetch) {
  return async (number) => {
    ensure(
      positiveId(number) && typeof token === 'string' && token.length > 0,
      'PR_CI_READ_CONTEXT_INVALID'
    );
    try {
      const response = await fetchImpl(
        `https://api.github.com/repos/${repository}/pulls/${number}`,
        {
          method: 'GET',
          redirect: 'error',
          signal: AbortSignal.timeout(15000),
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'User-Agent': 'club-arena-pr-ci-admission',
            'X-GitHub-Api-Version': '2022-11-28',
            'Cache-Control': 'no-cache',
          },
        }
      );
      ensure(response.ok, 'PR_CI_READ_FAILED');
      const text = await response.text();
      ensure(Buffer.byteLength(text) <= 1024 * 1024, 'PR_CI_RESPONSE_TOO_LARGE');
      return JSON.parse(text);
    } catch {
      throw new Error('PR_CI_READ_FAILED');
    }
  };
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  try {
    const eventName = process.env.GITHUB_EVENT_NAME;
    const result = await admitCurrentPrCi({
      eventName,
      event:
        eventName === 'pull_request'
          ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'))
          : null,
      repositoryName: process.env.GITHUB_REPOSITORY,
      readPr: githubPrReader(process.env.GH_TOKEN),
    });
    process.stdout.write(`PR CI admission: ${result.reason}\n`);
  } catch (error) {
    const code = /^PR_CI_[A-Z_]+$/.test(error?.message) ? error.message : 'PR_CI_CONTEXT_INVALID';
    process.stderr.write(`::error::${code}; required heavy work was not verified.\n`);
    process.exitCode = 1;
  }
}
