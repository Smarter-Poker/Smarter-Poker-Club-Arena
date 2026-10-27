#!/usr/bin/env node
/**
 * P15-A step 4: exact historical replay, one fresh process per decision.
 *
 *   node scripts/phase15-exact-replay.mjs <journal copy .ndjson> [--limit N] [--since <iso>]
 *        [--until <iso>] [--store-snapshot <json>]... [--concurrency K] [--out <dir>]
 *        [--full-verdicts <path outside the repo>] [--label <name>] [--note <text>]...
 *        [--node <node executable>] [--esbuild-binary <esbuild executable>]
 *
 *   node scripts/phase15-exact-replay.mjs --child --running-source <sha> [--store-snapshot <json>]...
 *        (stdin: {"record": <decision record>, "execution": <execution record> | null})
 *
 *   node scripts/phase15-exact-replay.mjs --v56-cases [--store-snapshot <json>]...
 *        [--node <node executable>] [--esbuild-binary <esbuild executable>]
 *        (private stdin: {"version":1,"cases":[{"decisionSha256":<hash>,"records":[...]}]})
 *        One fresh bounded offline child per explicit case; sanitized output only.
 *
 * The batch mode selects the newest N decision records (at or after --since,
 * before --until)
 * in the read-only copy, joins each to the execution record of the same turn,
 * and replays each in its own child process: a new Node process with no
 * module state from any other record, a scrubbed environment (no database
 * address or key, no journal directory, no policy artifact path) and the
 * running source named by `git rev-parse HEAD` of a clean checkout. The child
 * loads the store snapshots through the production store modules, refuses
 * any whose computed identity is not the one the file declares, runs
 * server/src/engine/horseDecision/replay/exactReplay.ts and prints one
 * verdict line. Nothing is written to the journal, the database or a table.
 *
 * A record replays only on the JavaScript runtime that made it (Node and V8
 * version, CPU architecture; exactReplay refuses any other). --node names the
 * executable the children run on, for example the engine's Node release for
 * its architecture; --esbuild-binary gives the TypeScript loader the esbuild
 * build for that architecture.
 *
 * Committed evidence is aggregate: counts by outcome, first difference,
 * (format, variant, street) and acceptance join; no decision, hand, player or
 * table id and no cards. --full-verdicts writes the per-decision verdicts to
 * a path outside the repository.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '..');
const SHA = /^[0-9a-f]{40}$/;

function parseArgs(argv) {
  const out = {
    child: false,
    v56Cases: false,
    v56Child: false,
    runningSource: null,
    journal: null,
    limit: 200,
    since: null,
    until: null,
    storeSnapshots: [],
    concurrency: 4,
    out: join(repoRoot, 'docs', 'evidence', 'phase15'),
    fullVerdicts: null,
    label: null,
    notes: [],
    node: process.execPath,
    esbuildBinary: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--v56-cases') out.v56Cases = true;
    else if (a === '--v56-child') out.v56Child = true;
    else if (a === '--child') out.child = true;
    else if (a === '--running-source') out.runningSource = next();
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--since') out.since = next();
    else if (a === '--until') out.until = next();
    else if (a === '--store-snapshot') out.storeSnapshots.push(resolve(next()));
    else if (a === '--concurrency') out.concurrency = Number(next());
    else if (a === '--out') out.out = resolve(next());
    else if (a === '--full-verdicts') out.fullVerdicts = resolve(next());
    else if (a === '--label') out.label = next();
    else if (a === '--note') out.notes.push(next());
    else if (a === '--node') out.node = resolve(next());
    else if (a === '--esbuild-binary') out.esbuildBinary = resolve(next());
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else out.journal = resolve(a);
  }
  return out;
}

/** Only what Node needs to start; nothing that names a database, journal or artifact. */
export function exactReplayChildEnv(env = process.env, esbuildBinary = null) {
  const kept = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (env[key]) kept[key] = env[key];
  return {
    ...kept,
    ...(esbuildBinary ? { ESBUILD_BINARY_PATH: esbuildBinary } : {}),
    TZ: 'UTC',
    // Modules that build a database client at load time get an address that
    // resolves to nothing and a key that is not one.
    SUPABASE_URL: 'https://supabase.invalid',
    SUPABASE_SERVICE_ROLE_KEY: 'phase15-exact-replay-offline-placeholder',
  };
}

