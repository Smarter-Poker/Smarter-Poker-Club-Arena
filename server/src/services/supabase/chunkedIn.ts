/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  AN ID LIST GOES IN THE URL, SO IT HAS A CEILING - THIS IS THE ONE HELPER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-03)
 *
 * PostgREST puts an `.in()` filter's id list in the query string. Measured
 * against this project's instance on the day this file was written, the
 * largest list `profiles?id=in.(...)` will accept is 675 UUIDs - about 25 KB
 * of URL. Past that it answers HTTP 400 Bad Request.
 *
 * That alone is survivable. What is not survivable is the shape almost every
 * call site had:
 *
 *     const { data } = await supabase.from('profiles').select('id').in('id', ids);
 *     const horses = new Set((data || []).map((h) => h.id));
 *
 * The error is discarded, `data` comes back null, and the set is EMPTY - which
 * does not read as "the query failed", it reads as "none of them qualify".
 * Found in production: HorseSessionRotator had been handing this 713 seated
 * user ids and getting a 400 every 90 seconds, so `horseIds` was empty, every
 * seat in the room looked like a person, and the entire humanisation service -
 * session ends, breaks, top-ups, table changes - had gone silent without one
 * line of log. The same audit found seven more, three of them already past the
 * ceiling at the current floor size of 1,131 tables.
 *
 * The convention already existed - HorseFleetManager chunks at 200, the
 * elimination sweep at its own TABLE_ID_CHUNK, RakebackSettler at
 * LEDGER_READ_CHUNK - but there was no shared helper, so it was applied
 * unevenly and one file could chunk in one method and not in another a
 * thousand lines away.
 *
 * This is that helper, and it makes the dangerous half impossible: it returns
 * `complete`, so a caller cannot accidentally read a failure as an empty
 * answer. It never throws and never guesses.
 *
 * `fetchAllRows` is the other half of the same problem and does NOT overlap:
 * it pages a RESULT SET that is too big to return. This bounds a FILTER that
 * is too big to send. A call can need both.
 */
import { reportError } from '../errorReporter.js';

/** The estate's settled chunk size for an id list. */
export const IN_LIST_CHUNK = 200;

export interface ChunkedInResult<T> {
  rows: T[];
  /**
   * False when ANY chunk failed. The rows already read are still returned - a
   * caller that only accumulates (a "which of these are horses" set) may use
   * them - but no caller may treat an incomplete read as a complete answer.
   */
  complete: boolean;
}

/**
 * Run `query` once per chunk of `ids` and concatenate the rows.
 *
 * @param ids   the id list; de-duplicated and emptied of blanks first
 * @param query called with each batch, returns the supabase builder's result
 * @param label appears in the error report, e.g. 'HorseSessionRotator.horseIds'
 */
export async function selectInChunks<T>(
  ids: readonly (string | null | undefined)[],
  query: (batch: string[]) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  label: string,
  chunkSize: number = IN_LIST_CHUNK
): Promise<ChunkedInResult<T>> {
  const unique = [
    ...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== '')),
  ];
  if (unique.length === 0) return { rows: [], complete: true };

  const size = Math.max(1, Math.min(chunkSize, IN_LIST_CHUNK));
  const rows: T[] = [];
  for (let i = 0; i < unique.length; i += size) {
    let result: { data: T[] | null; error: { message: string } | null };
    try {
      result = await query(unique.slice(i, i + size));
    } catch (err: unknown) {
      reportError(
        new Error(
          `[chunkedIn] ${label} threw on the chunk at ${i} of ${unique.length}: ${(err as Error)?.message ?? err}`
        ),
        'chunkedIn.threw'
      );
      return { rows, complete: false };
    }
    if (result.error || !result.data) {
      reportError(
        new Error(
          `[chunkedIn] ${label} failed on the chunk at ${i} of ${unique.length}: ${result.error?.message ?? 'no rows returned'}`
        ),
        'chunkedIn.failed'
      );
      return { rows, complete: false };
    }
    rows.push(...result.data);
  }
  return { rows, complete: true };
}
