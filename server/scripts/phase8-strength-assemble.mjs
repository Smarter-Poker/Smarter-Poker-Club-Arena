#!/usr/bin/env node
/**
 * P8.2 STRENGTH EVIDENCE ASSEMBLER (Horse Brain Phase 8)
 *
 * Reads the 18 promotion-mode league runs written by
 * src/scripts/horseTournamentEvaluate.ts (one directory per objective and
 * seed) and writes one strength record plus the Phase 8 qualification file
 * that HorseQualifiedAuthority admits. It never runs a tournament, never
 * reads a network, database or credential, and never decides promotion
 * itself: the whole-matrix verdict is the real `summarizeTournamentPromotion`
 * and `tournamentRunCanPromote` imported from the league contract, so this
 * must run under tsx.
 *
 *   cd server && npx tsx scripts/phase8-strength-assemble.mjs \
 *     --runs=<directory holding the 18 <objective>-<seed> run directories> \
 *     --hosts=<hosts.json> [--context=<context.json>] [--superseded=<superseded.json>] \
 *     --out=../docs/evidence/phase8/strength-YYYY-MM-DD
 *
 *   --hosts                 {hosts: {<name>: {...}}, runs: {"<objective>-<seed>": <name> or
 *                           {host, exitCode}}}: the fixed run assignment, keyed by run
 *   --superseded=<file>     an earlier matrix this one replaces (where it is kept and why),
 *                           copied into strength.json as `superseded`
 *   --qualification=<file>  default <out>/../phase8-qualification-YYYY-MM-DD.json
 *   --repo-root=<dir>       root that evidencePath is relative to (default: this checkout)
 *   --fixture               assemble fixture-mode runs (tests only); never qualifies
 *   --defective=<file>      {"<objective>-<seed>": {status, reason, logTail}} for runs that
 *                           ended without a result. They are recorded, never replaced; the
 *                           contract then reports the matrix incomplete. A run that has a
 *                           result cannot be declared defective.
 *
 * Refusals (exit 2, every reason named on stderr, nothing written): a missing,
 * duplicate or unexpected run, a missing receipt, a run not in promotion mode,
 * a requested pair count below 1,024, a dirty checkout, a head / sourceSha256 /
 * serverLockSha256 / continuation version that differs between runs, a
 * receipt that does not match its result, a run without a host record, or a
 * policy source that changed between the runs' head and this checkout (the
 * policy digest is computed here, so it must be the runs' policy).
 *
 * Output is deterministic: the same inputs give byte-identical strength.json.
 * Run results and their receipts are copied verbatim and their sha256 is
 * recorded, so they are excluded from Prettier (see .prettierignore).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Offline only (the phase8-useful-completion pattern): the league contract's
// imports construct a Supabase client at load time, so they get an address
// that resolves to nothing and a key that is not one.
process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'phase8-strength-assemble-offline-placeholder';
process.env.EQUITY_GOVERNOR = 'off';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const sourceRepo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: serverRoot,
  encoding: 'utf8',
}).trim();

const league = await import('../src/benchmark/HorseTournamentLeague.ts');
const { PHASE8_POLICY } = await import('../src/engine/HorseTournamentPostflop.ts');
const authority = await import('../src/engine/HorseQualifiedAuthority.ts');
const prettier = await import('prettier');

export const STRENGTH_SCHEMA = 'horse-phase8-strength-v1';
export const QUALIFICATION_SCHEMA = 'horse-phase8-qualification-v1';
/** No production module names a pack id. HorseQualifiedAuthority.test-support.ts
 * uses this value for the one implemented pack, the tournament postflop policy
 * family that PHASE8_POLICY.version belongs to; the record names that source. */
const PACK_ID = 'horse-tournament-postflop';
const PACK_ID_SOURCE =
  'server/src/engine/HorseQualifiedAuthority.test-support.ts testQualificationEvidence(); no production module defines a pack id';
/** Every literal that horsePhase8PolicyDigest() hashes is declared in these files. */
const POLICY_SOURCE_FILES = [
  'server/src/engine/HorseTournamentPostflop.ts',
  'server/src/engine/HorseTournamentContinuation.ts',
  'server/src/engine/HorseTournamentFutureHand.ts',
  'server/src/engine/HorseQualifiedAuthority.ts',
];
const RECEIPTS = ['manifest.json', 'summary.json', 'baseline-verification.json'];
const RESULT_FILE = /^[a-z]+-\d+\.json$/;

