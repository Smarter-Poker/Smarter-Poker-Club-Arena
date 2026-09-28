import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** A closed window of capture time whose published segments the ring never
 * retires. Resolved once, when a writer opens with it, to the published
 * segments whose records fall inside it; segments appended later are the
 * ring's. */
export interface HorseJournalArchiveHold {
  fromMs: number;
  untilMs: number;
}

export interface HorseJournalArchiveOptions {
  directory: string;
  maxBytes: number;
  maxSegments: number;
  /** Absent or null: nothing is held and every published segment is a ring
   * candidate. */
  hold?: HorseJournalArchiveHold | null;
}

// Separate durable archive allocation; the original 64 MiB journal remains
// unchanged. These bound compressed files independently of the catalog's
// 6 GiB physical ceiling and each 4 MiB decoded batch.
//
// THE ALLOCATION IS A RING (2026-09-26). Until then a full allocation paused
// capture for good: on 2026-09-25 19:34 UTC the production archive reached
// 500,000 segments (4,139,804 records, 6.48 GB compressed, 8.3 days of play,
// 9.7 GB on disk with the catalog) and no Horse decision was journaled again.
// Now, once a batch would exceed the segment, record, byte or catalog quota,
// the writer retires the oldest PUBLISHED segments, oldest first, inside the
// same reservation transaction until the batch fits, and capture continues.
// A reserved batch that has not been published is never retired, so only
// unpublished segments can ever hold capture at a quota; the filesystem's own
// free space is not a ring quota and still pauses capture, by name, because
// the archive retires within its allocation and not for whatever else filled
// the disk. No quota describes an incomplete window as complete: a retired
// record is a missing record to every reader.
//
// THE ARCHIVE DID NOT HOLD EIGHT DAYS (measured read-only 2026-09-27). The
// 500,000 segments are two runs: rowids 1 to 262,387 from 2026-09-17 15:02 to
// 2026-09-18 09:20 UTC (16 records a segment, until the former 2 GiB catalog
// filled), nothing at all from then until the 6 GiB catalog shipped in
// 778075b419, and rowids 262,388 to 500,000 from 2026-09-25 15:47:23 to
// 19:34:05 UTC: 237,613 segments, 780,363 records and 1.49 GB in 3.8 hours.
// Current capture writes a segment per publisher batch, about 3.3 records,
// so it spends 500,000 segments in about eight hours while it spends the
// 8 GiB byte bound in about 22 and the 8,000,000-record cap in about 39. The
// segment count was the wrong limit to bind first.
//
// HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS is the ring's length in
// segments. Default and ceiling 2,000,000, so that on the engine host the
// ring is bounded by bytes: HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES (default
// 8 GiB compressed) plus a catalog that stays under its 6 GiB page ceiling,
// about 12 GB of a 75 GB disk that had 21 GB free with the archive full. The
// record cap is maxSegments * 16 but never above 8,000,000, the figure the
// catalog is sized for. Lowering either knob retires the excess over the
// following appends; a segment count past the ceiling is refused at start.
//
// THE RING HOLDS THE PHASE 6A/6B EVIDENCE (decision D4, 2026-09-27). Nothing
// ships segments off the host, and the ring retires oldest first, so without
// a hold the only Phase 6A/6B decisions ever captured (the 09-25 run above,
// release 778075b419, which 6C replays and 6D's declared population covers)
// would be retired within a day of the ring's deploy. So the ring skips an
// explicit evidence hold. HORSE_DECISION_JOURNAL_ARCHIVE_HOLD is
// "<from>/<until>" (UTC, whole seconds, "Z") or "none". Its default runs from
// 2026-09-18 21:56:28 UTC, when engine release 8825af5181 first carrying
// Phase 6A began serving (engine-release-audit commit event), to 2026-09-25
// 19:34:06 UTC, one second after the last segment written before the archive
// filled. A writer resolves the window at open to the published segments
// whose records fall inside it (on the host: the 237,613 of the 09-25 run)
// and records that set; they count against every quota as before and are
// never retired, and the ring retires the oldest published segment outside
// them. Capture then runs forever inside the same fixed budget: the ring
// keeps about 18 hours of new play beside the held 1.49 GB. When only held
// or unpublished segments remain, a quota still refuses by name and /health
// says so. "none" releases the hold once the evidence is exported, and the
// ring reclaims those segments oldest first. A malformed value refuses the
// writer's start.
export const HORSE_JOURNAL_ARCHIVE_HOLD = '2026-09-18T21:56:28Z/2026-09-25T19:34:06Z';
export const HORSE_JOURNAL_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
export const HORSE_JOURNAL_ARCHIVE_SEGMENTS = 2_000_000;
// The record cap the catalog is sized for, whatever the segment count.
export const HORSE_JOURNAL_ARCHIVE_RECORDS = 8_000_000;
/** The writer refuses a batch once the archive would hold more records than
 * this: 16 a segment, never above the catalog's sizing. */
export const archiveRecordCap = (maxSegments: number): number =>
  Math.min(maxSegments * 16, HORSE_JOURNAL_ARCHIVE_RECORDS);
