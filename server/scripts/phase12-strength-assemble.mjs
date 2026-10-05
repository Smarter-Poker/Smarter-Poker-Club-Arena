#!/usr/bin/env node
/**
 * P12.2 PHASE 12 STRENGTH EVIDENCE ASSEMBLER (Horse Brain Phase 12)
 *
 * One pack per assembly. Reads every attempt the P12.2 workflow uploaded for
 * that pack (one directory per attempt, `p122-<profile>-<seed>-s<shard>-a<attempt>`,
 * as `gh run download` writes them; every profile id names its variant) and
 * writes one strength record plus a `horse-phase12-qualification-v1` file for
 * that pack. It never plays a hand, never reads a network, database or
 * credential, and never decides the verdict itself:
 * `summarizeRemainingVariantStrength`, `remainingVariantStrengthShardReasons`
 * and the contract are imported from
 * server/src/benchmark/RemainingVariantStrengthContract.ts, so this must run
 * under tsx. A pass for one pack never certifies another: a shard of another
 * pack in the runs directory is refused by name.
 *
 *   cd server && npx tsx scripts/phase12-strength-assemble.mjs \
 *     --variant=<short_deck|pineapple|flh|flo8> \
 *     --runs=<directory holding the downloaded attempt directories> \
 *     --out=../docs/evidence/phase12/strength-YYYY-MM-DD-<variant> \
 *     [--defective=<file>] [--context=<file>] [--qualification=<file>] \
 *     [--repo-root=<dir>] [--development] [--no-format]
 *
 *   --defective=<file>  {"<shard key>": {status, reason}} for a shard none of whose
 *                       attempts produced a complete result. It is recorded, never
 *                       replaced; the contract then reports the shard missing and
 *                       the pack not qualified. A shard with a complete result
 *                       cannot be declared defective.
 *   --development       assemble development-mode runs (tests only); never qualifies
 *   --no-format         write copies verbatim (committedSha256 = sourceSha256)
 *
 * Attempt rule, fixed before any run: a shard counts its earliest complete
 * attempt. Every other complete attempt of the same shard must replay it
 * exactly (same pair digest and strata, the runs are deterministic) or the
 * assembly is refused; incomplete attempts (a lost runner, a cancelled job)
 * are recorded in `attempts` with their runner and exit code and never
 * counted. No attempt is discarded.
 *
 * Refusals (exit 2, every reason named on stderr, nothing written): an unknown
 * variant, an unexpected directory or shard (including any shard of another
 * pack), an attempt without its runner record, a required shard with no
 * complete attempt and no defective record, a defective record for a shard
 * that has a complete result, a result or manifest that does not match its
 * directory or variant, a run not in contract mode, a dirty checkout, a head /
 * sourceSha256 / sourceFiles / serverLockSha256 / contract digest / pack
 * version that differs between runs or from this checkout's contract, a source
 * that changed during a run, a cancelled result counted as complete, a
 * nondeterministic replay, a Phase 12 policy source file that differs between
 * the runs' head and this checkout (`policy_source_changed`), an output name
 * that does not carry the date and the variant, or an existing output.
 *
 * Policy digest: `policyDigest` is `horsePhase12PolicyDigest(variant)`,
 * imported from server/src/engine/HorsePhase12PolicyDigest.ts and computed
 * here from this checkout, which must match the runs' head for every hashed
 * file. P12.3 admission can recompute the same function from the running code.
 *
 * Reported, never gated: per shard and in total, `illegalCandidates` (hero
 * candidate proposals the HorseLogic selection guard refused, so the
 * candidate arm played the reference) beside `changed`, and Pineapple
 * `discards` (never betting decisions, never candidate changes).
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.SUPABASE_URL = 'https://supabase.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'phase12-strength-assemble-offline-placeholder';
process.env.EQUITY_GOVERNOR = 'off';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
/** Git finds this checkout from the script's own location. An inherited GIT_DIR
 * (a git hook exports one) would make the working directory the work tree, so
 * root-relative paths such as server/src/... would name files that do not exist. */
const gitEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
);
const sourceRepo = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  cwd: serverRoot,
  env: gitEnv,
  encoding: 'utf8',
}).trim();

const contract = await import('../src/benchmark/RemainingVariantStrengthContract.ts');
const authority = await import('../src/engine/HorsePhase12PolicyDigest.ts');

