/** Maintained Phase 6C snapshots through the original production hydrators.
 * Frozen inputs live outside the server Docker context, never query a DB. */
import { readFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setGtoCharts, gtoChartStoreIdentity, type GtoChartRow } from '../engine/GtoCharts.js';
import {
  replaceGtoPostflop,
  gtoPostflopStoreIdentity,
  type GtoPostflopRow,
} from '../engine/GtoPostflop.js';
import { isSolverStoreIdentity, sameSolverStoreIdentity } from '../gto/SolverStoreIdentity.js';
import { assertCompleteGtoChartCorpus } from '../gto/GtoChartCorpus.js';
import { currentReplaySolverStores } from '../engine/horseDecision/replay/references.js';
const MAX_COMPRESSED = 8 * 1024 * 1024,
  MAX_UNCOMPRESSED = 64 * 1024 * 1024;
const FIXTURE_ROOT = fileURLToPath(
  new URL('../../../tests/fixtures/horse-feature-ablation-stores/', import.meta.url)
);
const hash = (b: Buffer) => createHash('sha256').update(b).digest('hex');
export interface FrozenFeatureAblationStore {
  file: string;
  gzipBytes: number;
  sha256: string;
  uncompressedBytes: number;
  uncompressedSha256: string;
  store: string;
  identity: ReturnType<typeof gtoChartStoreIdentity>;
}
export function decodeFrozenFeatureAblationStore(bytes: Buffer, entry: FrozenFeatureAblationStore) {
  if (
    !Number.isSafeInteger(entry.uncompressedBytes) ||
    entry.uncompressedBytes < 0 ||
    entry.uncompressedBytes > MAX_UNCOMPRESSED
  )
    throw new Error('Oversized frozen input declaration');
  if (
    bytes.length > MAX_COMPRESSED ||
    bytes.length !== entry.gzipBytes ||
    hash(bytes) !== entry.sha256
  )
    throw new Error('Compressed frozen input digest/size mismatch');
  const raw = gunzipSync(bytes, { maxOutputLength: MAX_UNCOMPRESSED });
  if (raw.length !== entry.uncompressedBytes || hash(raw) !== entry.uncompressedSha256)
    throw new Error('Uncompressed frozen input digest/size mismatch');
  const snapshot = JSON.parse(raw.toString('utf8'));
  if (
    snapshot.version !== 'phase6c-store-snapshot-v1' ||
    snapshot.store !== entry.store ||
    !isSolverStoreIdentity(snapshot.identity) ||
    !sameSolverStoreIdentity(snapshot.identity, entry.identity) ||
    snapshot.identity.revision !== entry.identity.revision
  )
    throw new Error('Frozen store identity mismatch');
  return { snapshot, raw };
}
type StoreSnapshot = {
  version: string;
  identity: ReturnType<typeof gtoChartStoreIdentity>;
  source: unknown;
  fetchedFrom?: string;
  fetchedTo?: string;
} & (
  | { store: 'chart_store'; rows: GtoChartRow[] }
  | { store: 'solver_store:postflop'; rows: GtoPostflopRow[] }
);
async function hydrateSnapshots(
  snapshots: readonly { snapshot: StoreSnapshot; file: string; sha256: string }[]
) {
  const receipts: unknown[] = [];
  const seen = new Set<string>();
  for (const { snapshot: snap, file, sha256 } of snapshots) {
    if (
      snap.version !== 'phase6c-store-snapshot-v1' ||
      !isSolverStoreIdentity(snap.identity) ||
      !Array.isArray(snap.rows) ||
      seen.has(snap.store)
    )
      throw new Error('Invalid or duplicate store snapshot');
    let computed;
    if (snap.store === 'chart_store') {
      assertCompleteGtoChartCorpus(snap.rows);
      setGtoCharts(snap.rows);
      computed = gtoChartStoreIdentity();
    } else if (snap.store === 'solver_store:postflop') {
      replaceGtoPostflop(snap.rows, snap.identity.revision);
      computed = gtoPostflopStoreIdentity();
    } else throw new Error('Unknown store snapshot');
    if (
      !sameSolverStoreIdentity(computed, snap.identity) ||
      computed.revision !== snap.identity.revision
    )
      throw new Error('Hydrated store does not match its declared content identity');
    seen.add(snap.store);
    receipts.push({
      file,
      sha256,
      identity: computed,
      source: snap.source,
      fetchedFrom: snap.fetchedFrom,
      fetchedTo: snap.fetchedTo,
    });
  }
  if (!seen.has('chart_store') || !seen.has('solver_store:postflop'))
    throw new Error('Incomplete store snapshot set');
  return { snapshots: receipts, stores: currentReplaySolverStores() };
}
/** Explicit local inspection route for the same raw Phase 6C format. */
export async function hydrateFeatureAblationStores(files: readonly string[]) {
  if (files.length !== 2)
    throw new Error('Both exact current chart and postflop snapshots are required');
  const snapshots = [];
  for (const file of files) {
    if ((await stat(file)).size > MAX_UNCOMPRESSED) throw new Error('Oversized raw store snapshot');
    const bytes = await readFile(file);
    snapshots.push({ snapshot: JSON.parse(bytes.toString('utf8')), file, sha256: hash(bytes) });
  }
  return hydrateSnapshots(snapshots);
}
/** Strict immutable hosted/local qualification input, with no credentials. */
export async function hydrateFrozenFeatureAblationStores() {
  const manifestBytes = await readFile(resolve(FIXTURE_ROOT, 'manifest.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (
    manifest.schema !== 'horse-feature-ablation-frozen-stores-v1' ||
    manifest.maxCompressedBytes !== MAX_COMPRESSED ||
    manifest.maxUncompressedBytes !== MAX_UNCOMPRESSED ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== 2
  )
    throw new Error('Invalid frozen store manifest');
  for (const [key, name] of [
    ['provenance', 'capture-receipt.json'],
    ['boundaries', 'capture-boundaries.json'],
  ] as const) {
    if (
      manifest[key]?.file !== name ||
      hash(await readFile(resolve(FIXTURE_ROOT, name))) !== manifest[key].sha256
    )
      throw new Error('Frozen source provenance digest mismatch');
  }
  const snapshots = [];
  for (const entry of manifest.files as FrozenFeatureAblationStore[]) {
    if (!['chart-store.json.gz', 'postflop-store.json.gz'].includes(entry.file))
      throw new Error('Unsafe frozen input path');
    const path = resolve(FIXTURE_ROOT, entry.file);
    if ((await stat(path)).size > MAX_COMPRESSED) throw new Error('Oversized compressed snapshot');
    const bytes = await readFile(path),
      { snapshot } = decodeFrozenFeatureAblationStore(bytes, entry);
    snapshots.push({ snapshot, file: entry.file, sha256: entry.uncompressedSha256 });
  }
  return {
    ...(await hydrateSnapshots(snapshots)),
    fixtureManifestSha256: hash(manifestBytes),
    fixtureVersion: manifest.version,
  };
}
