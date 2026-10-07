/** P14.3 private accepted-source mapping producer. PURE, OFFLINE, READ-ONLY.
 *
 * For one UTC day's review-page rows it asks fn_horse_accepted_source_rows for
 * each selected hand's raw accepted row (plus the submission lease generation),
 * derives the journal hand key with the engine's own horseCompletedHandKey and
 * journalHash, finds the accepted_hand record in the READ-ONLY journal and its
 * exact record sha256, and runs the unchanged unsigned exporter over the join.
 *
 * It never writes the database, never opens a writable journal, never takes or
 * guesses a journal lease, and is not an authority token: every mapping it
 * emits has NO authorityPath, so the corrective authority stays an explicit
 * missing input. Every per-hand problem is a named pending reason. */
import {
  DAILY_LIMITS,
  type DailyCursor,
  type DailyManifest,
  type DailyMapping,
  type DailyRow,
  type DailySource,
} from './contract.js';
import { cursor, parseDailyPage, utcDay } from './validation.js';
import type { AcceptedSourceRowsReader } from './source.js';
import type { AcceptedSourceRow } from './selection.js';
import { dailyRowScreen } from './batch.js';
import { horseCompletedHandKey } from '../../engine/HorseDecisionHandBinding.js';
import {
  horseJournalJson,
  journalHash,
  type HorseJournalRecord,
} from '../horseDecisionJournal/record.js';
import { createUnsignedAcceptedCommitmentExport } from '../horseAcceptedRoster/exporter.js';
import { chipCents } from '../horseCorrectiveReview/eligibility.js';
import { CORRECTIVE_LIMITS } from '../horseCorrectiveReview/contract.js';
import { join, isAbsolute } from 'node:path';

export const DAILY_MAPPING_VERSION = 'horse-daily-accepted-source-mapping-v1' as const;
/** horseAcceptedRosterExport's raw-row input cap. */
export const RAW_ROWS_BYTES = 1048576;
export type JournalHandReader = (
  directory: string,
  handKey: string
) => readonly HorseJournalRecord[];
export interface DailyMappingRequest {
  day: string;
  after: DailyCursor | null;
  journalDirectory: string;
  outputDirectory: string;
}
export interface DailyMappingDependencies {
  source: DailySource;
  rows: AcceptedSourceRowsReader;
  readJournalHand: JournalHandReader;
}
export interface DailyMappingRowResult {
  queueCursor: DailyCursor;
  handRef: string;
  retryAfter: DailyCursor | null;
  screen: string | null;
}
export interface DailyMappingHandResult {
  handId: string;
  tableId: string;
  handRef: string;
  status: 'mapped' | 'pending';
  reason: string;
  retryAfter: DailyCursor | null;
  leaseBasis: 'hand_submission' | 'submission_missing' | 'not_read';
  handKey: string | null;
  acceptedHandRecordDigest: string | null;
  sourceRowDigest: string | null;
  inputPath: string | null;
  rawRowsPath: string | null;
  authorityPath: 'missing_input';
}
export interface DailyMappingReport {
  version: typeof DAILY_MAPPING_VERSION;
  scope: 'bounded_private_accepted_source_mapping';
  day: string;
  status: 'mapped_selection' | 'incomplete';
  reasons: string[];
  startCursor: DailyCursor | null;
  resumeCursor: DailyCursor | null;
  pages: number;
  snapshots: string[];
  selectionExhausted: boolean;
  rows: DailyMappingRowResult[];
  hands: DailyMappingHandResult[];
  manifestPath: string;
  authority: 'missing_input';
  databaseWrites: false;
  journalWrites: false;
  journalLeases: false;
  fullWindow: false;
  sourcePopulationVerified: false;
  gtoVerified: false;
  activationAllowed: false;
}
export interface DailyMappingOutput {
  report: DailyMappingReport;
  manifest: DailyManifest;
  /** Absolute path -> exact JSON text with its byte bound. Hand files first. */
  files: Array<{ path: string; json: string; maximumBytes: number }>;
}
/** A reply that arrived but named other hands, extra columns or bad bounds. */
const REFUSED_REPLY = new Set([
  'accepted_source_reply_refused',
  'accepted_source_row_refused',
  'accepted_source_mismatch',
  'accepted_source_bounds',
]);
const fileName = (handId: string, kind: 'input' | 'rows') => `hand-${handId}.${kind}.json`;
function validateRequest(r: DailyMappingRequest): void {
  if (
    !r ||
    !utcDay(r.day) ||
    (r.after !== null && (!cursor(r.after) || r.after.playedAt.slice(0, 10) !== r.day)) ||
    [r.journalDirectory, r.outputDirectory].some(
      (p) => typeof p !== 'string' || p.length > 4096 || p.includes('\0') || !isAbsolute(p)
    ) ||
    r.journalDirectory === r.outputDirectory
  )
    throw Error('invalid_daily_mapping_request');
}
/** Lease identity from the accepted submission only. 'unleased' (no row in
 * smarter_private.hand_submissions) is refused by horseJournalLeaseIdentityIsValid,
 * so no journal key can be derived for it and none is guessed. */
