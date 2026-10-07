#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conservativeClientInput,
  separateComponentPath,
  qualifiesRuntimeInputs,
} from './client-runtime-inputs.mjs';
import { readPublisherArtifactSha } from './production-e2e-provenance.mjs';

const SHA = /^[0-9a-f]{40}$/;
const ID = /^[1-9][0-9]*$/;
const ORIGINS = ['https://ca-static.smarter.poker', 'https://smarter.poker/hub/club-arena'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...args) => execFileSync('git', args, { maxBuffer: 32 * 1024 * 1024 });
const gh = (...args) =>
  execFileSync('gh', args, { timeout: 60000, maxBuffer: 32 * 1024 * 1024 }).toString();
const json = (value) => JSON.parse(value);
const validPath = (path) =>
  path &&
  !path.startsWith('/') &&
  !path.includes('\\') &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');

export function compareClientBacklog(base, target, cwd = process.cwd()) {
  if (!SHA.test(base) || !SHA.test(target))
    throw new Error('Client comparison requires full SHAs.');
  const run = (...args) =>
    execFileSync('git', ['-C', cwd, ...args], { maxBuffer: 32 * 1024 * 1024 });
  run('cat-file', '-e', `${base}^{commit}`);
  run('cat-file', '-e', `${target}^{commit}`);
  run('merge-base', '--is-ancestor', base, target);
  const bytes = run('diff', '--raw', '--no-abbrev', '--no-renames', '-z', base, target);
  if (!bytes.equals(Buffer.from(bytes.toString('utf8'), 'utf8')))
    throw new Error('Git paths are not UTF-8.');
  if (bytes.length && bytes.at(-1) !== 0) throw new Error('Git path evidence is truncated.');
  const parts = bytes.toString('utf8').split('\0');
  parts.pop();
  if (parts.length % 2) throw new Error('Git raw comparison is incomplete.');
  const paths = [];
  for (let i = 0; i < parts.length; i += 2) {
    const match = /^:(\d{6}) (\d{6}) [0-9a-f]{40} [0-9a-f]{40} [AMD]$/.exec(parts[i]);
    const path = parts[i + 1];
    if (!match || !validPath(path) || paths.includes(path))
      throw new Error('Invalid or duplicate Git path.');
    if (![match[1], match[2]].every((mode) => ['000000', '100644', '100755'].includes(mode))) {
      throw new Error('Symlink, submodule or unsupported path mode.');
    }
    paths.push(path);
  }
  return { paths };
}

export function verifyImmutableBundle(directory, manifest) {
  const records = String(manifest).split('\n');
  if (records.pop() !== '' || !records.length)
    throw new Error('The release manifest is empty or incomplete.');
  const files = new Map();
  for (const record of records) {
    const entry = /^([0-9a-f]{64})  \.\/(.+)$/.exec(record);
    if (
      !entry ||
      !validPath(entry[2]) ||
      entry[2] === '.release-manifest.sha256' ||
      files.has(entry[2])
    ) {
      throw new Error('The release manifest contains an invalid or duplicate path.');
    }
    files.set(entry[2], entry[1]);
  }
  const actual = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('A release artifact contains a symlink.');
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) actual.push(relative(directory, path));
      else throw new Error('A release artifact contains a non-regular file.');
    }
  };
  walk(directory);
  const expected = [...files.keys(), '.release-manifest.sha256'].sort();
  if (JSON.stringify(actual.sort()) !== JSON.stringify(expected))
    throw new Error('The release manifest does not cover the complete artifact.');
  for (const [path, expectedHash] of files) {
    if (hash(readFileSync(resolve(directory, path))) !== expectedHash)
      throw new Error(`Release byte mismatch: ${path}`);
  }
  return hash(manifest);
}