async function readStdin(maxBytes = Infinity) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('v56_input_bounds');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Refuse and count every outbound connection: the replay has no database, table or network. */
async function refuseNetwork() {
  const attempts = { fetch: 0, socket: 0 };
  globalThis.fetch = async () => {
    attempts.fetch++;
    throw new Error('exact replay has no network');
  };
  const net = await import('node:net');
  const connect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function refusedConnect(...args) {
    // A local IPC pipe (the TypeScript loader's own) is not a network peer.
    const target = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (
      (target && typeof target === 'object' && typeof target.path === 'string') ||
      (typeof target === 'string' && !/^\d+$/.test(target))
    )
      return connect.apply(this, args);
    attempts.socket++;
    queueMicrotask(() => this.destroy(new Error('exact replay has no network')));
    return this;
  };
  return attempts;
}

async function child(args) {
  if (!SHA.test(String(args.runningSource))) throw new Error('--running-source must be a full SHA');
  const input = JSON.parse(await readStdin());
  const attempts = await refuseNetwork();
  const { register } = await import('tsx/esm/api');
  register();
  const src = (p) => pathToFileURL(join(serverRoot, 'src', p)).href;
  const { exactReplayHorseDecisionRecord } = await import(
    src('engine/horseDecision/replay/exactReplay.ts')
  );
  const { currentReplaySolverStores } = await import(
    src('engine/horseDecision/replay/references.ts')
  );
  await hydrateReplayStores(args.storeSnapshots, src);
  const verdict = await exactReplayHorseDecisionRecord(input.record, {
    runningSource: args.runningSource,
    stores: currentReplaySolverStores(),
    execution: input.execution === undefined ? undefined : input.execution,
    planReceipt: input.planReceipt === undefined ? undefined : input.planReceipt,
  });
  process.stdout.write(
    `${JSON.stringify({ ...verdict, isolation: { pid: process.pid, networkAttempts: attempts } })}\n`
  );
}

async function hydrateReplayStores(storeSnapshots, src) {
  const { sameSolverStoreIdentity, isSolverStoreIdentity } = await import(
    src('gto/SolverStoreIdentity.ts')
  );
  const { setGtoCharts, gtoChartStoreIdentity } = await import(src('engine/GtoCharts.ts'));
  const { replaceGtoPostflop, gtoPostflopStoreIdentity } = await import(
    src('engine/GtoPostflop.ts')
  );
  for (const file of storeSnapshots) {
    const snap = JSON.parse(readFileSync(file, 'utf8'));
    if (snap.version !== 'phase6c-store-snapshot-v1' || !isSolverStoreIdentity(snap.identity))
      throw new Error(`${file} is not a store snapshot`);
    let computed;
    if (snap.store === 'chart_store') {
      setGtoCharts(snap.rows);
      computed = gtoChartStoreIdentity();
    } else {
      replaceGtoPostflop(snap.rows, snap.identity.revision);
      computed = gtoPostflopStoreIdentity();
    }
    if (
      !sameSolverStoreIdentity(computed, snap.identity) ||
      computed.revision !== snap.identity.revision
    )
      throw new Error(`${file} does not hold the identity it declares`);
  }
}

