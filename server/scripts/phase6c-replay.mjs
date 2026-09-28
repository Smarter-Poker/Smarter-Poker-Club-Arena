#!/usr/bin/env node
/**
 * Phase 6C batch replay.
 *
 *   node scripts/phase6c-replay.mjs <journal-path|copy> --engine-sha <sha> --limit N --since <iso>
 *        [--out <dir>] [--charts <json>] [--store-snapshot <json>]... [--store-pins <json>]
 *        [--negative-controls K] [--full-verdicts <path>] [--label <name>] [--note <text>]...
 *
 *   node scripts/phase6c-replay.mjs <journal-path|copy> --engine-sha <sha>
 *        --population <phase6d population json> [--out <dir>] ...
 *
 * Replays the predeclared batch (the newest N journaled decisions at or after
 * --since, in journal order; or, with --population, exactly the decisions a
 * Phase 6D population admitted, in its chain order) through
 * HorseDecisionReplay and writes one JSON
 * and one Markdown evidence file under docs/evidence/phase6c/. The batch rule,
 * the exact command line, the SHA of the code that ran, the release each
 * record was made by, the solver-store identities, the coverage matrix and the
 * negative controls are all in the output; nothing is averaged into a score.
 *
 * The committed evidence is aggregate: no decision, hand, player or table id
 * and no cards. Each decision is one row keyed by its position in the batch.
 * --full-verdicts writes the complete verdicts to a path outside the repo.
 *
 * Solver stores (G4): --store-snapshot loads a snapshot written by
 * scripts/phase6c-store-snapshot.mjs through the production store module and
 * refuses to run unless the module computes the identity the file declares.
 * --store-pins names, per store, the identity and the window over which its
 * source is witnessed unchanged; a record that journaled only a row count is
 * matched to a pin, never to a store of the same size.
 *
 * Read-only: the journal is never written, no store is refreshed from the
 * network, no plan effect is applied and no table is touched.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '..');

export const PHASE6C_STORE_PIN_VERSION = 'phase6c-store-pin-v1';
export const REPLAY_FORMATS = ['cash', 'mtt', 'sng', 'spin', 'hu_sng'];
export const REPLAY_STREETS = ['preflop', 'flop', 'turn', 'river'];

function parseArgs(argv) {
  const out = {
    limit: 200,
    since: null,
    out: join(repoRoot, 'docs', 'evidence', 'phase6c'),
    charts: null,
    storeSnapshots: [],
    storePins: null,
    negativeControls: 0,
    fullVerdicts: null,
    label: null,
    notes: [],
    engineSha: null,
    journal: null,
    population: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--engine-sha') out.engineSha = next();
    else if (a === '--limit') out.limit = Number(next());
    else if (a === '--since') out.since = next();
    else if (a === '--out') out.out = resolve(next());
    else if (a === '--charts') out.charts = resolve(next());
    else if (a === '--store-snapshot') out.storeSnapshots.push(resolve(next()));
    else if (a === '--store-pins') out.storePins = resolve(next());
    else if (a === '--negative-controls') out.negativeControls = Number(next());
    else if (a === '--full-verdicts') out.fullVerdicts = resolve(next());
    else if (a === '--label') out.label = next();
    else if (a === '--note') out.notes.push(next());
    else if (a === '--population') out.population = resolve(next());
    else rest.push(a);
  }
  out.journal = rest[0] ? resolve(rest[0]) : null;
  if (
    !out.journal ||
    !out.engineSha ||
    !/^[0-9a-f]{40}$/.test(out.engineSha) ||
    !Number.isSafeInteger(out.limit) ||
    out.limit < 1 ||
    !Number.isSafeInteger(out.negativeControls) ||
    out.negativeControls < 0
  )
    throw new Error(
      'usage: phase6c-replay.mjs <journal-path|copy> --engine-sha <40-hex sha> (--limit N [--since <iso>] | --population <json>) [--out <dir>] [--charts <json>] [--store-snapshot <json>]... [--store-pins <json>] [--negative-controls K] [--full-verdicts <path>] [--label <name>] [--note <text>]'
    );
  if (out.since !== null && !Number.isFinite(Date.parse(out.since)))
    throw new Error('--since must be an ISO timestamp');
  if (out.population && out.since !== null)
    throw new Error('--population selects its own decisions; --since does not apply');
  if (out.fullVerdicts && !relative(repoRoot, out.fullVerdicts).startsWith('..'))
    throw new Error('--full-verdicts must be outside the repository (it carries ids and cards)');
  return out;
}

/** The decisions a Phase 6D population admitted, in its chain order. A
 * population written before chains carried their journal decision id cannot
 * name its decisions and is refused rather than approximated. */
function populationDecisionIds(report) {
  const chains = Array.isArray(report?.chains) ? report.chains : null;
  if (!chains || report.stage !== '6D')
    throw new Error('--population is not a Phase 6D population');
  const ids = chains.map((c) => c.decisionId);
  if (ids.some((id) => typeof id !== 'string' || !/^[0-9a-f]{64}$/.test(id)))
    throw new Error('--population chains do not carry their journal decision ids');
  if (new Set(ids).size !== ids.length) throw new Error('--population names a decision twice');
  return ids;
}