export const STRENGTH_SCHEMA = 'horse-phase12-strength-v1';
export const QUALIFICATION_SCHEMA = 'horse-phase12-qualification-v1';
export const EVIDENCE_DIRECTORY = 'docs/evidence/phase12/';
const ATTEMPT_DIR = /^p122-(.+-\d+-s\d+)-a(\d+)$/;
/** Every file horsePhase12PolicyDigest() hashes, repository-relative. */
export const POLICY_SOURCE_FILES = authority.HORSE_PHASE12_POLICY_SOURCE_FILES.map(
  (file) => `server/${file}`
);
const IDENTITY_FIELDS = ['head', 'sourceSha256', 'sourceFiles', 'serverLockSha256'];

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
const readMaybe = (file) => (existsSync(file) ? readJson(file) : null);

export const RECEIPT_FORMATTING =
  'Each run file is the host bytes reformatted by the repository Prettier configuration; formatting is the only difference (the parsed JSON is identical, checked at assembly). sourceSha256 hashes the host bytes, committedSha256 the committed file.';

export async function loadRepositoryPrettier(root = sourceRepo) {
  try {
    const entry = createRequire(path.join(root, 'package.json')).resolve('prettier/package.json');
    return await import(pathToFileURL(path.join(path.dirname(entry), 'index.mjs')).href);
  } catch {
    return null;
  }
}
async function prettierCopy(prettier, from, to, label) {
  const source = readFileSync(from);
  if (!prettier) {
    const hash = sha256(source);
    return { label, to, text: source, sourceSha256: hash, committedSha256: hash };
  }
  const config = (await prettier.resolveConfig(to)) ?? {};
  const text = await prettier.format(source.toString('utf8'), {
    ...config,
    parser: 'json',
    filepath: to,
  });
  if (!same(JSON.parse(text), JSON.parse(source.toString('utf8'))))
    throw new Error(`formatting changed the content of ${from}`);
  return { label, to, text, sourceSha256: sha256(source), committedSha256: sha256(text) };
}
async function formatted(prettier, file, value) {
  if (!prettier) return JSON.stringify(value, null, 2) + '\n';
  const config = (await prettier.resolveConfig(file)) ?? {};
  return prettier.format(JSON.stringify(value), { ...config, parser: 'json', filepath: file });
}

/**
 * Null when every policy source file in the working tree of `repo` is
 * identical to `head`, so the digest computed here is the digest of the code
 * the runs measured; otherwise the refusal reason.
 */
export function policySourceRefusal(head, repo = sourceRepo) {
  try {
    execFileSync('git', ['diff', '--quiet', head, '--', ...POLICY_SOURCE_FILES], {
      cwd: repo,
      env: gitEnv,
      stdio: 'ignore',
    });
    return null;
  } catch (error) {
    return error.status === 1 ? 'policy_source_changed' : `policy_source_unverifiable:${head}`;
  }
}

