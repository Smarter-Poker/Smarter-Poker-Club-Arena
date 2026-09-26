import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface HorseJournalArchiveOptions {
  directory: string;
  maxBytes: number;
  maxSegments: number;
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
// HORSE_DECISION_JOURNAL_ARCHIVE_MAX_SEGMENTS is the ring's length and the
// one knob that sizes the retained window. Default 500,000 segments (the
// ceiling too: the catalog is sized for 8,000,000 records), which on the
// engine host is about eight days of capture in about 10 GB, on a 75 GB disk
// that had 21 GB free with the archive full. Lowering it retires the excess
// over the following appends; raising it past the ceiling is refused.
// HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES (default 8 GiB compressed) is the
// byte bound of the same ring.
export const HORSE_JOURNAL_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
export const HORSE_JOURNAL_ARCHIVE_SEGMENTS = 500_000;
// The writer refuses a batch once the archive holds maxSegments * 16 records.
export const HORSE_JOURNAL_ARCHIVE_RECORDS = HORSE_JOURNAL_ARCHIVE_SEGMENTS * 16;
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
