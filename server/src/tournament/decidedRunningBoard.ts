/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE DECIDED-BUT-RUNNING SWEEP READS EVERY PLAYING COUNT IN ONE PASS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY THIS EXISTS (2026-09-11)
 *
 * GameServer's discovery pass looks for RUNNING tournaments that are already
 * decided - one player, or none, still `playing` - and hands each to its finish
 * owner (STALLED DECIDED-BUT-RUNNING RECOVERY, GameServer.ts). It asked the
 * question one tournament at a time: an exact-count head request for every
 * RUNNING tournament started more than ten minutes ago, each one awaited
 * before the next was sent. Measured on production on 2026-09-11: 368 of them
 * at about 110 ms a round trip, roughly 40 seconds of every pass, and most of
 * what a pass still cost once the REGISTERING walk stopped re-reading the
 * fleet for every board (#4256). At 08:06 UTC the same board held 683.
 *
 * The same answers are now one read: every `playing` row for up to
 * IN_LIST_CHUNK tournaments at a time, keyset-paged by the row's primary key
 * (fetchAllRows), and counted here. The 683-tournament board with its 2,387
 * playing rows is four chunks and about five requests: chunked in start-time
 * order, the order the planner hands that board back in, one chunk holds 1,026
 * rows and needs a second page.
 *
 * AN UNREAD COUNT IS STILL UNKNOWN, NEVER ZERO
 *
 * The per-tournament loop carried one rule - PAYOUT-INTEGRITY: a count we
 * could not read is UNKNOWN, not zero - and batching is exactly where it could
 * quietly be lost. A tournament with no rows in a read that finished has
 * nobody playing. A tournament with no rows in a read that did NOT finish has
 * an unknown number playing. Nothing in the rows tells those two apart.
 *
 * So a read carries the ids it asked about and whether it finished. A read
 * that did not finish - a page that still failed after its retries, the row
 * ceiling, a page without its cursor column, a query that threw - makes every
 * count in it UNKNOWN, including a tournament it had already seen one row
 * for: one row seen before the failure can be two once the rest is read. An
 * unknown tournament is skipped for this pass and asked about again on the
 * next, exactly as a failed count was.
 *
 * Each chunk stands alone, as each tournament did before: a chunk that fails
 * leaves every other chunk's answers standing.
 *
 * WHAT A COUNT HERE IS FOR
 *
 * It decides only whether the sweep hands a tournament to its finish owner.
 * The owner reads its own exact count before it finishes anything, and skips
 * the cycle when that count is unreadable (the finish stage of
 * TournamentManagerEliminations), so nothing read here places or pays a
 * player. It must still never call an unread tournament decided: that is a
 * false recovery, and not making one is the rule this file exists to keep.
 *
 * THE READS WERE ALSO THE SWEEP'S ONLY BRAKE
 *
 * With a round trip in front of every tournament, the sweep could not act on
 * two decided tournaments less than about 110 ms apart, and nothing else
 * paced it. Both of its actions need that pacing. A decided tournament with
 * no manager in this process is RESUMED, and on 2026-09-10 ~740 resumes inside
 * three seconds starved the lease heartbeats and ended in a restart
 * (tournamentResumeBudget.ts). One with a manager gets an urgent wake on the
 * one process-wide elimination scheduler, which runs four sweeps at a time
 * from a first-come queue. At 08:06 UTC on 2026-09-11, 562 of the 683 RUNNING
 * tournaments on this board were decided, every one of them under a live
 * lease. Remove the reads and change nothing else, and the sweep would
 * queue all 562 urgent sweeps at once on every pass, ahead of every live
 * tournament's next elimination; after a restart, before any of them has a
 * manager again, it would launch all 562 resumes at once.
 *
 * So the recoveries keep the spacing the reads gave them: the sweep leaves
 * DECIDED_RECOVERY_STAGGER_MS between one recovery and the next. A board
 * with nothing decided on it, which is the healthy board, never waits for it.
 * Nor does the wait leave the sweep acting on older answers than it used to.
 * The old loop read the board once, before its first count, so the RUNNING
 * status behind its last recovery was one round trip per tournament on the
 * board old. The count behind the last recovery here is one wait per DECIDED
 * tournament old, and the manager it wakes or resumes is looked up after the
 * wait, as the old loop looked it up after its count.
 */
import { fetchAllRows, type PageQuery } from '../services/supabase/pagination.js';
import { IN_LIST_CHUNK } from '../services/supabase/chunkedIn.js';
import { reportError } from '../services/errorReporter.js';

/** At most this many players still `playing` and a RUNNING tournament is decided. */
export const DECIDED_PLAYING_MAX = 1;

/**
 * The least time between two recoveries. It is the round trip the
 * per-tournament count took on production on 2026-09-11, so the sweep acts
 * no faster than it could when every recovery waited on a count first. See
 * THE READS WERE ALSO THE SWEEP'S ONLY BRAKE above.
 */
export const DECIDED_RECOVERY_STAGGER_MS = 110;

/**
 * The row ceiling for one chunk's read. The busiest chunk of the 683-tournament
 * board held 1,026 playing rows. Reaching the ceiling is an incomplete read,
 * so every count in that chunk is unknown, and fetchAllRows reports it.
 */
export const PLAYING_ROWS_PER_CHUNK_MAX = 50_000;

/** One `tournament_players` row in status `playing`: its keyset id and its tournament. */
export interface PlayingRow extends Record<string, unknown> {
  id: string;
  tournament_id: string;
}

/** One chunk's answer: what it asked about, what came back, and whether that is all of it. */
export interface PlayingCountRead {
  /** Every tournament this read asked about. */
  tournamentIds: readonly string[];
  /** The `playing` rows that came back for them. */
  rows: readonly Pick<PlayingRow, 'tournament_id'>[];
  /**
   * False when the read did not finish. Every count in it is then UNKNOWN,
   * whatever rows came back before it stopped.
   */
  complete: boolean;
}

export type DecidedRunningVerdict =
  /** The count could not be read: skip the tournament this pass. */
  | { readonly kind: 'unknown' }
  /** Two or more still playing: a live contest, left alone. */
  | { readonly kind: 'live'; readonly playingCount: number }
  /** One or none still playing: recover the winner. */
  | { readonly kind: 'decided'; readonly playingCount: number };

const UNKNOWN: DecidedRunningVerdict = Object.freeze({ kind: 'unknown' });

/**
 * One page of `playing` rows for `tournamentIds`, by keyset: the caller must
 * filter `status = 'playing'` and `tournament_id in tournamentIds`, apply
 * `id > cursor` when the cursor is not null, order by `id` ascending and limit
 * to `want`. It must build a FRESH query each call.
 */
export type PlayingRowsPage = (
  tournamentIds: string[],
  cursor: string | null,
  want: number
) => PageQuery<PlayingRow>;

export interface ReadPlayingCountsOptions {
  /** Tournaments per read. Capped at IN_LIST_CHUNK, the estate's id-list size (chunkedIn.ts). */
  chunkSize?: number;
  /** Passed to fetchAllRows. Its default retries a failed page twice. */
  pageAttempts?: number;
  /** Row ceiling per chunk. See PLAYING_ROWS_PER_CHUNK_MAX. */
  maxRowsPerChunk?: number;
}

/**
 * Read every `playing` row for `tournamentIds`, one chunk of ids at a time,
 * each chunk paged to the end by keyset. Never throws: a chunk that cannot be
 * read comes back `complete: false`, and the chunks after it are still read.
 */
export async function readPlayingCounts(
  tournamentIds: readonly (string | null | undefined)[],
  page: PlayingRowsPage,
  options: ReadPlayingCountsOptions = {}
): Promise<PlayingCountRead[]> {
  const unique = [
    ...new Set(tournamentIds.filter((id): id is string => typeof id === 'string' && id !== '')),
  ];
  const size = Math.max(1, Math.min(options.chunkSize ?? IN_LIST_CHUNK, IN_LIST_CHUNK));
  const reads: PlayingCountRead[] = [];
  for (let at = 0; at < unique.length; at += size) {
    const chunk = unique.slice(at, at + size);
    try {
      const { rows, complete } = await fetchAllRows<PlayingRow>(
        (cursor, want) => page(chunk, cursor, want),
        {
          label: 'GameServer.decidedRunningBoard',
          maxRows: options.maxRowsPerChunk ?? PLAYING_ROWS_PER_CHUNK_MAX,
          pageAttempts: options.pageAttempts,
        }
      );
      reads.push({ tournamentIds: chunk, rows, complete });
    } catch (error: unknown) {
      reportError(error, 'GameServer.decidedRunningBoard.threw', {
        chunkAt: at,
        tournaments: unique.length,
      });
      reads.push({ tournamentIds: chunk, rows: [], complete: false });
    }
  }
  return reads;
}

/**
 * Turn the reads into one verdict per tournament. A tournament in a read that
 * did not finish is unknown, and stays unknown if another read also names it.
 * A row whose tournament its read did not ask about is not counted.
 */
export function decidedRunningVerdicts(
  reads: readonly PlayingCountRead[]
): Map<string, DecidedRunningVerdict> {
  const verdicts = new Map<string, DecidedRunningVerdict>();
  for (const read of reads) {
    if (!read.complete) {
      for (const id of read.tournamentIds) verdicts.set(id, UNKNOWN);
      continue;
    }
    const playing = new Map<string, number>();
    for (const id of read.tournamentIds) playing.set(id, 0);
    for (const row of read.rows) {
      const id = String(row.tournament_id);
      const seen = playing.get(id);
      if (seen !== undefined) playing.set(id, seen + 1);
    }
    for (const [id, playingCount] of playing) {
      if (verdicts.get(id)?.kind === 'unknown') continue;
      verdicts.set(
        id,
        playingCount <= DECIDED_PLAYING_MAX
          ? { kind: 'decided', playingCount }
          : { kind: 'live', playingCount }
      );
    }
  }
  return verdicts;
}

/** The verdict for one tournament. One that no read covered is unknown, never zero. */
export function verdictFor(
  verdicts: ReadonlyMap<string, DecidedRunningVerdict>,
  tournamentId: string
): DecidedRunningVerdict {
  return verdicts.get(tournamentId) ?? UNKNOWN;
}