/** Read and check every attempt. Returns { reasons } or the assembly. */
export function inspectAttempts({ variant, runsDir, development = false, defective = {} }) {
  const reasons = [];
  if (!contract.isRemainingVariantStrengthVariant(variant)) return { reasons: ['unknown_variant'] };
  const mode = development ? 'development' : 'contract';
  const digest = contract.remainingVariantStrengthContractDigest();
  const pack = contract.remainingVariantStrengthPack(variant);
  const required = contract.remainingVariantStrengthRequiredShards(variant);
  const requiredKeys = new Set(required.map((r) => r.key));
  if (!existsSync(runsDir) || !statSync(runsDir).isDirectory())
    return { reasons: ['missing_runs_directory'] };
  const byKey = new Map();
  for (const name of readdirSync(runsDir).sort()) {
    if (name.startsWith('.')) continue;
    const m = ATTEMPT_DIR.exec(name);
    if (!m || !statSync(path.join(runsDir, name)).isDirectory()) {
      reasons.push(`unexpected_run_directory:${name}`);
      continue;
    }
    const [, key, attempt] = m;
    if (!requiredKeys.has(key)) {
      reasons.push(`unexpected_shard:${key}`);
      continue;
    }
    const dir = path.join(runsDir, name);
    const runner = readMaybe(path.join(dir, 'runner.json'));
    const attemptRecord = readMaybe(path.join(dir, 'attempt.json'));
    if (!runner) reasons.push(`missing_runner_record:${name}`);
    const manifest = readMaybe(path.join(dir, key, 'manifest.json'));
    const resultFile = path.join(dir, key, `${key}.json`);
    const resultBytes = existsSync(resultFile) ? readFileSync(resultFile) : null;
    const result = resultBytes ? JSON.parse(resultBytes.toString('utf8')) : null;
    const list = byKey.get(key) ?? [];
    list.push({
      name,
      key,
      attempt: Number(attempt),
      dir,
      runner,
      attemptRecord,
      manifest,
      result,
      resultBytes,
    });
    byKey.set(key, list);
  }
  for (const key of Object.keys(defective)) {
    const record = defective[key];
    if (!requiredKeys.has(key)) reasons.push(`unknown_defective_shard:${key}`);
    else if (
      !['defective', 'unavailable external input'].includes(record?.status) ||
      typeof record?.reason !== 'string' ||
      !record.reason
    )
      reasons.push(`invalid_defective_record:${key}`);
  }
  const counted = [];
  const attempts = [];
  const defectiveShards = [];
  for (const r of required) {
    const list = (byKey.get(r.key) ?? []).sort((a, b) => a.attempt - b.attempt);
    const complete = [];
    for (const a of list) {
      const res = a.result;
      const status = !a.manifest
        ? 'no_manifest'
        : !res
          ? 'no_result'
          : res.complete === true && res.cancelled !== true
            ? 'complete'
            : res.cancelled
              ? 'cancelled'
              : 'incomplete';
      attempts.push({
        shard: r.key,
        attempt: a.attempt,
        directory: a.name,
        status,
        pairs: res?.pairs ?? null,
        requestedPairs: res?.requestedPairs ?? null,
        exitCode: a.attemptRecord?.exitCode ?? null,
        startedAt: a.attemptRecord?.startedAt ?? a.manifest?.createdAt ?? null,
        finishedAt: a.attemptRecord?.finishedAt ?? null,
        runner: a.runner,
      });
      if (!a.manifest) continue;
      const m = a.manifest;
      if (
        m.variant !== variant ||
        m.profileId !== r.profileId ||
        m.seed !== r.seed ||
        m.shard !== r.shard
      )
        reasons.push(`manifest_scope_mismatch:${a.name}`);
      if (m.mode !== mode)
        reasons.push(
          development ? `not_development_mode:${a.name}` : `not_contract_mode:${a.name}:${m.mode}`
        );
      if (m.dirty !== false) reasons.push(`dirty_checkout:${a.name}`);
      if (
        m.contractDigest !== digest ||
        m.contractVersion !== contract.REMAINING_VARIANT_STRENGTH_CONTRACT.version
      )
        reasons.push(`contract_mismatch:${a.name}`);
      if (m.packVersion !== pack.candidate.packVersion)
        reasons.push(`pack_version_mismatch:${a.name}`);
      if (!res) continue;
      if (
        res.variant !== variant ||
        res.profileId !== r.profileId ||
        res.seed !== r.seed ||
        res.shard !== r.shard
      )
        reasons.push(`result_identity_mismatch:${a.name}`);
      if (res.evidenceMode !== m.mode || res.contractDigest !== m.contractDigest)
        reasons.push(`receipt_mismatch:${a.name}`);
      if (status === 'complete') {
        if (res.sourceUnchanged !== true) reasons.push(`source_changed_during_run:${a.name}`);
        complete.push(a);
      }
    }
    if (defective[r.key]) {
      if (complete.length) reasons.push(`declared_defective_but_has_result:${r.key}`);
      defectiveShards.push({ shard: r.key, ...defective[r.key] });
      continue;
    }
    if (!complete.length) {
      reasons.push(`missing_complete_result:${r.key}`);
      continue;
    }
    const first = complete[0];
    for (const other of complete.slice(1))
      if (
        other.result.pairDigest !== first.result.pairDigest ||
        !same(other.result.strata, first.result.strata)
      )
        reasons.push(`nondeterministic_replay:${r.key}:a${first.attempt}/a${other.attempt}`);
    counted.push({ ...first, replays: complete.slice(1).map((a) => a.attempt) });
  }
  const manifests = counted.map((a) => a.manifest);
  for (const field of IDENTITY_FIELDS)
    if (new Set(manifests.map((m) => m[field])).size > 1)
      reasons.push(`identity_mismatch:${field}`);
  const head = manifests[0]?.head;
  if (head) {
    try {
      execFileSync('git', ['cat-file', '-e', `${head}^{commit}`], {
        cwd: sourceRepo,
        env: gitEnv,
        stdio: 'ignore',
      });
    } catch {
      reasons.push(`source_head_unknown:${head}`);
    }
  }
  if (!counted.length) reasons.push('no_complete_shards');
  return { reasons, counted, attempts, defectiveShards, head };
}