/** Replay one record in a fresh process; resolves to its verdict or a named failure. */
export function replayInFreshProcess({
  record,
  execution,
  planReceipt,
  runningSource,
  storeSnapshots = [],
  node = process.execPath,
  esbuildBinary = null,
}) {
  return new Promise((resolvePromise) => {
    const argv = [fileURLToPath(import.meta.url), '--child', '--running-source', runningSource];
    for (const file of storeSnapshots) argv.push('--store-snapshot', file);
    const proc = spawn(node, argv, {
      cwd: serverRoot,
      env: exactReplayChildEnv(process.env, esbuildBinary),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('close', (code) => {
      const line = stdout.trim().split('\n').pop();
      try {
        if (code !== 0) throw new Error(`child exited ${code}`);
        resolvePromise({ verdict: JSON.parse(line), pid: proc.pid });
      } catch (error) {
        resolvePromise({
          verdict: null,
          pid: proc.pid,
          error: `${error.message}: ${stderr.slice(-400)}`,
        });
      }
    });
    proc.stdin.end(JSON.stringify({ record, execution, planReceipt }));
  });
}

function readCopy(path) {
  const decisions = [];
  const executions = new Map();
  const planReceipts = new Map();
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    const parsed = JSON.parse(line);
    const record = parsed && typeof parsed.kind === 'string' ? parsed : parsed?.record;
    if (!record || typeof record.kind !== 'string') continue;
    if (record.kind === 'decision') decisions.push({ ordinal: index, record });
    else if (record.kind === 'execution') executions.set(record.turnKey, record);
    else if (record.kind === 'plan_receipt') planReceipts.set(record.turnKey, record);
  }
  return { decisions, executions, planReceipts };
}

const tally = (rows, key) => {
  const out = {};
  for (const row of rows) {
    const k = key(row);
    out[k] = (out[k] ?? 0) + 1;
  }
  return Object.fromEntries(
    Object.entries(out).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  );
};

async function batch(args) {
  if (!args.journal) throw new Error('a journal copy (.ndjson) is required');
  const runningSource = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain', '--', 'server'], {
    cwd: repoRoot,
    encoding: 'utf8',
  }).trim();
  // The running source is a commit only when the tree is that commit.
  if (dirty)
    throw new Error(
      'the server tree differs from HEAD; exact replay runs only on a clean checkout'
    );
  const sinceMs = args.since ? Date.parse(args.since) : 0;
  const untilMs = args.until ? Date.parse(args.until) : Number.POSITIVE_INFINITY;
  if (Number.isNaN(sinceMs) || Number.isNaN(untilMs))
    throw new Error('--since/--until must be ISO times');
  const { decisions, executions, planReceipts } = readCopy(args.journal);
  const selected = decisions
    .filter((row) => Number(row.record.atMs) >= sinceMs && Number(row.record.atMs) < untilMs)
    .sort((a, b) => Number(b.record.atMs) - Number(a.record.atMs) || b.ordinal - a.ordinal)
    .slice(0, args.limit);
  const startedAt = new Date();
  const results = new Array(selected.length);
  let next = 0;
  const pids = new Set();
  const worker = async () => {
    while (next < selected.length) {
      const i = next++;
      const { record } = selected[i];
      const execution = executions.get(record.turnKey) ?? null;
      const run = await replayInFreshProcess({
        record,
        execution,
        planReceipt: planReceipts.get(record.turnKey) ?? null,
        runningSource,
        storeSnapshots: args.storeSnapshots,
        node: args.node,
        esbuildBinary: args.esbuildBinary,
      });
      pids.add(run.pid);
      results[i] = run;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, args.concurrency) }, worker));
  const finishedAt = new Date();
  const verdicts = results.map((r) => r.verdict).filter(Boolean);
  const failures = results.filter((r) => !r.verdict).length;
  const cell = (v) =>
    `${v.context.format ?? v.context.gameMode ?? 'unknown'}/${v.context.variant ?? 'unknown'}/${v.context.stage ?? 'unknown'}`;
  const summary = {
    version: 'phase15-exact-replay-evidence-v1',
    label: args.label,
    command: ['node', 'scripts/phase15-exact-replay.mjs', ...process.argv.slice(2)].join(' '),
    runningSource,
    childRuntime: execFileSync(
      args.node,
      ['-p', 'JSON.stringify({node:process.version,v8:process.versions.v8,arch:process.arch})'],
      { encoding: 'utf8' }
    ).trim(),
    journalCopySha256: createHash('sha256').update(readFileSync(args.journal)).digest('hex'),
    batchRule: `newest ${args.limit} decision records at or after ${args.since ?? 'the start of the copy'} and before ${args.until ?? 'the end of the copy'}, one fresh process each`,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    decisionsInCopy: decisions.length,
    executionsInCopy: executions.size,
    planReceiptsInCopy: planReceipts.size,
    replayed: selected.length,
    freshProcesses: pids.size,
    childFailures: failures,
    window: selected.length
      ? {
          from: new Date(Math.min(...selected.map((r) => Number(r.record.atMs)))).toISOString(),
          to: new Date(Math.max(...selected.map((r) => Number(r.record.atMs)))).toISOString(),
        }
      : null,
    recordedSources: tally(verdicts, (v) => v.recordedSource ?? 'null'),
    recordedRuntimesByOutcome: tally(
      verdicts,
      (v) =>
        `${v.recordedRuntime ? `${v.recordedRuntime.node}/${v.recordedRuntime.arch}` : 'none'} ${v.outcome}`
    ),
    outcomes: tally(verdicts, (v) => v.outcome),
    replayVerified: verdicts.filter((v) => v.replayVerified).length,
    networkAttempts: verdicts.reduce(
      (n, v) =>
        n + (v.isolation?.networkAttempts.fetch ?? 0) + (v.isolation?.networkAttempts.socket ?? 0),
      0
    ),
    firstDifferences: tally(
      verdicts.filter((v) => v.firstDifference),
      (v) => `${v.outcome} ${v.firstDifference.replace(/\[\d+\]/g, '[]')}`
    ),
    byCell: Object.fromEntries(
      Object.entries(
        verdicts.reduce((acc, v) => {
          (acc[cell(v)] ??= []).push(v);
          return acc;
        }, {})
      )
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, vs]) => [k, tally(vs, (v) => v.outcome)])
    ),
    acceptance: tally(verdicts, (v) =>
      v.acceptance.status === 'joined'
        ? `joined:${v.acceptance.executionStatus}:selected_${v.acceptance.selectedEqualsDecision ? 'equal' : 'differs'}`
        : `not_joined:${v.acceptance.reason}`
    ),
    durableEffectReceipts: tally(verdicts, (v) => v.acceptance.durableEffectReceipt),
    durableEffectReceiptsByOutcome: tally(
      verdicts,
      (v) => `${v.outcome} ${v.acceptance.durableEffectReceipt}`
    ),
    notes: args.notes,
  };
  mkdirSync(args.out, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
  const base = join(args.out, `phase15-exact-replay-${args.label ?? 'batch'}-${stamp}`);
  writeFileSync(`${base}.json`, `${JSON.stringify(summary, null, 2)}\n`);
  const table = (obj) =>
    [
      '| Value | Count |',
      '| --- | --- |',
      ...Object.entries(obj).map(([k, n]) => `| \`${k}\` | ${n} |`),
    ].join('\n');
  writeFileSync(
    `${base}.md`,
    [
      `# P15-A exact historical replay evidence (${summary.startedAt})`,
      '',
      `- Command: \`${summary.command}\``,
      `- Running source: \`${runningSource}\``,
      `- Child runtime: \`${summary.childRuntime}\``,
      `- Batch rule: ${summary.batchRule}`,
      `- Copy: ${summary.decisionsInCopy} decision records, ${summary.executionsInCopy} execution records, ${summary.planReceiptsInCopy} plan receipts (sha256 \`${summary.journalCopySha256}\`)`,
      `- Window: ${summary.window ? `${summary.window.from} to ${summary.window.to}` : 'empty'}`,
      `- Replayed: ${summary.replayed} in ${summary.freshProcesses} fresh processes, ${failures} child failures`,
      `- replayVerified: ${summary.replayVerified}`,
      `- Outbound connection attempts refused in the children: ${summary.networkAttempts}`,
      '',
      '## Recorded Sources',
      '',
      table(summary.recordedSources),
      '',
      '## Outcomes',
      '',
      table(summary.outcomes),
      '',
      '## Recorded Runtime By Outcome',
      '',
      table(summary.recordedRuntimesByOutcome),
      '',
      '## First Differences',
      '',
      Object.keys(summary.firstDifferences).length ? table(summary.firstDifferences) : 'None.',
      '',
      '## Acceptance Join',
      '',
      table(summary.acceptance),
      '',
      '## Durable Accepted-Effect Receipts',
      '',
      table(summary.durableEffectReceiptsByOutcome),
      '',
      '## Outcomes By Format, Variant And Street',
      '',
      '| Cell | Outcomes |',
      '| --- | --- |',
      ...Object.entries(summary.byCell).map(
        ([k, t]) =>
          `| \`${k}\` | ${Object.entries(t)
            .map(([o, n]) => `${o} ${n}`)
            .join(', ')} |`
      ),
      '',
      ...(args.notes.length ? ['## Notes', '', ...args.notes.map((n) => `- ${n}`), ''] : []),
    ].join('\n')
  );
  if (args.fullVerdicts) writeFileSync(args.fullVerdicts, `${JSON.stringify(verdicts)}\n`);
  process.stdout.write(
    `${JSON.stringify({ base, outcomes: summary.outcomes, replayVerified: summary.replayVerified, childFailures: failures })}\n`
  );
}