export function acceptedSourceHandKey(
  tableId: string,
  handNumber: string | null,
  leaseGeneration: string | null
): { coordinate: string; handKey: string } | { reason: string } {
  if (typeof handNumber !== 'string' || !/^[1-9][0-9]{0,17}$/.test(handNumber))
    return { reason: 'accepted_source_hand_number_invalid' };
  if (leaseGeneration === null) return { reason: 'hand_submission_missing' };
  const n = Number(handNumber);
  // The exact fence supabase/handHistory.ts gives observeCompletedHand.
  const coordinate = horseCompletedHandKey({
    generation: n,
    fence: `${tableId}:${handNumber}:${leaseGeneration}:observe`,
    handKey: `${tableId}:${handNumber}`,
    actions: undefined,
    bigBlind: 0,
  });
  if (!coordinate) return { reason: 'hand_submission_lease_invalid' };
  return { coordinate, handKey: journalHash(coordinate) };
}
export async function produceDailyMapping(
  rawRequest: DailyMappingRequest,
  deps: DailyMappingDependencies
): Promise<DailyMappingOutput> {
  validateRequest(rawRequest);
  const request = Object.freeze({
    day: rawRequest.day,
    after: rawRequest.after ? Object.freeze({ ...rawRequest.after }) : null,
    journalDirectory: rawRequest.journalDirectory,
    outputDirectory: rawRequest.outputDirectory,
  });
  const { source, rows: readRows, readJournalHand } = deps;
  const report: DailyMappingReport = {
    version: DAILY_MAPPING_VERSION,
    scope: 'bounded_private_accepted_source_mapping',
    day: request.day,
    status: 'incomplete',
    reasons: [],
    startCursor: request.after,
    resumeCursor: request.after,
    pages: 0,
    snapshots: [],
    selectionExhausted: false,
    rows: [],
    hands: [],
    manifestPath: join(request.outputDirectory, 'manifest.json'),
    authority: 'missing_input',
    databaseWrites: false,
    journalWrites: false,
    journalLeases: false,
    fullWindow: false,
    sourcePopulationVerified: false,
    gtoVerified: false,
    activationAllowed: false,
  };
  const reason = (s: string) => {
    if (!report.reasons.includes(s)) report.reasons.push(s);
  };
  // 1. The day's queue rows, through the same detached page validator.
  const queue: Array<{ row: DailyRow; retryAfter: DailyCursor | null }> = [];
  try {
    let after = request.after;
    for (let pageIndex = 0; pageIndex < DAILY_LIMITS.pages; pageIndex++) {
      const pageRequest = Object.freeze({
        day: request.day,
        after: after ? Object.freeze({ ...after }) : null,
      });
      const page = parseDailyPage(
        await source({
          day: pageRequest.day,
          after: pageRequest.after ? { ...pageRequest.after } : null,
        }),
        pageRequest
      );
      report.pages++;
      report.snapshots.push(page.readAt);
      if (page.dayObservation !== 'present') reason('daily_source_observation_missing');
      let previous = pageRequest.after;
      for (const row of page.rows) {
        queue.push({ row, retryAfter: previous });
        previous = { playedAt: row.playedAt, handId: row.handId, horseId: row.horseId };
      }
      report.resumeCursor = page.next ?? report.resumeCursor;
      if (!page.hasMore) {
        report.selectionExhausted = true;
        break;
      }
      after = page.next;
    }
    if (!report.selectionExhausted) reason('daily_selection_page_limit');
  } catch {
    reason('daily_source_unavailable');
  }
  // 2. Group contiguous rows by hand. One review row per (hand, Horse).
  const hands = new Map<
    string,
    {
      tableId: string;
      rows: DailyRow[];
      retryAfter: DailyCursor | null;
      eligible: boolean;
      screen: string;
    }
  >();
  let tableConflict = false;
  for (const { row, retryAfter } of queue) {
    const screen = dailyRowScreen(row);
    report.rows.push({
      queueCursor: { playedAt: row.playedAt, handId: row.handId, horseId: row.horseId },
      handRef: journalHash(row.handId),
      retryAfter,
      screen,
    });
    const hand = hands.get(row.handId);
    if (!hand)
      hands.set(row.handId, {
        tableId: row.tableId,
        rows: [row],
        retryAfter,
        eligible: screen === null,
        screen: screen ?? '',
      });
    else {
      if (hand.tableId !== row.tableId) tableConflict = true;
      hand.rows.push(row);
      if (screen === null) hand.eligible = true;
      else hand.screen ||= screen;
    }
  }
  if (tableConflict) reason('daily_queue_table_conflict');
  // 3. Per-hand private join, strictly bounded; budget overflow stays explicit.
  const files: DailyMappingOutput['files'] = [];
  const mappings: DailyMapping[] = [];
  let attempts = 0,
    journalBytes = 0,
    journalRecords = 0,
    sourceStopped: string | null = null;
  for (const [handId, hand] of hands) {
    const out: DailyMappingHandResult = {
      handId,
      tableId: hand.tableId,
      handRef: journalHash(handId),
      status: 'pending',
      reason: '',
      retryAfter: hand.retryAfter,
      leaseBasis: 'not_read',
      handKey: null,
      acceptedHandRecordDigest: null,
      sourceRowDigest: null,
      inputPath: null,
      rawRowsPath: null,
      authorityPath: 'missing_input',
    };
    report.hands.push(out);
    if (tableConflict && hand.rows.some((r) => r.tableId !== hand.tableId)) {
      out.reason = 'daily_queue_table_conflict';
      continue;
    }
    if (!hand.eligible) {
      out.reason = hand.screen;
      continue;
    }
    if (sourceStopped) {
      out.reason = sourceStopped;
      continue;
    }
    if (attempts >= DAILY_LIMITS.hands) {
      out.reason = 'mapping_hand_budget_exhausted';
      continue;
    }
    attempts++;
    let found;
    try {
      found = (await readRows([{ handId, tableId: hand.tableId }])).get(handId);
    } catch (error) {
      // No retry and no further calls once the private reader failed or lied.
      out.reason =
        error instanceof Error && REFUSED_REPLY.has(error.message)
          ? 'accepted_source_reply_refused'
          : 'accepted_source_unavailable';
      sourceStopped = 'accepted_source_unavailable';
      continue;
    }
    // fn_horse_accepted_source_rows omits a hand with no accepted row AND a
    // hand above ACCEPTED_SOURCE_SELECT's size bounds; the two are not
    // distinguishable from the reply, so neither is claimed.
    if (!found) {
      out.reason = 'accepted_source_missing_or_oversized';
      continue;
    }
    const row: AcceptedSourceRow = found.row;
    out.sourceRowDigest = journalHash(horseJournalJson(row));
    out.leaseBasis = found.leaseGeneration === null ? 'submission_missing' : 'hand_submission';
    if (row.hand_id !== handId || row.table_id !== hand.tableId) {
      out.reason = 'accepted_source_identity_mismatch';
      continue;
    }
    const key = acceptedSourceHandKey(hand.tableId, row.hand_number, found.leaseGeneration);
    if ('reason' in key) {
      out.reason = key.reason;
      continue;
    }
    out.handKey = key.handKey;
    // The queue's payload hash and BB must be the accepted row's; otherwise
    // the queue row is not describing this accepted transaction.
    // Only the screened (eligible) rows describe the accepted payload; a
    // payload_unavailable sibling row carries no hash to compare.
    const eligibleRows = hand.rows.filter((r) => dailyRowScreen(r) === null);
    const queuedBb = chipCents(Number(eligibleRows[0]!.bigBlind));
    if (
      eligibleRows.some(
        (r) =>
          r.payloadHash !== row.payload_digest ||
          chipCents(Number(r.bigBlind)) !== queuedBb ||
          r.bigBlind === null
      ) ||
      typeof row.big_blind !== 'string' ||
      queuedBb === null ||
      chipCents(Number(row.big_blind)) !== queuedBb
    ) {
      out.reason = 'queued_source_changed';
      continue;
    }
    let records: readonly HorseJournalRecord[];
    try {
      records = readJournalHand(request.journalDirectory, key.handKey);
    } catch {
      out.reason = 'journal_unavailable';
      continue;
    }
    if (records.length > CORRECTIVE_LIMITS.records) {
      out.reason = 'journal_hand_exceeds_bounds';
      continue;
    }
    const bytes = records.reduce((n, r) => n + Buffer.byteLength(horseJournalJson(r)), 0);
    if (
      journalBytes + bytes > DAILY_LIMITS.journalBytes ||
      journalRecords + records.length > DAILY_LIMITS.records
    ) {
      out.reason = 'mapping_evidence_budget_exhausted';
      continue;
    }
    journalBytes += bytes;
    journalRecords += records.length;
    const accepted = records.filter((r) => r.kind === 'accepted_hand' && r.handKey === key.handKey);
    if (!accepted.length) {
      out.reason = 'journal_accepted_hand_missing';
      continue;
    }
    let pinned: HorseJournalRecord | undefined;
    let conflict = false;
    for (const record of accepted) {
      let body: unknown;
      try {
        body = JSON.parse(record.body);
      } catch {
        conflict = true;
        break;
      }
      const hb = body as { committedHandId?: unknown };
      const coordinate = horseCompletedHandKey(body as Parameters<typeof horseCompletedHandKey>[0]);
      if (coordinate !== key.coordinate || hb.committedHandId !== handId) {
        conflict = true;
        break;
      }
      if (pinned && horseJournalJson(JSON.parse(pinned.body)) !== horseJournalJson(body)) {
        conflict = true;
        break;
      }
      pinned ??= record;
    }
    if (conflict || !pinned) {
      out.reason = 'journal_accepted_hand_mismatch';
      continue;
    }
    out.acceptedHandRecordDigest = pinned.sha256;
    // The unchanged exporter is the join's validator: identity, payload digest,
    // actions, roster provenance, settlement receipt and gross commitments.
    const exported = createUnsignedAcceptedCommitmentExport({
      records,
      handKey: key.handKey,
      acceptedHandRecordDigest: pinned.sha256,
      rows: [row],
    });
    if (exported.sourceExport.status !== 'unsigned_export' || !('commitments' in exported)) {
      const reasons = exported.sourceExport.reasons;
      out.reason =
        reasons.find(
          (r) =>
            ![
              'trusted_roster_producer_authority_missing',
              'producer_implementation_pending',
              'historical_horse_population_not_established',
            ].includes(r)
        ) ?? 'source_export_invalid';
      continue;
    }
    if (exported.commitments.payloadDigest !== eligibleRows[0]!.payloadHash) {
      out.reason = 'queued_source_changed';
      continue;
    }
    const inputPath = join(request.outputDirectory, fileName(handId, 'input'));
    const rawRowsPath = join(request.outputDirectory, fileName(handId, 'rows'));
    const input =
      JSON.stringify({
        version: 2,
        commitments: exported.commitments,
        // Counterfactual references come only from an independent qualifier.
        references: [],
        rosterSource: { version: 1, rows: [row] },
        mapping: {
          version: DAILY_MAPPING_VERSION,
          handKey: key.handKey,
          acceptedHandRecordDigest: pinned.sha256,
          sourceRowDigest: out.sourceRowDigest,
          leaseBasis: out.leaseBasis,
          authority: 'missing_input',
        },
      }) + '\n';
    const rawRows = JSON.stringify({ version: 1, rows: [row] }) + '\n';
    const size = Buffer.byteLength(input);
    if (size > DAILY_LIMITS.inputBytes || Buffer.byteLength(rawRows) > RAW_ROWS_BYTES) {
      out.reason = 'mapping_input_exceeds_bounds';
      continue;
    }
    files.push({ path: inputPath, json: input, maximumBytes: DAILY_LIMITS.inputBytes });
    files.push({ path: rawRowsPath, json: rawRows, maximumBytes: RAW_ROWS_BYTES });
    out.status = 'mapped';
    out.reason = 'mapped_authority_missing_input';
    out.inputPath = inputPath;
    out.rawRowsPath = rawRowsPath;
    mappings.push(
      Object.freeze({ handId, tableId: hand.tableId, handKey: key.handKey, inputPath })
    );
  }
  // Resume no later than the first hand that could still become mappable.
  const firstRetry = report.hands.find((h) =>
    [
      'mapping_hand_budget_exhausted',
      'mapping_evidence_budget_exhausted',
      'accepted_source_unavailable',
      'accepted_source_reply_refused',
    ].includes(h.reason)
  );
  if (firstRetry) {
    report.resumeCursor = firstRetry.retryAfter;
    reason('mapping_budget_or_source_unavailable');
  }
  if (!report.hands.length) reason('no_retained_review_rows');
  if (report.hands.some((h) => h.status === 'pending')) reason('pending_private_mappings');
  reason('qualified_authority_missing_input');
  if (
    report.selectionExhausted &&
    report.hands.length > 0 &&
    report.reasons.every((r) => r === 'qualified_authority_missing_input')
  )
    report.status = 'mapped_selection';
  const manifest: DailyManifest = {
    version: 1,
    day: request.day,
    after: request.after,
    selectionAfter: null,
    journalDirectory: request.journalDirectory,
    mappings,
  };
  const manifestJson = JSON.stringify(manifest) + '\n';
  if (Buffer.byteLength(manifestJson) > DAILY_LIMITS.manifestBytes)
    throw Error('daily_mapping_bounds');
  files.push({
    path: report.manifestPath,
    json: manifestJson,
    maximumBytes: DAILY_LIMITS.manifestBytes,
  });
  return JSON.parse(JSON.stringify({ report, manifest, files })) as DailyMappingOutput;
}
/** Every journal access is the archive-aware read-only reader; never a writer. */
export async function readOnlyJournalHandReader(): Promise<JournalHandReader> {
  const { readHorseJournalHandRecords } = await import('../horseDecisionJournal/review.js');
  return (directory, handKey) => readHorseJournalHandRecords(directory, handKey);
}
