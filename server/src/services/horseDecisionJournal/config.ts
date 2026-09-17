import { lstatSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface HorseJournalArchiveOptions {
  directory: string;
  maxBytes: number;
  maxSegments: number;
}

// Separate durable archive allocation; the original 64 MiB journal remains
// unchanged. These bound compressed files independently of the catalog's
// 2 GiB physical ceiling and each 4 MiB decoded batch. No quota grants
// permission to delete records or describe an incomplete window as complete.
export const HORSE_JOURNAL_ARCHIVE_BYTES = 8 * 1024 * 1024 * 1024;
export const HORSE_JOURNAL_ARCHIVE_SEGMENTS = 500_000;

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