const V56_BATCH_BYTES = 32 * 1024 * 1024;
const V56_HAND_BYTES = 8 * 1024 * 1024;
const V56_OUTPUT_BYTES = 64 * 1024;
const V56_DEADLINE_MS = 30_000;
const v56Failure = (reason) => ({
  version: 'horse-v56-private-process-v1',
  status: 'unavailable',
  reason,
});
const v56Object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** Git cannot take an inherited alternative index/worktree/object store or
 * injected config as proof of the physical checkout that executes this file. */
export function v56GitEnv(environment = process.env) {
  const env = { ...environment };
  const advertised = execFileSync('git', ['rev-parse', '--local-env-vars'], {
    cwd: repoRoot,
    env: { PATH: environment.PATH ?? '/usr/bin:/bin' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
    .trim()
    .split('\n');
  for (const key of Object.keys(env))
    if (
      advertised.includes(key) ||
      key === 'GIT_CONFIG_PARAMETERS' ||
      key === 'GIT_CONFIG_COUNT' ||
      key.startsWith('GIT_CONFIG_KEY_') ||
      key.startsWith('GIT_CONFIG_VALUE_') ||
      ['GIT_CONFIG', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'].includes(key)
    )
      delete env[key];
  return env;
}
export function v56ExecutingSource(root = repoRoot, environment = process.env) {
  const env = v56GitEnv(environment);
  const git = (argv) =>
    execFileSync('git', argv, {
      cwd: root,
      env,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  if (realpathSync(git(['rev-parse', '--show-toplevel'])) !== realpathSync(root))
    throw Error('v56_source_unavailable');
  const source = git(['rev-parse', 'HEAD']);
  if (!SHA.test(source) || git(['status', '--porcelain', '--untracked-files=normal']))
    throw Error('v56_source_unavailable');
  return source;
}
export function v56CasesAreBounded(input) {
  try {
    return (
      v56Object(input) &&
      Object.keys(input).sort().join(',') === 'cases,version' &&
      input.version === 1 &&
      Array.isArray(input.cases) &&
      input.cases.length >= 1 &&
      input.cases.length <= 6 &&
      new Set(input.cases.map((c) => c.decisionSha256)).size === input.cases.length &&
      Buffer.byteLength(JSON.stringify(input)) <= V56_BATCH_BYTES &&
      input.cases.every(
        (c) =>
          v56Object(c) &&
          Object.keys(c).sort().join(',') === 'decisionSha256,records' &&
          /^[a-f0-9]{64}$/.test(c.decisionSha256) &&
          Array.isArray(c.records) &&
          c.records.length <= 256 &&
          Buffer.byteLength(JSON.stringify(c.records)) <= V56_HAND_BYTES
      )
    );
  } catch {
    return false;
  }
}
function v56FlagsAreClosed(argv, args) {
  const values = new Set(['--store-snapshot', '--node', '--esbuild-binary', '--running-source']);
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--v56-cases' || flag === '--v56-child') continue;
    if (!values.has(flag) || typeof argv[++i] !== 'string' || argv[i].startsWith('--'))
      return false;
    if (flag === '--running-source' && !args.v56Child) return false;
  }
  return args.v56Cases && !args.child && (!args.v56Child || SHA.test(String(args.runningSource)));
}

/** Fresh child, bounded input/output/deadline. No child's raw stderr escapes. */
export function replayV56InFreshProcess(
  { caseInput, runningSource, storeSnapshots = [], node = process.execPath, esbuildBinary = null },
  dependencies = {}
) {
  return new Promise((resolvePromise) => {
    if (
      !v56CasesAreBounded({ version: 1, cases: [caseInput] }) ||
      !SHA.test(String(runningSource))
    ) {
      resolvePromise(v56Failure('input_bounds'));
      return;
    }
    const argv = [
      fileURLToPath(import.meta.url),
      '--v56-cases',
      '--v56-child',
      '--running-source',
      runningSource,
    ];
    for (const file of storeSnapshots) argv.push('--store-snapshot', file);
    const proc = (dependencies.spawn ?? spawn)(node, argv, {
      cwd: serverRoot,
      env: exactReplayChildEnv(process.env, esbuildBinary),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let bytes = 0,
      stderrBytes = 0,
      stdout = '',
      settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(value);
    };
    const refuse = (reason) => {
      proc.kill('SIGKILL');
      finish(v56Failure(reason));
    };
    timer = setTimeout(() => refuse('child_deadline'), dependencies.deadlineMs ?? V56_DEADLINE_MS);
    proc.stdout.on('data', (data) => {
      bytes += data.length;
      if (bytes > V56_OUTPUT_BYTES) refuse('child_output_bounds');
      else stdout += data;
    });
    proc.stderr.on('data', (data) => {
      stderrBytes += data.length;
      if (stderrBytes > V56_OUTPUT_BYTES) refuse('child_output_bounds');
    });
    proc.on('error', () => finish(v56Failure('child_unavailable')));
    proc.stdin.on('error', () => refuse('child_unavailable'));
    proc.on('close', (code) => {
      if (settled) return;
      try {
        const value = JSON.parse(stdout.trim());
        if (
          code !== 0 ||
          !v56Object(value) ||
          Object.keys(value).sort().join(',') !== 'isolation,result,status,version' ||
          value.version !== 'horse-v56-private-process-v1' ||
          value.status !== 'computed' ||
          !v56SanitizedResult(value.result) ||
          (value.result.decisionSha256 !== null &&
            value.result.decisionSha256 !== caseInput.decisionSha256) ||
          !v56Object(value.isolation) ||
          Object.keys(value.isolation).sort().join(',') !== 'networkAttempts,pid' ||
          !Number.isSafeInteger(value.isolation.pid) ||
          value.isolation.pid <= 0 ||
          value.isolation.pid !== proc.pid ||
          !v56Object(value.isolation.networkAttempts) ||
          Object.keys(value.isolation.networkAttempts).sort().join(',') !== 'fetch,socket' ||
          value.isolation.networkAttempts.fetch !== 0 ||
          value.isolation.networkAttempts.socket !== 0
        )
          throw Error();
        finish(value);
      } catch {
        finish(v56Failure('child_unavailable'));
      }
    });
    proc.stdin.end(JSON.stringify({ version: 1, cases: [caseInput] }));
  });
}
function v56SanitizedResult(value) {
  const hashes = ['decisionSha256', 'readFrameSha256', 'onActionSha256', 'offActionSha256'];
  const booleans = [
    'originalExact',
    'originalAccepted',
    'v56Observed',
    'offComputed',
    'sameAdmissions',
    'actionChanged',
    'offAccepted',
    'activationAllowed',
  ];
  const reasons = [
    'bounds',
    'busy',
    'invalid_records',
    'case_unbound',
    'unsupported_deep',
    'outside_domain',
    'original_v56_off',
    'pins_missing',
    'hand_not_reconciled',
    'execution_unbound',
    'baseline_not_exact',
    'baseline_not_accepted',
    'v56_witness_unavailable',
    'v56_not_observed',
    'off_arm_unavailable',
    'admission_changed',
    'original_mutated',
    'executed_no_difference',
    'causal_application_observed',
  ];
  return (
    v56Object(value) &&
    Object.keys(value).sort().join(',') ===
      [...hashes, ...booleans, 'version', 'reason'].sort().join(',') &&
    value.version === 'horse-v56-private-counterfactual-v1' &&
    reasons.includes(value.reason) &&
    hashes.every((key) => value[key] === null || /^[a-f0-9]{64}$/.test(value[key])) &&
    booleans.every((key) => typeof value[key] === 'boolean') &&
    value.offAccepted === false &&
    value.activationAllowed === false
  );
}
async function v56Mode(args, argv) {
  if (!v56FlagsAreClosed(argv, args)) return v56Failure('arguments');
  let input;
  try {
    input = JSON.parse(await readStdin(V56_BATCH_BYTES));
  } catch {
    return v56Failure('input_bounds');
  }
  if (!v56CasesAreBounded(input)) return v56Failure('input_bounds');
  let source;
  try {
    source = v56ExecutingSource();
  } catch {
    return v56Failure('source_unavailable');
  }
  if (args.v56Child) {
    if (source !== args.runningSource || input.cases.length !== 1)
      return v56Failure('source_unavailable');
    const attempts = await refuseNetwork();
    const { register } = await import('tsx/esm/api');
    register();
    const src = (p) => pathToFileURL(join(serverRoot, 'src', p)).href;
    await hydrateReplayStores(args.storeSnapshots, src);
    const { verifyV56CounterfactualCases } = await import(
      src('engine/horseDecision/replay/v56Counterfactual.ts')
    );
    const { currentReplaySolverStores } = await import(
      src('engine/horseDecision/replay/references.ts')
    );
    const [result] = await verifyV56CounterfactualCases(input.cases, {
      runningSource: source,
      stores: currentReplaySolverStores(),
    });
    if (!v56SanitizedResult(result)) return v56Failure('child_unavailable');
    return {
      version: 'horse-v56-private-process-v1',
      status: 'computed',
      result,
      isolation: { pid: process.pid, networkAttempts: attempts },
    };
  }
  const results = [];
  for (const caseInput of input.cases)
    results.push(
      await replayV56InFreshProcess({
        caseInput,
        runningSource: source,
        storeSnapshots: args.storeSnapshots,
        node: args.node,
        esbuildBinary: args.esbuildBinary,
      })
    );
  try {
    if (v56ExecutingSource() !== source) return v56Failure('source_unavailable');
  } catch {
    return v56Failure('source_unavailable');
  }
  return {
    version: 'horse-v56-private-process-batch-v1',
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    results,
  };
}

/** Exit only after the pipe acknowledges the entire sanitized receipt. */
export function writeV56Output(
  value,
  exitCode,
  output = process.stdout,
  finish = (code) => process.exit(code)
) {
  output.write(JSON.stringify(value) + '\n', (error) => finish(error ? 1 : exitCode));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const argv = process.argv.slice(2);
  if (argv.includes('--v56-cases') || argv.includes('--v56-child')) {
    Promise.resolve()
      .then(() => v56Mode(parseArgs(argv), argv))
      .then(
        (result) => {
          writeV56Output(
            result,
            result.status === 'unavailable' ||
              result.results?.some((row) => row.status !== 'computed')
              ? 1
              : 0
          );
        },
        () => {
          writeV56Output(v56Failure('unavailable'), 1);
        }
      );
  } else {
    const args = parseArgs(argv);
    (args.child ? child(args) : batch(args)).then(
      () => process.exit(0),
      (error) => {
        process.stderr.write(`${error?.stack ?? error}\n`);
        process.exit(1);
      }
    );
  }
}
