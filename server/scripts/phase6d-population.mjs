#!/usr/bin/env node
/**
 * Phase 6D predeclared finite natural population selector.
 *
 * The declaration (docs/evidence/phase6d/population-declaration-<date>.json) is
 * committed before any journal record is read. This script never changes it:
 * a run whose window, strata, target, axes or admitted releases differ from the
 * declaration is refused, a decision whose cell is not declared fills nothing,
 * and a cell nobody reached is reported as unobserved. Nothing is filled,
 * sampled outside the strata, averaged or turned into a percentage.
 *
 * Modes
 *   run     --declaration <json> --out <dir>      observe on the engine host, then report
 *   report  --declaration <json> --observation <json> --out <dir>
 *   observe <base64 declaration>                  runs inside the read-only observer
 *                                                 container on the engine host; never
 *                                                 invoked on a workstation
 *
 * The observer is the Phase 6A pattern: a throwaway container from the serving
 * image, the journal bind-mounted read-only, network none, removed afterwards.
 * It reads through the image's compiled HorseDecisionJournalStore and copies the
 * image's reconcileHorseJournalHand verdict beside every chain.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';

export const CHAIN_LINKS = Object.freeze([
  'request',
  'calculation',
  'reference',
  'acceptedAction',
  'completedHand',
]);
export const PATHS = Object.freeze(['normal', 'bypass', 'fallback']);
const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const HOUR_MS = 3_600_000;
/** Catalog rows scanned for sequence continuity after a stratum's last row. */
export const CAPTURE_TAIL_ROWS = 20_000;

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const cellKey = (c) => `${c.format}|${c.branch}|${c.size}|${c.anteMode}|${c.path}`;
export const parseCellKey = (key) => {
  const [format, branch, size, anteMode, path] = key.split('|');
  return { format, branch, size: Number(size), anteMode, path };
};

/** Read and validate a committed declaration. The digest binds every later
 * artifact to these exact bytes. */
export function loadDeclaration(path) {
  const text = readFileSync(path, 'utf8');
  const declaration = JSON.parse(text);
  validateDeclaration(declaration);
  return { declaration, digest: sha256(text), path };
}

export function validateDeclaration(d) {
  const fail = (why) => {
    throw Error(`Phase 6D declaration invalid: ${why}`);
  };
  if (!d || typeof d !== 'object' || d.declarationVersion !== 1 || d.stage !== '6D')
    fail('version or stage');
  const w = d.window;
  if (
    !w ||
    !Number.isSafeInteger(w.startMs) ||
    !Number.isSafeInteger(w.endMs) ||
    w.endMs <= w.startMs ||
    w.endMs - w.startMs > 24 * HOUR_MS
  )
    fail('window must be epoch milliseconds, at most 24 hours long');
  if (!SHA40.test(d.servingRelease?.sha ?? '')) fail('servingRelease.sha');
  if (!Array.isArray(d.admittedReleases) || !d.admittedReleases.length) fail('admittedReleases');
  for (const r of d.admittedReleases) if (!SHA40.test(r?.sha ?? '')) fail('admittedReleases sha');
  if (!d.admittedReleases.some((r) => r.sha === d.servingRelease.sha))
    fail('servingRelease must be admitted');
  const a = d.population?.axes;
  for (const axis of ['format', 'branch', 'size', 'anteMode', 'path'])
    if (!Array.isArray(a?.[axis]) || !a[axis].length) fail(`axes.${axis}`);
  if (a.path.some((p) => !PATHS.includes(p)) || a.path.length !== PATHS.length) fail('axes.path');
  if (!Number.isSafeInteger(d.population.targetPerCell) || d.population.targetPerCell < 1)
    fail('targetPerCell');
  const s = d.selection;
  if (!Number.isSafeInteger(s?.handsPerStratum) || s.handsPerStratum < 1) fail('handsPerStratum');
  if (!Number.isSafeInteger(s?.bounds?.maxHandsInspected) || s.bounds.maxHandsInspected < 1)
    fail('bounds.maxHandsInspected');
  if (!Number.isSafeInteger(s?.bounds?.observerDeadlineSeconds)) fail('observerDeadlineSeconds');
  return true;
}

/** Hourly strata from the window start; the last one ends at the window end.
 * A 24-hour window has 24 strata; a shorter window has one per started hour. */
export function strataCount(declaration) {
  return Math.ceil((declaration.window.endMs - declaration.window.startMs) / HOUR_MS);
}

/** The finite declared cell set: the axis product with the one stated
 * exclusion (cash admits branch none only). */
export function declaredCells(declaration) {
  const a = declaration.population.axes;
  const cells = new Map();
  for (const format of a.format)
    for (const branch of a.branch) {
      if (format === 'cash' && branch !== 'none') continue;
      for (const size of a.size)
        for (const anteMode of a.anteMode)
          for (const path of a.path) {
            const cell = { format, branch, size, anteMode, path };
            cells.set(cellKey(cell), cell);
          }
    }
  return cells;
}

/** A run request must restate the declaration exactly. Any drift (a different
 * window, target, stratum size or an extra release) is refused, never merged. */
export function enforceDeclaration(loaded, request) {
  const d = loaded.declaration;
  const refuse = (why) => {
    throw Error(`Phase 6D run refused: ${why}`);
  };
  if (request.declarationDigest !== loaded.digest) refuse('declaration digest changed');
  if (request.window.startMs !== d.window.startMs || request.window.endMs !== d.window.endMs)
    refuse('window differs from the declaration');
  if (request.targetPerCell !== d.population.targetPerCell) refuse('target differs');
  if (request.handsPerStratum !== d.selection.handsPerStratum) refuse('handsPerStratum differs');
  const admitted = new Set(d.admittedReleases.map((r) => r.sha));
  for (const sha of request.releases ?? [])
    if (!admitted.has(sha)) refuse(`release ${sha} not admitted`);
  if (request.servingRelease !== d.servingRelease.sha) refuse('serving release differs');
  return true;
}

/** The run request a previously written population report stands for. A new
 * run into the same output is admitted only when this request still restates
 * the declaration, so a window, target or release change after the first
 * report is refused rather than silently overwriting it. */
export function requestFromReport(report) {
  return {
    declarationDigest: report?.declaration?.sha256 ?? null,
    window: { startMs: report?.window?.startMs ?? null, endMs: report?.window?.endMs ?? null },
    targetPerCell: report?.targetPerCell ?? null,
    handsPerStratum: report?.handsPerStratum ?? null,
    releases: Array.isArray(report?.admittedReleases) ? report.admittedReleases : [],
    servingRelease: report?.servingRelease ?? null,
  };
}

/** The request this invocation makes, restated from the loaded declaration. */
export function requestFromDeclaration(loaded) {
  const d = loaded.declaration;
  return {
    declarationDigest: loaded.digest,
    window: { startMs: d.window.startMs, endMs: d.window.endMs },
    targetPerCell: d.population.targetPerCell,
    handsPerStratum: d.selection.handsPerStratum,
    releases: d.admittedReleases.map((r) => r.sha),
    servingRelease: d.servingRelease.sha,
  };
}

/** Mutable population state. Cells exist only when declared. */
export function createPopulation(loaded) {
  const d = loaded.declaration;
  const cells = new Map();
  for (const [key, cell] of declaredCells(d))
    cells.set(key, {
      ...cell,
      target: d.population.targetPerCell,
      observed: 0,
      overflow: 0,
      chains: [],
    });
  return {
    declarationDigest: loaded.digest,
    targetPerCell: d.population.targetPerCell,
    cells,
    chains: [],
    rejected: Object.create(null),
    perRelease: Object.create(null),
  };
}

function count(map, key) {
  map[key] = (map[key] ?? 0) + 1;
}

/** Admit one classified chain. An undeclared cell is refused and counted; a
 * full cell counts overflow and lists nothing. Returns what happened. */