/** Decision-code files (engine and gto sources, tests and this replay module
 * excluded) that differ between two revisions; null when git cannot say. */
function decisionCodeDiff(from, to) {
  try {
    return execFileSync(
      'git',
      [
        'diff',
        '--name-only',
        from,
        to,
        '--',
        'server/src/engine',
        'server/src/gto',
        ':(exclude)*.test.ts',
        ':(exclude)server/src/engine/horseDecision/replay',
      ],
      { cwd: repoRoot, encoding: 'utf8' }
    )
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function gitHead() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/** Commit time of a release: no process running it can have started earlier. */
function commitTimeMs(sha) {
  try {
    const iso = execFileSync('git', ['show', '-s', '--format=%cI', sha], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? ms : null;
  } catch {
    return null;
  }
}

const pct = (n, d) => `${n} of ${d}`;
const ms = (v) => (v === null || v === undefined ? 'n/a' : v.toFixed(2));
const fmtAction = (a) => (a ? `${a.action}${a.amount === null ? '' : ` ${a.amount}`}` : 'n/a');
const sorted = (values) => values.filter((x) => typeof x === 'number').sort((a, b) => a - b);
const median = (values) => {
  const v = sorted(values);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const p95 = (values) => {
  const v = sorted(values);
  return v.length ? v[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : null;
};
const tally = (items, key) =>
  Object.fromEntries(
    Object.entries(
      items.reduce((acc, item) => {
        const k = key(item);
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {})
    ).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  );
const fmtTally = (t) =>
  Object.entries(t)
    .map(([k, v]) => `${k} ${v}`)
    .join('; ');

/** Format as the snapshot states it; the 6D rule when it states none. */
export const replayFormat = (context) =>
  context.format ?? (context.gameMode === 'tournament' ? 'mtt' : context.gameMode ? 'cash' : '?');

/** What a verdict says about its cell: the route or owner it reproduced, or its reason. */
export const replayOutcome = (v) =>
  v.status === 'reproduced'
    ? `reproduced:${v.qualification.route.original ?? v.authority.original.module}`
    : `${v.status}:${v.reason ?? 'unstated'}`;

/**
 * The replay coverage matrix: every declared (format, variant, street) cell,
 * observed or not, with what happened to each decision in it. An unobserved
 * cell is listed as unobserved and is never filled from a neighbour.
 */
export function coverageMatrix(verdicts, variants) {
  const cells = new Map();
  for (const format of REPLAY_FORMATS)
    for (const variant of variants)
      for (const street of REPLAY_STREETS)
        cells.set(`${format}|${variant}|${street}`, {
          format,
          variant,
          street,
          declared: true,
          verdicts: [],
        });
  for (const v of verdicts) {
    const key = `${replayFormat(v.context)}|${v.context.gameVariant ?? '?'}|${v.context.stage ?? '?'}`;
    if (!cells.has(key)) {
      const [format, variant, street] = key.split('|');
      cells.set(key, { format, variant, street, declared: false, verdicts: [] });
    }
    cells.get(key).verdicts.push(v);
  }
  return [...cells.values()].map((c) => {
    const n = c.verdicts.length;
    const count = (s) => c.verdicts.filter((v) => v.status === s).length;
    const reproduced = count('reproduced');
    const diverged = count('diverged');
    const refused = count('refused');
    return {
      format: c.format,
      variant: c.variant,
      street: c.street,
      declared: c.declared,
      observed: n,
      reproduced,
      diverged,
      refused,
      coverage:
        n === 0
          ? 'unobserved'
          : reproduced === n
            ? 'replayed'
            : reproduced === 0
              ? 'unreplayed'
              : 'partly unreplayed',
      outcomes: tally(c.verdicts, replayOutcome),
      tableSizes: tally(c.verdicts, (v) => String(v.context.tableSize ?? '?')),
    };
  });
}

/** One aggregate row per decision: position in the batch, never an id. */
const aggregateRow = (v, index) => ({
  index: index + 1,
  releasePrefix: (v.recordedRelease ?? 'null').slice(0, 8),
  format: replayFormat(v.context),
  variant: v.context.gameVariant,
  street: v.context.stage,
  tableSize: v.context.tableSize,
  status: v.status,
  reason: v.reason ?? null,
  route: v.qualification.route,
  authority: {
    original: v.authority.original.module,
    replayed: v.authority.replayed?.module ?? null,
  },
  actionSame:
    v.replayedAction === null
      ? null
      : v.originalAction?.action === v.replayedAction.action &&
        v.originalAction?.amount === v.replayedAction.amount,
  qualification: {
    status: v.qualification.status,
    checks: Object.fromEntries(
      Object.entries(v.qualification.checks).map(([k, c]) => [k, c.status])
    ),
  },
  references: v.qualification.references.map((r) => ({
    ref: r.ref.startsWith('atlas_cell:') ? 'atlas_cell' : r.ref,
    status: r.status,
    detail: r.ref.startsWith('atlas_cell:') ? null : r.detail,
  })),
  receiptDigestEqual:
    v.qualification.receiptDigest.replayed === null
      ? null
      : v.qualification.receiptDigest.replayed === v.qualification.receiptDigest.original,
  latency: v.latency,
  work: v.work,
});

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // The replay never reaches the database: the modules it imports construct a
  // Supabase client at load time, so give them an address that resolves to
  // nothing and a key that is not one. No loader is started, no store is
  // refreshed and no journal is opened for writing.
  process.env.SUPABASE_URL = 'https://supabase.invalid';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'phase6c-replay-offline-placeholder';
  delete process.env.HORSE_DECISION_JOURNAL_DIR;
  // Quoted for a POSIX shell, so the recorded line re-runs exactly as given.
  const shellQuote = (arg) =>
    /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`;
  const commandLine = ['node', 'scripts/phase6c-replay.mjs', ...process.argv.slice(2)]
    .map(shellQuote)
    .join(' ');
  const unregister = register();
  try {
    const src = (p) => pathToFileURL(join(serverRoot, 'src', p)).href;
    const { openHorseJournalSource } = await import(
      src('engine/horseDecision/replay/journalSource.ts')
    );
    const { replayHorseDecisionRecord } = await import(
      src('engine/horseDecision/replay/HorseDecisionReplay.ts')
    );
    const { currentReplaySolverStores } = await import(
      src('engine/horseDecision/replay/references.ts')
    );
    const { HORSE_POLICY_REGISTRY } = await import(src('engine/HorsePolicyRegistry.ts'));
    const { sameSolverStoreIdentity, isSolverStoreIdentity } = await import(
      src('gto/SolverStoreIdentity.ts')
    );
    const { setGtoCharts, gtoChartStoreIdentity } = await import(src('engine/GtoCharts.ts'));
    const { replaceGtoPostflop, gtoPostflopStoreIdentity } = await import(
      src('engine/GtoPostflop.ts')
    );
    const { makeHorseJournalRecord } = await import(src('services/horseDecisionJournal/record.ts'));
    const { buildHorseDecisionKey } = await import(src('engine/horseDecision/protocol.ts'));

    let chartsLoaded = 0;
    if (args.charts) chartsLoaded = setGtoCharts(JSON.parse(readFileSync(args.charts, 'utf8')));

    // Store snapshots, loaded through the production store modules.
    const snapshots = {};
    const loadStore = (store, rows, revision) => {
      if (store === 'chart_store') {
        setGtoCharts(rows);
        return gtoChartStoreIdentity();
      }
      replaceGtoPostflop(rows, revision);
      return gtoPostflopStoreIdentity();
    };
    for (const file of args.storeSnapshots) {
      const snap = JSON.parse(readFileSync(file, 'utf8'));
      if (snap.version !== 'phase6c-store-snapshot-v1' || !isSolverStoreIdentity(snap.identity))
        throw new Error(`${file} is not a phase6c store snapshot`);
      const revision = snap.store === 'chart_store' ? null : snap.identity.revision;
      const computed = loadStore(snap.store, snap.rows, revision);
      if (
        !sameSolverStoreIdentity(computed, snap.identity) ||
        computed.revision !== snap.identity.revision
      )
        throw new Error(
          `${file} does not hold the identity it declares: file ${snap.identity.rows}@${snap.identity.digest}, module ${computed.rows}@${computed.digest}`
        );
      snapshots[snap.store] = {
        file,
        identity: computed,
        rows: snap.rows,
        revision,
        source: snap.source,
        fetchedFrom: snap.fetchedFrom,
        fetchedTo: snap.fetchedTo,
      };
    }

    // Pins: identity plus the window its source is witnessed unchanged.
    let pinFile = null;
    const pins = {};
    if (args.storePins) {
      pinFile = JSON.parse(readFileSync(args.storePins, 'utf8'));
      if (pinFile.version !== PHASE6C_STORE_PIN_VERSION || !Array.isArray(pinFile.pins))
        throw new Error(`${args.storePins} is not a ${PHASE6C_STORE_PIN_VERSION} file`);
      for (const p of pinFile.pins) {
        const from = Date.parse(p.unchangedFrom);
        const to = Date.parse(p.unchangedTo);
        if (!isSolverStoreIdentity(p.identity) || !Number.isFinite(from) || !(to >= from))
          throw new Error(`pin for ${p.store} is malformed`);
        const key =
          p.store === 'chart_store'
            ? 'charts'
            : p.store === 'solver_store:postflop'
              ? 'postflop'
              : null;
        if (!key) throw new Error(`pin names unknown store ${p.store}`);
        pins[key] = {
          identity: p.identity,
          unchangedFromMs: from,
          unchangedToMs: to,
          witness: p.witnessShort ?? 'witness in pin file',
        };
      }
    }
    const storesWith = (overrides = {}) => ({
      ...currentReplaySolverStores(),
      pins: overrides.pins ?? pins,
    });

    const headSha = gitHead();
    const engineSha = headSha ?? args.engineSha;
    const source = openHorseJournalSource(args.journal);
    const sinceMs = args.since ? Date.parse(args.since) : 0;
    const startedAt = new Date();
    let populationText = null;
    let populationMissing = 0;
    let batch;
    if (args.population) {
      populationText = readFileSync(args.population, 'utf8');
      batch = [];
      populationDecisionIds(JSON.parse(populationText)).forEach((id, index) => {
        const record = source.recordById(id);
        if (record && record.kind === 'decision') batch.push({ ordinal: index + 1, record });
        else populationMissing++;
      });
    } else batch = source.newestDecisions(args.limit, sinceMs);
    const releasesInBatch = [
      ...new Set(batch.map((row) => row.record.sourceRelease).filter((r) => typeof r === 'string')),
    ];
    const releaseNotBeforeMs = Object.fromEntries(
      releasesInBatch.map((r) => [r, commitTimeMs(r)]).filter(([, t]) => t !== null)
    );
    const replay = (record, overrides = {}) =>
      replayHorseDecisionRecord(record, {
        engineSha,
        stores: storesWith(overrides),
        releaseNotBeforeMs: overrides.releaseNotBeforeMs ?? releaseNotBeforeMs,
      });
    const verdicts = [];
    for (const row of batch) verdicts.push(await replay(row.record));
    source.close();
    const finishedAt = new Date();

    // ── Negative controls on the batch's own records ─────────────────────
    const controls = [];
    if (args.negativeControls > 0) {
      const K = args.negativeControls;
      const resign = (record, mutate) => {
        const body = JSON.parse(record.body);
        mutate(body);
        return makeHorseJournalRecord(
          {
            producerId: record.producerId,
            sequence: record.sequence,
            atMs: record.atMs,
            sourceRelease: record.sourceRelease,
            kind: record.kind,
            handKey: record.handKey,
            turnKey: record.turnKey,
          },
          body
        );
      };
      const reproducedIdx = verdicts
        .map((v, i) => (v.status === 'reproduced' ? i : -1))
        .filter((i) => i >= 0);
      const pick = (predicate) => reproducedIdx.filter((i) => predicate(verdicts[i])).slice(0, K);
      const cites = (v, ref) =>
        v.qualification.references.some((r) => r.ref === ref && r.status === 'available');
      const run = async (name, expectation, indices, fn, pass) => {
        const results = [];
        for (const i of indices) {
          const v = await fn(batch[i].record, verdicts[i]);
          results.push({ index: i + 1, status: v.status, reason: v.reason ?? null, pass: pass(v) });
        }
        controls.push({
          name,
          expectation,
          attempted: results.length,
          passed: results.filter((r) => r.pass).length,
          outcomes: tally(results, (r) => `${r.status}:${r.reason ?? 'clean'}`),
          rows: results.map((r) => r.index),
        });
      };
      await run(
        'substituted_action',
        'a re-signed record whose recorded action was changed replays to the true action and is diverged with reason action',
        pick(() => true),
        (record, v) =>
          replay(
            resign(record, (body) => {
              body.decision.action = v.originalAction?.action === 'fold' ? 'call' : 'fold';
              body.decision.amount = null;
            })
          ),
        (v) => v.status === 'diverged' && String(v.reason).split(';').includes('action')
      );
      await run(
        'substituted_rng',
        'a re-signed record whose RNG stream was changed is refused as rng_stream_mismatch',
        pick(() => true),
        (record) =>
          replay(
            resign(record, (body) => {
              body.rngBefore = (body.rngBefore ^ 0x5a5a5a5a) >>> 0;
            })
          ),
        (v) => v.status === 'refused' && v.reason === 'rng_stream_mismatch'
      );
      await run(
        'stale_m_state',
        'M evidence changed and re-signed under a valid decision key is disagreed by the independent m_state check and never reproduced',
        pick((v) => v.context.gameMode === 'tournament' && v.context.stage === 'preflop'),
        (record) =>
          replay(
            resign(record, (body) => {
              body.snapshot.gameState.tournament.m.realM += 1;
              body.snapshot.decisionKey = buildHorseDecisionKey(body.snapshot);
            })
          ),
        (v) => v.status !== 'reproduced' && v.qualification.checks.m_state.status === 'disagreed'
      );
      for (const [store, key] of [
        ['chart_store', 'charts'],
        ['solver_store:postflop', 'postflop'],
      ]) {
        const indices = pick((v) => cites(v, store));
        const snap = snapshots[store];
        // A record that journaled its store identity is matched by digest; one
        // that journaled a count only is matched to a pin. Each gets its own controls.
        const journaledIdentity = (i) => {
          try {
            return JSON.parse(batch[i].record.body)?.readiness?.solverStoreIdentity?.[key] ?? null;
          } catch {
            return null;
          }
        };
        const countOnly = indices.filter((i) => !journaledIdentity(i));
        const withIdentity = indices.filter((i) => journaledIdentity(i));
        if (countOnly.length) {
          await run(
            `${store}:no_pin`,
            `a count-only record meeting a loaded store of the same size, with no pin, is refused as reference_unavailable:${store}`,
            countOnly,
            (record) => replay(record, { pins: {} }),
            (v) => v.status === 'refused' && v.reason === `reference_unavailable:${store}`
          );
          if (pins[key])
            await run(
              `${store}:release_predates_pin`,
              `a release that could have loaded its store before the pinned window opened is refused as reference_unavailable:${store}`,
              countOnly,
              (record) =>
                replay(record, {
                  releaseNotBeforeMs: Object.fromEntries(
                    Object.keys(releaseNotBeforeMs).map((r) => [r, pins[key].unchangedFromMs - 1])
                  ),
                }),
              (v) => v.status === 'refused' && v.reason === `reference_unavailable:${store}`
            );
        }
        if (withIdentity.length) {
          await run(
            `${store}:journaled_identity_substituted`,
            `a re-signed record whose journaled ${store} digest names a different store of the same size is refused as reference_unavailable:${store}, even with the true store loaded`,
            withIdentity,
            (record) =>
              replay(
                resign(record, (body) => {
                  const id = body.readiness.solverStoreIdentity[key];
                  id.digest = (id.digest[0] === '0' ? '1' : '0') + id.digest.slice(1);
                })
              ),
            (v) => v.status === 'refused' && v.reason === `reference_unavailable:${store}`
          );
          await run(
            `${store}:journaled_identity_without_pin`,
            'a record that journaled its store identity reproduces against the loaded store by digest alone, with no pin',
            withIdentity,
            (record) => replay(record, { pins: {} }),
            (v) => v.status === 'reproduced'
          );
        }
        if (snap && indices.length) {
          // Same number of entries, one frequency moved: a count cannot see it.
          const tampered = structuredClone(snap.rows);
          let moved = false;
          for (const row of tampered) {
            for (const hand of Object.keys(row.hand_matrix).sort()) {
              const mix = row.hand_matrix[hand];
              const actions = Object.keys(mix)
                .filter((k) => typeof mix[k] === 'number')
                .sort();
              const from = actions.find((k) => mix[k] >= 0.01);
              const to = actions.find((k) => k !== from);
              if (from && to) {
                mix[from] -= 0.005;
                mix[to] += 0.005;
                moved = true;
                break;
              }
            }
            if (moved) break;
          }
          if (!moved) throw new Error(`${store} snapshot has no frequency a control can move`);
          const tamperedIdentity = loadStore(store, tampered, snap.revision);
          await run(
            `${store}:same_count_tampered`,
            `a store with the same ${snap.identity.rows} entries and one changed frequency (digest ${tamperedIdentity.digest.slice(0, 12)}) is refused as reference_unavailable:${store}`,
            indices,
            (record) => replay(record),
            (v) =>
              v.status === 'refused' &&
              v.reason === `reference_unavailable:${store}` &&
              tamperedIdentity.rows === snap.identity.rows &&
              tamperedIdentity.digest !== snap.identity.digest
          );
          const restored = loadStore(store, snap.rows, snap.revision);
          if (!sameSolverStoreIdentity(restored, snap.identity))
            throw new Error(`${store} did not restore to its snapshot identity`);
          await run(
            `${store}:restored`,
            'the untampered snapshot reloaded through the store module reproduces the same decisions again',
            indices,
            (record) => replay(record),
            (v) => v.status === 'reproduced'
          );
        }
      }
    }

    const count = (predicate) => verdicts.filter(predicate).length;
    const releases = [...new Set(verdicts.map((v) => v.recordedRelease))];
    const rowsForServing = count((v) => v.recordedRelease === args.engineSha);
    const variants = Object.keys(HORSE_POLICY_REGISTRY);
    const matrix = coverageMatrix(verdicts, variants);
    const storeRefs = (ref) =>
      tally(
        verdicts.flatMap((v) => v.qualification.references.filter((r) => r.ref === ref)),
        (r) => `${r.status}: ${r.detail}`
      );
    const summary = {
      protocol: 'docs/horse-brain-phase6c-replay-protocol-2026-09-26.md',
      evidenceShape:
        'aggregate: no decision, hand, player or table id and no cards; decisions are rows keyed by batch position',
      commandLine,
      batchRule: args.population
        ? `every decision admitted by the Phase 6D population ${basename(args.population)} (sha256 ${createHash('sha256').update(populationText).digest('hex')}), in its chain order; ${populationMissing} of them not found in the source`
        : `newest ${args.limit} journaled decision records${args.since ? ` at or after ${args.since}` : ''}, in journal order`,
      populationRecordsMissing: args.population ? populationMissing : null,
      source: source.describe().replace(/ndjson copy \S+/, 'ndjson copy'),
      servingEngineSha: args.engineSha,
      replayEngineSha: engineSha,
      replayEngineIsServingEngine: engineSha === args.engineSha,
      recordedReleases: releases,
      releaseNotBefore: Object.fromEntries(
        Object.entries(releaseNotBeforeMs).map(([r, t]) => [r, new Date(t).toISOString()])
      ),
      recordsForServingEngine: rowsForServing,
      servingEngineRows: rowsForServing > 0 ? 'present' : 'unavailable external input',
      stores: {
        charts: gtoChartStoreIdentity(),
        postflop: gtoPostflopStoreIdentity(),
        chartsLoadedFromFile: chartsLoaded,
        snapshots: Object.fromEntries(
          Object.entries(snapshots).map(([store, s]) => [
            store,
            {
              identity: s.identity,
              source: s.source,
              fetchedFrom: s.fetchedFrom,
              fetchedTo: s.fetchedTo,
            },
          ])
        ),
        pins: pinFile?.pins ?? [],
      },
      storeReferences: {
        chart_store: storeRefs('chart_store'),
        'solver_store:postflop': storeRefs('solver_store:postflop'),
      },
      decisionCodeDiff: {
        servingToReplay: decisionCodeDiff(args.engineSha, engineSha),
        recordedToReplay: Object.fromEntries(
          releases.filter(Boolean).map((r) => [r, decisionCodeDiff(r, engineSha)])
        ),
      },
      notes: args.notes,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      total: verdicts.length,
      firstAt: verdicts.length
        ? new Date(Math.min(...verdicts.map((v) => v.context.atMs ?? Infinity))).toISOString()
        : null,
      lastAt: verdicts.length
        ? new Date(Math.max(...verdicts.map((v) => v.context.atMs ?? -Infinity))).toISOString()
        : null,
      reproduced: count((v) => v.status === 'reproduced'),
      diverged: count((v) => v.status === 'diverged'),
      refused: count((v) => v.status === 'refused'),
      reasons: tally(verdicts, (v) => `${v.status}:${v.reason ?? 'clean'}`),
      qualification: {
        agreed: count((v) => v.qualification.status === 'agreed'),
        disagreed: count((v) => v.qualification.status === 'disagreed'),
        refused: count((v) => v.qualification.status === 'refused'),
      },
      receiptDigestEqual: count(
        (v) =>
          v.qualification.receiptDigest.replayed !== null &&
          v.qualification.receiptDigest.replayed === v.qualification.receiptDigest.original
      ),
      latencyMs: {
        replayComputeMedian: median(verdicts.map((v) => v.latency.computeMs)),
        replayComputeP95: p95(verdicts.map((v) => v.latency.computeMs)),
        originalComputeMedian: median(verdicts.map((v) => v.latency.originalComputeMs)),
        originalComputeP95: p95(verdicts.map((v) => v.latency.originalComputeMs)),
        wallMedian: median(verdicts.map((v) => v.latency.wallMs)),
        wallP95: p95(verdicts.map((v) => v.latency.wallMs)),
      },
      work: {
        equitySamplesMedian: median(verdicts.map((v) => v.work.equitySamples)),
        equitySamplesMax: Math.max(-1, ...verdicts.map((v) => v.work.equitySamples ?? -1)),
        equityCallsMedian: median(verdicts.map((v) => v.work.equityCalls)),
        nodeVisitsMedian: median(verdicts.map((v) => v.work.nodeVisits)),
      },
      authority: tally(verdicts, (v) => v.authority.original.module),
      authoritySame: count((v) => v.authority.same === true),
      population: tally(
        verdicts,
        (v) =>
          `${replayFormat(v.context)}/${v.context.gameVariant ?? '?'}/${v.context.stage ?? '?'}`
      ),
      coverage: {
        dimensions: {
          format: REPLAY_FORMATS,
          variant: variants,
          street: REPLAY_STREETS,
          outcome: 'reproduced:<route or owning module> | diverged:<reason> | refused:<reason>',
        },
        declaredCells: matrix.filter((c) => c.declared).length,
        observedCells: matrix.filter((c) => c.observed > 0).length,
        replayedCells: matrix.filter((c) => c.coverage === 'replayed').length,
        partlyUnreplayedCells: matrix.filter((c) => c.coverage === 'partly unreplayed').length,
        unreplayedCells: matrix.filter((c) => c.coverage === 'unreplayed').length,
        unobservedCells: matrix.filter((c) => c.coverage === 'unobserved').length,
        undeclaredObservedCells: matrix.filter((c) => !c.declared).length,
      },
      negativeControls: controls,
    };
    mkdirSync(args.out, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const base = join(args.out, `phase6c-replay-${args.label ? `${args.label}-` : ''}${stamp}`);
    if (args.fullVerdicts)
      writeFileSync(args.fullVerdicts, JSON.stringify({ summary, verdicts }, null, 2) + '\n');
    writeFileSync(
      `${base}.json`,
      JSON.stringify(
        { summary, coverageMatrix: matrix, decisions: verdicts.map(aggregateRow) },
        null,
        2
      ) + '\n'
    );

    const lines = [];
    lines.push(`# Phase 6C exact-input replay evidence (${startedAt.toISOString()})`);
    lines.push('');
    lines.push(`Protocol: \`${summary.protocol}\`. Evidence shape: ${summary.evidenceShape}.`);
    lines.push('');
    lines.push('## Batch');
    lines.push('');
    lines.push(`- Command: \`${commandLine}\``);
    lines.push(`- Batch rule: ${summary.batchRule}`);
    lines.push(`- Source: ${summary.source}`);
    lines.push(`- Decisions from ${summary.firstAt} to ${summary.lastAt}`);
    lines.push(`- Serving engine SHA (declared): \`${summary.servingEngineSha}\``);
    lines.push(
      `- Replay engine SHA (code that ran): \`${summary.replayEngineSha}\`${summary.replayEngineIsServingEngine ? '' : ' (not the serving engine)'}`
    );
    lines.push(
      `- Releases recorded on the replayed rows: ${releases.map((r) => `\`${r}\``).join(', ')}`
    );
    lines.push(
      `- Rows for the serving engine in this batch: ${rowsForServing}${rowsForServing === 0 ? ' (unavailable external input: the journal holds no decision made by the serving engine; the newest rows that exist were replayed and their release is stated above)' : ''}`
    );
    const id = (i) =>
      i ? `${i.rows} entries, digest \`${i.digest}\`, revision ${i.revision ?? 'null'}` : 'n/a';
    lines.push(`- Chart store at replay: ${id(summary.stores.charts)}`);
    lines.push(`- Postflop store at replay: ${id(summary.stores.postflop)}`);
    for (const [store, s] of Object.entries(summary.stores.snapshots))
      lines.push(
        `- Snapshot ${store}: fetched ${s.fetchedFrom} to ${s.fetchedTo} from ${s.source.table} through the production loader, identity recomputed by the store module on load`
      );
    for (const p of summary.stores.pins)
      lines.push(
        `- Pin ${p.store}: ${p.identity.rows}@\`${p.identity.digest.slice(0, 16)}\`, source unchanged ${p.unchangedFrom} to ${p.unchangedTo}; witness: ${p.witness}`
      );
    for (const [r, t] of Object.entries(summary.releaseNotBefore))
      lines.push(
        `- Release \`${r.slice(0, 12)}\` committed ${t} (no process running it started earlier)`
      );
    const diffLine = (files) =>
      files === null
        ? 'unavailable (revision not in this clone)'
        : files.length === 0
          ? 'none'
          : files.map((f) => `\`${f}\``).join(', ');
    lines.push(
      `- Decision-code files that differ, serving engine to replay code: ${diffLine(summary.decisionCodeDiff.servingToReplay)}`
    );
    for (const [release, files] of Object.entries(summary.decisionCodeDiff.recordedToReplay))
      lines.push(
        `- Decision-code files that differ, recorded release \`${release.slice(0, 12)}\` to replay code: ${diffLine(files)}`
      );
    for (const note of args.notes) lines.push(`- Note: ${note}`);
    lines.push('');
    lines.push('## Result');
    lines.push('');
    lines.push(`- Total: ${summary.total}`);
    lines.push(`- reproduced: ${pct(summary.reproduced, summary.total)}`);
    lines.push(`- diverged: ${pct(summary.diverged, summary.total)}`);
    lines.push(`- refused: ${pct(summary.refused, summary.total)}`);
    lines.push(
      `- Independent qualification: agreed ${summary.qualification.agreed}, disagreed ${summary.qualification.disagreed}, refused (reference unavailable) ${summary.qualification.refused}`
    );
    lines.push(
      `- Receipt digest equal to the original: ${summary.receiptDigestEqual} of ${summary.reproduced + summary.diverged} replayed`
    );
    lines.push(
      `- Authority owner identical between original and replay: ${summary.authoritySame} of ${summary.reproduced + summary.diverged} replayed`
    );
    lines.push('');
    lines.push('### Status and reason');
    lines.push('');
    lines.push('| status:reason | count |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(summary.reasons)) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    lines.push('### Solver-store references');
    lines.push('');
    lines.push('| reference | status and detail | decisions |');
    lines.push('| --- | --- | --- |');
    for (const [ref, t] of Object.entries(summary.storeReferences))
      for (const [k, v] of Object.entries(t)) lines.push(`| ${ref} | ${k} | ${v} |`);
    lines.push('');
    if (controls.length) {
      lines.push('### Negative controls (the batch records, changed)');
      lines.push('');
      lines.push('| control | expectation | attempted | passed | outcomes |');
      lines.push('| --- | --- | --- | --- | --- |');
      for (const c of controls)
        lines.push(
          `| ${c.name} | ${c.expectation} | ${c.attempted} | ${c.passed} | ${fmtTally(c.outcomes) || 'none'} |`
        );
      lines.push('');
    }
    lines.push('### Latency and work');
    lines.push('');
    lines.push(
      `- Replay computeMs median ${ms(summary.latencyMs.replayComputeMedian)}, p95 ${ms(summary.latencyMs.replayComputeP95)}; original computeMs median ${ms(summary.latencyMs.originalComputeMedian)}, p95 ${ms(summary.latencyMs.originalComputeP95)}; replay wall (runtime round trip) median ${ms(summary.latencyMs.wallMedian)}, p95 ${ms(summary.latencyMs.wallP95)}`
    );
    lines.push(
      `- Equity samples per replay: median ${summary.work.equitySamplesMedian ?? 'n/a'}, max ${summary.work.equitySamplesMax}; equity calls median ${summary.work.equityCallsMedian ?? 'n/a'}; policy-graph node visits median ${summary.work.nodeVisitsMedian ?? 'n/a'}`
    );
    lines.push('');
    lines.push('### Authority (module that produced the accepted action, original decisions)');
    lines.push('');
    lines.push('| module | count |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(summary.authority)) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    lines.push('## Coverage Matrix (format x variant x street x outcome)');
    lines.push('');
    const cov = summary.coverage;
    lines.push(
      `${cov.declaredCells} declared cells (${REPLAY_FORMATS.length} formats x ${variants.length} registered variants x ${REPLAY_STREETS.length} streets): ${cov.observedCells} observed, of which ${cov.replayedCells} fully replayed, ${cov.partlyUnreplayedCells} partly unreplayed and ${cov.unreplayedCells} unreplayed; ${cov.unobservedCells} unobserved; ${cov.undeclaredObservedCells} observed outside the declared domain. An unobserved cell is listed as unobserved and is never filled from a neighbour.`
    );
    lines.push('');
    lines.push('### Observed cells');
    lines.push('');
    lines.push(
      '| format | variant | street | observed | reproduced | diverged | refused | coverage | outcomes (route or reason) | table sizes |'
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const c of matrix.filter((c) => c.observed > 0))
      lines.push(
        `| ${c.format} | ${c.variant} | ${c.street} | ${c.observed} | ${c.reproduced} | ${c.diverged} | ${c.refused} | ${c.coverage}${c.declared ? '' : ' (outside declared domain)'} | ${fmtTally(c.outcomes)} | ${fmtTally(c.tableSizes)} |`
      );
    lines.push('');
    lines.push('### Unreplayed decisions by cell and named reason');
    lines.push('');
    lines.push('| format | variant | street | reason | decisions |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of matrix.filter((c) => c.observed > c.reproduced))
      for (const [k, v] of Object.entries(c.outcomes))
        if (!k.startsWith('reproduced:'))
          lines.push(`| ${c.format} | ${c.variant} | ${c.street} | ${k} | ${v} |`);
    lines.push('');
    lines.push('### Unobserved cells');
    lines.push('');
    lines.push('| format | variant | unobserved streets |');
    lines.push('| --- | --- | --- |');
    for (const format of REPLAY_FORMATS)
      for (const variant of variants) {
        const streets = matrix
          .filter((c) => c.format === format && c.variant === variant && c.observed === 0)
          .map((c) => c.street);
        if (streets.length)
          lines.push(
            `| ${format} | ${variant} | ${streets.length === 4 ? 'all four' : streets.join(', ')} |`
          );
      }
    lines.push('');
    lines.push('## Decisions');
    lines.push('');
    lines.push(
      '| # | release | format/variant/street/size | route orig/replay | action same | status | reason | compute orig/replay ms | wall ms | samples | node visits | authority |'
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    verdicts.forEach((v, i) => {
      const r = aggregateRow(v, i);
      lines.push(
        `| ${r.index} | ${r.releasePrefix} | ${r.format}/${r.variant ?? '?'}/${r.street ?? '?'}/${r.tableSize ?? '?'}p | ${r.route.original ?? '-'}/${r.route.replayed ?? '-'} | ${r.actionSame === null ? 'n/a' : r.actionSame ? 'yes' : 'no'} | ${r.status} | ${r.reason ?? ''} | ${ms(v.latency.originalComputeMs)}/${ms(v.latency.computeMs)} | ${ms(v.latency.wallMs)} | ${v.work.equitySamples ?? 'n/a'} | ${v.work.nodeVisits ?? 'n/a'} | ${r.authority.original} |`
      );
    });
    lines.push('');
    lines.push(
      'Deterministic replay is not GTO strength. A reproduced decision proves the published code repeats itself on its exact original inputs; it does not certify the action.'
    );
    lines.push('');
    writeFileSync(`${base}.md`, lines.join('\n'));
    console.log(
      JSON.stringify({
        json: `${base}.json`,
        markdown: `${base}.md`,
        total: summary.total,
        reproduced: summary.reproduced,
        diverged: summary.diverged,
        refused: summary.refused,
        reasons: summary.reasons,
        controls: controls.map((c) => `${c.name} ${c.passed}/${c.attempted}`),
      })
    );
  } finally {
    unregister();
  }
}

// The decision code this replays imports production singletons that own
// intervals (the lobby broadcast in hub/ChannelHub, reached through
// workerRuntime -> HorseMindHydrator -> services/supabase). The replay is a
// command: once its evidence is written it exits with its own status, rather
// than waiting on a timer it never started.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
    .catch((error) => {
      console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
      process.exitCode = 1;
    })
    .finally(() => process.exit());
