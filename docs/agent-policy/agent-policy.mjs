import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  lstatSync,
  realpathSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Bounded, directly invoked evidence reader. No network, publisher, scheduler or retry.
export const POLICY_VERSION = '2.9';
export const POLICY_FILES = {
  'OWNER-POLICY.md': 'AGENTS.md',
  'OPERATING-LAW.md': 'AGENT-OPERATING-LAW.md',
  'HARDENING.md': 'AGENT-HARDENING-STANDARD.md',
  'REFERENCE-INDEX.md': 'AGENT-REFERENCE-INDEX.md',
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const requireValue = (ok, message) => {
  if (!ok) throw new Error(message);
};
const ownDir = dirname(fileURLToPath(import.meta.url));
const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))),
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trimEnd();
const physicalFile = (dir, name) => {
  requireValue(/^[A-Za-z0-9_.-]+$/.test(name), 'Unsafe policy filename');
  const path = join(dir, name);
  requireValue(lstatSync(path).isFile(), `Policy input must be a regular file: ${name}`);
  return path;
};

export function verifyPolicy(dir = ownDir) {
  const manifest = json(physicalFile(dir, 'policy-manifest.json'));
  requireValue(
    manifest.schemaVersion === 1 && manifest.policyVersion === POLICY_VERSION,
    'Unsupported policy version'
  );
  requireValue(
    JSON.stringify(Object.keys(manifest.files).sort()) ===
      JSON.stringify(
        [...Object.keys(POLICY_FILES), 'agent-policy.mjs', 'agent-policy.test.mjs'].sort()
      ),
    'Incomplete policy manifest'
  );
  const files = {};
  for (const [name, hash] of Object.entries(manifest.files)) {
    requireValue(/^[a-f0-9]{64}$/.test(hash), `Invalid hash: ${name}`);
    const localName = existsSync(join(dir, name)) ? name : POLICY_FILES[name];
    const path = physicalFile(dir, localName ?? name);
    const bytes = readFileSync(path);
    requireValue(digest(bytes) === hash, `Policy drift: ${path}`);
    if (name.endsWith('.md'))
      requireValue(
        bytes.toString().includes(`Policy version: ${POLICY_VERSION}`),
        `Missing policy version: ${name}`
      );
    files[name] = { path, sha256: hash };
  }
  requireValue(
    manifest.references?.active?.length === 4 &&
      Object.keys(POLICY_FILES).every((f) => manifest.references.active.includes(f)),
    'Active policy references incomplete'
  );
  requireValue(
    Array.isArray(manifest.references.historicalPrefixes) &&
      manifest.references.historicalPrefixes.length > 0,
    'Historical reference roles missing'
  );
  return {
    policyVersion: POLICY_VERSION,
    manifestSHA256: digest(readFileSync(join(dir, 'policy-manifest.json'))),
    files,
  };
}

export function comparePolicies(left, right) {
  const a = verifyPolicy(left),
    b = verifyPolicy(right);
  requireValue(
    a.manifestSHA256 === b.manifestSHA256,
    'Policy copies differ; reconcile against current owner authority, do not overwrite another task'
  );
  return { policyVersion: POLICY_VERSION, copiesAgree: true };
}