export function admitChain(population, chain) {
  if (!chain?.cell) {
    count(population.rejected, `unclassified:${chain?.rejectReason ?? 'unknown'}`);
    return { admitted: false, reason: chain?.rejectReason ?? 'unclassified' };
  }
  const key = cellKey(chain.cell);
  const cell = population.cells.get(key);
  if (!cell) {
    count(population.rejected, 'undeclared_cell');
    return { admitted: false, reason: 'undeclared_cell', key };
  }
  const release = population.perRelease[chain.sourceRelease] ?? {
    decisions: 0,
    admitted: 0,
    complete: 0,
  };
  release.decisions++;
  population.perRelease[chain.sourceRelease] = release;
  if (cell.observed >= cell.target) {
    cell.overflow++;
    return { admitted: false, reason: 'cell_full', key };
  }
  cell.observed++;
  release.admitted++;
  if (chain.complete) release.complete++;
  const id = population.chains.length + 1;
  cell.chains.push(id);
  population.chains.push({ id, cellKey: key, ...chain });
  return { admitted: true, key, id };
}

export function cellStatus(cell) {
  return cell.observed === 0 ? 'unobserved' : `observed ${cell.observed}/${cell.target}`;
}

/** Cell classification exactly as the declaration states it. Returns
 * { cell } or { rejectReason }. */
export function classifyDecision({ snapshot, decision, witness, acceptedOrigin, declaration }) {
  const gs = snapshot?.gameState;
  if (!gs || gs.stage !== 'preflop') return { rejectReason: 'postflop' };
  const attribution = decision?.tournamentPreflopAttribution ?? null;
  const tournamentMode = gs.gameMode
    ? gs.gameMode === 'tournament'
    : gs.tournament != null || (gs.bigBlind ?? 0) >= 10;
  const format = gs.format ?? (tournamentMode ? 'mtt' : 'cash');
  const lookup = attribution?.lookup ?? null;
  const t = gs.tournament ?? {};
  const branch = lookup ? lookup.coordinate.branch : 'none';
  const size = lookup
    ? lookup.coordinate.tableSize
    : Number.isSafeInteger(t.playersAtTable)
      ? t.playersAtTable
      : Math.max(2, Array.isArray(gs.players) ? gs.players.length : 0);
  const anteMode = lookup
    ? lookup.coordinate.anteType
    : (t.anteType ??
      (gs.bigBlindAnte === true ? 'big_blind' : (gs.ante ?? 0) > 0 ? 'per_player' : 'none'));
  let path;
  if (decision?.policyFallback || witness?.policyFallback || acceptedOrigin === 'horse_fallback')
    path = 'fallback';
  else if (!attribution) return { rejectReason: 'unclassified_path' };
  else if (attribution.status === 'bypassed') path = 'bypass';
  else if (attribution.status === 'atlas_evaluated') path = 'normal';
  else if (attribution.status === 'unavailable')
    path = attribution.reason === 'outside_tournament' ? 'normal' : 'fallback';
  else return { rejectReason: 'unclassified_path' };
  const cell = { format, branch, size, anteMode, path };
  const axes = declaration.population.axes;
  if (
    !axes.format.includes(format) ||
    !axes.branch.includes(branch) ||
    !axes.size.includes(size) ||
    !axes.anteMode.includes(anteMode)
  )
    return { rejectReason: 'undeclared_cell', cell };
  return { cell };
}

const sameTurn = (a, b) => a.producerId === b.producerId && a.turnKey === b.turnKey;
const parse = (record) => JSON.parse(record.body);

/** Assemble request -> calculation -> reference -> accepted action -> completed
 * hand for one decision record. Every link is marked present or
 * missing:<what>; nothing is inferred from a neighbouring link. `deps` are the
 * image's own validators (or, in tests, explicit predicates). */
export function assembleChain({ records, decisionRecord, handKey, deps }) {
  const links = Object.create(null);
  const capture = parse(decisionRecord);
  const snapshot = capture.snapshot ?? null;
  const decision = capture.decision ?? null;
  const requested = records.find(
    (r) =>
      r.kind === 'request_lifecycle' &&
      sameTurn(r, decisionRecord) &&
      parse(r).phase === 'requested'
  );
  if (!snapshot) links.request = 'missing:request_snapshot';
  else if (!requested) links.request = 'missing:request_lifecycle';
  else
    links.request =
      deps.lifecycleRequestDigest(snapshot) === parse(requested).requestDigest
        ? 'present'
        : 'missing:request_digest';
  let calculation = false;
  try {
    calculation =
      !!snapshot &&
      !!decision &&
      deps.samplingStateIsValid(capture.rngBefore) &&
      deps.samplingStateIsValid(capture.rngAfter) &&
      deps.computeMetadataIsValid(capture) &&
      deps.decisionReceiptIsValid(decision, snapshot.gameState?.gameVariant);
  } catch {
    calculation = false;
  }
  links.calculation = calculation ? 'present' : 'missing:calculation_receipt';
  const attribution = decision?.tournamentPreflopAttribution ?? null;
  if (!attribution) links.reference = 'missing:reference';
  else {
    let matches = false;
    try {
      matches = deps.attributionMatchesSnapshot(decision, snapshot);
    } catch {
      matches = false;
    }
    links.reference = matches ? 'present' : 'missing:reference_mismatch';
  }
  const execution = records.find((r) => r.kind === 'execution' && sameTurn(r, decisionRecord));
  let witness = null;
  let accepted = null;
  if (!execution) links.acceptedAction = 'missing:execution_witness';
  else {
    witness = parse(execution);
    const list = Array.isArray(witness.acceptedActions) ? witness.acceptedActions : [];
    if (
      ['intended', 'coerced'].includes(witness.executionStatus) &&
      list.length === 1 &&
      list[0].intended === true
    ) {
      links.acceptedAction = 'present';
      accepted = list[0];
    } else if (witness.executionStatus === 'not_executed')
      links.acceptedAction = `missing:accepted_action:${witness.retirementReason ?? 'retired'}`;
    else links.acceptedAction = `missing:accepted_action:${witness.executionStatus ?? 'unknown'}`;
  }
  const handRecord = records.find((r) => r.kind === 'accepted_hand');
  let acceptedOrigin = null;
  let actionOrdinal = null;
  if (!handRecord) links.completedHand = 'missing:accepted_hand';
  else {
    const raw = parse(handRecord);
    const hand = {
      generation: raw.generation,
      fence: raw.fence,
      handKey: raw.handKey,
      committedHandId: raw.committedHandId,
      actions: raw.actions,
      bigBlind: raw.bigBlind,
      showdown: raw.showdown,
      scope: raw.scope,
    };
    let coordinate = null;
    try {
      coordinate = deps.completedHandKey(hand);
    } catch {
      coordinate = null;
    }
    if (!coordinate || deps.journalHash(coordinate) !== handKey)
      links.completedHand = 'missing:hand_key_mismatch';
    else if (!witness) links.completedHand = 'missing:hand_binding:no_witness';
    else {
      let binding;
      try {
        binding = deps.bindToCommittedHand(witness, hand);
      } catch {
        binding = { status: 'unavailable', reason: 'binding_threw' };
      }
      if (binding.status === 'bound') {
        links.completedHand = 'present';
        actionOrdinal = binding.actionOrdinal;
        acceptedOrigin = hand.actions?.[binding.actionOrdinal]?.origin ?? null;
      } else links.completedHand = `missing:hand_binding:${binding.reason ?? binding.status}`;
    }
  }
  const complete = CHAIN_LINKS.every((link) => links[link] === 'present');
  return {
    links,
    complete,
    snapshot,
    decision,
    witness,
    acceptedOrigin,
    actionOrdinal,
    lane:
      snapshot?.type === 'DECIDE_FAST' ? 'fast' : snapshot?.type === 'DECIDE_DEEP' ? 'deep' : null,
    selectedAction: decision?.action ?? null,
    acceptedAction: accepted?.record?.action ?? null,
    executionStatus: witness?.executionStatus ?? null,
    attribution: attribution
      ? {
          version: attribution.version,
          status: attribution.status,
          route: attribution.route,
          reason: attribution.reason,
          atlasEvaluated: attribution.atlasEvaluated,
          cell: attribution.lookup?.policy?.cell ?? null,
          stackBB: attribution.lookup?.coordinate?.stackBB ?? null,
        }
      : null,
  };
}

