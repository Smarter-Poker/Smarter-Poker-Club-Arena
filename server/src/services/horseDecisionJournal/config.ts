import { execFile, execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, statfsSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

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
/** Additional shards have no historical allocation to preserve. */
export const HORSE_JOURNAL_ADDITIONAL_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
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

/** ONE CATALOG PER DECISION-SHARD WRITER (2026-09-28). Every Horse decision
 * worker shard runs its own journal publisher and, until now, its own writer
 * on the SAME catalog file (one shared `archive/horse-journal-archive.sqlite`
 * for every shard). SQLite allows one writer per file: a shard's `BEGIN
 * IMMEDIATE` routinely found the other shard's commit already holding the
 * write lock, and at the archive's steady-state byte ceiling - where every
 * append also retires a segment inside that same transaction (see
 * HORSE_ARCHIVE_CATALOG_CONNECTION in store.ts) - the loser paid a 250 ms
 * busy wait plus the lock-retry ladder (HORSE_JOURNAL_LOCK_RETRY_DELAYS_MS)
 * before its batch was retried, long enough to overflow the publisher's
 * 64-record queue. Measured locally (two writers hammering one shared
 * catalog at production's byte ceiling vs one apiece): 0 lock retries and
 * +69% aggregate throughput once each shard owns its own file - see
 * docs/horse-brain-journal-retention-2026-09-26.md, "the journal keeps up
 * with the fleet" (2026-09-28).
 *
 * Shard 0 always resolves to 'archive', the one directory every deployment
 * - single-worker or the first shard of a sharded one - has ever written to,
 * so turning on a second decision-worker shard never orphans existing
 * evidence: shard 0 keeps the exact catalog and allocation it already had.
 * Later shards (1, 2, ...) get their own fresh 'archive-shard-<index>'
 * catalog. Shards 0 and 1 keep their existing full 8 GiB segment allocation:
 * lowering them would retire historical evidence. New shards 2+ default to
 * 4 GiB segments with the same 6 GiB catalog ceiling. A configured
 * HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES overrides both defaults for every
 * shard. Operators raising HORSE_DECISION_WORKERS should size
 * HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES/SEGMENTS with that in mind, or
 * watch each shard's own /health figures (now reported per shard). */
export interface HorseJournalArchiveShard {
  /** 0-based position among this engine's decision-worker shards. */
  index: number;
}
function archiveDirectoryName(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) throw Error('Invalid Horse journal shard');
  return index === 0 ? 'archive' : `archive-shard-${index}`;
}
/** Every archive directory name a shard index could ever resolve to, ordered
 * for a reader to try: shard 0's ('archive') first if it exists, then any
 * later shards' that exist, lowest index first. Empty when neither exists
 * yet (a fresh or disabled journal) - never a guess at a layout nobody wrote. */
export function horseJournalArchiveDirectoryNames(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter(
      (name) =>
        name === 'archive' ||
        (/^archive-shard-[1-9][0-9]*$/.test(name) &&
          Number.isSafeInteger(Number(name.slice('archive-shard-'.length))))
    )
    .sort((a, b) => {
      const index = (name: string) =>
        name === 'archive' ? 0 : Number(name.slice('archive-shard-'.length));
      return index(a) - index(b);
    });
}

/** This runs in the existing journal owner before its dedicated writer starts.
 * The archive stays under the already sealed persistent private bind mount. */
