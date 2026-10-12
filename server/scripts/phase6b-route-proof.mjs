#!/usr/bin/env node
// Phase 6B bounded observed route proof.
//
// One predeclared, finite selector: an explicit UTC time window and the exact
// engine release, both given as arguments and recorded in the output. The
// script reads the Horse decision journal archive that production already
// emits (the same private spool the Phase 6A verifier read) and reports, per
// domain cell (dealt size x preflop branch x ante mode x stack-anchor band),
// the observed lookup count, the accepted-action count and the refusal count.
// A cell with no observation is reported as "unobserved". Nothing is invented
// or interpolated: every number is a count of retained records, and every
// join is made by the deployed matcher and binder, never re-derived here.
//
// It runs inside a read-only observer container built from the serving image
// (see phase6b-route-proof-observe.py), importing the deployed compiled
// modules from /app/dist so the atlas domain, receipt matcher and accepted
// action binder are the ones the release actually serves. It never prints
// record bodies, actor or table identifiers, hand keys, private cards or
// arbitrary error text; only aggregate counts, the selector and digests.
//
//   observe --release <sha40> --since <ISO> --until <ISO>
//           [--records-release <sha40>] (records written by another release; historical only)
//           [--journal-dir /var/lib/club-arena/horse-decisions] [--dist /app/dist]
//           [--max-rows 3000000] [--margin-rows 8192]
//   render  --input <envelope-or-observation.json> (prints the markdown table)
//
import { createHash } from 'node:crypto';
import { openSync, fstatSync, readSync, closeSync, constants, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const SHA40 = /^[0-9a-f]{40}$/;
const SHA64 = /^[0-9a-f]{64}$/;
const DECODE_BYTES = 8 * 1024 * 1024;
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) throw Error(`missing value for --${key}`);
      out[key] = value;
      i++;
    } else out._.push(arg);
  }
  return out;
}

function parseIso(label, value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value))
    throw Error(`${label} must be an explicit UTC ISO-8601 instant ending in Z`);
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw Error(`${label} is not a valid instant`);
  return ms;
}

function bandOf(stackBB, anchors) {
  if (!Number.isFinite(stackBB)) return 'nonfinite';
  const min = anchors[0];
  const max = anchors[anchors.length - 1];
  if (stackBB < min) return `below-${min}`;
  if (stackBB > max) return `above-${max}`;
  if (stackBB === max) return String(max);
  for (let i = 0; i < anchors.length - 1; i++) {
    if (stackBB >= anchors[i] && stackBB < anchors[i + 1]) return `${anchors[i]}-${anchors[i + 1]}`;
  }
  return 'nonfinite';
}

function bandsOf(anchors) {
  const bands = [`below-${anchors[0]}`];
  for (let i = 0; i < anchors.length - 1; i++) bands.push(`${anchors[i]}-${anchors[i + 1]}`);
  bands.push(String(anchors[anchors.length - 1]));
  bands.push(`above-${anchors[anchors.length - 1]}`);
  return bands;
}

const cellKey = (size, branch, ante, band) => `size=${size}|branch=${branch}|ante=${ante}|band=${band}`;

function compiledHash(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw Error('compiled_regular_file_required');
    const bytes = Buffer.alloc(1048577);
    let n,
      size = 0;
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, size)) > 0)
      size += n;
    if (size > 1048576) throw Error('compiled_read_bound');
    return sha256(bytes.subarray(0, size));
  } finally {
    closeSync(fd);
  }
}

const bump = (map, key, by = 1) => {
  map[key] = (map[key] ?? 0) + by;
};

/* THE ARCHIVE IS ONE CATALOG PER DECISION SHARD (2026-09-29). #5541 gave each
   decision-shard writer its own catalog: shard 0 stays in 'archive', later
   shards are 'archive-shard-N'. This tool used to open 'archive' only, so the
   hands and producers of every other shard were never observed. These helpers
   are the only place it builds a path into the archive, and the names come from
   the journal's own directory listing. Identical to the helpers in
   phase6d-population.mjs and phase6d-chain-export.mjs (each tool ships alone
   into the observer container, so it cannot import them); a law test keeps the
   three in step. */
