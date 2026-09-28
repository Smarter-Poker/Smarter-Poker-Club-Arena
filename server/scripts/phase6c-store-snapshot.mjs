#!/usr/bin/env node
/**
 * Phase 6C store snapshot (G4): capture the chart store and the postflop
 * open-node store exactly as a decision worker hydrates them, with their
 * immutable identity, so the offline replay can load the same store.
 *
 *   node scripts/phase6c-store-snapshot.mjs --out <dir> [--stores chart_store,solver_store:postflop]
 *   node scripts/phase6c-store-snapshot.mjs --out <dir> --from-rows <rows.json>...
 *
 * Reads with the production loaders' own fetch functions (fetchGtoChartRows,
 * fetchGtoPostflopSnapshot: the same query, completeness and boundary checks
 * the live load uses), swaps the rows into the production store modules
 * (setGtoCharts, replaceGtoPostflop: the same validation), and asks those
 * modules for the identity. Nothing is written to the database; the rows are
 * written to <dir> and must stay outside the repository (they are solver
 * content, tens of megabytes). The committed evidence carries identities only.
 *
 * Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment, or
 * --from-rows: row files exported by scripts/phase6c-store-export-rows.mjs on
 * a host that holds the database identity (the same queries). Those rows pass
 * the same completeness checks (assertCompleteGtoChartCorpus,
 * assertCompleteGtoPostflopSnapshot) before the store modules take them.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, '..');

export const PHASE6C_STORE_SNAPSHOT_VERSION = 'phase6c-store-snapshot-v1';

function parseArgs(argv) {
  const out = { out: null, stores: ['chart_store', 'solver_store:postflop'], fromRows: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = resolve(argv[++i]);
    else if (argv[i] === '--stores') out.stores = argv[++i].split(',');
    else if (argv[i] === '--from-rows') out.fromRows.push(resolve(argv[++i]));
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!out.out)
    throw new Error(
      'usage: phase6c-store-snapshot.mjs --out <dir> [--stores ...] [--from-rows <file>]...'
    );
  for (const s of out.stores)
    if (s !== 'chart_store' && s !== 'solver_store:postflop') throw new Error(`unknown store ${s}`);
  if (!out.fromRows.length && (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY))
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required without --from-rows');
  if (out.fromRows.length) {
    // The store modules import a client at load time; give it nothing to reach.
    process.env.SUPABASE_URL = 'https://supabase.invalid';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'phase6c-snapshot-offline-placeholder';
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const unregister = register();
  try {
    const src = (p) => pathToFileURL(join(serverRoot, 'src', p)).href;
    mkdirSync(args.out, { recursive: true });
    const written = [];
    const sources = args.fromRows.length
      ? args.fromRows.map((file) => ({ file, exported: JSON.parse(readFileSync(file, 'utf8')) }))
      : args.stores.map((store) => ({ file: null, exported: { store } }));
    for (const { file: rowsFile, exported } of sources) {
      const store = exported.store;
      if (rowsFile && exported.version !== 'phase6c-store-rows-v1')
        throw new Error(`${rowsFile} is not a phase6c-store-rows-v1 export`);
      let startedAt = new Date().toISOString();
      let finishedAt = null;
      let rows;
      let identity;
      let source;
      if (store === 'chart_store') {
        const { fetchGtoChartRows } = await import(src('services/GtoChartLoader.ts'));
        const { assertCompleteGtoChartCorpus } = await import(src('gto/GtoChartCorpus.ts'));
        const { setGtoCharts, gtoChartStoreIdentity } = await import(src('engine/GtoCharts.ts'));
        if (rowsFile) {
          rows = exported.rows;
          assertCompleteGtoChartCorpus(rows);
        } else rows = await fetchGtoChartRows();
        setGtoCharts(rows);
        identity = gtoChartStoreIdentity();
        source = { table: 'memory_charts_gold', fetchedRows: rows.length };
      } else if (store === 'solver_store:postflop') {
        const { fetchGtoPostflopSnapshot, assertCompleteGtoPostflopSnapshot } = await import(
          src('services/GtoPostflopLoader.ts')
        );
        const { replaceGtoPostflop, gtoPostflopStoreIdentity } = await import(
          src('engine/GtoPostflop.ts')
        );
        let boundary;
        if (rowsFile) {
          rows = exported.rows;
          assertCompleteGtoPostflopSnapshot(
            exported.boundary.before,
            rows.length,
            exported.boundary.after
          );
          boundary = exported.boundary.after;
        } else {
          const snapshot = await fetchGtoPostflopSnapshot();
          rows = snapshot.rows;
          boundary = snapshot.boundary;
        }
        replaceGtoPostflop(rows, boundary.latestBuiltAt);
        identity = gtoPostflopStoreIdentity();
        source = { table: 'gto_postflop_compact', fetchedRows: rows.length, boundary };
      } else throw new Error(`unknown store ${store}`);
      if (rowsFile) {
        startedAt = exported.fetchedFrom;
        finishedAt = exported.fetchedTo;
        source.fetchedVia = 'scripts/phase6c-store-export-rows.mjs (the loader queries)';
      }
      finishedAt ??= new Date().toISOString();
      const file = join(
        args.out,
        `phase6c-store-${store.replace(/[^a-z0-9]+/gi, '-')}-${identity.digest.slice(0, 12)}.json`
      );
      writeFileSync(
        file,
        JSON.stringify({
          version: PHASE6C_STORE_SNAPSHOT_VERSION,
          store,
          identity,
          source,
          fetchedFrom: startedAt,
          fetchedTo: finishedAt,
          rows,
        }) + '\n'
      );
      written.push({
        store,
        file,
        identity,
        source,
        fetchedFrom: startedAt,
        fetchedTo: finishedAt,
      });
    }
    console.log(JSON.stringify(written, null, 2));
  } finally {
    unregister();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});