/* THE ARCHIVE IS ONE CATALOG PER DECISION SHARD (2026-09-29). #5541 gave each
   decision-shard writer its own catalog: shard 0 stays in 'archive', later
   shards are 'archive-shard-N'. These helpers are the only place this tool
   builds a path into the archive, and the names come from the journal's own
   directory listing (config.horseJournalArchiveDirectoryNames), so a shard the
   journal has cannot be one this tool never opens. Empty is not "nothing to
   read": the journal answers empty only when no archive exists at all. */
export function archiveShardNames(config, directory) {
  const names = config.horseJournalArchiveDirectoryNames(directory);
  if (!Array.isArray(names) || !names.length) throw Error('archive_custody_unavailable');
  return names;
}
export const shardCatalogPath = (directory, shardName) =>
  directory + '/' + shardName + '/horse-journal-archive.sqlite';
export const shardSegmentPath = (directory, shardName, sha) =>
  directory + '/' + shardName + '/segments/' + sha + '.ndjson.gz';
/** The union of two shards' bounds: a missing bound never wins. */
export const mergeBound = (a, b, pick) =>
  Number.isSafeInteger(a) ? (Number.isSafeInteger(b) ? pick(a, b) : a) : (b ?? null);

/* CAPTURE SHED IS NAMED, NOT GUESSED (2026-09-27). The 2026-09-27 population
   on 6b6eabb1 admitted 68 incomplete tournament chains whose completed-hand
   record or execution witness was absent. Their hands were committed in
   hand_history and hand_atomic_commits within seconds; the records were never
   archived because the publisher sheds a record at its queue bound after it
   has already spent that record's sequence number (HorseDecisionJournal.ts,
   `queue_capacity`). The only journal-side evidence of a shed record is the
   hole it leaves in its producer's sequence. The observer used to report the
   missing link and nothing about capture, so a shed record and a record that
   was never produced looked the same. Each stratum now reports its producers'
   sequence continuity, and each chain says when its producer first shed a
   record at or after the decision. That is an observed interval, not a claim
   that the shed record was this chain's. */

/** Sequence continuity per producer over catalog rows [{ rowid, producer,
 * sequence }]. A producer's sequence is dense by construction (one ++ per
 * record attempt), so every hole is a record attempted and never archived.
 * Producers are labelled by first appearance; their ids never leave here. */
export function captureContinuity(rows) {
  const byProducer = new Map();
  for (const row of rows) {
    let p = byProducer.get(row.producer);
    if (!p) byProducer.set(row.producer, (p = { firstRowid: row.rowid, entries: [] }));
    p.entries.push([row.sequence, row.rowid]);
  }
  const producers = new Map();
  let label = 0;
  for (const [producer, p] of [...byProducer].sort((a, b) => a[1].firstRowid - b[1].firstRowid)) {
    p.entries.sort((a, b) => a[0] - b[0]);
    const gaps = [];
    for (let i = 1; i < p.entries.length; i++) {
      const [before, beforeRowid] = p.entries[i - 1];
      const [after, afterRowid] = p.entries[i];
      if (after === before) throw Error('Horse archive sequence duplicated');
      if (after !== before + 1)
        gaps.push({ afterSequence: before, nextSequence: after, beforeRowid, afterRowid });
    }
    const first = p.entries[0][0],
      last = p.entries[p.entries.length - 1][0];
    producers.set(producer, {
      label: `producer ${++label}`,
      archived: p.entries.length,
      firstSequence: first,
      lastSequence: last,
      notArchived: last - first + 1 - p.entries.length,
      gaps,
    });
  }
  return producers;
}

/** The first shed hole in this producer's sequence at or after `sequence`:
 * the hole begins after an archived record whose sequence is >= the given one,
 * or the given sequence itself lies inside a hole. Null when none was seen. */
export function firstShedAtOrAfter(continuity, producer, sequence) {
  const p = continuity.get(producer);
  if (!p) return null;
  let lo = 0,
    hi = p.gaps.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (p.gaps[mid].nextSequence <= sequence) lo = mid + 1;
    else hi = mid;
  }
  return p.gaps[lo] ?? null;
}

/** The capture mark copied beside a chain: how long after the decision its
 * own producer first shed a record, or that it shed none in the scanned rows. */
export function captureMark(continuity, record, shedAtMs) {
  const p = continuity.get(record.producerId);
  if (!p) return { status: 'producer_not_scanned' };
  const gap = firstShedAtOrAfter(continuity, record.producerId, record.sequence);
  if (!gap) return { status: 'no_shed_after_decision', producer: p.label };
  const atMs = shedAtMs(gap);
  return {
    status: 'shed_after_decision',
    producer: p.label,
    firstShedAfterDecisionMs: Number.isSafeInteger(atMs) ? Math.max(0, atMs - record.atMs) : null,
  };
}

/** The public shape of one admitted chain. No hand key, actor, card, seed or
 * record body leaves the observer; the archive rowid is a locator only. */
function chainSummary(chain, extra) {
  return {
    ...extra,
    complete: chain.complete,
    links: chain.links,
    lane: chain.lane,
    selectedAction: chain.selectedAction,
    acceptedAction: chain.acceptedAction,
    executionStatus: chain.executionStatus,
    attribution: chain.attribution,
  };
}