export function runtimeHorseJournalArchiveOptions(
  directory: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  shard: HorseJournalArchiveShard = { index: 0 }
): HorseJournalArchiveOptions {
  if (!isAbsolute(directory)) throw Error('Invalid Horse journal directory');
  return {
    directory: join(directory, archiveDirectoryName(shard.index)),
    maxBytes: positiveInteger(
      environment.HORSE_DECISION_JOURNAL_ARCHIVE_MAX_BYTES,
      shard.index < 2 ? HORSE_JOURNAL_ARCHIVE_BYTES : HORSE_JOURNAL_ADDITIONAL_ARCHIVE_BYTES,
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
 * Reading never creates a directory, opens a writer or completes pending work.
 * `archiveDirectory` selects which shard's catalog to open ('archive' by
 * default, exactly as before sharding existed); a caller iterating shards
 * passes a name from horseJournalArchiveDirectoryNames. */
export function readonlyHorseJournalStoreOptions(
  directory: string,
  archiveDirectory = 'archive'
): {
  readOnly: true;
  archive?: HorseJournalArchiveOptions;
} {
  const index =
    archiveDirectory === 'archive' ? 0 : Number(archiveDirectory.slice('archive-shard-'.length));
  if (archiveDirectory !== archiveDirectoryName(index))
    throw Error('Invalid Horse journal shard directory');
  const archive = runtimeHorseJournalArchiveOptions(directory, {}, { index });
  try {
    lstatSync(archive.directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { readOnly: true };
    throw error;
  }
  return { readOnly: true, archive };
}

/* A SHARD THE DISK CANNOT HOLD IS NEVER ADDED BY DEFAULT (2026-10-12). Each
   decision-worker shard owns a full allocation (above), so the default worker
   count (horseDecisionWorkerCount in engine/horseDecision/lane.ts) is bounded
   by how many shards the journal's filesystem can hold. A shard's worst case
   on disk is its compressed segment bytes at the small-file block overhead
   plus the catalog ceiling: measured on the engine host on 2026-10-12, 8.6 GB
   of compressed segments took 10.4 GB of blocks (1.21x) beside a 3.3 GB
   catalog, 14 GB a shard. The reserve is what every shard at its worst case
   still leaves to the rest of the host (the engine image build, logs). Existing
   archives grow on demand too: their remaining growth is charged first. */
export const HORSE_JOURNAL_SEGMENT_BLOCK_OVERHEAD = 1.25;
export const HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES = 4 * 1024 * 1024 * 1024;

/** One shard's worst-case footprint on disk at the given segment allocation. */
export function horseJournalShardDiskBytes(maxBytes: number): number {
  return (
    Math.ceil(maxBytes * HORSE_JOURNAL_SEGMENT_BLOCK_OVERHEAD) + HORSE_JOURNAL_ARCHIVE_CATALOG_BYTES
  );
}

/** du exits 1 when retention retires a segment between listing a directory
 * and stat-ing the file ("cannot access ...: No such file or directory").
 * A journal at its byte cap retires segments continuously. On the engine
 * host (2026-10-15, release 3002fe25, archives at their caps) the startup
 * walk met eleven, the reading was refused, and the lane fell back to the
 * legacy two-worker ceiling on a host whose disk budget admits three.
 *
 * Such a reading is still exact for the budget: a retired segment is unlinked
 * before statfs is read, so its blocks are counted as free, and leaving them
 * out of the allocation charges the same bytes again as remaining growth.
 * Allocated plus free is unchanged, so the result never authorizes a worker
 * the disk cannot hold. Only that one failure is accepted: any other stderr,
 * a timeout, a signal, an exit other than 1, a path outside the scanned
 * archives, or missing totals is still refused. */
function horseJournalAllocationDespiteRetiredSegments(
  error: unknown,
  directories: readonly string[]
): string {
  const failure = error as {
    status?: unknown;
    signal?: unknown;
    stdout?: unknown;
    stderr?: unknown;
  } | null;
  if (
    !failure ||
    failure.status !== 1 ||
    failure.signal ||
    typeof failure.stdout !== 'string' ||
    typeof failure.stderr !== 'string'
  )
    throw error;
  const complaints = failure.stderr.trimEnd().split('\n');
  const retired = complaints.every((line) => {
    const match = /^du: cannot access '(.+)': No such file or directory$/.exec(line);
    return (
      !!match &&
      !match[1]!.includes('\n') &&
      directories.some((directory) => match[1]!.startsWith(directory + '/'))
    );
  });
  if (!complaints.length || !retired) throw error;
  return failure.stdout;
}

/** Read actual allocated blocks once, without following symlinks. du walks the
 * potentially large archive, so cap its execution; a failed/incomplete reading
 * must never authorize an additional worker. Round down one KiB per result,
 * because du -k rounds each allocation up to a KiB. */
export const HORSE_JOURNAL_DU_TIMEOUT_MS = 15_000;
export const HORSE_JOURNAL_DU_ASYNC_TIMEOUT_MS = 90_000;

export function horseJournalArchiveAllocatedBytes(directories: readonly string[]): number[] {
  if (!directories.length) return [];
  checkArchiveDirectories(directories);
  let output: string;
  try {
    output = execFileSync('/usr/bin/du', ['-sk', ...directories], {
      encoding: 'utf8',
      timeout: HORSE_JOURNAL_DU_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    output = horseJournalAllocationDespiteRetiredSegments(error, directories);
  }
  return parseHorseJournalDu(output, directories);
}

function checkArchiveDirectories(directories: readonly string[]): void {
  for (const directory of directories) {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw Error('Invalid Horse journal archive directory');
  }
}

function parseHorseJournalDu(output: string, directories: readonly string[]): number[] {
  const lines = output.trimEnd().split('\n');
  if (lines.length !== directories.length) throw Error('Unreadable Horse archive allocation');
  return lines.map((line, index) => {
    const match = /^([0-9]+)\t(.*)$/.exec(line);
    if (!match || match[2] !== directories[index])
      throw Error('Unreadable Horse archive allocation');
    const bytes = Number(match[1]) * 1024;
    if (!Number.isSafeInteger(bytes) || bytes < 0)
      throw Error('Unreadable Horse archive allocation');
    return Math.max(0, bytes - 1024);
  });
}

/**
 * THE WALK RUNS OFF THE EVENT LOOP, WITH TIME FOR A FULL ARCHIVE (2026-10-15).
 * The synchronous walk had 15 s. Three archives at their caps (13.9, 13.7 and
 * 5.7 GB of segments) took 9.9 s warm on the engine host read-only, two thirds
 * of that limit, and the boot walk on releases e848247e, 3002fe25 and 9970aa0c
 * (the last with the retired-segment rule) was refused each time, keeping the
 * two-worker ceiling on a host whose disk admits three. Lane start is
 * already asynchronous, so the walk now runs as a child process the event loop
 * does not wait on, with HORSE_JOURNAL_DU_ASYNC_TIMEOUT_MS. Every refusal rule
 * of the synchronous walk is unchanged.
 */
export async function horseJournalArchiveAllocatedBytesAsync(
  directories: readonly string[]
): Promise<number[]> {
  if (!directories.length) return [];
  checkArchiveDirectories(directories);
  const output = await new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/bin/du',
      ['-sk', ...directories],
      {
        encoding: 'utf8',
        timeout: HORSE_JOURNAL_DU_ASYNC_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, LC_ALL: 'C' },
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        try {
          resolve(
            horseJournalAllocationDespiteRetiredSegments(
              Object.assign(error, {
                status: typeof error.code === 'number' ? error.code : null,
                stdout,
                stderr,
              }),
              directories
            )
          );
        } catch (refused) {
          reject(refused);
        }
      }
    );
  });
  return parseHorseJournalDu(output, directories);
}

/**
 * THE WALK LEAVES THE BOOT PATH WHEN IT CANNOT CHANGE THE ANSWER (2026-10-24).
 * Lane construction awaits this before any table can be dealt, so the du walk
 * over every archive shard (about 3.5 million segment files on engine-01) sat
 * on the critical path of every engine start. Release c485ce7a booted with the
 * lane starting 23 s after the process; the same walk is why release e4f7
 * reached dealer readiness too late for its final database proof inside the
 * maintenance break and rolled back.
 *
 * The walk only ever matters through the default worker count, which takes the
 * minimum of the CPU default, this capacity and a fixed maximum. So the
 * capacity is first priced with every existing archive assumed EMPTY - the
 * most growth those archives could still claim, which can only lower the
 * answer - from one statfs and a directory listing. When even that lower bound
 * already admits `sufficientShards` (the lane passes its maximum worker count),
 * the measured answer could not change the worker count and the walk is
 * skipped; the published capacity is that lower bound. Otherwise, or when the
 * bound itself is unreadable, the original walk runs with every refusal rule
 * unchanged, so a full disk is still measured exactly and an unreadable
 * reading still keeps the legacy two-worker ceiling.
 */
export async function horseJournalShardCapacityMeasured(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  options: { sufficientShards?: number } = {}
): Promise<number | undefined> {
  const directory = environment.HORSE_DECISION_JOURNAL_DIR;
  if (!directory) return horseJournalShardCapacity(environment);
  const sufficient = options.sufficientShards;
  if (sufficient !== undefined && Number.isSafeInteger(sufficient) && sufficient >= 1) {
    const lowerBound = horseJournalShardCapacity(environment, (directories) =>
      directories.map(() => 0)
    );
    if (
      horseJournalCapacityUnreadableReason() === null &&
      lowerBound !== undefined &&
      lowerBound >= sufficient
    ) {
      return lowerBound;
    }
  }
  let measured: number[] | { error: unknown };
  try {
    const names = horseJournalArchiveDirectoryNames(directory);
    measured = await horseJournalArchiveAllocatedBytesAsync(names.map((n) => join(directory, n)));
  } catch (error) {
    measured = { error };
  }
  return horseJournalShardCapacity(environment, () => {
    if (!Array.isArray(measured)) throw measured.error;
    return measured;
  });
}

/** Existing archives consume free space as they grow towards their quotas.
 * Reserve that remaining growth before admitting fresh full-size shards.
 * Retain existing workers when their previous allocation already exceeds the
 * disk budget; this guard never retires archives or changes their retention. */
export function horseJournalShardsAffordable(input: {
  existingShardAllocatedBytes: readonly number[];
  availableBytes: number;
  shardBytes: number;
  /** Worst-case cost for indexes 2+, defaulting to the legacy cost. */
  additionalShardBytes?: number;
  reserveBytes: number;
}): number {
  const additional = input.additionalShardBytes ?? input.shardBytes;
  if (
    ![input.availableBytes, input.shardBytes, additional, input.reserveBytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0
    ) ||
    input.shardBytes === 0 ||
    additional === 0 ||
    input.existingShardAllocatedBytes.some((value) => !Number.isSafeInteger(value) || value < 0)
  )
    throw Error('Unreadable Horse journal disk capacity');
  const remainingGrowth = input.existingShardAllocatedBytes.reduce(
    (total, bytes, index) =>
      total + Math.max(0, (index < 2 ? input.shardBytes : additional) - bytes),
    0
  );
  if (!Number.isSafeInteger(remainingGrowth)) throw Error('Unreadable Horse journal disk capacity');
  const existing = input.existingShardAllocatedBytes.length;
  const budget = Math.max(0, input.availableBytes - input.reserveBytes - remainingGrowth);
  // A fresh journal must pay for indexes 0 and 1 before cheaper later shards.
  const legacyFresh = Math.min(Math.max(0, 2 - existing), Math.floor(budget / input.shardBytes));
  const laterFresh =
    existing + legacyFresh >= 2
      ? Math.floor((budget - legacyFresh * input.shardBytes) / additional)
      : 0;
  return Math.max(1, existing + legacyFresh + laterFresh);
}

let journalCapacityUnreadable: string | null = null;

/** Why the last journal capacity reading was refused, published on /health
 * (liveHorseDecision.journalCapacityUnreadable) so the reason a host runs the
 * two-worker ceiling is visible without reading the host. Null when the last
 * reading succeeded or nothing is journaled. */
export function horseJournalCapacityUnreadableReason(): string | null {
  return journalCapacityUnreadable;
}

/** One bounded line: the error's first line, with the exit status, signal and
 * first stderr line of a failed command. Paths only; never an environment value. */
function capacityFailureText(error: unknown): string {
  const e = (error ?? {}) as {
    message?: unknown;
    status?: unknown;
    signal?: unknown;
    code?: unknown;
    stderr?: unknown;
  };
  const first = (value: unknown) =>
    typeof value === 'string' ? (value.split('\n').find((line) => line.trim()) ?? '') : '';
  const parts = [first(e.message) || 'unknown error'];
  if (e.code !== undefined) parts.push(`code=${String(e.code)}`);
  if (e.status !== undefined && e.status !== null) parts.push(`status=${String(e.status)}`);
  if (e.signal) parts.push(`signal=${String(e.signal)}`);
  const stderr = first(e.stderr);
  if (stderr) parts.push(`stderr=${stderr}`);
  return parts.join(' ').slice(0, 400);
}

/** Measure once at lane construction. No configured journal means no disk
 * limit. A configured journal whose budget cannot be read retains the legacy
 * two-worker ceiling; inability to measure must never increase the default. */
export function horseJournalShardCapacity(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  allocationReader: (directories: readonly string[]) => number[] = horseJournalArchiveAllocatedBytes
): number | undefined {
  const directory = environment.HORSE_DECISION_JOURNAL_DIR;
  journalCapacityUnreadable = null;
  if (!directory) return undefined;
  try {
    const { maxBytes } = runtimeHorseJournalArchiveOptions(directory, environment);
    let probe = directory;
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
    const names = horseJournalArchiveDirectoryNames(directory);
    if (names.some((name, index) => name !== archiveDirectoryName(index)))
      throw Error('Incomplete Horse journal archive layout');
    const directories = names.map((name) => join(directory, name));
    const allocated = allocationReader(directories);
    if (allocated.length !== directories.length) throw Error('Incomplete Horse archive allocation');
    // Read free space after the allocation walk. Lane construction precedes
    // spawning its shard writers; no publisher starts during this measurement.
    const fs = statfsSync(probe);
    const shards = horseJournalShardsAffordable({
      existingShardAllocatedBytes: allocated,
      availableBytes: fs.bavail * fs.bsize,
      shardBytes: horseJournalShardDiskBytes(maxBytes),
      additionalShardBytes: horseJournalShardDiskBytes(
        runtimeHorseJournalArchiveOptions(directory, environment, { index: 2 }).maxBytes
      ),
      reserveBytes: HORSE_JOURNAL_SHARD_DISK_RESERVE_BYTES,
    });
    journalCapacityUnreadable = null;
    return shards;
  } catch (error) {
    journalCapacityUnreadable = capacityFailureText(error);
    console.warn(
      '[HorseDecisionLane] journal disk capacity unreadable; retaining legacy two-worker ceiling',
      journalCapacityUnreadable
    );
    return 2;
  }
}
