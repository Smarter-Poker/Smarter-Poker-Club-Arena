/** Finite, read-only metadata proof. This never claims that V31 caused an action. */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const hash = /^[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const exact = (v, keys) =>
  v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export const LIMITS = Object.freeze({
  workers: 8,
  catalogRows: 1024,
  handsPerWorker: 8,
  bytes: 32 * 1024 * 1024,
  recordsPerHand: 256,
  elapsedMs: 30000,
});
export function validateRequest(p, now = Date.now()) {
  if (
    !exact(p, [
      'version',
      'sourceSha',
      'datasetId',
      'datasetChecksum',
      'cellCount',
      'workerCount',
      'afterUtc',
    ]) ||
    p.version !== 1 ||
    !sha.test(p.sourceSha) ||
    !uuid.test(p.datasetId) ||
    !hash.test(p.datasetChecksum) ||
    p.workerCount !== LIMITS.workers ||
    !Number.isSafeInteger(p.cellCount) ||
    p.cellCount < 1 ||
    p.cellCount > 10000 ||
    typeof p.afterUtc !== 'string' ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(p.afterUtc) ||
    !Number.isFinite(Date.parse(p.afterUtc)) ||
    new Date(p.afterUtc).toISOString() !== p.afterUtc ||
    Date.parse(p.afterUtc) > now ||
    now - Date.parse(p.afterUtc) > 86400000
  )
    throw Error('request_refused');
  return p;
}
export function healthMatches(h, p) {
  const live = h?.liveHorseDecision,
    store = live?.solverStores;
  return (
    h?.status === 'ok' &&
    h.releaseSha === p.sourceSha &&
    live?.phase === 'ready' &&
    live.workerCount === p.workerCount &&
    store?.postflopV31 === p.cellCount &&
    store.postflopV31Dataset?.id === p.datasetId &&
    store.postflopV31Dataset?.checksum === p.datasetChecksum
  );
}
/** LIMIT is applied before deduplication: never scan until a desired answer appears. */
export function candidateHandKeys(db) {
  const rows = db
    .prepare('SELECT hand_key FROM archive_events ORDER BY rowid DESC LIMIT 1024')
    .all();
  const keys = [];
  for (const row of rows) {
    if (typeof row.hand_key !== 'string' || !hash.test(row.hand_key))
      throw Error('catalog_refused');
    if (!keys.includes(row.hand_key)) keys.push(row.hand_key);
    if (keys.length === LIMITS.handsPerWorker) break;
  }
  return keys;
}
export function loadedAcceptedWitness(records, p, worker, api, now = Date.now()) {
  if (!Array.isArray(records) || records.length > LIMITS.recordsPerHand)
    throw Error('records_refused');
  for (const r of records) api.validateHorseJournalRecord(r);
  if (!records.length || records.some((r) => r.sourceRelease !== p.sourceSha)) return null;
  const handKey = records[0].handKey;
  if (
    records.some((r) => r.handKey !== handKey) ||
    api.reconcileHorseJournalHand(records, handKey).status !== 'reconciled'
  )
    return null;
  const after = Date.parse(p.afterUtc);
  for (const decision of records.filter((r) => r.kind === 'decision')) {
    if (decision.atMs < after || decision.atMs > now) continue;
    const c = JSON.parse(decision.body),
      s = c.snapshot,
      store = c.readiness?.solverStores;
    if (
      !['DECIDE_FAST', 'DECIDE_DEEP'].includes(s?.type) ||
      typeof s.fence !== 'string' ||
      api.horseDecisionShard(s.fence, p.workerCount) !== worker ||
      store?.postflopV31 !== p.cellCount ||
      !exact(store.postflopV31Dataset, ['id', 'checksum']) ||
      store.postflopV31Dataset.id !== p.datasetId ||
      store.postflopV31Dataset.checksum !== p.datasetChecksum
    )
      continue;
    for (const execution of records.filter(
      (r) =>
        r.kind === 'execution' &&
        r.producerId === decision.producerId &&
        r.turnKey === decision.turnKey
    )) {
      const w = JSON.parse(execution.body);
      if (
        w.executionStatus !== 'intended' ||
        execution.atMs < decision.atMs ||
        execution.atMs > now
      )
        continue;
      for (const accepted of records.filter((r) => r.kind === 'accepted_hand')) {
        if (accepted.atMs < execution.atMs || accepted.atMs > now) continue;
        const bound = api.bindHorseDecisionToCommittedHand(w, JSON.parse(accepted.body));
        if (bound.status !== 'bound') continue;
        return {
          worker,
          atMs: decision.atMs,
          loadedCells: store.postflopV31,
          datasetId: store.postflopV31Dataset.id,
          datasetChecksum: store.postflopV31Dataset.checksum,
          decisionSha256: decision.sha256,
          executionSha256: execution.sha256,
          acceptedHandSha256: accepted.sha256,
          actionOrdinal: bound.actionOrdinal,
        };
      }
    }
  }
  return null;
}
const rowKeys = [
  'worker',
  'atMs',
  'loadedCells',
  'datasetId',
  'datasetChecksum',
  'decisionSha256',
  'executionSha256',
  'acceptedHandSha256',
  'actionOrdinal',
];
export function receiptMatches(r, p) {
  return (
    exact(r, [
      'version',
      'scope',
      'status',
      'sourceSha',
      'observedAt',
      'workers',
      'qualified',
      'activationAllowed',
      'policyApplicationProven',
    ]) &&
    r.version === 1 &&
    r.scope === 'v31_loaded_before_natural_accepted_decisions' &&
    r.status === 'verified' &&
    r.sourceSha === p.sourceSha &&
    Number.isSafeInteger(r.observedAt) &&
    r.observedAt >= Date.parse(p.afterUtc) &&
    r.qualified === false &&
    r.activationAllowed === false &&
    r.policyApplicationProven === false &&
    Array.isArray(r.workers) &&
    r.workers.length === p.workerCount &&
    r.workers.every(
      (w, i) =>
        exact(w, rowKeys) &&
        w.worker === i &&
        w.datasetId === p.datasetId &&
        w.datasetChecksum === p.datasetChecksum &&
        w.loadedCells === p.cellCount &&
        Number.isSafeInteger(w.atMs) &&
        w.atMs >= Date.parse(p.afterUtc) &&
        w.atMs <= r.observedAt &&
        ['decisionSha256', 'executionSha256', 'acceptedHandSha256'].every((k) => hash.test(w[k])) &&
        Number.isSafeInteger(w.actionOrdinal) &&
        w.actionOrdinal >= 0 &&
        w.actionOrdinal <= 4095
    )
  );
}
export async function inspect(p, environment = process.env) {
  let stage = 'request_refused';
  const stores = [];
  try {
    validateRequest(p);
    stage = 'serving_identity_refused';
    if (environment.GIT_COMMIT_SHA !== p.sourceSha) throw Error();
    stage = 'module_load_failed';
    const moduleAt = (path) => import(pathToFileURL(resolve('dist', path)).href);
    const [config, { HorseDecisionJournalStore }, review, record, binding, shard] =
      await Promise.all([
        moduleAt('services/horseDecisionJournal/config.js'),
        moduleAt('services/horseDecisionJournal/store.js'),
        moduleAt('services/horseDecisionJournal/review.js'),
        moduleAt('services/horseDecisionJournal/record.js'),
        moduleAt('engine/HorseDecisionHandBinding.js'),
        moduleAt('engine/horseDecision/shard.js'),
      ]);
    const api = { ...review, ...record, ...binding, ...shard };
    stage = 'journal_configuration_missing';
    const directory = environment.HORSE_DECISION_JOURNAL_DIR;
    if (!directory) throw Error();
    const names = config.horseJournalArchiveDirectoryNames(directory);
    const started = performance.now(),
      workers = [];
    let bytes = 0;
    for (let worker = 0; worker < p.workerCount; worker++) {
      stage = 'worker_archive_unavailable';
      const name = worker === 0 ? 'archive' : `archive-shard-${worker}`;
      if (!names.includes(name)) throw Error();
      const options = config.readonlyHorseJournalStoreOptions(directory, name);
      if (options.readOnly !== true || !options.archive) throw Error();
      // The maintained store validates private canonical paths/schema/legacy bytes.
      const store = new HorseDecisionJournalStore(directory, options);
      stores.push(store);
      stage = 'catalog_read_failed';
      const db = new DatabaseSync(join(options.archive.directory, 'horse-journal-archive.sqlite'), {
        readOnly: true,
        allowExtension: false,
      });
      let keys;
      try {
        db.exec('PRAGMA query_only=ON; PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=250;');
        keys = candidateHandKeys(db);
      } finally {
        db.close();
      }
      let witness = null;
      for (const key of keys) {
        stage = 'inspection_bound';
        if (performance.now() - started > LIMITS.elapsedMs) throw Error();
        stage = 'journal_read_failed';
        // Join every archive through the maintained reader: conflicting copies
        // or an unreadable peer cannot silently become a positive witness.
        const records = api.readHorseJournalHandRecords(directory, key);
        // The maintained reader caps this hand at 256 records/8 MiB. The
        // aggregate budget is checked after that bounded read, not preemptively.
        bytes += records.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0);
        stage = 'inspection_bound';
        if (bytes > LIMITS.bytes || performance.now() - started > LIMITS.elapsedMs) throw Error();
        stage = 'accepted_binding_failed';
        witness = loadedAcceptedWitness(records, p, worker, api);
        if (witness) break;
      }
      if (!witness)
        return {
          version: 1,
          scope: 'v31_loaded_before_natural_accepted_decisions',
          status: 'incomplete',
          reason: 'matching_accepted_decision_unobserved',
          missingWorker: worker,
          qualified: false,
          activationAllowed: false,
          policyApplicationProven: false,
        };
      workers.push(witness);
    }
    stage = 'output_refused';
    const result = {
      version: 1,
      scope: 'v31_loaded_before_natural_accepted_decisions',
      status: 'verified',
      sourceSha: p.sourceSha,
      observedAt: Date.now(),
      workers,
      qualified: false,
      activationAllowed: false,
      policyApplicationProven: false,
    };
    if (!receiptMatches(result, p)) throw Error();
    return result;
  } catch {
    return {
      version: 1,
      scope: 'v31_loaded_before_natural_accepted_decisions',
      status: 'unavailable',
      reason: stage,
      qualified: false,
      activationAllowed: false,
      policyApplicationProven: false,
    };
  } finally {
    for (const store of stores) {
      try {
        store.close();
      } catch {}
    }
  }
}
if (
  process.argv[1] === '-' ||
  (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
) {
  try {
    const mode = process.argv[2],
      encoded = mode?.startsWith('--') ? process.argv[3] : mode;
    if (typeof encoded !== 'string' || encoded.length > 16000 || !/^[A-Za-z0-9+/=]+$/.test(encoded))
      throw Error();
    const p = validateRequest(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')));
    if (mode === '--validate') process.exitCode = 0;
    else if (mode === '--health' || mode === '--receipt') {
      const value = JSON.parse(readFileSync(process.argv[4], 'utf8'));
      if (!(mode === '--health' ? healthMatches(value, p) : receiptMatches(value, p)))
        throw Error();
    } else {
      const result = await inspect(p);
      console.log(JSON.stringify(result));
      process.exitCode = result.status === 'verified' ? 0 : result.status === 'incomplete' ? 2 : 3;
    }
  } catch {
    console.error('v31_readiness_inspection_refused');
    process.exitCode = 3;
  }
}