function archiveShardNames(config, directory) {
  const names = config.horseJournalArchiveDirectoryNames(directory);
  if (!Array.isArray(names) || !names.length) throw Error('archive_custody_unavailable');
  return names;
}
const shardCatalogPath = (directory, shardName) =>
  directory + '/' + shardName + '/horse-journal-archive.sqlite';
const shardSegmentPath = (directory, shardName, sha) =>
  directory + '/' + shardName + '/segments/' + sha + '.ndjson.gz';

async function observe(args) {
  const startedAt = Date.now();
  const release = args.release;
  if (!SHA40.test(release ?? '')) throw Error('exact_release_required');
  const imageRelease = process.env.GIT_COMMIT_SHA ?? null;
  if (imageRelease !== release) throw Error('observer_image_release_mismatch');
  // The release whose retained records are selected. It is the serving release
  // unless the caller declares an earlier one for a historical-only window.
  const recordsRelease = args['records-release'] ?? release;
  if (!SHA40.test(recordsRelease)) throw Error('records_release_invalid');
  const sinceMs = parseIso('--since', args.since);
  const untilMs = parseIso('--until', args.until);
  if (!(untilMs > sinceMs)) throw Error('window_must_be_positive');
  const journalDir = args['journal-dir'] ?? '/var/lib/club-arena/horse-decisions';
  const dist = args.dist ?? '/app/dist';
  const maxRows = Number(args['max-rows'] ?? 3_000_000);
  const marginRows = Number(args['margin-rows'] ?? 8192);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1) throw Error('max_rows_invalid');
  if (!Number.isSafeInteger(marginRows) || marginRows < 0) throw Error('margin_rows_invalid');

  const [{ DatabaseSync }, atlas, attribution, binding, record, config] = await Promise.all([
    import('node:sqlite'),
    import(`${dist}/engine/HorseTournamentPreflop.js`),
    import(`${dist}/engine/HorsePhase6Attribution.js`),
    import(`${dist}/engine/HorseDecisionHandBinding.js`),
    import(`${dist}/services/horseDecisionJournal/record.js`),
    import(`${dist}/services/horseDecisionJournal/config.js`),
  ]);
  const domain = atlas.TOURNAMENT_PREFLOP_ATLAS_DOMAIN;
  const anchors = [...domain.depth.anchorsBB];
  const bands = bandsOf(anchors);
  const sizes = [...domain.tableSizes];
  const branches = [...domain.branches];
  const anteTypes = [...domain.anteTypes];
  const recomputedDigest = sha256(atlas.canonicalJson(domain));

  const compiledHashes = {};
  for (const file of [
    'engine/HorseTournamentPreflop',
    'engine/HorsePhase6Attribution',
    'engine/HorseDecisionHandBinding',
    'engine/HorseTournamentContextProvenance',
    'services/horseDecisionJournal/record',
    'services/horseDecisionJournal/store',
    'services/horseDecisionJournal/review',
    'services/horseDecisionJournal/config',
  ])
    compiledHashes[file] = compiledHash(`${dist}/${file}.js`);

  const counts = {
    rowsScanned: 0,
    rowsInWindow: 0,
    rowsBeforeWindow: 0,
    rowsAfterWindow: 0,
    rowsOtherRelease: 0,
    otherReleases: {},
    byKind: {},
    truncated: false,
  };
  const decisions = {
    total: 0,
    cash: 0,
    tournamentNotPreflop: 0,
    tournamentPreflop: 0,
    tournamentSchemaUnavailable: 0,
    brainException: 0,
    receiptAbsent: 0,
    receiptV1: 0,
    receiptV2: 0,
    receiptByRoute: {},
    receiptByStatus: {},
    receiptByReason: {},
    withLookup: 0,
    withoutLookup: 0,
    lookupBySource: {},
    lookupByFamily: {},
    lookupByContextStatus: {},
    lookupRefusedByReason: {},
    matchedSnapshot: 0,
    mismatchRefused: 0,
    mismatchByReason: {},
    depthBracketDisagreements: 0,
    atlasRevisionOther: 0,
    outsideDomainCoordinate: 0,
  };
  const joins = {
    completedHandsSeen: 0,
    completedHandsWithPreflopTournamentExecutions: 0,
    executionsSeen: 0,
    executionsPreflopTournament: 0,
    executionsWithoutDecision: 0,
    acceptedBound: 0,
    acceptedBoundWithoutLookup: 0,
    bindingUnavailableByReason: {},
    decisionsWithoutCompletedHand: 0,
    recordsAfterCompletedHand: 0,
    handsEvictedIncomplete: 0,
    handsWithMultipleDecisionsForTurn: 0,
  };
  const cells = new Map();
  const cellFor = (key, meta) => {
    let cell = cells.get(key);
    if (!cell) {
      cell = {
        cell: key,
        ...meta,
        observed: 0,
        baseline: 0,
        refused: {},
        mismatchRefused: 0,
        accepted: 0,
        acceptedUnavailable: {},
      };
      cells.set(key, cell);
    }
    return cell;
  };
  const hands = new Map();
  const completed = new Set();
  const handState = (handKey) => {
    let hand = hands.get(handKey);
    if (!hand) {
      hand = { decisions: new Map(), executions: new Map(), order: hands.size };
      hands.set(handKey, hand);
      if (hands.size > 20000) {
        const oldest = hands.keys().next().value;
        const state = hands.get(oldest);
        joins.handsEvictedIncomplete++;
        joins.decisionsWithoutCompletedHand += state.decisions.size;
        hands.delete(oldest);
      }
    }
    return hand;
  };
  const mismatchNamed = typeof attribution.horsePhase6AttributionMismatch === 'function';

  const shardNames = archiveShardNames(config, journalDir);
  const shardReports = [];
  let segmentsDecodedTotal = 0;
  for (const shardName of shardNames) {
    const archivePath = shardCatalogPath(journalDir, shardName);
    const db = new DatabaseSync(archivePath, { readOnly: true, allowExtension: false });
    db.exec('PRAGMA busy_timeout=250; PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;');
    const segmentMeta = db.prepare(
      'SELECT sha, compressed_sha, bytes, decoded_bytes, records FROM archive_segments WHERE sha=?'
    );
    const cache = new Map();
    let segmentsDecoded = 0;
    const rowsBeforeShard = counts.rowsScanned;
    const readSegment = (sha) => {
      const hit = cache.get(sha);
      if (hit) return hit;
      if (!SHA64.test(sha)) throw Error('segment_sha_invalid');
      const meta = segmentMeta.get(sha);
      if (!meta) throw Error('segment_meta_missing');
      const compressed = readFileSync(shardSegmentPath(journalDir, shardName, sha));
      if (compressed.length !== Number(meta.bytes) || sha256(compressed) !== meta.compressed_sha)
        throw Error('segment_bytes_mismatch');
      const decoded = gunzipSync(compressed, { maxOutputLength: DECODE_BYTES });
      if (decoded.length !== Number(meta.decoded_bytes) || sha256(decoded) !== sha)
        throw Error('segment_decoded_mismatch');
      const lines = decoded.toString('utf8').slice(0, -1).split('\n');
      const records = lines.map((line) => {
        const value = JSON.parse(line);
        record.validateHorseJournalRecord(value);
        return value;
      });
      if (records.length !== Number(meta.records)) throw Error('segment_record_count_mismatch');
      segmentsDecoded++;
      segmentsDecodedTotal++;
      cache.set(sha, records);
      if (cache.size > 256) cache.delete(cache.keys().next().value);
      return records;
    };
    const rowAtOrAfter = db.prepare(
      'SELECT rowid, segment_sha, ordinal FROM archive_events WHERE rowid>=? ORDER BY rowid LIMIT 1'
    );
    const rowAtOrBefore = db.prepare(
      'SELECT rowid, segment_sha, ordinal FROM archive_events WHERE rowid<=? ORDER BY rowid DESC LIMIT 1'
    );
    const atMsOf = (row) => Number(readSegment(row.segment_sha)[Number(row.ordinal)].atMs);
    const maxRowid = Number(db.prepare('SELECT coalesce(max(rowid),0) AS n FROM archive_events').get().n);
    const minRowid = Number(db.prepare('SELECT coalesce(min(rowid),0) AS n FROM archive_events').get().n);
    const catalogRecords = Number(db.prepare('SELECT records FROM archive_meta WHERE id=1').get().records);
    if (maxRowid < 1) {
      // An empty shard has nothing to scan; only every shard being empty is an error.
      db.close();
      shardReports.push({ shard: shardName, empty: true, catalogRecords });
      continue;
    }

    // Binary search the first row whose record time is at or after `ms`. Row order
    // and record time agree only approximately (several producers append), so the
    // scan below widens the range by --margin-rows and filters by exact atMs.
    const firstRowAtOrAfter = (ms) => {
      let lo = minRowid,
        hi = maxRowid + 1;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const row = rowAtOrAfter.get(mid);
        if (!row) {
          hi = mid;
          continue;
        }
        if (atMsOf(row) >= ms) hi = Number(row.rowid);
        else lo = Number(row.rowid) + 1;
      }
      return lo;
    };
    const sinceRowid = firstRowAtOrAfter(sinceMs);
    const untilRowid = firstRowAtOrAfter(untilMs);
    const scanFrom = Math.max(minRowid, sinceRowid - marginRows);
    const scanTo = Math.min(maxRowid, untilRowid + marginRows);
    const edgeAtMs = {
      firstRowAtOrAfterSince: sinceRowid,
      firstRowAtOrAfterUntil: untilRowid,
      lastArchivedAtMs: atMsOf(rowAtOrBefore.get(maxRowid)),
    };

    let cursor = scanFrom - 1;
    const page = db.prepare(
      'SELECT rowid, event_id, hand_key, segment_sha, ordinal FROM archive_events WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 2048'
    );
    scan: for (;;) {
      const rows = page.all(cursor, scanTo);
      if (!rows.length) break;
      for (const row of rows) {
        cursor = Number(row.rowid);
        if (counts.rowsScanned >= maxRows) {
          counts.truncated = true;
          break scan;
        }
        counts.rowsScanned++;
        const rec = readSegment(row.segment_sha)[Number(row.ordinal)];
        if (!rec || rec.handKey !== row.hand_key || rec.eventId !== row.event_id)
          throw Error('archive_index_disagrees_with_segment');
        const atMs = Number(rec.atMs);
        if (atMs < sinceMs) {
          counts.rowsBeforeWindow++;
          continue;
        }
        if (atMs >= untilMs) {
          counts.rowsAfterWindow++;
          continue;
        }
        counts.rowsInWindow++;
        if (rec.sourceRelease !== recordsRelease) {
          counts.rowsOtherRelease++;
          bump(counts.otherReleases, String(rec.sourceRelease));
          continue;
        }
        bump(counts.byKind, rec.kind);
        if (rec.kind === 'decision') {
          decisions.total++;
          const capture = JSON.parse(rec.body);
          const snapshot = capture?.snapshot;
          const gs = snapshot?.gameState;
          const decision = capture?.decision;
          if (gs?.gameMode !== 'tournament') {
            decisions.cash++;
            continue;
          }
          if (gs?.stage !== 'preflop') {
            decisions.tournamentNotPreflop++;
            continue;
          }
          if (gs?.tournament?.schemaVersion !== 1) {
            decisions.tournamentSchemaUnavailable++;
            continue;
          }
          decisions.tournamentPreflop++;
          if (decision?.policyFallback === 'brain_exception') decisions.brainException++;
          const receipt = decision?.tournamentPreflopAttribution;
          if (!receipt) {
            decisions.receiptAbsent++;
            continue;
          }
          if (receipt.version === 'horse-phase6-attribution-v1') decisions.receiptV1++;
          else if (receipt.version === 'horse-phase6-attribution-v2') decisions.receiptV2++;
          bump(decisions.receiptByRoute, String(receipt.route));
          bump(decisions.receiptByStatus, String(receipt.status));
          bump(decisions.receiptByReason, String(receipt.reason));
          if (
            receipt.inputSource?.atlasRevision !== undefined &&
            receipt.inputSource.atlasRevision !== domain.atlasRevision
          )
            decisions.atlasRevisionOther++;
          const matched = attribution.horsePhase6AttributionMatchesSnapshot(decision, snapshot);
          if (matched) decisions.matchedSnapshot++;
          else {
            decisions.mismatchRefused++;
            if (mismatchNamed)
              bump(
                decisions.mismatchByReason,
                String(attribution.horsePhase6AttributionMismatch(decision, snapshot))
              );
          }
          const lookup = receipt.lookup;
          if (!lookup) {
            decisions.withoutLookup++;
            continue;
          }
          decisions.withLookup++;
          const c = lookup.coordinate,
            p = lookup.policy;
          bump(decisions.lookupBySource, String(p.source));
          bump(decisions.lookupByFamily, String(c.gameFamily));
          bump(decisions.lookupByContextStatus, String(c.contextStatus));
          if (p.fallbackReason) bump(decisions.lookupRefusedByReason, String(p.fallbackReason));
          const size = Number(c.tableSize);
          const band = bandOf(Number(c.stackBB), anchors);
          const inDomain =
            sizes.includes(size) && branches.includes(c.branch) && anteTypes.includes(c.anteType);
          if (!inDomain) decisions.outsideDomainCoordinate++;
          const expectedDepth = atlas.interpolateTournamentDepth(Number(c.stackBB));
          if (
            p.depth?.lower !== expectedDepth.lower ||
            p.depth?.upper !== expectedDepth.upper ||
            p.depth?.weight !== expectedDepth.weight
          )
            decisions.depthBracketDisagreements++;
          const key = cellKey(
            inDomain ? size : `outside-${String(size)}`,
            String(c.branch),
            String(c.anteType),
            band
          );
          const cell = cellFor(key, {
            size: inDomain ? size : null,
            branch: String(c.branch),
            anteType: String(c.anteType),
            band,
            inDomain,
          });
          cell.observed++;
          if (p.fallbackReason) bump(cell.refused, String(p.fallbackReason));
          else cell.baseline++;
          if (!matched) cell.mismatchRefused++;
          const hand = handState(rec.handKey);
          if (completed.has(rec.handKey)) joins.recordsAfterCompletedHand++;
          if (hand.decisions.has(rec.turnKey)) joins.handsWithMultipleDecisionsForTurn++;
          hand.decisions.set(rec.turnKey, { key, matched });
          continue;
        }
        if (rec.kind === 'execution') {
          joins.executionsSeen++;
          const witness = JSON.parse(rec.body);
          if (witness?.identity?.stage !== 'preflop' || witness?.identity?.gameMode !== 'tournament')
            continue;
          joins.executionsPreflopTournament++;
          if (completed.has(rec.handKey)) joins.recordsAfterCompletedHand++;
          handState(rec.handKey).executions.set(rec.turnKey, witness);
          continue;
        }
        if (rec.kind === 'accepted_hand') {
          joins.completedHandsSeen++;
          completed.add(rec.handKey);
          if (completed.size > 200000) completed.delete(completed.keys().next().value);
          const hand = hands.get(rec.handKey);
          if (!hand) continue;
          hands.delete(rec.handKey);
          const body = JSON.parse(rec.body);
          if (hand.executions.size) joins.completedHandsWithPreflopTournamentExecutions++;
          for (const [turnKey, witness] of hand.executions) {
            const decision = hand.decisions.get(turnKey);
            let bound;
            try {
              bound = binding.bindHorseDecisionToCommittedHand(witness, body);
            } catch {
              bound = { status: 'unavailable', reason: 'binder_exception' };
            }
            if (!decision) {
              joins.executionsWithoutDecision++;
              if (bound.status === 'bound') joins.acceptedBoundWithoutLookup++;
              continue;
            }
            hand.decisions.delete(turnKey);
            const cell = cells.get(decision.key);
            if (bound.status === 'bound') {
              joins.acceptedBound++;
              cell.accepted++;
            } else {
              const reason = String(bound.reason ?? bound.status);
              bump(joins.bindingUnavailableByReason, reason);
              bump(cell.acceptedUnavailable, reason);
            }
          }
          for (const [, decision] of hand.decisions) {
            const cell = cells.get(decision.key);
            bump(cell.acceptedUnavailable, 'execution_missing');
            bump(joins.bindingUnavailableByReason, 'execution_missing');
          }
          continue;
        }
      }
    }
    for (const [, hand] of hands) {
      joins.decisionsWithoutCompletedHand += hand.decisions.size;
      for (const [, decision] of hand.decisions) {
        const cell = cells.get(decision.key);
        bump(cell.acceptedUnavailable, 'completed_hand_not_in_window');
      }
    }
    db.close();
    // A hand lives in exactly one shard, so what was still open above has been
    // settled and will not be completed by a later shard: keep the join state bounded.
    hands.clear();
    shardReports.push({
      shard: shardName,
      empty: false,
      minRowid,
      maxRowid,
      catalogRecords,
      scanFromRowid: scanFrom,
      scanToRowid: scanTo,
      ...edgeAtMs,
      segmentsDecoded,
      rowsScannedInShard: counts.rowsScanned - rowsBeforeShard,
    });
    if (counts.truncated) break;
  }
  if (shardReports.every((r) => r.empty)) throw Error('archive_empty');

  const observed = [...cells.values()].sort((a, b) => (a.cell < b.cell ? -1 : a.cell > b.cell ? 1 : 0));
  const unobserved = [];
  for (const size of sizes)
    for (const branch of branches)
      for (const ante of anteTypes)
        for (const band of bands) {
          const key = cellKey(size, branch, ante, band);
          if (!cells.has(key)) unobserved.push(key);
        }
  const marginal = (pick) => {
    const out = {};
    for (const cell of observed) {
      const key = String(pick(cell));
      const row = (out[key] ??= { observed: 0, baseline: 0, refused: 0, mismatchRefused: 0, accepted: 0 });
      row.observed += cell.observed;
      row.baseline += cell.baseline;
      row.refused += Object.values(cell.refused).reduce((n, x) => n + x, 0);
      row.mismatchRefused += cell.mismatchRefused;
      row.accepted += cell.accepted;
    }
    return out;
  };
  const totalCells = sizes.length * branches.length * anteTypes.length * bands.length;
  const observedInDomain = observed.filter((cell) => cell.inDomain).length;
  const output = {
    version: 'phase6b-route-proof-v1',
    scope: 'bounded_natural_journal_window_exact_release',
    selector: {
      release,
      recordsRelease,
      historicalOnly: recordsRelease !== release,
      since: args.since,
      until: args.until,
      sinceMs,
      untilMs,
      journalDir,
      dist,
      maxRows,
      marginRows,
    },
    imageRelease,
    observedAt: new Date(startedAt).toISOString(),
    elapsedMs: Date.now() - startedAt,
    atlas: {
      revision: domain.atlasRevision,
      implementation: domain.implementation,
      pinnedDigest: atlas.TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST ?? null,
      recomputedDigest,
      digestMatches: atlas.TOURNAMENT_PREFLOP_ATLAS_DOMAIN_DIGEST === recomputedDigest,
      totalValidCoordinates: domain.totalValidCoordinates,
      sizes,
      branches,
      anteTypes,
      bands,
      mismatchReasonsNamed: mismatchNamed,
    },
    compiledHashes,
    archive: {
      shardCount: shardNames.length,
      shardsRead: shardReports.map((r) => r.shard),
      shards: shardReports,
      catalogRecords: shardReports.reduce((n, r) => n + Number(r.catalogRecords ?? 0), 0),
      segmentsDecoded: segmentsDecodedTotal,
      ...counts,
    },
    decisions,
    joins,
    cells: {
      universe: totalCells,
      observedInDomain,
      observedOutsideDomain: observed.length - observedInDomain,
      unobservedCount: unobserved.length,
      observed,
      unobserved,
    },
    marginals: {
      bySize: marginal((cell) => cell.size ?? 'outside'),
      byBranch: marginal((cell) => cell.branch),
      byAnteType: marginal((cell) => cell.anteType),
      byBand: marginal((cell) => cell.band),
    },
    limitations: [
      'Counts are of retained journal records inside the window on the exact release; a finite spool cannot establish decisions that never reached it.',
      'Accepted-action joins use the deployed binder on the completed-hand record; a decision whose completed hand lies outside the window or the scan bound is reported as unavailable, not as unaccepted.',
      'Row order and record time agree only approximately; the scan widened the rowid range by margin-rows and filtered by exact record time.',
      'Unobserved cells are reported as unobserved. Nothing is interpolated, and no cell is certified by another cell.',
      'A receipt observed on the intent-engine route is a lookup performed, not proof that the atlas caused the accepted action.',
    ],
    completePopulation: false,
    replayVerified: false,
    gtoVerified: false,
    activationAllowed: false,
  };
  process.stdout.write(JSON.stringify(output) + '\n');
}