// ---------------------------------------------------------------------------
// observe: runs inside the read-only container on the engine host.
// ---------------------------------------------------------------------------
async function observe(declarationB64) {
  const startedAt = Date.now();
  const declarationText = Buffer.from(declarationB64, 'base64').toString('utf8');
  const declaration = JSON.parse(declarationText);
  validateDeclaration(declaration);
  const declarationDigest = sha256(declarationText);
  const expectedRelease = declaration.servingRelease.sha;
  if (process.env.GIT_COMMIT_SHA !== expectedRelease) throw Error('exact_release_required');
  const directory = process.env.HORSE_DECISION_JOURNAL_DIR;
  if (directory !== '/var/lib/club-arena/horse-decisions') throw Error('private_mount_required');
  const { DatabaseSync } = await import('node:sqlite');
  const { gunzipSync } = await import('node:zlib');
  const { readFileSync: readFile } = await import('node:fs');
  const [store, config, review, record, lifecycle, validation, binding, attribution] =
    await Promise.all([
      import('/app/dist/services/horseDecisionJournal/store.js'),
      import('/app/dist/services/horseDecisionJournal/config.js'),
      import('/app/dist/services/horseDecisionJournal/review.js'),
      import('/app/dist/services/horseDecisionJournal/record.js'),
      import('/app/dist/services/horseDecisionJournal/lifecycle.js'),
      import('/app/dist/engine/horseDecision/responseValidation.js'),
      import('/app/dist/engine/HorseDecisionHandBinding.js'),
      import('/app/dist/engine/HorsePhase6Attribution.js'),
    ]);
  const deps = {
    lifecycleRequestDigest: lifecycle.horseLifecycleRequestDigest,
    samplingStateIsValid: validation.horseSamplingStateIsValid,
    computeMetadataIsValid: validation.horseComputeMetadataIsValid,
    decisionReceiptIsValid: validation.horseDecisionReceiptIsValid,
    attributionMatchesSnapshot: attribution.horsePhase6AttributionMatchesSnapshot,
    completedHandKey: binding.horseCompletedHandKey,
    bindToCommittedHand: binding.bindHorseDecisionToCommittedHand,
    journalHash: record.journalHash,
  };
  const deadlineMs = startedAt + declaration.selection.bounds.observerDeadlineSeconds * 1000;
  const admitted = new Set(declaration.admittedReleases.map((r) => r.sha));
  const population = createPopulation({ declaration, digest: declarationDigest });
  // EVERY ARCHIVE SHARD IS READ (2026-09-29). Since #5541 each decision-shard
  // writer owns its own catalog: shard 0 stays in 'archive', later shards are
  // 'archive-shard-N', and a hand's records live in exactly one of them. This
  // observer used to open 'archive' only, so half of the fleet's hands were
  // never selected and the capture continuity of half of its producers was
  // never measured. The shards are listed by the same function the journal's
  // own reader uses, and none of them may be skipped.
  const shardNames = archiveShardNames(config, directory);
  const shards = shardNames.map((name) => {
    const journal = new store.HorseDecisionJournalStore(
      directory,
      config.readonlyHorseJournalStoreOptions(directory, name)
    );
    const storage = journal.storageStats();
    if (!storage.archive) throw Error('archive_custody_unavailable');
    const catalog = new DatabaseSync(shardCatalogPath(directory, name), {
      readOnly: true,
      allowExtension: false,
    });
    catalog.exec('PRAGMA busy_timeout=250; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    return { name, journal, storage, catalog };
  });
  const output = {
    observedAt: new Date(startedAt).toISOString(),
    expectedRelease,
    declarationDigest,
    // Shard 0's storage stays under its old name; every shard is under shards.
    storage: shards[0].storage,
    shards: shards.map((sh) => ({ shard: sh.name, storage: sh.storage })),
    strata: [],
    counts: {
      handsInspected: 0,
      handsPendingCustody: 0,
      handsUnreadable: 0,
      decisionRecords: 0,
      preflopDecisions: 0,
      chainsAdmitted: 0,
      chainsComplete: 0,
      segmentProbes: 0,
    },
    stopReason: 'strata_exhausted',
  };
  try {
    let handsTotal = 0;
    shards: for (const shard of shards) {
      const { name: shardName, catalog } = shard;
      const maxRowid = catalog
        .prepare('SELECT COALESCE(max(rowid),0) AS rowid FROM archive_events')
        .get().rowid;
      // The archive is a ring (#5355): the oldest segments are retired, so the
      // catalog's rowids start above 1 and every probe lands on a rowid that exists.
      const minRowid = catalog
        .prepare('SELECT COALESCE(min(rowid),0) AS rowid FROM archive_events')
        .get().rowid;
      if (!('maxRowid' in output)) {
        output.maxRowid = maxRowid;
        output.minRowid = minRowid;
      }
      const shardOutput = output.shards.find((x) => x.shard === shardName);
      shardOutput.minRowid = minRowid;
      shardOutput.maxRowid = maxRowid;
      const existingAtOrAfter = catalog.prepare(
        'SELECT rowid FROM archive_events WHERE rowid >= ? ORDER BY rowid LIMIT 1'
      );
      const rowMeta = catalog.prepare(
        `SELECT e.hand_key, e.ordinal, s.sha, s.compressed_sha, s.bytes, s.decoded_bytes, s.records
         FROM archive_events e JOIN archive_segments s ON s.sha = e.segment_sha WHERE e.rowid = ?`
      );
      const segmentCache = new Map();
      const atMsOf = (rowid) => {
        const row = rowMeta.get(rowid);
        if (!row) throw Error('rowid_unavailable');
        let lines = segmentCache.get(row.sha);
        if (!lines) {
          output.counts.segmentProbes++;
          const compressed = readFile(shardSegmentPath(directory, shardName, row.sha));
          if (record.journalHash(compressed) !== row.compressed_sha) throw Error('segment_digest');
          const decoded = gunzipSync(compressed, { maxOutputLength: 4 * 1024 * 1024 + 65536 });
          if (record.journalHash(decoded) !== row.sha) throw Error('segment_digest');
          lines = decoded.toString('utf8').slice(0, -1).split('\n');
          if (segmentCache.size > 64) segmentCache.clear();
          segmentCache.set(row.sha, lines);
        }
        const parsed = JSON.parse(lines[Number(row.ordinal)]);
        record.validateHorseJournalRecord(parsed);
        return parsed.atMs;
      };
      const lowerBound = (t) => {
        let lo = Math.max(1, Number(minRowid)),
          hi = maxRowid + 1;
        while (lo < hi) {
          const mid = Math.floor((lo + hi) / 2);
          const row = Number(existingAtOrAfter.get(mid).rowid);
          if (atMsOf(row) < t) lo = row + 1;
          else hi = mid;
        }
        return lo;
      };
      let shardFirstAtMs = null;
      try {
        // The oldest segment may be retired by the ring while this reads.
        shardFirstAtMs = maxRowid ? atMsOf(Number(minRowid)) : null;
      } catch {
        shardFirstAtMs = null;
      }
      const shardLastAtMs = maxRowid ? atMsOf(maxRowid) : null;
      shardOutput.archiveFirstAtMs = shardFirstAtMs;
      shardOutput.archiveLastAtMs = shardLastAtMs;
      // The archive's span is the union of its shards' spans.
      output.archiveFirstAtMs = mergeBound(output.archiveFirstAtMs, shardFirstAtMs, Math.min);
      output.archiveLastAtMs = mergeBound(output.archiveLastAtMs, shardLastAtMs, Math.max);
      const continuityRows = catalog.prepare(
        'SELECT rowid, producer_id, sequence FROM archive_events WHERE rowid >= ? AND rowid < ?'
      );
      const handRows = catalog.prepare(
        'SELECT rowid, hand_key FROM archive_events WHERE rowid >= ? AND rowid < ? ORDER BY rowid LIMIT 4096'
      );
      const windowEnd = declaration.window.endMs;
      outer: for (let h = 0; h < strataCount(declaration); h++) {
        const startMs = declaration.window.startMs + h * HOUR_MS;
        const endMs = Math.min(startMs + HOUR_MS, windowEnd);
        const stratum = {
          shard: shardName,
          index: h,
          start: new Date(startMs).toISOString(),
          end: new Date(endMs).toISOString(),
          firstRowid: null,
          nextRowid: null,
          hands: 0,
          preflopDecisions: 0,
          admitted: 0,
          status: 'walked',
        };
        output.strata.push(stratum);
        if (Date.now() > deadlineMs) {
          stratum.status = 'not walked: deadline';
          output.stopReason = 'deadline';
          continue;
        }
        const firstRowid = lowerBound(startMs);
        const nextRowid = lowerBound(endMs);
        stratum.firstRowid = firstRowid;
        stratum.nextRowid = nextRowid;
        if (firstRowid > maxRowid || firstRowid >= nextRowid) {
          stratum.status = 'stratum empty: no archived records';
          continue;
        }
        // Sequence continuity over the stratum and a bounded tail after it: a
        // hand's trailing records (its witnesses and completed hand) are written
        // after the stratum's last decision.
        const scanEnd = Math.min(maxRowid + 1, nextRowid + CAPTURE_TAIL_ROWS);
        const continuity = captureContinuity(
          continuityRows.all(firstRowid, scanEnd).map((r) => ({
            rowid: Number(r.rowid),
            producer: String(r.producer_id),
            sequence: Number(r.sequence),
          }))
        );
        const gapTimes = new Map();
        const shedAtMs = (gap) => {
          if (!gapTimes.has(gap.beforeRowid)) {
            let at = null;
            try {
              at = atMsOf(gap.beforeRowid);
            } catch {
              at = null;
            }
            gapTimes.set(gap.beforeRowid, at);
          }
          return gapTimes.get(gap.beforeRowid);
        };
        stratum.capture = {
          scannedRowids: [firstRowid, scanEnd],
          producers: [...continuity.values()].map((p) => {
            const at = p.gaps.length ? shedAtMs(p.gaps[0]) : null;
            return {
              producer: p.label,
              archived: p.archived,
              firstSequence: p.firstSequence,
              lastSequence: p.lastSequence,
              notArchived: p.notArchived,
              holes: p.gaps.length,
              firstShedAt: Number.isSafeInteger(at) ? new Date(at).toISOString() : null,
            };
          }),
        };
        const seen = new Set();
        let cursor = firstRowid;
        while (seen.size < declaration.selection.handsPerStratum && cursor < nextRowid) {
          const rows = handRows.all(cursor, nextRowid);
          if (!rows.length) break;
          for (const row of rows) {
            cursor = Number(row.rowid) + 1;
            if (seen.has(row.hand_key)) continue;
            if (seen.size >= declaration.selection.handsPerStratum) break;
            seen.add(row.hand_key);
            if (Date.now() > deadlineMs) {
              stratum.status = 'partially walked: deadline';
              output.stopReason = 'deadline';
              break outer;
            }
            if (++handsTotal > declaration.selection.bounds.maxHandsInspected) {
              stratum.status = 'partially walked: maxHandsInspected';
              output.stopReason = 'maxHandsInspected';
              break outer;
            }
            output.counts.handsInspected++;
            stratum.hands++;
            let records;
            try {
              records = shard.journal.readHand(row.hand_key);
            } catch (error) {
              if (error instanceof Error && error.message === 'Horse archive custody pending')
                output.counts.handsPendingCustody++;
              else output.counts.handsUnreadable++;
              continue;
            }
            const verdict = review.reconcileHorseJournalHand(records, row.hand_key);
            const decisions = records.filter((r) => r.kind === 'decision');
            output.counts.decisionRecords += decisions.length;
            for (const decisionRecord of decisions) {
              let chain;
              try {
                chain = assembleChain({ records, decisionRecord, handKey: row.hand_key, deps });
              } catch {
                count(population.rejected, 'unreadable_decision');
                continue;
              }
              if (chain.snapshot?.gameState?.stage !== 'preflop') {
                count(population.rejected, 'postflop');
                continue;
              }
              output.counts.preflopDecisions++;
              stratum.preflopDecisions++;
              if (
                decisionRecord.atMs < declaration.window.startMs ||
                decisionRecord.atMs >= windowEnd
              ) {
                count(population.rejected, 'outside_window');
                continue;
              }
              if (!admitted.has(decisionRecord.sourceRelease ?? '')) {
                count(population.rejected, 'release');
                continue;
              }
              const classified = classifyDecision({
                snapshot: chain.snapshot,
                decision: chain.decision,
                witness: chain.witness,
                acceptedOrigin: chain.acceptedOrigin,
                declaration,
              });
              const result = admitChain(population, {
                ...(classified.cell
                  ? { cell: classified.cell }
                  : { rejectReason: classified.rejectReason }),
                sourceRelease: decisionRecord.sourceRelease,
                isServingRelease: decisionRecord.sourceRelease === expectedRelease,
                stratum: h,
                shard: shardName,
                rowid: Number(row.rowid),
                atMs: decisionRecord.atMs,
                at: new Date(decisionRecord.atMs).toISOString(),
                review: { status: verdict.status, gaps: verdict.gaps },
                decisionId: decisionRecord.eventId,
                capture: captureMark(continuity, decisionRecord, shedAtMs),
                ...chainSummary(chain, {}),
              });
              if (result.admitted) {
                stratum.admitted++;
                output.counts.chainsAdmitted++;
                if (chain.complete) output.counts.chainsComplete++;
              }
            }
          }
        }
      }
      if (output.stopReason !== 'strata_exhausted') break shards;
    }
    output.population = serializePopulation(population);
    output.status = 'observed';
  } catch (error) {
    output.status = 'unavailable';
    output.reason = error instanceof Error ? error.message.slice(0, 120) : 'observer_failed';
  } finally {
    for (const sh of shards) {
      try {
        sh.catalog.close();
      } catch {
        output.cleanupVerified = false;
      }
      try {
        sh.journal.close();
      } catch {
        output.cleanupVerified = false;
      }
    }
  }
  output.finishedAt = new Date().toISOString();
  process.stdout.write(JSON.stringify(output) + '\n');
  process.exitCode = output.status === 'observed' ? 0 : 3;
}

export function serializePopulation(population) {
  const cells = {};
  for (const [key, cell] of population.cells)
    cells[key] = {
      target: cell.target,
      observed: cell.observed,
      overflow: cell.overflow,
      status: cellStatus(cell),
      chains: cell.chains,
    };
  return {
    targetPerCell: population.targetPerCell,
    cells,
    chains: population.chains.map((chain) => {
      const { snapshot, decision, witness, acceptedOrigin, actionOrdinal, ...rest } = chain;
      void snapshot;
      void decision;
      void witness;
      void acceptedOrigin;
      void actionOrdinal;
      return rest;
    }),
    rejected: population.rejected,
    perRelease: population.perRelease,
  };
}

// ---------------------------------------------------------------------------
// run: one finite read-only observation on the engine host (Phase 6A pattern).
// ---------------------------------------------------------------------------
const REMOTE_OBSERVER = String.raw`import base64,json,re,subprocess,sys,time
p=json.load(sys.stdin)
sha=p["release"]; name=p["name"]; deadline_s=int(p["deadline"])
assert re.fullmatch(r"[0-9a-f]{40}",sha) and re.fullmatch(r"horse-phase6d-population-[0-9tz]+",name), "payload_identity"
source=base64.b64decode(p["source"],validate=True)
declaration=p["declaration"]
assert len(source)<=262144 and re.fullmatch(r"[A-Za-z0-9+/=]+",declaration), "payload_bounds"
mount="/var/lib/club-arena/horse-decisions"
deadline=time.monotonic()+deadline_s
def command(args,**kw):
 cleanup=kw.pop("cleanup",False)
 remaining=deadline-time.monotonic()-(0 if cleanup else 10)
 if remaining<=0: raise TimeoutError("observation_deadline")
 return subprocess.run(args,capture_output=True,timeout=min(kw.pop("timeout",3),remaining),**kw)
def serving():
 r=command(["docker","inspect","--format","{{.Id}} {{.Image}} {{.State.Running}} {{index .Config.Labels \"sp.release.sha\"}} {{.State.StartedAt}}","club-arena-engine"])
 assert r.returncode==0, "serving_inspect"
 parts=r.stdout.decode().strip().split()
 assert len(parts)==5 and re.fullmatch(r"[0-9a-f]{64}",parts[0]) and re.fullmatch(r"sha256:[0-9a-f]{64}",parts[1]) and parts[2:4]==["true",sha] and re.fullmatch(r"[0-9TZ:.+-]+",parts[4]), "serving_identity"
 return parts
identity=serving(); image=identity[1]
r=command(["docker","image","inspect","--format","{{index .Config.Labels \"org.opencontainers.image.revision\"}}",image]); assert r.returncode==0 and r.stdout.decode().strip()==sha, "image_revision"
r=command(["docker","inspect","--format","{{json .Mounts}}",identity[0]]); assert r.returncode==0, "mounts_inspect"
mounts=[m for m in json.loads(r.stdout) if m.get("Destination")==mount]
assert len(mounts)==1 and mounts[0].get("Type")=="bind" and mounts[0].get("Source")==mount and mounts[0].get("RW") is True, "journal_mount"
r=command(["docker","inspect","--format",'{{range .Config.Env}}{{if eq (index (split . "=") 0) "HORSE_DECISION_JOURNAL_DIR"}}{{println .}}{{end}}{{end}}',identity[0]]); assert r.returncode==0, "env_inspect"
assert [l for l in r.stdout.decode().splitlines() if l]==["HORSE_DECISION_JOURNAL_DIR="+mount], "journal_env"
result={"containerName":name,"release":sha,"imageId":image,"servingContainer":identity[0],"servingStartedAt":identity[4],"horseJournalMountVerified":True,"readOnly":True,"network":"none","memoryBytes":536870912,"cpus":0.5}
try:
 r=command(["docker","create","--name",name,"-i","--network","none","--no-healthcheck","--read-only","--memory","512m","--memory-swap","512m","--cpus","0.5","--pids-limit","32","--mount","type=bind,src="+mount+",dst="+mount+",readonly","--env","HORSE_DECISION_JOURNAL_DIR="+mount,"--entrypoint","node",image,"--no-warnings","--input-type=module","-","observe",declaration])
 assert r.returncode==0, r.stderr.decode()[:200]
 r=command(["docker","start","-ai",name],input=source,timeout=deadline_s-20)
 result["exitCode"]=r.returncode
 result["stderrBytes"]=len(r.stderr)
 result["stderrTail"]=r.stderr.decode(errors="replace")[-400:]
 assert len(r.stdout)<=16777216
 result["observation"]=json.loads(r.stdout)
 state=command(["docker","inspect","--format","{{json .State}}",name]); assert state.returncode==0
 state=json.loads(state.stdout);result["oomKilled"]=state["OOMKilled"];result["containerExitCode"]=state["ExitCode"]
 result["sameServingIdentityAfter"]=serving()==identity
except Exception as error:
 result["executionStatus"]="unavailable";result["errorClass"]=type(error).__name__;result["errorText"]=str(error)[:300]
finally:
 try:
  cleanup=command(["docker","rm","-f",name],cleanup=True,timeout=5)
  result["cleanupExitCode"]=cleanup.returncode
 except Exception as error:
  result["cleanupStatus"]="unknown";result["cleanupErrorClass"]=type(error).__name__
 try:
  check=command(["docker","ps","-a","--format","{{.Names}}","--filter","name=^/"+name+"$"],cleanup=True,timeout=5)
  result["observerRemoved"]=check.returncode==0 and not check.stdout.strip()
 except Exception as error:
  result["observerRemoved"]=False;result["absenceErrorClass"]=type(error).__name__
 print(json.dumps(result))
`;

function runObservation({ loaded, sshTarget, sshKey, outDir, date }) {
  const declarationText = readFileSync(loaded.path, 'utf8');
  const source = readFileSync(new URL(import.meta.url));
  const stamp = new Date().toISOString().replace(/[-:.]/g, '').toLowerCase();
  const name = 'horse-phase6d-population-' + stamp;
  const deadline = loaded.declaration.selection.bounds.observerDeadlineSeconds + 40;
  const payload = {
    release: loaded.declaration.servingRelease.sha,
    name,
    deadline,
    source: source.toString('base64'),
    declaration: Buffer.from(declarationText).toString('base64'),
  };
  const startedAt = new Date().toISOString();
  const run = spawnSync(
    'ssh',
    [
      '-i',
      sshKey,
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=10',
      sshTarget,
      'python3 -c ' + shellQuote(REMOTE_OBSERVER),
    ],
    { input: JSON.stringify(payload), maxBuffer: 64 * 1024 * 1024, timeout: (deadline + 90) * 1000 }
  );
  const result = {
    containerName: name,
    startedAt,
    finishedAt: new Date().toISOString(),
    sshExitCode: run.status,
    sshSignal: run.signal ?? null,
    scriptSha256: sha256(source),
    sshStderrBytes: run.stderr?.length ?? 0,
    sshStderrTail: run.stderr ? run.stderr.toString('utf8').slice(-300) : '',
  };
  if (run.status === 0 && run.stdout?.length) {
    try {
      result.execution = JSON.parse(run.stdout.toString('utf8'));
    } catch {
      result.executionStatus = 'unavailable';
      result.reason = 'observer_output_not_json';
    }
  } else result.executionStatus = 'unavailable';
  const execution = result.execution ?? {};
  const observation = execution.observation ?? {};
  result.qualifiedExecution =
    result.sshExitCode === 0 &&
    !('executionStatus' in result) &&
    !('executionStatus' in execution) &&
    execution.exitCode === 0 &&
    execution.containerExitCode === 0 &&
    execution.oomKilled === false &&
    execution.sameServingIdentityAfter === true &&
    execution.observerRemoved === true &&
    execution.cleanupExitCode === 0 &&
    execution.horseJournalMountVerified === true &&
    observation.status === 'observed' &&
    observation.expectedRelease === loaded.declaration.servingRelease.sha &&
    observation.declarationDigest === loaded.digest;
  mkdirSync(outDir, { recursive: true });
  const path = join(outDir, `population-observation-${date}.json`);
  return { result, path };
}

/** The declaration must be committed, byte for byte, before a run reads any
 * record: an untracked or locally edited declaration is refused. */
function refuseUncommittedDeclaration(path) {
  const cwd = dirname(path);
  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', basename(path)], { cwd });
  if (tracked.status !== 0) throw Error('Phase 6D run refused: declaration is not committed');
  const clean = spawnSync('git', ['diff', '--quiet', 'HEAD', '--', basename(path)], { cwd });
  if (clean.status !== 0) throw Error('Phase 6D run refused: declaration differs from its commit');
}

function shellQuote(text) {
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

// ---------------------------------------------------------------------------
// report: population JSON + Markdown from one observation.
// ---------------------------------------------------------------------------
export function buildReport({ loaded, observationFile, observation, commandLine, date }) {
  const d = loaded.declaration;
  const execution = observation.execution ?? {};
  const remote = execution.observation ?? {};
  if (remote.declarationDigest && remote.declarationDigest !== loaded.digest)
    throw Error('Phase 6D report refused: observation was made under a different declaration');
  const cells = declaredCells(d);
  const observed = remote.population?.cells ?? {};
  const merged = {};
  let observedCells = 0;
  for (const [key, cell] of cells) {
    const o = observed[key] ?? {
      target: d.population.targetPerCell,
      observed: 0,
      overflow: 0,
      chains: [],
    };
    const status = o.observed === 0 ? 'unobserved' : `observed ${o.observed}/${o.target}`;
    if (o.observed > 0) observedCells++;
    merged[key] = {
      ...cell,
      target: o.target,
      observed: o.observed,
      overflow: o.overflow,
      status,
      chains: o.chains,
    };
  }
  const chains = remote.population?.chains ?? [];
  const linkTally = {};
  for (const link of CHAIN_LINKS) linkTally[link] = {};
  for (const chain of chains)
    for (const link of CHAIN_LINKS)
      count(linkTally[link], chain.links?.[link] ?? 'missing:unmarked');
  const byFormatPath = {};
  for (const cell of Object.values(merged)) {
    const k = `${cell.format}|${cell.path}`;
    const row = (byFormatPath[k] ??= {
      format: cell.format,
      path: cell.path,
      declared: 0,
      observed: 0,
    });
    row.declared++;
    if (cell.observed > 0) row.observed++;
  }
  const servingRelease = d.servingRelease.sha;
  const perRelease = remote.population?.perRelease ?? {};
  const report = {
    reportVersion: 1,
    stage: '6D',
    generatedAt: new Date().toISOString(),
    commandLine,
    declaration: { path: basename(loaded.path), sha256: loaded.digest, declaredAt: d.declaredAt },
    window: d.window,
    targetPerCell: d.population.targetPerCell,
    handsPerStratum: d.selection.handsPerStratum,
    admittedReleases: d.admittedReleases.map((r) => r.sha),
    servingRelease,
    observationFile: basename(observationFile),
    observer: {
      containerName: observation.containerName,
      startedAt: observation.startedAt,
      finishedAt: observation.finishedAt,
      qualifiedExecution: observation.qualifiedExecution,
      sshExitCode: observation.sshExitCode,
      executionStatus: observation.executionStatus ?? execution.executionStatus ?? null,
      errorClass: execution.errorClass ?? null,
      imageId: execution.imageId ?? null,
      servingContainer: execution.servingContainer ?? null,
      servingStartedAt: execution.servingStartedAt ?? null,
      exitCode: execution.exitCode ?? null,
      oomKilled: execution.oomKilled ?? null,
      observerRemoved: execution.observerRemoved ?? null,
      sameServingIdentityAfter: execution.sameServingIdentityAfter ?? null,
      scriptSha256: observation.scriptSha256,
    },
    archive: {
      status: remote.status ?? 'unavailable',
      reason: remote.reason ?? null,
      observedAt: remote.observedAt ?? null,
      finishedAt: remote.finishedAt ?? null,
      storage: remote.storage ?? null,
      shards: remote.shards ?? null,
      minRowid: remote.minRowid ?? null,
      maxRowid: remote.maxRowid ?? null,
      firstRecordAt: remote.archiveFirstAtMs
        ? new Date(remote.archiveFirstAtMs).toISOString()
        : null,
      lastRecordAt: remote.archiveLastAtMs ? new Date(remote.archiveLastAtMs).toISOString() : null,
      stopReason: remote.stopReason ?? null,
      counts: remote.counts ?? null,
    },
    strata: remote.strata ?? [],
    summary: {
      declaredCells: cells.size,
      observedCells,
      unobservedCells: cells.size - observedCells,
      chainsAdmitted: chains.length,
      chainsComplete: chains.filter((c) => c.complete).length,
      chainsIncomplete: chains.filter((c) => !c.complete).length,
      servingReleaseChains: chains.filter((c) => c.isServingRelease).length,
      linkTally,
      byFormatPath: Object.values(byFormatPath),
      perRelease,
      rejected: remote.population?.rejected ?? {},
      incompleteByCapture: tallyIncompleteByCapture(chains),
    },
    observedCells: Object.fromEntries(Object.entries(merged).filter(([, c]) => c.observed > 0)),
    unobservedCells: Object.entries(merged)
      .filter(([, c]) => c.observed === 0)
      .map(([key]) => key),
    chains,
  };
  return report;
}

/** Incomplete chains by their producer's capture mark: whether it shed a
 * record at or after the decision, and within a minute or later. A chain from
 * an observation made before capture marks existed is counted as unmarked. */
export function captureBucket(capture) {
  if (!capture) return 'unmarked';
  if (capture.status !== 'shed_after_decision') return capture.status;
  const ms = capture.firstShedAfterDecisionMs;
  if (!Number.isSafeInteger(ms)) return 'shed_after_decision:time_unavailable';
  return ms <= 60_000 ? 'shed_within_60s_of_decision' : 'shed_later_than_60s_after_decision';
}
export function tallyIncompleteByCapture(chains) {
  const tally = {};
  for (const chain of chains) if (!chain.complete) count(tally, captureBucket(chain.capture));
  return tally;
}

const short = (sha) => (typeof sha === 'string' ? sha.slice(0, 10) : 'none');

export function renderMarkdown(report, loaded) {
  const d = loaded.declaration;
  const s = report.summary;
  const lines = [];
  lines.push(
    `# Horse Brain Phase 6D: predeclared finite natural population, ${report.declaration.declaredAt.slice(0, 10)}`
  );
  lines.push('');
  lines.push(
    `Generated ${report.generatedAt}. Declaration \`${report.declaration.path}\` (sha256 \`${report.declaration.sha256}\`, declared ${report.declaration.declaredAt}, before any record was read). Window ${d.window.start} to ${d.window.end}. Serving release at the /health read: \`${report.servingRelease}\`.`
  );
  lines.push('');
  lines.push('Exact command line:');
  lines.push('');
  lines.push('```');
  lines.push(report.commandLine);
  lines.push('```');
  lines.push('');
  lines.push('## Observer');
  lines.push('');
  const o = report.observer;
  lines.push(
    `Container \`${o.containerName ?? 'none'}\` from image \`${o.imageId ?? 'none'}\` beside serving container \`${short(o.servingContainer)}\` (started ${o.servingStartedAt ?? 'unknown'}); read-only journal mount, network none; exit ${o.exitCode ?? 'none'}, OOM ${o.oomKilled ?? 'unknown'}, removed ${o.observerRemoved ?? 'unknown'}, serving identity unchanged ${o.sameServingIdentityAfter ?? 'unknown'}, qualified execution ${o.qualifiedExecution}.`
  );
  lines.push('');
  const a = report.archive;
  lines.push('## Archive state seen by the observer');
  lines.push('');
  lines.push(
    `Status ${a.status}${a.reason ? ` (${a.reason})` : ''}; observed ${a.observedAt ?? 'never'} to ${a.finishedAt ?? 'never'}; stop reason ${a.stopReason ?? 'none'}. Catalog rowids ${a.minRowid ?? 'unknown'} to ${a.maxRowid ?? 'unknown'}; first archived record ${a.firstRecordAt ?? 'unknown'}; last archived record ${a.lastRecordAt ?? 'unknown'}.`
  );
  if (Array.isArray(a.shards) && a.shards.length)
    lines.push(
      '',
      `Archive shards read (${a.shards.length}): ` +
        a.shards
          .map(
            (sh) =>
              `${sh.shard} rowids ${sh.minRowid ?? 'unknown'} to ${sh.maxRowid ?? 'unknown'}, ${sh.storage?.archive?.segments ?? 'unknown'} segments`
          )
          .join('; ') +
        '.'
    );
  const windowEnd = d.window.end;
  if (a.lastRecordAt && Date.parse(a.lastRecordAt) < Date.parse(windowEnd))
    lines.push(
      '',
      `Archived records end at ${a.lastRecordAt}, before the window end ${windowEnd}. Every stratum after that instant is empty because nothing was archived after it; an empty stratum is unobserved, not a zero rate.`
    );
  const archiveStorage = a.storage?.archive;
  if (archiveStorage && archiveStorage.segments >= archiveStorage.maxSegments)
    lines.push(
      '',
      `The archive holds ${archiveStorage.segments} of ${archiveStorage.maxSegments} permitted segments, so the journal could not archive further records at the time of the read.`
    );
  if (report.summary.servingReleaseChains === 0)
    lines.push(
      '',
      `No chain in this population comes from the serving release \`${short(report.servingRelease)}\`. This population is production evidence for the window and the releases named per chain; it is not evidence for the serving revision.`
    );
  if (a.storage) lines.push('', 'Storage: `' + JSON.stringify(a.storage) + '`');
  if (a.counts) lines.push('', 'Counts: `' + JSON.stringify(a.counts) + '`');
  lines.push('');
  lines.push(`## Strata (${strataCount(d)} hourly, walked in rowid order)`);
  lines.push('');
  lines.push(
    '| Shard | Stratum | Start | First rowid | Next rowid | Hands read | Preflop decisions | Admitted | Status |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const st of report.strata)
    lines.push(
      `| ${st.shard ?? 'archive'} | ${st.index} | ${st.start} | ${st.firstRowid ?? 'none'} | ${st.nextRowid ?? 'none'} | ${st.hands} | ${st.preflopDecisions} | ${st.admitted} | ${st.status} |`
    );
  lines.push('');
  lines.push('## Capture continuity');
  lines.push('');
  lines.push(
    "A producer's journal sequence is spent once per record attempt, so a hole in it is a record the publisher attempted and never archived (shed at its queue bound, or lost with a failed writer). Scanned: each stratum's rows and a tail of at most " +
      CAPTURE_TAIL_ROWS +
      ' rows after it. Producers are numbered by first appearance.'
  );
  lines.push('');
  lines.push(
    '| Shard | Stratum | Producer | Archived | Sequence range | Not archived | Holes | First shed |'
  );
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  let captureRows = 0;
  for (const st of report.strata)
    for (const p of st.capture?.producers ?? []) {
      captureRows++;
      lines.push(
        `| ${st.shard ?? 'archive'} | ${st.index} | ${p.producer} | ${p.archived} | ${p.firstSequence} to ${p.lastSequence} | ${p.notArchived} | ${p.holes} | ${p.firstShedAt ?? 'none'} |`
      );
    }
  if (!captureRows) lines.push('| none | none | none | 0 | none | 0 | 0 | none |');
  lines.push('');
  lines.push(
    'Incomplete chains by the capture mark of their own producer: `' +
      JSON.stringify(report.summary.incompleteByCapture ?? {}) +
      '`. A shed after the decision is an observed interval beside the gap, not proof that the shed record was the missing one.'
  );
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(
    `Declared cells ${s.declaredCells}; observed cells ${s.observedCells}; unobserved cells ${s.unobservedCells}. Chains admitted ${s.chainsAdmitted} (complete ${s.chainsComplete}, incomplete ${s.chainsIncomplete}); chains from the serving release ${s.servingReleaseChains}. Every count is a count; nothing here is a percentage.`
  );
  lines.push('');
  lines.push(
    'Per release (decisions classified inside the window, chains admitted, complete chains):'
  );
  lines.push('');
  lines.push('| Release | Decisions | Admitted | Complete | Serving |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const r of d.admittedReleases) {
    const p = s.perRelease[r.sha] ?? { decisions: 0, admitted: 0, complete: 0 };
    lines.push(
      `| \`${short(r.sha)}\` | ${p.decisions} | ${p.admitted} | ${p.complete} | ${r.sha === report.servingRelease ? 'yes' : 'no'} |`
    );
  }
  lines.push('');
  lines.push('Chain links across admitted chains:');
  lines.push('');
  lines.push('| Link | Marks |');
  lines.push('| --- | --- |');
  for (const link of CHAIN_LINKS) {
    const marks = Object.entries(s.linkTally[link] ?? {})
      .sort((x, y) => y[1] - x[1])
      .map(([mark, n]) => `${mark} ${n}`)
      .join('; ');
    lines.push(`| ${link} | ${marks || 'no chains'} |`);
  }
  lines.push('');
  lines.push('Rejected (never fill a cell): `' + JSON.stringify(s.rejected) + '`');
  lines.push('');
  lines.push('## Observed cells by format and path');
  lines.push('');
  lines.push('| Format | Path | Declared cells | Observed cells | Unobserved cells |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of s.byFormatPath)
    lines.push(
      `| ${row.format} | ${row.path} | ${row.declared} | ${row.observed} | ${row.declared - row.observed} |`
    );
  lines.push('');
  lines.push('## Observed cells');
  lines.push('');
  const observedCells = Object.values(report.observedCells);
  if (!observedCells.length) lines.push('No declared cell was observed.');
  else {
    lines.push('| Format | Branch | Size | Ante | Path | Status | Overflow | Chains |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const c of observedCells)
      lines.push(
        `| ${c.format} | ${c.branch} | ${c.size} | ${c.anteMode} | ${c.path} | ${c.status} | ${c.overflow} | ${c.chains.join(', ')} |`
      );
  }
  lines.push('');
  lines.push(`## Unobserved cells`);
  lines.push('');
  lines.push(
    `${s.unobservedCells} declared cells were not reached by any admitted decision in the walked strata. They are listed by cell key in the JSON (\`unobservedCells\`). They are unobserved, not zero-rate and not covered.`
  );
  lines.push('');
  lines.push('## Chains');
  lines.push('');
  if (!report.chains.length) lines.push('No chain was admitted.');
  else {
    lines.push(
      '| Id | Cell | Release | Serving | At | Lane | Attribution | Selected | Accepted | Links | Review | Capture |'
    );
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    for (const c of report.chains) {
      const attr = c.attribution
        ? `${c.attribution.status}/${c.attribution.route}/${c.attribution.reason}`
        : 'none';
      const links = CHAIN_LINKS.map((l) => `${l}=${c.links[l]}`).join(' ');
      lines.push(
        `| ${c.id} | ${c.cellKey} | \`${short(c.sourceRelease)}\` | ${c.isServingRelease ? 'yes' : 'no'} | ${c.at} | ${c.lane} | ${attr} | ${c.selectedAction} | ${c.acceptedAction ?? 'none'} | ${links} | ${c.review.status}${c.review.gaps.length ? ' ' + c.review.gaps.join(',') : ''} | ${captureBucket(c.capture)} |`
      );
    }
  }
  lines.push('');
  lines.push('## What this does and does not show');
  lines.push('');
  lines.push(
    '- Every admitted chain is a real production decision joined link by link to its own retained records. A present link is an exact join; a missing link names what is absent.'
  );
  lines.push(
    '- An unobserved cell means no admitted decision reached it inside the walked strata. It is not filled, estimated or inferred from a neighbouring cell.'
  );
  lines.push(
    '- Chains from earlier admitted releases are production evidence for the window, not evidence for the serving revision. The serving-release count above is the only serving-revision figure.'
  );
  lines.push(
    '- Nothing here measures GTO strength, causal influence or calibration; the reference link records the atlas receipt that was actually produced.'
  );
  lines.push('');
  return lines.join('\n');
}

/** Every evidence file is written in the repository's own Prettier output
 * shape (its .prettierrc, resolved for the target path), so a rerun and a
 * `prettier --check` see identical bytes and nothing needs an ignore entry. */
export async function formatEvidence(path, text) {
  const prettier = await import('prettier');
  const config = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(text, { ...config, filepath: path });
}

async function writeEvidence(path, text) {
  writeFileSync(path, await formatEvidence(path, text));
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else args._.push(a);
  }
  return args;
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.find((a) => ['run', 'report', 'observe'].includes(a));
  const args = parseArgs(argv.filter((a) => a !== mode));
  if (mode === 'observe') {
    try {
      await observe(args._[0]);
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          status: 'unavailable',
          reason: error instanceof Error ? error.message.slice(0, 120) : 'observer_failed',
        }) + '\n'
      );
      process.exitCode = 3;
    }
    return;
  }
  if (!mode || !args.declaration) {
    process.stderr.write(
      'usage: phase6d-population.mjs run --declaration <json> --out <dir> [--date YYYY-MM-DD]\n' +
        '       phase6d-population.mjs report --declaration <json> --observation <json> --out <dir>\n'
    );
    process.exitCode = 2;
    return;
  }
  const loaded = loadDeclaration(resolve(args.declaration));
  const date = args.date ?? loaded.declaration.declaredAt.slice(0, 10);
  const outDir = resolve(args.out ?? '.');
  const commandLine = ['node', 'server/scripts/phase6d-population.mjs', ...argv].join(' ');
  refuseUncommittedDeclaration(loaded.path);
  const priorPath = join(outDir, `population-${date}.json`);
  if (existsSync(priorPath))
    enforceDeclaration(loaded, requestFromReport(JSON.parse(readFileSync(priorPath, 'utf8'))));
  enforceDeclaration(loaded, requestFromDeclaration(loaded));
  let observationFile = args.observation ? resolve(args.observation) : null;
  let observation;
  if (mode === 'run') {
    const { result, path } = runObservation({
      loaded,
      sshTarget: args['ssh-target'] ?? 'root@5.161.252.33',
      sshKey: args['ssh-key'] ?? '/Users/smarter.poker/.ssh/hetzner_engine_key',
      outDir,
      date,
    });
    observation = result;
    observationFile = path;
    await writeEvidence(path, JSON.stringify(result, null, 2) + '\n');
  } else observation = JSON.parse(readFileSync(observationFile, 'utf8'));
  const report = buildReport({ loaded, observationFile, observation, commandLine, date });
  mkdirSync(outDir, { recursive: true });
  await writeEvidence(
    join(outDir, `population-${date}.json`),
    JSON.stringify(report, null, 2) + '\n'
  );
  await writeEvidence(join(outDir, `population-${date}.md`), renderMarkdown(report, loaded));
  process.stdout.write(
    JSON.stringify({
      declaredCells: report.summary.declaredCells,
      observedCells: report.summary.observedCells,
      unobservedCells: report.summary.unobservedCells,
      chainsAdmitted: report.summary.chainsAdmitted,
      chainsComplete: report.summary.chainsComplete,
      servingReleaseChains: report.summary.servingReleaseChains,
      archiveStatus: report.archive.status,
      qualifiedExecution: report.observer.qualifiedExecution,
    }) + '\n'
  );
  process.exitCode = report.observer.qualifiedExecution ? 0 : 2;
}

const entry = process.argv[1] ? basename(process.argv[1]) : '';
if (entry === '-' || entry === 'phase6d-population.mjs') await main();