function args(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`unknown argument ${arg}`);
    out[m[1]] = m[2] ?? true;
  }
  return out;
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

async function formatted(file, value) {
  const config = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(JSON.stringify(value), { ...config, parser: 'json', filepath: file });
}

/** The host record is keyed by run: `runs["<objective>-<seed>"]` names a host in
 * `hosts`, either as the bare name or as `{ host, exitCode }`. */
export function normalizeHosts(raw) {
  const runs = {};
  const exits = { ...(raw.exits ?? {}) };
  for (const [key, value] of Object.entries(raw.runs ?? {})) {
    if (typeof value === 'string') runs[key] = value;
    else if (value && typeof value === 'object') {
      runs[key] = value.host;
      if (value.exitCode !== undefined) exits[key] = value.exitCode;
    }
  }
  return { ...raw, runs, exits };
}

/** Read, check and summarize every run. Returns { reasons } or the assembly. */
export function inspectRuns({ runsDir, hosts, fixture, defective = {} }) {
  const reasons = [];
  const defectiveRuns = [];
  const mode = fixture ? 'fixture' : 'promotion';
  const { TOURNAMENT_LEAGUE_OBJECTIVES, TOURNAMENT_PROMOTION_SEEDS, TOURNAMENT_PROMOTION_PAIRS } =
    league;
  const expected = [];
  for (const seed of TOURNAMENT_PROMOTION_SEEDS)
    for (const objective of TOURNAMENT_LEAGUE_OBJECTIVES)
      expected.push({ key: `${objective}-${seed}`, objective, seed });
  const expectedKeys = new Set(expected.map((r) => r.key));
  if (!existsSync(runsDir) || !statSync(runsDir).isDirectory())
    return { reasons: [`missing_runs_directory`] };
  for (const name of readdirSync(runsDir).sort()) {
    if (name.startsWith('.')) continue;
    if (!expectedKeys.has(name)) reasons.push(`unexpected_run_directory:${name}`);
  }
  for (const key of Object.keys(defective)) {
    const record = defective[key];
    if (!expectedKeys.has(key)) reasons.push(`unknown_defective_run:${key}`);
    else if (
      !['defective', 'unavailable external input'].includes(record?.status) ||
      typeof record?.reason !== 'string' ||
      !record.reason
    )
      reasons.push(`invalid_defective_record:${key}`);
  }
  const claimed = new Map();
  const runs = [];
  const manifests = [];
  for (const { key, objective, seed } of expected) {
    const dir = path.join(runsDir, key);
    const declared = defective[key];
    const host = hosts.runs?.[key];
    if (!host || !hosts.hosts?.[host]) reasons.push(`missing_host_record:${key}`);
    const exists = existsSync(dir) && statSync(dir).isDirectory();
    const files = exists ? readdirSync(dir).sort() : [];
    if (declared) {
      // A run is declared defective only when it produced no result. A run
      // with a result is kept whatever it says; it can never be declared away.
      if (files.includes(`${key}.json`)) reasons.push(`declared_defective_but_has_result:${key}`);
      const manifest = files.includes('manifest.json')
        ? readJson(path.join(dir, 'manifest.json'))
        : null;
      if (manifest) manifests.push(manifest);
      defectiveRuns.push({
        key,
        objective,
        seed,
        dir: exists ? dir : null,
        host,
        receipts: RECEIPTS.filter((f) => files.includes(f)),
        manifest,
        declared,
      });
      continue;
    }
    if (!exists) {
      reasons.push(`missing_run:${key}`);
      continue;
    }
    for (const file of files)
      if (RESULT_FILE.test(file) && file !== `${key}.json` && !RECEIPTS.includes(file))
        reasons.push(`duplicate_result:${key}:${file}`);
    const missing = RECEIPTS.filter((f) => !files.includes(f));
    for (const f of missing) reasons.push(`missing_receipt:${key}:${f}`);
    if (!files.includes(`${key}.json`)) {
      reasons.push(`missing_result:${key}`);
      continue;
    }
    if (missing.length) continue;
    const resultBytes = readFileSync(path.join(dir, `${key}.json`));
    const result = JSON.parse(resultBytes.toString('utf8'));
    const manifest = readJson(path.join(dir, 'manifest.json'));
    const summary = readJson(path.join(dir, 'summary.json'));
    const baseline = readJson(path.join(dir, 'baseline-verification.json'));
    const claim = `${result.objective}-${result.seed}`;
    claimed.set(claim, (claimed.get(claim) ?? 0) + 1);
    if (result.objective !== objective || result.seed !== seed)
      reasons.push(`result_identity_mismatch:${key}:${claim}`);
    if (manifest.mode !== mode || result.evidenceMode !== mode)
      reasons.push(
        fixture
          ? `not_fixture_mode:${key}`
          : `not_promotion_mode:${key}:${manifest.mode}/${result.evidenceMode}`
      );
    if (manifest.dirty !== false) reasons.push(`dirty_checkout:${key}`);
    if (!same(manifest.seeds, [seed]) || !same(manifest.objectives, [objective]))
      reasons.push(`manifest_scope_mismatch:${key}`);
    if (
      !same(manifest.requiredMatrix, {
        seeds: TOURNAMENT_PROMOTION_SEEDS,
        objectives: TOURNAMENT_LEAGUE_OBJECTIVES,
        pairs: TOURNAMENT_PROMOTION_PAIRS,
      })
    )
      reasons.push(`contract_mismatch:${key}`);
    // A run asked for fewer pairs than the contract is a changed matrix and is
    // refused. A run that asked for the contract and stopped early (the league
    // ends a run at its first incomplete pair) is an unfavorable result: it is
    // kept, recorded with its completed count, and the contract marks it not
    // promotable. Dropping it would be selecting results.
    for (const [label, value] of [
      ['manifest', manifest.pairs],
      ['requested', result.requestedPairs],
    ])
      if (!(Number.isInteger(value) && value >= TOURNAMENT_PROMOTION_PAIRS))
        reasons.push(`pairs_below_contract:${key}:${label}=${value}`);
    if (!Number.isInteger(result.pairs) || result.pairs < 0 || result.pairs > result.requestedPairs)
      reasons.push(`pairs_out_of_range:${key}:${result.pairs}`);
    if (!same(summary, league.summarizeTournamentPromotion([result])))
      reasons.push(`receipt_mismatch:${key}:summary.json`);
    if (
      baseline.version !== result.version ||
      !Array.isArray(baseline.runs) ||
      baseline.runs.length !== 1 ||
      baseline.runs[0].objective !== objective ||
      baseline.runs[0].seed !== seed ||
      baseline.runs[0].verified !== league.tournamentBaselineRunVerified(result)
    )
      reasons.push(`receipt_mismatch:${key}:baseline-verification.json`);
    const promotable = league.tournamentRunCanPromote(result);
    if (result.promotionEligible !== promotable)
      reasons.push(`receipt_mismatch:${key}:promotionEligible`);
    manifests.push(manifest);
    runs.push({
      key,
      objective,
      seed,
      dir,
      resultBytes,
      result,
      manifest,
      baseline,
      promotable,
      host,
    });
  }
  for (const [claim, count] of claimed) if (count > 1) reasons.push(`duplicate_run:${claim}`);
  for (const field of ['head', 'sourceSha256', 'sourceFiles', 'serverLockSha256'])
    if (new Set(manifests.map((m) => m[field])).size > 1)
      reasons.push(`identity_mismatch:${field}`);
  if (new Set(runs.map((r) => r.result.version)).size > 1)
    reasons.push('identity_mismatch:version');
  if (runs.some((r) => r.result.version !== PHASE8_POLICY.version))
    reasons.push(`continuation_version_mismatch:${PHASE8_POLICY.version}`);
  const head = manifests[0]?.head;
  if (head) {
    try {
      execFileSync('git', ['cat-file', '-e', `${head}^{commit}`], {
        cwd: sourceRepo,
        stdio: 'ignore',
      });
      execFileSync('git', ['diff', '--quiet', head, 'HEAD', '--', ...POLICY_SOURCE_FILES], {
        cwd: sourceRepo,
        stdio: 'ignore',
      });
    } catch (error) {
      reasons.push(
        error.status === 1 ? 'policy_source_changed' : `policy_source_unverifiable:${head}`
      );
    }
  }
  if (!runs.length) reasons.push('no_run_results');
  return { reasons, runs, defectiveRuns, head };
}