export async function assemble(options) {
  const development = Boolean(options.development);
  const defective = options.defective ? readJson(options.defective) : {};
  const context = options.context ? readJson(options.context) : null;
  const variant = options.variant;
  const inspected = inspectAttempts({ variant, runsDir: options.runs, development, defective });
  if (inspected.reasons.includes('unknown_variant'))
    return { refused: true, reasons: inspected.reasons };
  const out = path.resolve(options.out);
  const dated = /^strength-(\d{4}-\d{2}-\d{2})-(short_deck|pineapple|flh|flo8)$/.exec(
    path.basename(out)
  );
  if (!dated || dated[2] !== variant)
    inspected.reasons.push(`output_name_must_be_strength-YYYY-MM-DD-${variant}`);
  if (existsSync(path.join(out, 'strength.json')) || existsSync(path.join(out, 'runs')))
    inspected.reasons.push('output_exists');
  const repoRoot = path.resolve(options['repo-root'] ?? sourceRepo);
  const qualificationFile = path.resolve(
    options.qualification ??
      path.join(
        path.dirname(out),
        `phase12-qualification-${dated?.[1] ?? 'undated'}-${variant}.json`
      )
  );
  const evidencePath = path
    .relative(repoRoot, path.join(out, 'strength.json'))
    .split(path.sep)
    .join('/');
  if (!evidencePath.startsWith(EVIDENCE_DIRECTORY))
    inspected.reasons.push(`evidence_outside_${EVIDENCE_DIRECTORY}`);
  const prettier = options['no-format'] ? null : await loadRepositoryPrettier();
  if (!options['no-format'] && !prettier) inspected.reasons.push('prettier_unavailable');
  let policyDigest = null;
  if (!inspected.reasons.length) {
    const changed = policySourceRefusal(inspected.head);
    if (changed) inspected.reasons.push(changed);
    else {
      policyDigest = authority.horsePhase12PolicyDigest(variant);
      if (!policyDigest) inspected.reasons.push('policy_source_unreadable');
    }
  }
  if (inspected.reasons.length) return { refused: true, reasons: inspected.reasons };

  const { counted, attempts, defectiveShards, head } = inspected;
  const verdict = contract.summarizeRemainingVariantStrength(
    variant,
    counted.map((a) => a.result)
  );
  const pack = contract.remainingVariantStrengthPack(variant);
  const runsOut = path.join(out, 'runs');
  const copies = [];
  const dirs = readdirSync(options.runs)
    .filter((n) => ATTEMPT_DIR.test(n))
    .sort();
  for (const name of dirs) {
    const [, key] = ATTEMPT_DIR.exec(name);
    const dir = path.join(options.runs, name);
    for (const rel of [
      'runner.json',
      'attempt.json',
      `${key}/manifest.json`,
      `${key}/${key}.json`,
    ]) {
      const from = path.join(dir, rel);
      if (existsSync(from))
        copies.push(
          await prettierCopy(prettier, from, path.join(runsOut, name, rel), `${name}/${rel}`)
        );
    }
  }
  const files = Object.fromEntries(
    copies.map((c) => [
      c.label,
      { sourceSha256: c.sourceSha256, committedSha256: c.committedSha256 },
    ])
  );
  const first = counted[0].manifest;
  const strength = {
    schema: STRENGTH_SCHEMA,
    phase: 'P12.2',
    variant,
    mode: development ? 'development' : 'contract',
    contract: contract.REMAINING_VARIANT_STRENGTH_CONTRACT,
    contractDigest: contract.remainingVariantStrengthContractDigest(),
    domain: pack.domain,
    verdictFunctions:
      'summarizeRemainingVariantStrength and remainingVariantStrengthShardReasons, server/src/benchmark/RemainingVariantStrengthContract.ts',
    source: {
      head,
      dirty: false,
      sourceSha256: first.sourceSha256,
      sourceFiles: first.sourceFiles,
      serverLockSha256: first.serverLockSha256,
      packVersion: first.packVersion,
      policyDigest,
      policyDigestDefinition: authority.HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
      policyDigestFiles: POLICY_SOURCE_FILES,
      policyDigestCheck: `computed by horsePhase12PolicyDigest("${variant}"); every policyDigestFiles entry is identical at ${head} and the assembling checkout`,
    },
    attemptRule:
      'earliest complete attempt counts; other complete attempts must replay it exactly; incomplete attempts are recorded, never counted',
    matrixComplete: defectiveShards.length === 0,
    receiptFormatting: prettier ? RECEIPT_FORMATTING : 'none',
    shards: counted.map((a) => ({
      shard: a.key,
      attempt: a.attempt,
      replayedBy: a.replays,
      runner: a.runner,
      startedAt: a.manifest.createdAt,
      durationMs: a.result.durationMs,
      pairs: a.result.pairs,
      changedPairs: a.result.changedPairs,
      eligible: a.result.eligible,
      changed: a.result.changed,
      illegalCandidates: a.result.illegalCandidates,
      discards: a.result.discards,
      decisions: a.result.decisions,
      showdownsChecked: a.result.showdownsChecked,
      foldWinsChecked: a.result.foldWinsChecked,
      lowHalvesChecked: a.result.lowHalvesChecked,
      validity: {
        illegalActions: a.result.illegalActions,
        conservationErrors: a.result.conservationErrors,
        cardErrors: a.result.cardErrors,
        truncatedHands: a.result.truncatedHands,
        settlementMismatches: a.result.settlementMismatches,
        deductionMismatches: a.result.deductionMismatches,
        pairedReplayMismatches: a.result.pairedReplayMismatches,
      },
      reasons: contract.remainingVariantStrengthShardReasons(variant, a.result),
      pairDigest: a.result.pairDigest,
    })),
    selectionGuard: {
      gate: false,
      changed: counted.reduce((n, a) => n + a.result.changed, 0),
      illegalCandidates: counted.reduce((n, a) => n + a.result.illegalCandidates, 0),
      discards: counted.reduce((n, a) => n + a.result.discards, 0),
    },
    attempts,
    defectiveShards,
    files,
    verdict,
    productionContext: context,
  };
  const strengthText = await formatted(prettier, path.join(out, 'strength.json'), strength);
  const qualified = !development && verdict.qualified === true;
  const qualification = {
    schema: QUALIFICATION_SCHEMA,
    qualified,
    mode: strength.mode,
    variant,
    sourceSha: head,
    packVersion: first.packVersion,
    contractVersion: contract.REMAINING_VARIANT_STRENGTH_CONTRACT.version,
    contractDigest: strength.contractDigest,
    domain: pack.domain,
    policyDigest,
    policyDigestDefinition: authority.HORSE_PHASE12_POLICY_DIGEST_DEFINITION,
    objectives: {
      cash: {
        qualified,
        status: 'measured',
        regressionMarginBbPer100: pack.regressionMargin.lowerBoundAtLeastBbPer100,
      },
      tournament: verdict.tournament,
    },
    admissionAlsoRequires:
      contract.REMAINING_VARIANT_STRENGTH_CONTRACT.liveConditions.admissionAlsoRequires,
    evidencePath,
    evidenceSha256: sha256(strengthText),
    reasons: development
      ? ['development_mode_never_qualifies', ...verdict.reasons]
      : verdict.reasons,
  };
  const qualificationText = await formatted(prettier, qualificationFile, qualification);
  for (const c of copies) {
    mkdirSync(path.dirname(c.to), { recursive: true });
    writeFileSync(c.to, c.text);
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'strength.json'), strengthText);
  mkdirSync(path.dirname(qualificationFile), { recursive: true });
  writeFileSync(qualificationFile, qualificationText);
  return {
    refused: false,
    variant,
    qualified,
    reasons: qualification.reasons,
    strength: path.join(out, 'strength.json'),
    qualification: qualificationFile,
    evidenceSha256: qualification.evidenceSha256,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = args(process.argv.slice(2));
  for (const required of ['variant', 'runs', 'out'])
    if (typeof options[required] !== 'string') {
      console.error(`--${required}=<value> is required`);
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
