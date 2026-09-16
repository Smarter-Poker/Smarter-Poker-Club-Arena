#!/usr/bin/env node
// World Hub only: protected GitHub event -> existing M3 publisher -> prebuilt Vercel.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const REPOSITORY = 'Smarter-Poker/Smarter-Poker-World-Hub';
export const PROJECT = 'prj_op66GkZyZcygXQKm76iyycfVFAQx';
export const TEAM = 'team_SVD8r7AOPH065G3usBxVvrBc';
const IMAGE = 'node@sha256:d318ba50c09fe519ec81396723ef353d5eed7b5be0f1c46779b4cbaf4f70cbd9';

export function validateRequest(event, sha) {
  if (event.action !== 'publish-world-hub' || event.client_payload?.repository !== REPOSITORY ||
      !/^[a-f0-9]{40}$/.test(sha || '') || event.client_payload.sha !== sha) {
    throw new Error('Invalid World Hub publication request');
  }
}
export function assertHealth(health, sha) {
  if (health.status !== 'ok' || health.version !== sha || health.checks?.db?.status !== 'ok') {
    throw new Error('Deployment health or exact source identity did not verify');
  }
}
export function deploymentArgs() {
  // Never accept deploy arguments from an event or publish source remotely.
  return ['deploy', '--prebuilt', '--prod', '--skip-domain', '--yes', '--scope', TEAM];
}
export function cacheKey(lock, environment, configuration) {
  return createHash('sha256').update(IMAGE).update('vercel59.1.3').update(lock)
    .update(environment).update(configuration).digest('hex');
}

const run = (command, args, options = {}) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
  } catch (error) {
    // execFile's default error embeds the command line, including credentials.
    throw new Error(`${command} failed (exit ${error.status ?? 'unknown'}); inspect the preceding protected job log`);
  }
};
const api = (path) => JSON.parse(run('gh', ['api', path]));
function currentMain(sha) {
  if (api(`repos/${REPOSITORY}/commits/main`).sha !== sha) {
    throw new Error('Request superseded by newer protected main; its push owns the next publication');
  }
}
function status(sha, state, description) {
  run('gh', ['api', '--method', 'POST', `repos/${REPOSITORY}/statuses/${sha}`,
    '-f', `state=${state}`, '-f', 'context=world-hub/publication', '-f', `description=${description}`,
    '-f', `target_url=https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`]);
}
async function verify(url, sha) {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`Health returned HTTP ${response.status}`);
  assertHealth(await response.json(), sha);
}