function runRecord(r, hosts) {
  const x = r.result;
  return {
    run: r.key,
    objective: r.objective,
    seed: r.seed,
    host: r.host,
    hostLabel: hosts.hosts[r.host]?.label ?? null,
    startedAt: r.manifest.createdAt,
    durationMs: x.durationMs,
    resultSha256: sha256(r.resultBytes),
    solverStores: r.manifest.solverStores,
    requestedPairs: x.requestedPairs,
    pairs: x.pairs,
    complete: x.complete,
    pairsShortOfRequest: x.requestedPairs - x.pairs,
    decisions: x.decisions,
    eligible: x.eligible,
    fired: x.fired,
    completed: x.completed,
    changed: x.changed,
    completionRefusals: x.completionRefusals,
    completionDiagnosticsDropped: x.completionDiagnosticsDropped,
    budgetExhaustions: x.budgetExhaustions,
    illegalActions: x.illegalActions,
    conservationErrors: x.conservationErrors,
    truncatedHands: x.truncatedHands,
    candidateDeepOnePairCommitments: x.candidateDeepOnePairCommitments,
    baselineDeepOnePairCommitments: x.baselineDeepOnePairCommitments,
    preventedCommitments: x.preventedCommitments,
    latencyMs: x.latencyMs,
    primaryMetric: x.primaryMetric,
    candidateReturn: x.candidateReturn,
    baselineReturn: x.baselineReturn,
    meanDifference: x.meanDifference,
    standardError: x.standardError,
    confidence99: x.confidence99,
    promotable: r.promotable,
    baselineVerified: r.baseline.complete === true,
    exitCode: hosts.exits?.[r.key] ?? null,
  };
}