/* THE HOLD HAS ITS OWN BUDGET (2026-09-28). Held segments count against every
   quota, so a hold as large as the allocation leaves the ring nothing to
   retire and capture stops at the quota. The hold may keep at most half of
   each quota (bytes, segments and records); the other half always belongs to
   new capture. A window whose segments exceed the budget keeps its OLDEST
   segments up to the budget (for the default window, the start of the only
   Phase 6A/6B capture) and the writer says so in its log line and on
   /health (holdTrimmedSegments); the rest become the ring's, retired oldest
   first like any other segment. On production the default hold is about
   1.49 GB of the 8 GiB bound and 237,613 of 2,000,000 segments, well inside
   its budget, so nothing is trimmed there. */
export const HORSE_JOURNAL_HOLD_BUDGET_SHARE = 2;
export const horseJournalHoldBudget = (
  maxBytes: number,
  maxSegments: number
): { bytes: number; segments: number; records: number } => ({
  bytes: Math.floor(maxBytes / HORSE_JOURNAL_HOLD_BUDGET_SHARE),
  segments: Math.floor(maxSegments / HORSE_JOURNAL_HOLD_BUDGET_SHARE),
  records: Math.floor(archiveRecordCap(maxSegments) / HORSE_JOURNAL_HOLD_BUDGET_SHARE),
});
// The former 2 GiB catalog filled at 262387 segments / 4.99 GB compressed,
// before either archive allocation was reached. That catalog indexed its
// records at ~639 bytes each, so the 4 GiB that replaced it covered ~6.7M
// records while the record cap above is 8,000,000: the catalog was still the
// first limit reached, and it was reached inside SQLite rather than by a named
// refusal. Derivation of the current figure: 8,000,000 records x ~640 bytes
// ~= 5.12 GB (4.77 GiB); 6 GiB = 1,572,864 whole 4096-byte pages leaves ~26%
// margin for index growth and the transient pending batch. Workload-based
// sizing, not a guarantee every record mix fits. Keep a finite allocation,
// shared by writer enforcement and reader diagnostics; SQLite grows on demand.
export const HORSE_JOURNAL_ARCHIVE_CATALOG_BYTES = 6 * 1024 * 1024 * 1024;

function positiveInteger(value: string | undefined, fallback: number, ceiling: number): number {
  if (value === undefined) return fallback;
  if (!/^[1-9][0-9]*$/.test(value)) throw Error('Invalid Horse archive resource allocation');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > ceiling)
    throw Error('Invalid Horse archive resource allocation');
  return parsed;
}

const HOLD_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
function evidenceHold(value: string | undefined): HorseJournalArchiveHold | null {
  const text = value ?? HORSE_JOURNAL_ARCHIVE_HOLD;
  if (text === 'none') return null;
  const parts = text.split('/');
  if (parts.length !== 2 || !parts.every((p) => HOLD_INSTANT.test(p)))
    throw Error('Invalid Horse archive evidence hold');
  const [fromMs, untilMs] = parts.map((p) => Date.parse(p));
  // Date.parse rolls an impossible calendar date over; the round trip refuses it.
  if (
    !parts.every(
      (p, i) => new Date([fromMs, untilMs][i]).toISOString() === p.replace('Z', '.000Z')
    ) ||
    !(fromMs < untilMs)
  )
    throw Error('Invalid Horse archive evidence hold');
  return { fromMs, untilMs };
}

/** This runs in the existing journal owner before its dedicated writer starts.
 * The archive stays under the already sealed persistent private bind mount. */
export function runtimeHorseJournalArchiveOptions(
  directory: string,
  environment: Readonly<Record<string, string | undefined>> = process.env
): HorseJournalArchiveOptions {
  if (!isAbsolute(directory)) throw Error('Invalid Horse journal directory');
  return {
    directory: join(directory, 'archive'),
    maxBytes: positiveInteger(
      environment.HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES,
      HORSE_JOURNAL_ARCHIVE_BYTES,
      Number.MAX_SAFE_INTEGER
    ),
    maxSegments: positiveInteger(
      environment.HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS,
      HORSE_JOURNAL_ARCHIVE_SEGMENTS,
      HORSE_JOURNAL_ARCHIVE_SEGMENTS
    ),
    hold: evidenceHold(environment.HORSE_DECISION_JOURNAL_ARCHIVE_HOLD),
  };
}

/** Historical journal-only directories stay readable. A present archive,
 * including a broken symlink or an incomplete/corrupt catalog, must reach the
 * strict store validator rather than silently returning legacy-only evidence.
 * Reading never creates a directory, opens a writer or completes pending work. */
export function readonlyHorseJournalStoreOptions(directory: string): {
  readOnly: true;
  archive?: HorseJournalArchiveOptions;
} {
  const archive = runtimeHorseJournalArchiveOptions(directory, {});
  try {
    lstatSync(archive.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { readOnly: true };
    throw error;
  }
  return { readOnly: true, archive };
}