export async function main(mode) {
  if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_EVENT_NAME !== 'repository_dispatch' ||
      process.env.GITHUB_REPOSITORY !== 'Smarter-Poker/Smarter-Poker-Club-Arena' || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('Publication is restricted to the protected-main GitHub publisher');
  }
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const sha = process.env.WH_SHA;
  validateRequest(event, sha);
  if (mode === 'status') {
    const passed = process.env.PUBLISH_RESULT === 'success';
    status(sha, passed ? 'success' : 'failure', passed ? 'Published and live identity verified' : 'Publication failed; inspect the linked operation before retrying');
    return;
  }
  currentMain(sha);
  const rules = api(`repos/${REPOSITORY}/rules/branches/main`);
  if (!rules.some(r => r.type === 'pull_request') ||
      !rules.some(r => r.type === 'required_status_checks' && r.parameters?.required_status_checks?.length)) {
    throw new Error('Required World Hub merge protections are missing');
  }
  if (!process.env.VERCEL_TOKEN) throw new Error('Missing trusted publisher Vercel credential');
  if (mode === 'validate') {
    status(sha, 'pending', 'M3 publisher accepted protected main');
    return;
  }
  if (mode !== 'publish') throw new Error('Unknown publisher operation');
  const started = Date.now();
  const source = resolve(process.env.WH_SOURCE);
  if (run('git', ['-C', source, 'rev-parse', 'HEAD']).trim() !== sha ||
      run('git', ['-C', source, 'status', '--porcelain', '--untracked-files=no']).trim()) {
    throw new Error('World Hub source does not match the immutable request');
  }
  const v = (args, options = {}) => run('vercel', [...args, '--token', process.env.VERCEL_TOKEN], { cwd: source, ...options });
  mkdirSync(join(source, '.vercel'), { recursive: true, mode: 0o700 });
  writeFileSync(join(source, '.vercel/project.json'), JSON.stringify({ projectId: PROJECT, orgId: TEAM }), { mode: 0o600 });
  v(['pull', '--yes', '--environment=production', '--scope', TEAM]);
  const buildEnv = join(source, '.vercel/.env.production.local');
  run('/opt/publisher-tools/node-v24.12.0-linux-arm64/bin/node',
    [join(source, 'scripts/check-local-production-build-env.mjs'), '--build-env-file', buildEnv]);
  const key = cacheKey(readFileSync(join(source, 'package-lock.json')), readFileSync(buildEnv), readFileSync(join(source, 'vercel.json')));
  const cache = `/home/lima.guest/.cache/world-hub/${key}`;
  for (const p of [cache, `${cache}/next`, `${cache}/npm`, `${cache}/cli`, join(source, '.next/cache')]) mkdirSync(p, { recursive: true, mode: 0o700 });
  const buildStarted = Date.now();
  // The container receives build settings but no Vercel/GitHub publication token.
  run('docker', ['run', '--rm', '--name', `wh-build-${process.env.GITHUB_RUN_ID}`, '--platform', 'linux/amd64',
    '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'HOME=/tmp', '-e', 'npm_config_cache=/tmp/npm-cache',
    '--cpus=4', '--memory=10g', '--memory-swap=10g', '--pids-limit=512', '--ulimit', 'core=0',
    '--mount', `type=bind,src=${source},dst=/work`, '--mount', `type=bind,src=${cache}/next,dst=/work/.next/cache`,
    '--mount', `type=bind,src=${cache}/npm,dst=/tmp/npm-cache`, '--mount', `type=bind,src=${cache}/cli,dst=/tools`,
    '--workdir', '/work', '-e', 'CI=1', '-e', 'VERCEL_TELEMETRY_DISABLED=1',
    '-e', `VERCEL_GIT_COMMIT_SHA=${sha}`, '-e', `GITHUB_SHA=${sha}`, IMAGE, 'bash', '-euc',
    `node -e 'if(process.arch!=="x64"||process.versions.node!=="24.12.0")process.exit(1)'
     git config --global --add safe.directory /work
     if ! test -x /tools/node_modules/.bin/vercel; then
       npm install --prefix /tools --ignore-scripts --no-audit --no-fund vercel@59.1.3
     fi
     node -e 'if(require("/tools/node_modules/vercel/package.json").version!=="59.1.3")process.exit(1)'
     /tools/node_modules/.bin/vercel build --prod --standalone
     test -f .vercel/output/config.json
     git diff --exit-code HEAD -- package-lock.json`], { stdio: 'inherit', timeout: 1200000 });
  const buildSeconds = (Date.now() - buildStarted) / 1000;
  if (!existsSync(join(source, '.vercel/output/config.json'))) throw new Error('Missing locally built output');
  currentMain(sha);
  const output = v([...deploymentArgs(), '--meta', `githubCommitSha=${sha}`, '--meta', 'githubCommitRef=main',
    '--meta', 'githubRepo=Smarter-Poker-World-Hub', '--meta', 'githubOrg=Smarter-Poker']);
  const urls = output.match(/https:\/\/[a-z0-9-]+\.vercel\.app/g) || [];
  const url = urls.at(-1);
  if (!url) throw new Error('Upload outcome unknown; inspect Vercel before retrying');
  // Retain the candidate identity before any verification or promotion.
  const receipt = { sha, url, requestedAt: event.client_payload.requested_at, buildSeconds, runId: process.env.GITHUB_RUN_ID };
  writeFileSync(join(source, 'publication-receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(`Prebuilt candidate: ${url}`);
  await verify(url, sha);
  currentMain(sha);
  v(['promote', url, '--yes', '--scope', TEAM]);
  await verify('https://smarter.poker', sha);
  receipt.liveVerifiedAt = new Date().toISOString();
  receipt.publisherSeconds = (Date.now() - started) / 1000;
  writeFileSync(join(source, 'publication-receipt.json'), JSON.stringify(receipt, null, 2));
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `World Hub ${sha} is live.\n\nCandidate: ${url}\n\nLocal build: ${buildSeconds}s; publisher: ${receipt.publisherSeconds}s.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