function render(args) {
  const input = args.input;
  if (!input) throw Error('--input required');
  const parsed = JSON.parse(readFileSync(input, 'utf8'));
  // Accept the observer envelope (phase6b-route-proof-observe.py) or a bare observation.
  const o = parsed?.execution?.observation ?? parsed;
  if (o?.version !== 'phase6b-route-proof-v1' || o.status === 'unavailable')
    throw Error('observation_unavailable');
  const lines = [];
  const sum = (row) => row.observed;
  if (parsed?.commandLine) lines.push(`Command: \`${parsed.commandLine}\``, '');
  for (const [label, health] of [
    ['before', parsed?.servingHealthBefore],
    ['after', parsed?.servingHealthAfter],
  ]) {
    if (!health?.ok) continue;
    const j = health.horseJournal ?? {};
    lines.push(
      `Engine /health ${label}: release \`${health.releaseSha}\`; Horse journal mode ${j.mode}${j.pausedReason ? ` (paused: ${j.pausedReason} since ${j.pausedSince})` : ''}; journal records ${j.records}.`,
      ''
    );
  }
  lines.push(`Selector: observer release \`${o.selector.release}\`, records release \`${o.selector.recordsRelease}\`${o.selector.historicalOnly ? ' (historical only)' : ''}, window ${o.selector.since} to ${o.selector.until} (UTC), journal \`${o.selector.journalDir}\`.`);
  lines.push('');
  lines.push(`Archive shards read ${(o.archive.shardsRead ?? []).join(', ')}; rows scanned ${o.archive.rowsScanned} (${(o.archive.shards ?? []).map((r) => (r.empty ? `${r.shard}: empty` : `${r.shard}: rowid ${r.scanFromRowid} to ${r.scanToRowid}`)).join('; ')}); rows inside the window ${o.archive.rowsInWindow}; other-release rows inside the window ${o.archive.rowsOtherRelease}; truncated: ${o.archive.truncated}.`);
  lines.push('');
  lines.push(`Tournament preflop decisions on this release: ${o.decisions.tournamentPreflop}; receipts with a lookup ${o.decisions.withLookup}; matched snapshot ${o.decisions.matchedSnapshot}; mismatch refused ${o.decisions.mismatchRefused}; accepted actions bound ${o.joins.acceptedBound}.`);
  lines.push('');
  lines.push(`Cells: universe ${o.cells.universe} (sizes ${o.atlas.sizes.length} x branches ${o.atlas.branches.length} x ante modes ${o.atlas.anteTypes.length} x bands ${o.atlas.bands.length}); observed ${o.cells.observedInDomain}; unobserved ${o.cells.unobservedCount}.`);
  lines.push('');
  const table = (title, rows, keys) => {
    lines.push(`### ${title}`);
    lines.push('');
    lines.push('| Key | Observed | Baseline | Refused | Mismatch refused | Accepted |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const key of keys) {
      const row = rows[key];
      if (!row) lines.push(`| ${key} | unobserved | | | | |`);
      else lines.push(`| ${key} | ${sum(row)} | ${row.baseline} | ${row.refused} | ${row.mismatchRefused} | ${row.accepted} |`);
    }
    lines.push('');
  };
  table('By dealt size', o.marginals.bySize, o.atlas.sizes.map(String));
  table('By preflop branch', o.marginals.byBranch, o.atlas.branches);
  table('By ante mode', o.marginals.byAnteType, o.atlas.anteTypes);
  table('By stack-anchor band (big blinds)', o.marginals.byBand, o.atlas.bands);
  lines.push('### Observed cells');
  lines.push('');
  lines.push('| Size | Branch | Ante | Band | Observed | Baseline | Refused | Mismatch refused | Accepted | Accepted unavailable |');
  lines.push('| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const cell of o.cells.observed) {
    const refused = Object.entries(cell.refused).map(([k, v]) => `${k} ${v}`).join(', ') || '0';
    const unavailable = Object.entries(cell.acceptedUnavailable).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
    lines.push(`| ${cell.size ?? 'outside'} | ${cell.branch} | ${cell.anteType} | ${cell.band} | ${cell.observed} | ${cell.baseline} | ${refused} | ${cell.mismatchRefused} | ${cell.accepted} | ${unavailable} |`);
  }
  lines.push('');
  lines.push(`Unobserved cells: ${o.cells.unobservedCount} of ${o.cells.universe}; the full list is in the JSON under \`cells.unobserved\`.`);
  process.stdout.write(lines.join('\n') + '\n');
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];
try {
  if (command === 'observe') await observe(args);
  else if (command === 'render') render(args);
  else throw Error('usage: phase6b-route-proof.mjs observe|render ...');
} catch (error) {
  // Only a finite classification leaves the process; never arbitrary error text.
  const message = error instanceof Error ? error.message : 'unknown';
  const named = /^[a-z_]+$/.test(message) ? message : 'observation_failed';
  process.stderr.write(`${error instanceof Error ? error.constructor.name : 'Error'}\n`);
  // Only an operator running the script by hand, outside the observer, sees detail.
  if (process.env.PHASE6B_ROUTE_PROOF_DEBUG === '1' && error instanceof Error)
    process.stderr.write(`${error.stack ?? error.message}\n`);
  process.stdout.write(JSON.stringify({ version: 'phase6b-route-proof-v1', status: 'unavailable', reason: named }) + '\n');
  process.exitCode = 3;
}