export function referenceRole(path, manifest) {
  if (manifest.references.active.includes(path.replace(/^docs\/agent-policy\//, '')))
    return 'active-policy';
  if (manifest.references.historicalPrefixes.some((prefix) => path.startsWith(prefix)))
    return 'historical-evidence';
  return 'scope-specific-reference';
}

export function classifyDelivery(paths, contract = null) {
  requireValue(
    Array.isArray(paths) &&
      paths.length > 0 &&
      paths.every(
        (p) =>
          typeof p === 'string' &&
          p &&
          !p.startsWith('/') &&
          !p.includes('\0') &&
          !p.split('/').includes('..')
      ),
    'Changed paths unavailable or malformed'
  );
  const components = new Set(),
    reasons = [],
    unknown = [];
  for (const path of paths) {
    if (
      /(?:^tests\/|^__tests__\/|^server\/sim\/|^operations\/release\/(?:fixture|native|ci)\/|\.(?:test|spec)\.[cm]?[jt]sx?$)/.test(
        path
      )
    ) {
      components.add('verification');
      continue;
    }
    if (
      /^(server\/(src|Dockerfile|package|tsconfig)|\.github\/workflows\/(auto-deploy-hetzner|stage-engine-release)\.|\.github\/scripts\/(engine-|audit-engine)|operations\/release\/)/.test(
        path
      )
    ) {
      components.add('engine');
      reasons.push(`Engine runtime or release input: ${path}`);
    } else if (/^(supabase\/|migrations\/)|\.sql$/.test(path)) components.add('database');
    else if (/\.(md|mdx)$/.test(path)) components.add('documentation');
    else if (/^(src\/|pages\/|app\/|public\/|components\/|styles\/)/.test(path))
      components.add('client');
    else if (
      /^(scripts\/|tests\/|__tests__\/|\.github\/|\.husky\/|docs\/agent-policy\/)/.test(path)
    )
      components.add('delivery-tooling');
    else unknown.push(path);
  }
  if (contract !== null) {
    requireValue(
      typeof contract.dependency === 'string' &&
        contract.dependency.trim() &&
        typeof contract.evidence === 'string' &&
        contract.evidence.trim(),
      'New engine contract requires the specific dependency and source evidence'
    );
    components.add('engine-contract');
    reasons.push(`New contract: ${contract.dependency}; evidence: ${contract.evidence}`);
  }
  if (unknown.length) components.add('unclassified');
  return {
    components: [...components].sort(),
    engineActivationRequired: components.has('engine') || components.has('engine-contract'),
    engineReasons: reasons,
    unclassifiedPaths: unknown,
    preparation:
      'Proceed now with applicable prechecks, submission, protected merge, build and staging',
    publication: reasons.length
      ? 'Gate only engine activation or dependent behavior on its certified window'
      : 'Use the normal component route immediately; no hourly gate',
    classificationComplete: unknown.length === 0,
    limitation:
      'Path evidence is not a compatibility review. Identify any required new engine contract explicitly; CI suite selection is separate.',
  };
}

export function inspectCandidate(cwd, base, head = 'HEAD', contract = null) {
  const actualHead = git(cwd, 'rev-parse', `${head}^{commit}`);
  const baseSHA = git(cwd, 'rev-parse', `${base}^{commit}`);
  const mergeBase = git(cwd, 'merge-base', '--all', baseSHA, actualHead);
  requireValue(/^[a-f0-9]{40}$/.test(mergeBase), 'Unique merge base required');
  const paths = git(
    cwd,
    'diff',
    '--name-only',
    '--no-renames',
    '-z',
    `${mergeBase}..${actualHead}`,
    '--'
  )
    .split('\0')
    .filter(Boolean);
  return {
    head: actualHead,
    tree: git(cwd, 'rev-parse', `${actualHead}^{tree}`),
    base: baseSHA,
    mergeBase,
    paths,
    trackedWorktreeClean: git(cwd, 'status', '--porcelain', '--untracked-files=no') === '',
    delivery: classifyDelivery(paths, contract),
  };
}

export function nextAction(state) {
  requireValue(state && typeof state === 'object', 'Delivery state required');
  if (state.outcome === 'unknown')
    return {
      action: 'read-owning-operation',
      retry: false,
      operation: state.operation ?? null,
      independentWork: true,
    };
  if (state.outcome === 'published')
    return { action: 'verify-live-identity-and-behavior', retry: false, independentWork: true };
  if (['build-failed', 'check-failed', 'preflight-failed'].includes(state.outcome))
    return { action: 'diagnose-fix-revalidate-and-submit', hourlyWait: false, retry: false };
  if (state.access !== 'available')
    return {
      action: 'resolve-specific-access',
      dependentActionAllowed: false,
      independentWork: true,
      ownerApprovalRequired: false,
    };
  if (state.helper === 'unavailable')
    return {
      action: 'recover-owned-work-and-complete-directly',
      confirmNoOtherWriter: true,
      waitForChat: false,
    };
  if (state.outcome === 'cutover-failed')
    return {
      action: 'read-serving-version-and-owning-recovery',
      retry: false,
      reassessCertificateNow: true,
    };
  if (state.checks !== 'passed')
    return { action: 'complete-applicable-checks', hourlyWait: false, retry: false };
  if (state.classificationComplete === false)
    return { action: 'inspect-unclassified-inputs-and-contracts', hourlyWait: false, retry: false };
  if (state.engineActivationRequired === true)
    return {
      action: 'prepare-now-activate-only-with-owner-certificate',
      hourlyWaitForPreparation: false,
      certificateRequired: true,
    };
  requireValue(state.engineActivationRequired === false, 'Delivery classification missing');
  return { action: 'publish-and-verify-now', hourlyWait: false, waitForChat: false };
}

const instant = (value) =>
  typeof value === 'string' &&
  /(?:Z|[+-]\d\d:\d\d)$/.test(value) &&
  Number.isFinite(Date.parse(value))
    ? Date.parse(value)
    : null;
export function duration(start, end) {
  const a = instant(start),
    b = instant(end);
  return a === null || b === null || b < a ? null : (b - a) / 1000;
}
export function providerTiming(run, jobs) {
  requireValue(
    run && typeof run.id === 'number' && /^[a-f0-9]{40}$/.test(run.head_sha ?? ''),
    'Provider run identity required'
  );
  requireValue(
    jobs &&
      Array.isArray(jobs.jobs) &&
      Number.isInteger(jobs.total_count) &&
      jobs.total_count === jobs.jobs.length,
    'Complete provider jobs response required; paginate before reporting'
  );
  requireValue(
    jobs.jobs.every((job) => job.run_id === run.id),
    'Jobs belong to another run'
  );
  return {
    runId: run.id,
    revision: run.head_sha,
    conclusion: run.conclusion ?? 'unknown',
    runQueueSeconds: duration(run.created_at, run.run_started_at),
    jobs: jobs.jobs.map((job) => ({
      id: job.id,
      name: job.name,
      conclusion: job.conclusion ?? 'unknown',
      executionSeconds: duration(job.started_at, job.completed_at),
      runnerQueueSeconds: null,
    })),
    limitation:
      'GitHub job responses do not expose per-job enqueue time. Do not call dependency wait runner queue time, or add overlapping job durations to claim elapsed delivery time.',
  };
}

export function deliveryReport(input) {
  requireValue(
    input?.schemaVersion === 1 && /^[a-f0-9]{40}$/.test(input.revision ?? ''),
    'Report needs exact revision'
  );
  requireValue(
    Array.isArray(input.requiredEvidence) &&
      input.requiredEvidence.length > 0 &&
      new Set(input.requiredEvidence).size === input.requiredEvidence.length,
    'Explicit unique required evidence list needed'
  );
  requireValue(Array.isArray(input.evidence), 'Evidence array required');
  requireValue(
    new Set(input.evidence.map((e) => e.id)).size === input.evidence.length,
    'Duplicate evidence identity'
  );
  const results = input.requiredEvidence.map((id) => {
    const item = input.evidence.find((e) => e.id === id);
    const identityMatches = item?.revision === input.revision;
    const actualResult =
      identityMatches &&
      typeof item.source === 'string' &&
      item.source.trim() &&
      instant(item.observedAt) !== null;
    const status =
      actualResult && ['passed', 'failed', 'pending', 'unknown'].includes(item.status)
        ? item.status
        : 'unknown';
    return {
      id,
      status,
      source: item?.source ?? null,
      reason: !item
        ? 'Missing evidence'
        : !actualResult
          ? 'Missing provenance, timestamp or exact revision'
          : null,
    };
  });
  const stages = [
    'preparation',
    'runner-queue',
    'execution',
    'publication',
    'activation',
    'verification',
  ];
  return {
    schemaVersion: 1,
    revision: input.revision,
    policyVersion: POLICY_VERSION,
    results,
    suppliedRequirementsSatisfied: results.every((r) => r.status === 'passed'),
    remaining: results.filter((r) => r.status !== 'passed').map((r) => r.id),
    nextAction: input.state
      ? nextAction(input.state)
      : {
          action: 'inspect-existing-checklist-and-provider-results',
          reason: 'No authoritative operation state supplied',
        },
    timing: stages.map((phase) => {
      const item = input.intervals?.find((v) => v.phase === phase);
      return {
        phase,
        seconds: item?.source ? duration(item.start, item.end) : null,
        source: item?.source ?? null,
      };
    }),
    limitation:
      'This summarizes supplied evidence; it does not authenticate provider data, determine all applicable requirements, grant release authority or certify agent behavior. Use the maintained workflow and acceptance checklist.',
  };
}

function hookReport(cwd, start, exitCode) {
  requireValue(
    Number.isFinite(Number(start)) && /^\d+$/.test(exitCode),
    'Hook start and actual exit status required'
  );
  const observedAt = new Date().toISOString(),
    revision = git(cwd, 'rev-parse', 'HEAD');
  const report = deliveryReport({
    schemaVersion: 1,
    revision,
    requiredEvidence: ['local-prepush', 'protected-checks', 'publication', 'live-verification'],
    evidence: [
      {
        id: 'local-prepush',
        revision,
        status: exitCode === '0' ? 'passed' : 'failed',
        source: '.husky/pre-push EXIT status',
        observedAt,
      },
    ],
    intervals: [
      {
        phase: 'preparation',
        start: new Date(Number(start) * 1000).toISOString(),
        end: observedAt,
        source: 'Local pre-push start/end; excludes earlier implementation time',
      },
    ],
  });
  report.scope =
    'Local prechecks only. Remaining publication/live proof is component-specific; instruction-only work needs protected source and applicable executed checks, never an engine cutover.';
  report.tree = git(cwd, 'rev-parse', 'HEAD^{tree}');
  try {
    report.candidate = inspectCandidate(cwd, 'origin/main');
  } catch {
    report.candidate = {
      status: 'unknown',
      reason: 'No nonempty verifiable candidate diff against origin/main',
    };
  }
  report.policy = verifyPolicy();
  const path = resolve(cwd, git(cwd, 'rev-parse', '--git-path', 'agent-policy-preflight.json'));
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temp, path);
  console.log(
    `Policy ${POLICY_VERSION}; local pre-push ${exitCode === '0' ? 'passed' : 'failed'}. Remaining evidence: ${report.remaining.join(', ')}. Report: ${path}`
  );
}

export function cli(args) {
  const [command, ...values] = args;
  if (command === 'check') {
    requireValue(
      values.length % 2 === 0 &&
        values.every((v, i) => i % 2 || ['--canonical', '--peer'].includes(v)),
      'check [--canonical DIR] [--peer DIR]'
    );
    const receipt = verifyPolicy();
    for (let i = 0; i < values.length; i += 2) comparePolicies(ownDir, resolve(values[i + 1]));
    console.log(JSON.stringify(receipt, null, 2));
  } else if (command === 'read') {
    requireValue(values.length === 0, 'read takes no arguments');
    const receipt = verifyPolicy();
    for (const name of Object.keys(POLICY_FILES)) {
      console.log(
        `\n--- ${receipt.files[name].path} ---\n${readFileSync(receipt.files[name].path, 'utf8')}`
      );
    }
    console.log(
      JSON.stringify(
        {
          ...receipt,
          emittedAt: new Date().toISOString(),
          kind: 'policy-content-emitted',
          limitation:
            'Record in the existing checkpoint only after reading the full output. Read repository, publishing, nested instructions and task checkpoint separately. Not proof of comprehension or compliance.',
        },
        null,
        2
      )
    );
  } else if (command === 'plan') {
    requireValue(
      values.length >= 1 && values.length <= 3,
      'plan BASE [HEAD] [NEW_ENGINE_CONTRACT_JSON]'
    );
    console.log(
      JSON.stringify(
        inspectCandidate(
          process.cwd(),
          values[0],
          values[1] ?? 'HEAD',
          values[2] ? json(values[2]) : null
        ),
        null,
        2
      )
    );
  } else if (command === 'report') {
    requireValue(values.length === 1, 'report EVIDENCE_JSON');
    console.log(JSON.stringify(deliveryReport(json(values[0])), null, 2));
  } else if (command === 'timing') {
    requireValue(values.length === 2, 'timing RUN_JSON COMPLETE_JOBS_JSON');
    console.log(JSON.stringify(providerTiming(json(values[0]), json(values[1])), null, 2));
  } else if (command === 'ci-report') {
    requireValue(values.length === 0, 'ci-report takes no arguments');
    const needs = JSON.parse(process.env.POLICY_CI_NEEDS ?? '{}');
    const revision = process.env.POLICY_CI_REVISION;
    const report = deliveryReport({
      schemaVersion: 1,
      revision,
      requiredEvidence: Object.keys(needs),
      evidence: Object.entries(needs).map(([id, job]) => ({
        id,
        revision,
        status:
          job.result === 'success' ? 'passed' : job.result === 'failure' ? 'failed' : 'unknown',
        source: `Actions run ${process.env.GITHUB_RUN_ID ?? 'unknown'} needs.${id}.result`,
        observedAt: new Date().toISOString(),
      })),
    });
    console.log(JSON.stringify(report, null, 2));
  } else if (command === 'hook-report') {
    requireValue(values.length === 2, 'hook-report START_EPOCH ACTUAL_EXIT_CODE');
    hookReport(process.cwd(), ...values);
  } else throw new Error('Commands: check, read, plan, report, timing, ci-report, hook-report');
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    cli(process.argv.slice(2));
  } catch (error) {
    console.error(`Agent policy: ${error.message}`);
    process.exitCode = 1;
  }
}
