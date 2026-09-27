#!/usr/bin/env node
/**
 * Phase 6C batch replay.
 *
 *   node scripts/phase6c-replay.mjs <journal-path|copy> --engine-sha <sha> --limit N --since <iso>
 *        [--out <dir>] [--charts <json>] [--label <name>] [--note <text>]...
 *
 * Replays the predeclared batch (the newest N journaled decisions at or after
 * --since, in journal order) through HorseDecisionReplay and writes one JSON
 * and one Markdown evidence file under docs/evidence/phase6c/. The batch rule,
 * the exact command line, the SHA of the code that ran and the release each
 * record was made by are all in the output; nothing is averaged into a score.
 *
 * Read-only: the journal is never written, no store is refreshed from the
 * network, no plan effect is applied and no table is touched.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');
const repoRoot = resolve(serverRoot, '..');

function parseArgs(argv) {
  const out = {
    limit: 200,
    since: null,
    out: join(repoRoot, 'docs', 'evidence', 'phase6c'),
    charts: null,
    label: null,
    notes: [],
    engineSha: null,
    journal: null,
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
    else if (a === '--label') out.label = next();
    else if (a === '--note') out.notes.push(next());
    else rest.push(a);
  }
  out.journal = rest[0] ? resolve(rest[0]) : null;
  if (
    !out.journal ||
    !out.engineSha ||
    !/^[0-9a-f]{40}$/.test(out.engineSha) ||
    !Number.isSafeInteger(out.limit) ||
    out.limit < 1
  )
    throw new Error(
      'usage: phase6c-replay.mjs <journal-path|copy> --engine-sha <40-hex sha> --limit N [--since <iso>] [--out <dir>] [--charts <json>] [--label <name>] [--note <text>]'
    );
  if (out.since !== null && !Number.isFinite(Date.parse(out.since)))
    throw new Error('--since must be an ISO timestamp');
  return out;
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
    ).sort((a, b) => b[1] - a[1])
  );

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
    let chartsLoaded = 0;
    if (args.charts) {
      const { setGtoCharts } = await import(src('engine/GtoCharts.ts'));
      chartsLoaded = setGtoCharts(JSON.parse(readFileSync(args.charts, 'utf8')));
    }
    const headSha = gitHead();
    const engineSha = headSha ?? args.engineSha;
    const source = openHorseJournalSource(args.journal);
    const sinceMs = args.since ? Date.parse(args.since) : 0;
    const startedAt = new Date();
    const batch = source.newestDecisions(args.limit, sinceMs);
    const verdicts = [];
    for (const row of batch) {
      const verdict = await replayHorseDecisionRecord(row.record, { engineSha });
      verdicts.push({ catalogOrdinal: row.ordinal, ...verdict });
    }
    source.close();
    const finishedAt = new Date();

    const count = (predicate) => verdicts.filter(predicate).length;
    const releases = [...new Set(verdicts.map((v) => v.recordedRelease))];
    const rowsForServing = count((v) => v.recordedRelease === args.engineSha);
    const summary = {
      protocol: 'docs/horse-brain-phase6c-replay-protocol-2026-09-26.md',
      commandLine,
      batchRule: `newest ${args.limit} journaled decision records${args.since ? ` at or after ${args.since}` : ''}, in journal order`,
      source: source.describe(),
      servingEngineSha: args.engineSha,
      replayEngineSha: engineSha,
      replayEngineIsServingEngine: engineSha === args.engineSha,
      recordedReleases: releases,
      recordsForServingEngine: rowsForServing,
      servingEngineRows: rowsForServing > 0 ? 'present' : 'unavailable external input',
      stores: { ...currentReplaySolverStores(), chartsLoadedFromFile: chartsLoaded },
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
      reproduced: count((v) => v.status === 'reproduced'),
      diverged: count((v) => v.status === 'diverged'),
      refused: count((v) => v.status === 'refused'),
      reasons: tally(verdicts, (v) => `${v.status}:${v.reason ?? 'clean'}`),
      qualification: {
        agreed: count((v) => v.qualification.status === 'agreed'),
        disagreed: count((v) => v.qualification.status === 'disagreed'),
        refused: count((v) => v.qualification.status === 'refused'),
      },
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
      },
      authority: tally(verdicts, (v) => v.authority.original.module),
      authoritySame: count((v) => v.authority.same === true),
      population: tally(
        verdicts,
        (v) =>
          `${v.context.gameMode ?? '?'}/${v.context.gameVariant ?? '?'}/${v.context.stage ?? '?'}`
      ),
    };
    mkdirSync(args.out, { recursive: true });
    const stamp = startedAt.toISOString().replace(/[:.]/g, '-');
    const base = join(args.out, `phase6c-replay-${args.label ? `${args.label}-` : ''}${stamp}`);
    writeFileSync(`${base}.json`, JSON.stringify({ summary, verdicts }, null, 2) + '\n');

    const lines = [];
    lines.push(`# Phase 6C exact-input replay evidence (${startedAt.toISOString()})`);
    lines.push('');
    lines.push(`Protocol: \`${summary.protocol}\`.`);
    lines.push('');
    lines.push('## Batch');
    lines.push('');
    lines.push(`- Command: \`${commandLine}\``);
    lines.push(`- Batch rule: ${summary.batchRule}`);
    lines.push(`- Source: ${summary.source}`);
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
    lines.push(
      `- Solver stores at replay: charts ${summary.stores.charts}, postflop ${summary.stores.postflop}, postflopV31 ${summary.stores.postflopV31}${chartsLoaded ? ` (charts loaded from ${args.charts})` : ''}`
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
      `- Authority owner identical between original and replay: ${summary.authoritySame} of ${summary.reproduced + summary.diverged} replayed`
    );
    lines.push('');
    lines.push('### Status and reason');
    lines.push('');
    lines.push('| status:reason | count |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(summary.reasons)) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    lines.push('### Latency and work');
    lines.push('');
    lines.push(
      `- Replay computeMs median ${ms(summary.latencyMs.replayComputeMedian)}, p95 ${ms(summary.latencyMs.replayComputeP95)}; original computeMs median ${ms(summary.latencyMs.originalComputeMedian)}, p95 ${ms(summary.latencyMs.originalComputeP95)}; replay wall (runtime round trip) median ${ms(summary.latencyMs.wallMedian)}, p95 ${ms(summary.latencyMs.wallP95)}`
    );
    lines.push(
      `- Equity samples per replay: median ${summary.work.equitySamplesMedian ?? 'n/a'}, max ${summary.work.equitySamplesMax}; equity calls median ${summary.work.equityCallsMedian ?? 'n/a'}`
    );
    lines.push('');
    lines.push('### Authority (module that produced the accepted action, original decisions)');
    lines.push('');
    lines.push('| module | count |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(summary.authority)) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    lines.push('### Population');
    lines.push('');
    lines.push('| mode/variant/stage | count |');
    lines.push('| --- | --- |');
    for (const [k, v] of Object.entries(summary.population)) lines.push(`| ${k} | ${v} |`);
    lines.push('');
    lines.push('## Decisions');
    lines.push('');
    lines.push(
      '| decision | release | context | original | replayed | route orig/replay | status | reason | compute orig/replay ms | wall ms | samples | authority |'
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const v of verdicts) {
      lines.push(
        `| ${v.decisionId.slice(0, 12)} | ${(v.recordedRelease ?? 'null').slice(0, 8)} | ${v.context.gameMode ?? '?'}/${v.context.gameVariant ?? '?'}/${v.context.stage ?? '?'}/${v.context.tableSize ?? '?'}p | ${fmtAction(v.originalAction)} | ${fmtAction(v.replayedAction)} | ${v.qualification.route.original ?? '-'}/${v.qualification.route.replayed ?? '-'} | ${v.status} | ${v.reason ?? ''} | ${ms(v.latency.originalComputeMs)}/${ms(v.latency.computeMs)} | ${ms(v.latency.wallMs)} | ${v.work.equitySamples ?? 'n/a'} | ${v.authority.original.module} |`
      );
    }
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
      })
    );
  } finally {
    unregister();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