export function readRetentionReceipt(raw, runId, triggerSha, repositoryId) {
  const receipt = typeof raw === 'string' ? json(raw) : raw;
  if (
    !receipt ||
    receipt.schema !== 1 ||
    receipt.kind !== 'retained-client-runtime' ||
    !SHA.test(receipt.runtimeSha) ||
    !SHA.test(receipt.verificationSha) ||
    !ID.test(String(runId)) ||
    !SHA.test(triggerSha) ||
    !ID.test(String(repositoryId)) ||
    receipt.sourceRunId !== String(runId) ||
    receipt.sourceTriggerSha !== triggerSha ||
    receipt.repositoryId !== String(repositoryId) ||
    !ID.test(receipt.originalPublisherRunId) ||
    !Number.isSafeInteger(receipt.originalArtifactId) ||
    receipt.originalArtifactId <= 0 ||
    !receipt.inputs ||
    receipt.inputs.sourceSha !== receipt.runtimeSha ||
    receipt.inputs.complete !== true ||
    !/^[0-9a-f]{64}$/.test(receipt.buildInfoSHA256) ||
    !/^[0-9a-f]{64}$/.test(receipt.manifestSHA256) ||
    !Array.isArray(receipt.paths) ||
    receipt.paths.some((path) => !validPath(path)) ||
    new Set(receipt.paths).size !== receipt.paths.length
  ) {
    throw new Error('Retained runtime receipt does not bind this exact protected publisher run.');
  }
  return receipt;
}

export function receiptArtifactId(payload, runId, triggerSha, repositoryId) {
  if (
    !payload ||
    !Array.isArray(payload.artifacts) ||
    payload.total_count !== payload.artifacts.length
  )
    throw new Error('Incomplete retained artifact metadata.');
  const matches = payload.artifacts.filter((entry) => entry.name === 'club-arena-retained-runtime');
  if (matches.length !== 1) throw new Error('Expected one immutable retained runtime receipt.');
  const artifact = matches[0];
  // Reuse the maintained exact run/repository/branch artifact validator without
  // pretending that this separate receipt is a newly built client bundle.
  readPublisherArtifactSha(
    JSON.stringify({
      total_count: 1,
      artifacts: [{ ...artifact, name: `club-arena-dist-${triggerSha}` }],
    }),
    String(runId),
    triggerSha,
    String(repositoryId)
  );
  return artifact.id;
}

async function readOrigin(path) {
  return Promise.all(
    ORIGINS.map(async (origin) => {
      const response = await fetch(
        `${origin}/${path}?runtime-retention=${process.env.GITHUB_RUN_ID || Date.now()}`,
        {
          headers: { 'Cache-Control': 'no-cache' },
          signal: AbortSignal.timeout(20000),
          redirect: 'error',
        }
      );
      if (!response.ok) throw new Error(`Origin evidence HTTP ${response.status}.`);
      return Buffer.from(await response.arrayBuffer());
    })
  );
}

async function requireCurrentReceipt(receipt) {
  const comparison = compareClientBacklog(receipt.runtimeSha, receipt.verificationSha);
  if (
    !qualifiesRuntimeInputs(
      receipt.inputs,
      receipt.runtimeSha,
      receipt.verificationSha,
      comparison.paths
    ) ||
    JSON.stringify(comparison.paths) !== JSON.stringify(receipt.paths)
  )
    throw new Error('The complete client backlog differs from its receipt.');
  git('merge-base', '--is-ancestor', receipt.verificationSha, 'origin/main');
  const [info, manifests] = await Promise.all([
    readOrigin('build-info.json'),
    readOrigin('.release-manifest.sha256'),
  ]);
  assertReceiptOrigins(receipt, info, manifests);
}

export function assertReceiptOrigins(receipt, info, manifests) {
  if (
    !Array.isArray(info) ||
    info.length !== 2 ||
    !Array.isArray(manifests) ||
    manifests.length !== 2
  )
    throw new Error('Both actual origins are required.');
  for (let i = 0; i < 2; i++) {
    const value = json(info[i]);
    if (
      value.ca_sha !== receipt.runtimeSha ||
      String(value.run_id) !== receipt.originalPublisherRunId ||
      value.built_by !== 'publish-club-arena.yml' ||
      hash(info[i]) !== receipt.buildInfoSHA256 ||
      hash(manifests[i]) !== receipt.manifestSHA256
    )
      throw new Error('The actual origin no longer matches the retained runtime.');
  }
}