export async function assemble(options) {
  const fixture = Boolean(options.fixture);
  const hosts = normalizeHosts(readJson(options.hosts));
  const context = options.context ? readJson(options.context) : null;
  const superseded = options.superseded ? readJson(options.superseded) : null;
  const defective = options.defective ? readJson(options.defective) : {};
  const inspected = inspectRuns({ runsDir: options.runs, hosts, fixture, defective });
  const out = path.resolve(options.out);
  const dated = /^strength-(\d{4}-\d{2}-\d{2})$/.exec(path.basename(out));
  if (!dated) inspected.reasons.push('output_name_must_be_strength-YYYY-MM-DD');
  if (existsSync(path.join(out, 'strength.json')) || existsSync(path.join(out, 'runs')))
    inspected.reasons.push('output_exists');
  const repoRoot = path.resolve(options['repo-root'] ?? sourceRepo);
  const qualificationFile = path.resolve(
    options.qualification ??
      path.join(path.dirname(out), `phase8-qualification-${dated?.[1] ?? 'undated'}.json`)
  );
  const evidencePath = path
    .relative(repoRoot, path.join(out, 'strength.json'))
    .split(path.sep)
    .join('/');
  if (!evidencePath.startsWith(authority.HORSE_PHASE8_EVIDENCE_DIRECTORY))
    inspected.reasons.push(`evidence_outside_${authority.HORSE_PHASE8_EVIDENCE_DIRECTORY}`);
  if (inspected.reasons.length) return { refused: true, reasons: inspected.reasons };

  const { runs, defectiveRuns, head } = inspected;
  const verdict = league.summarizeTournamentPromotion(runs.map((r) => r.result));
  const policyDigest = authority.horsePhase8PolicyDigest();
  const first = runs[0].manifest;
  const strength = {
    schema: STRENGTH_SCHEMA,
    phase: 'P8.2',
    mode: fixture ? 'fixture' : 'promotion',
    contract: {
      seeds: league.TOURNAMENT_PROMOTION_SEEDS,
      objectives: league.TOURNAMENT_LEAGUE_OBJECTIVES,
      pairsPerRun: league.TOURNAMENT_PROMOTION_PAIRS,
      requiredRuns:
        league.TOURNAMENT_PROMOTION_SEEDS.length * league.TOURNAMENT_LEAGUE_OBJECTIVES.length,
      domain: authority.HORSE_PHASE8_DOMAIN,
      verdictFunctions:
        'summarizeTournamentPromotion and tournamentRunCanPromote, server/src/benchmark/HorseTournamentLeague.ts',
      runner:
        'server/src/scripts/horseTournamentEvaluate.ts --output=<dir> --objective=<o> --seed=<s> --promotion',
      limits: {
        workBudgetMs: PHASE8_POLICY.workBudgetMs,
        budgetMs: PHASE8_POLICY.budgetMs,
        policyBudgetMs: PHASE8_POLICY.policyBudgetMs,
      },
    },
    source: {
      head,
      dirty: false,
      sourceSha256: first.sourceSha256,
      sourceFiles: first.sourceFiles,
      serverLockSha256: first.serverLockSha256,
      continuationVersion: runs[0].result.version,
      policyDigest,
      policyDigestCheck: `computed by horsePhase8PolicyDigest(); ${POLICY_SOURCE_FILES.join(', ')} are identical at ${head} and the assembling checkout`,
    },
    hosts: hosts.hosts,
    hostAssignment: hosts.assignment ?? null,
    matrixComplete: defectiveRuns.length === 0,
    runs: runs.map((r) => runRecord(r, hosts)),
    defectiveRuns: defectiveRuns.map((d) => ({
      run: d.key,
      objective: d.objective,
      seed: d.seed,
      host: d.host,
      hostLabel: hosts.hosts[d.host]?.label ?? null,
      startedAt: d.manifest?.createdAt ?? null,
      solverStores: d.manifest?.solverStores ?? null,
      status: d.declared.status,
      reason: d.declared.reason,
      exitCode: hosts.exits?.[d.key] ?? null,
      logTail: d.declared.logTail ?? null,
      receipts: d.receipts,
    })),
    verdict: {
      promoted: verdict.promoted,
      reasons: verdict.reasons,
      promotableRuns: runs.filter((r) => r.promotable).length,
      baselineVerifiedRuns: runs.filter((r) => r.baseline.complete === true).length,
      buckets: verdict.buckets,
    },
    productionContext: context,
    superseded,
  };
  const strengthText = await formatted(path.join(out, 'strength.json'), strength);
  const qualified = !fixture && verdict.promoted === true;
  const qualification = {
    schema: QUALIFICATION_SCHEMA,
    qualified,
    mode: strength.mode,
    sourceSha: head,
    continuationVersion: runs[0].result.version,
    packId: PACK_ID,
    packIdSource: PACK_ID_SOURCE,
    domain: authority.HORSE_PHASE8_DOMAIN,
    policyDigest,
    evidencePath,
    evidenceSha256: sha256(strengthText),
    reasons: fixture ? ['fixture_mode_never_qualifies', ...verdict.reasons] : verdict.reasons,
  };
  const qualificationText = await formatted(qualificationFile, qualification);

  mkdirSync(path.join(out, 'runs'), { recursive: true });
  for (const r of runs) {
    copyFileSync(path.join(r.dir, `${r.key}.json`), path.join(out, 'runs', `${r.key}.json`));
    mkdirSync(path.join(out, 'runs', r.key));
    for (const f of RECEIPTS) copyFileSync(path.join(r.dir, f), path.join(out, 'runs', r.key, f));
  }
  for (const d of defectiveRuns) {
    if (!d.receipts.length) continue;
    mkdirSync(path.join(out, 'runs', d.key));
    for (const f of d.receipts) copyFileSync(path.join(d.dir, f), path.join(out, 'runs', d.key, f));
  }
  writeFileSync(path.join(out, 'strength.json'), strengthText);
  mkdirSync(path.dirname(qualificationFile), { recursive: true });
  writeFileSync(qualificationFile, qualificationText);
  return {
    refused: false,
    promoted: verdict.promoted,
    qualified,
    reasons: qualification.reasons,
    strength: path.join(out, 'strength.json'),
    qualification: qualificationFile,
    evidenceSha256: qualification.evidenceSha256,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = args(process.argv.slice(2));
  for (const required of ['runs', 'hosts', 'out'])
    if (typeof options[required] !== 'string') {
      console.error(`--${required}=<path> is required`);
      process.exit(64);
    }
  const outcome = await assemble(options);
  if (outcome.refused) {
    console.error(JSON.stringify({ refused: true, reasons: outcome.reasons }, null, 2));
    process.exit(2);
  }
  console.log(JSON.stringify(outcome, null, 2));
  process.exit(0);
}