async function admit(target) {
  if (process.env.GITHUB_EVENT_NAME === 'repository_dispatch')
    throw new Error('Exact-SHA repair/configuration events require normal publication.');
  if (!SHA.test(target) || git('rev-parse', 'HEAD').toString().trim() !== target)
    throw new Error('Admission checkout differs from current protected target.');
  git('merge-base', '--is-ancestor', target, 'origin/main');
  const info = await readOrigin('build-info.json');
  if (!info[0].equals(info[1])) throw new Error('The two actual origins disagree.');
  const baseline = json(info[0]);
  if (
    !SHA.test(baseline.ca_sha) ||
    !ID.test(String(baseline.run_id)) ||
    baseline.built_by !== 'publish-club-arena.yml'
  )
    throw new Error('No exact original publisher provenance.');
  const comparison = compareClientBacklog(baseline.ca_sha, target);
  if (
    comparison.paths.some((path) => conservativeClientInput(path) || !separateComponentPath(path))
  )
    throw new Error(
      'The complete backlog contains a conservative runtime/build input or unknown component.'
    );
  const repo = process.env.GITHUB_REPOSITORY;
  const originalRunId = String(baseline.run_id);
  const originalRun = json(gh('api', `repos/${repo}/actions/runs/${originalRunId}`));
  if (
    originalRun.path !== '.github/workflows/publish-club-arena.yml' ||
    originalRun.head_branch !== 'main' ||
    !['push', 'repository_dispatch'].includes(originalRun.event) ||
    originalRun.status !== 'completed' ||
    String(originalRun.repository?.id) !== process.env.GITHUB_REPOSITORY_ID
  )
    throw new Error('The original build is not a protected publisher run.');
  const metadata = gh('api', `repos/${repo}/actions/runs/${originalRunId}/artifacts?per_page=100`);
  if (
    readPublisherArtifactSha(
      metadata,
      originalRunId,
      originalRun.head_sha,
      process.env.GITHUB_REPOSITORY_ID
    ) !== baseline.ca_sha
  )
    throw new Error('The original publisher selected another bundle.');
  const artifact = json(metadata).artifacts.find(
    (entry) => entry.name === `club-arena-dist-${baseline.ca_sha}`
  );
  const jobs = json(
    gh('api', `repos/${repo}/actions/runs/${originalRunId}/jobs?filter=latest&per_page=100`)
  );
  if (!Array.isArray(jobs.jobs) || jobs.total_count !== jobs.jobs.length)
    throw new Error('Original publisher job evidence is incomplete.');
  const origins = jobs.jobs.filter((entry) => entry.name === 'publish-to-origin');
  if (
    origins.length !== 1 ||
    origins[0].status !== 'completed' ||
    origins[0].conclusion !== 'success' ||
    origins[0].steps?.filter(
      (entry) =>
        entry.name === 'Verify the origin serves this bundle' &&
        entry.status === 'completed' &&
        entry.conclusion === 'success'
    ).length !== 1
  )
    throw new Error('Original publisher did not prove the origin.');
  const dir = mkdtempSync(
    resolve(process.env.RUNNER_TEMP || process.env.TMPDIR || '.', 'client-runtime-')
  );
  try {
    gh('run', 'download', originalRunId, '--repo', repo, '--name', artifact.name, '--dir', dir);
    const manifest = readFileSync(resolve(dir, '.release-manifest.sha256'));
    const manifestSHA256 = verifyImmutableBundle(dir, manifest);
    const inputs = json(readFileSync(resolve(dir, 'client-runtime-inputs.json')));
    if (!qualifiesRuntimeInputs(inputs, baseline.ca_sha, target, comparison.paths))
      throw new Error('The complete backlog changes client build inputs or an unclassified path.');
    if (!readFileSync(resolve(dir, 'build-info.json')).equals(info[0]))
      throw new Error('The real bundle build-info differs from both origins.');
    const provenance = json(readFileSync(resolve(dir, 'ca-provenance.json')));
    if (
      provenance.schema !== 1 ||
      provenance.commit !== baseline.ca_sha ||
      provenance.builtBy !== 'github-actions' ||
      provenance.dirty !== false ||
      provenance.historyComplete !== true ||
      provenance.validationOnly === true ||
      provenance.ciRun !== `https://github.com/${repo}/actions/runs/${originalRunId}`
    )
      throw new Error('Original immutable bytes are not a clean production build.');
    const receipt = {
      schema: 1,
      kind: 'retained-client-runtime',
      runtimeSha: baseline.ca_sha,
      verificationSha: target,
      sourceRunId: process.env.GITHUB_RUN_ID,
      sourceTriggerSha: process.env.GITHUB_SHA,
      repositoryId: process.env.GITHUB_REPOSITORY_ID,
      originalPublisherRunId: originalRunId,
      originalArtifactId: artifact.id,
      manifestSHA256,
      buildInfoSHA256: hash(info[0]),
      inputs,
      paths: comparison.paths,
    };
    readRetentionReceipt(
      receipt,
      process.env.GITHUB_RUN_ID,
      process.env.GITHUB_SHA,
      process.env.GITHUB_REPOSITORY_ID
    );
    await requireCurrentReceipt(receipt);
    return receipt;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export async function publicationDecision(admission) {
  try {
    const receipt = await admission();
    if (!receipt) throw new Error('Missing retention admission evidence.');
    return { publish: false, receipt };
  } catch (error) {
    return { publish: true, reason: error.message };
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'admit') {
    const decision = await publicationDecision(() => admit(args[0]));
    if (!decision.publish) {
      const receipt = decision.receipt;
      writeFileSync('runtime-admission.json', `${JSON.stringify(receipt, null, 2)}\n`);
      appendFileSync(process.env.GITHUB_OUTPUT, 'publish=false\n');
      console.log(
        `Retaining actual client ${receipt.runtimeSha}; verification source ${receipt.verificationSha}.`
      );
    } else {
      appendFileSync(process.env.GITHUB_OUTPUT, 'publish=true\n');
      console.log(`Normal publication required: ${decision.reason}`);
    }
  } else if (command === 'finalize') {
    const receipt = readRetentionReceipt(
      readFileSync('runtime-admission.json', 'utf8'),
      process.env.GITHUB_RUN_ID,
      process.env.GITHUB_SHA,
      process.env.GITHUB_REPOSITORY_ID
    );
    if (git('rev-parse', 'HEAD').toString().trim() !== receipt.verificationSha)
      throw new Error('Wrong qualification source checkout.');
    await requireCurrentReceipt(receipt);
    writeFileSync(args[0], `${JSON.stringify(receipt, null, 2)}\n`);
  } else if (command === 'receive') {
    const receipt = readRetentionReceipt(readFileSync(args[0], 'utf8'), args[1], args[2], args[3]);
    await requireCurrentReceipt(receipt);
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `sha=${receipt.runtimeSha}\nverification_sha=${receipt.verificationSha}\n`
    );
  } else if (command === 'receipt-artifact') {
    console.log(receiptArtifactId(json(readFileSync(0, 'utf8')), ...args));
  } else if (command === 'harness') {
    if (git('rev-parse', 'HEAD').toString().trim() !== args[1])
      throw new Error('Retained verification source mismatch.');
    const receipt = readRetentionReceipt(readFileSync(args[2], 'utf8'), args[3], args[4], args[5]);
    if (receipt.runtimeSha !== args[0] || receipt.verificationSha !== args[1])
      throw new Error('Retained runtime harness does not match its receipt.');
    await requireCurrentReceipt(receipt);
  } else throw new Error('Unsupported runtime retention command.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
