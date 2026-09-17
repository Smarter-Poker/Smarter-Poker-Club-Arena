import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
// Native Node resolution also works with the repository's older Vite builtin
// inventory; this is the bundled Node implementation, not an added dependency.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite');
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  existsSync,
  readFileSync,
  writeFileSync,
  fsyncSync,
  linkSync,
  unlinkSync,
  constants,
  readSync,
  type Stats,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { HorseJournalArchiveOptions } from './config.js';
import { isAbsolute, join } from 'node:path';
import { horseJournalJson, validateHorseJournalRecord, type HorseJournalRecord } from './record.js';

/** Private host-local spool. Its synchronous I/O belongs ONLY in the dedicated
 * journal worker, never the engine or HorseLogic event loop. SQLite supplies
 * transactions and restart/competing-writer recovery without a PID lockfile.
 * No read or local write is a Supabase acknowledgement or complete population. */
class LegacyHorseJournalStore {
  protected readonly db: Database;
  readonly maxBytes: number;
  readonly maxRecords: number;
  private readonly readOnly: boolean;
  constructor(
    directory: string,
    limits: { maxBytes?: number; maxRecords?: number; readOnly?: boolean } = {}
  ) {
    this.readOnly = limits.readOnly === true;
    this.maxBytes = limits.maxBytes ?? 64 * 1024 * 1024;
    this.maxRecords = limits.maxRecords ?? 100000;
    if (
      !isAbsolute(directory) ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1 ||
      this.maxBytes > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(this.maxRecords) ||
      this.maxRecords < 1 ||
      this.maxRecords > 100000
    )
      throw Error('Invalid Horse journal configuration');
    if (!this.readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 });
    const info = lstatSync(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw Error('Horse journal directory is not private');
    const path = join(realpathSync(directory), 'horse-decisions.sqlite');
    if (!this.readOnly) {
      try {
        closeSync(openSync(path, 'wx', 0o600));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    const file = lstatSync(path);
    if (
      !file.isFile() ||
      file.isSymbolicLink() ||
      file.nlink !== 1 ||
      (file.mode & 0o077) !== 0 ||
      (process.getuid && file.uid !== process.getuid())
    )
      throw Error('Horse journal file is not private');
    this.db = new DatabaseSync(path, {
      enableForeignKeyConstraints: true,
      allowExtension: false,
      readOnly: this.readOnly,
    });
    try {
      if (this.readOnly) {
        this.db.exec('PRAGMA busy_timeout=250; PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
        if (this.db.prepare('PRAGMA user_version').get()!.user_version !== 1)
          throw Error('Unknown Horse journal schema');
        return;
      }
      this.db.exec(
        'PRAGMA busy_timeout=250; PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA trusted_schema=OFF; PRAGMA max_page_count=32768;'
      );
      const version = this.db.prepare('PRAGMA user_version').get()!.user_version;
      if (version !== 0 && version !== 1) throw Error('Unknown Horse journal schema');
      if (
        version === 0 &&
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
          .all().length
      )
        throw Error('Foreign Horse journal schema');
      if (
        this.db.prepare('PRAGMA journal_mode').get()!.journal_mode !== 'delete' ||
        this.db.prepare('PRAGMA synchronous').get()!.synchronous !== 3 ||
        this.db.prepare('PRAGMA fullfsync').get()!.fullfsync !== 1 ||
        this.db.prepare('PRAGMA page_size').get()!.page_size !== 4096 ||
        this.db.prepare('PRAGMA max_page_count').get()!.max_page_count !== 32768
      )
        throw Error('Horse journal durability settings unavailable');
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS horse_journal_events(
          event_id TEXT PRIMARY KEY, producer_id TEXT NOT NULL, sequence INTEGER NOT NULL,
          hand_key TEXT NOT NULL, turn_key TEXT NOT NULL, record_json TEXT NOT NULL,
          record_bytes INTEGER NOT NULL CHECK(record_bytes > 0), UNIQUE(producer_id,sequence)
        ) STRICT;
        CREATE INDEX IF NOT EXISTS horse_journal_hand ON horse_journal_events(hand_key,producer_id,sequence);
        CREATE TABLE IF NOT EXISTS horse_journal_usage(id INTEGER PRIMARY KEY CHECK(id=1), bytes INTEGER NOT NULL, records INTEGER NOT NULL) STRICT;
        INSERT OR IGNORE INTO horse_journal_usage VALUES(1,0,0);
        PRAGMA user_version=1;
        COMMIT;`);
    } catch (e) {
      this.db.close();
      throw e;
    }
  }

  append(record: HorseJournalRecord): 'recorded' | 'replayed' {
    return this.appendBatch([record])[0]!;
  }

  appendBatch(records: readonly HorseJournalRecord[]): Array<'recorded' | 'replayed'> {
    if (this.readOnly) throw Error('Horse journal is read only');
    if (!Array.isArray(records) || records.length < 1 || records.length > 16)
      throw Error('Horse journal batch exceeds bounds');
    for (const record of records) validateHorseJournalRecord(record);
    if (records.reduce((n, r) => n + Buffer.byteLength(horseJournalJson(r)), 0) > 4 * 1024 * 1024)
      throw Error('Horse journal batch exceeds bounds');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const outcomes = records.map((record) => this.appendInTransaction(record));
      this.db.exec('COMMIT');
      return outcomes;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        /* SQLite can roll back disk-full itself. */
      }
      throw e;
    }
  }

  private appendInTransaction(record: HorseJournalRecord): 'recorded' | 'replayed' {
    validateHorseJournalRecord(record);
    const json = horseJournalJson(record),
      bytes = Buffer.byteLength(json);
    const existing = this.db
      .prepare(
        'SELECT record_json FROM horse_journal_events WHERE event_id=? OR (producer_id=? AND sequence=?)'
      )
      .all(record.eventId, record.producerId, record.sequence);
    if (existing.length) {
      if (existing.length !== 1 || existing[0]!.record_json !== json)
        throw Error('Horse journal identity conflict');
      return 'replayed';
    }
    const usage = this.db
      .prepare('SELECT bytes,records FROM horse_journal_usage WHERE id=1')
      .get()!;
    if (Number(usage.bytes) + bytes > this.maxBytes || Number(usage.records) + 1 > this.maxRecords)
      throw Error('Horse journal capacity exhausted');
    this.db
      .prepare('INSERT INTO horse_journal_events VALUES(?,?,?,?,?,?,?)')
      .run(
        record.eventId,
        record.producerId,
        record.sequence,
        record.handKey,
        record.turnKey,
        json,
        bytes
      );
    this.db
      .prepare('UPDATE horse_journal_usage SET bytes=bytes+?,records=records+1 WHERE id=1')
      .run(bytes);
    return 'recorded';
  }

  /** One bounded statement snapshot. Missing records are returned as missing,
   * never an assertion that every decision for this hand was captured. */
  readHand(handKey: string): readonly HorseJournalRecord[] {
    if (!/^[0-9a-f]{64}$/.test(handKey)) throw Error('Invalid Horse journal hand key');
    this.db.exec('BEGIN');
    try {
      const sizes = this.db
        .prepare(
          'SELECT record_bytes,length(CAST(record_json AS BLOB)) AS actual_bytes FROM horse_journal_events WHERE hand_key=? ORDER BY producer_id,sequence LIMIT 257'
        )
        .all(handKey);
      if (sizes.some((r) => r.record_bytes !== r.actual_bytes))
        throw Error('Horse journal storage corruption');
      if (
        sizes.length > 256 ||
        sizes.reduce((n, r) => n + Number(r.actual_bytes), 0) > 8 * 1024 * 1024
      )
        throw Error('Horse journal read exceeds bounds');
      const rows = this.db
        .prepare(
          'SELECT record_json,record_bytes FROM horse_journal_events WHERE hand_key=? ORDER BY producer_id,sequence LIMIT 257'
        )
        .all(handKey);
      if (
        rows.length > 256 ||
        rows.reduce((n, r) => n + Number(r.record_bytes), 0) > 8 * 1024 * 1024
      )
        throw Error('Horse journal read exceeds bounds');
      const records = rows.map((row) => {
        if (
          typeof row.record_json !== 'string' ||
          Buffer.byteLength(row.record_json) !== row.record_bytes
        )
          throw Error('Horse journal storage corruption');
        const record: unknown = JSON.parse(row.record_json);
        validateHorseJournalRecord(record);
        if (record.handKey !== handKey) throw Error('Horse journal key corruption');
        return Object.freeze(record);
      });
      this.db.exec('COMMIT');
      return records;
    } catch (e) {
      try {
        this.db.exec('ROLLBACK');
      } catch {}
      throw e;
    }
  }
  close(): void {
    this.db.close();
  }
}

const DECODE_BYTES = 4 * 1024 * 1024;
const CATALOG_BYTES = 2 * 1024 * 1024 * 1024;
const SHA = /^[0-9a-f]{64}$/;
const digest = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');
const rollback = (db: Database): void => {
  try {
    db.exec('ROLLBACK');
  } catch {}
};
function privatePath(path: string, directory = false): Stats {
  const s = lstatSync(path);
  if (
    s.isSymbolicLink() ||
    (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1) ||
    (s.mode & 0o077) !== 0 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw Error('Horse archive path is not private');
  return s;
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function legacyIdentity(path: string): { sha256: string; stamp: string } {
  const before = privatePath(path);
  if (before.size > 128 * 1024 * 1024) throw Error('Horse legacy file exceeds bounds');
  const hash = createHash('sha256'),
    chunk = Buffer.alloc(64 * 1024);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    let offset = 0;
    while (offset < before.size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, before.size - offset), offset);
      if (!n) throw Error('Horse legacy file changed');
      hash.update(chunk.subarray(0, n));
      offset += n;
    }
  } finally {
    closeSync(fd);
  }
  const stamp = legacyStamp(path);
  if (stamp !== stampOf(before)) throw Error('Horse legacy file changed');
  return { sha256: hash.digest('hex'), stamp };
}
const stampOf = (s: Stats): string => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':');
const legacyStamp = (path: string): string => stampOf(privatePath(path));
interface Segment {
  sha: string;
  compressedSha: string;
  bytes: number;
  decodedBytes: number;
  records: HorseJournalRecord[];
  compressed: Buffer;
}
function decodeSegment(
  compressed: Buffer,
  sha: string,
  compressedSha: string,
  bytes: number,
  decodedBytes: number
): Segment {
  if (
    !SHA.test(sha) ||
    !SHA.test(compressedSha) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > DECODE_BYTES + 65536 ||
    !Number.isSafeInteger(decodedBytes) ||
    decodedBytes < 1 ||
    decodedBytes > DECODE_BYTES ||
    compressed.length !== bytes ||
    digest(compressed) !== compressedSha
  )
    throw Error('Horse archive segment corruption');
  const decoded = gunzipSync(compressed, { maxOutputLength: DECODE_BYTES });
  if (decoded.length !== decodedBytes || digest(decoded) !== sha || decoded.at(-1) !== 10)
    throw Error('Horse archive segment corruption');
  const text = decoded.toString('utf8');
  if (!Buffer.from(text).equals(decoded)) throw Error('Horse archive original bytes changed');
  const lines = text.slice(0, -1).split('\n');
  if (!lines.length || lines.length > 16) throw Error('Horse archive segment corruption');
  const records = lines.map((line) => {
    const record: unknown = JSON.parse(line);
    validateHorseJournalRecord(record);
    if (horseJournalJson(record) !== line) throw Error('Horse archive original bytes changed');
    return record;
  });
  return { sha, compressedSha, bytes, decodedBytes, records, compressed };
}
function segmentsFor(records: HorseJournalRecord[]): Segment[] {
  const groups: string[][] = [];
  let lines: string[] = [],
    size = 0;
  for (const record of records) {
    const line = horseJournalJson(record) + '\n',
      bytes = Buffer.byteLength(line);
    if (size + bytes > DECODE_BYTES) {
      groups.push(lines);
      lines = [];
      size = 0;
    }
    lines.push(line);
    size += bytes;
  }
  if (lines.length) groups.push(lines);
  return groups.map((group) => {
    const decoded = Buffer.from(group.join('')),
      compressed = gzipSync(decoded);
    return decodeSegment(
      compressed,
      digest(decoded),
      digest(compressed),
      compressed.length,
      decoded.length
    );
  });
}

/** Archive records retain the original v1 envelope. The legacy database is
 * immutable in this mode; quota reservation precedes file creation. At most one
 * pending batch is completed by startup/append, never a timer or directory scan.
 * A successful append proves local fsynced custody, not off-host export. */
export class HorseDecisionJournalStore extends LegacyHorseJournalStore {
  private catalog: Database | undefined;
  private archive: Readonly<HorseJournalArchiveOptions> | undefined;
  private readonly archiveReadOnly: boolean;
  private readonly legacyPath: string;
  private legacyStamp: string | undefined;
  private catalogPath: string | undefined;
  constructor(
    directory: string,
    limits: {
      maxBytes?: number;
      maxRecords?: number;
      readOnly?: boolean;
      archive?: HorseJournalArchiveOptions;
    } = {}
  ) {
    const archive = limits.archive && { ...limits.archive };
    if (
      archive &&
      (!isAbsolute(archive.directory) ||
        !Number.isSafeInteger(archive.maxBytes) ||
        archive.maxBytes < 1 ||
        !Number.isSafeInteger(archive.maxSegments) ||
        archive.maxSegments < 1 ||
        archive.maxSegments > 500000 ||
        archive.directory === directory)
    )
      throw Error('Invalid Horse archive configuration');
    // A fresh installation gets the same empty v1 legacy database once. Existing
    // spools, including a full spool, are opened read-only without a migration.
    if (archive && !limits.readOnly && !existsSync(join(directory, 'horse-decisions.sqlite'))) {
      const initial = new LegacyHorseJournalStore(directory, limits);
      initial.close();
    }
    super(directory, { ...limits, readOnly: archive ? true : limits.readOnly });
    this.archiveReadOnly = limits.readOnly === true;
    this.legacyPath = join(realpathSync(directory), 'horse-decisions.sqlite');
    if (!archive) return;
    this.archive = Object.freeze(archive);
    try {
      const identity = legacyIdentity(this.legacyPath);
      this.legacyStamp = identity.stamp;
      if (!this.archiveReadOnly) mkdirSync(archive.directory, { recursive: true, mode: 0o700 });
      privatePath(archive.directory, true);
      if (!this.archiveReadOnly) syncDirectory(directory);
      const segmentDir = join(archive.directory, 'segments');
      if (!this.archiveReadOnly) mkdirSync(segmentDir, { mode: 0o700, recursive: true });
      privatePath(segmentDir, true);
      this.catalogPath = join(archive.directory, 'horse-journal-archive.sqlite');
      if (!this.archiveReadOnly) {
        try {
          closeSync(openSync(this.catalogPath, 'wx', 0o600));
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        }
      }
      privatePath(this.catalogPath);
      const db = (this.catalog = new DatabaseSync(this.catalogPath, {
        readOnly: this.archiveReadOnly,
        allowExtension: false,
        enableForeignKeyConstraints: true,
      }));
      db.exec(
        'PRAGMA busy_timeout=250; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE;'
      );
      const version = db.prepare('PRAGMA user_version').get()!.user_version;
      if (
        version !== 1 &&
        (version !== 0 ||
          this.archiveReadOnly ||
          db.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").all().length)
      )
        throw Error('Unknown Horse archive schema');
      if (this.archiveReadOnly) db.exec('PRAGMA query_only=ON;');
      else {
        db.exec(
          'PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA max_page_count=524288;'
        );
        if (
          db.prepare('PRAGMA page_size').get()!.page_size !== 4096 ||
          db.prepare('PRAGMA max_page_count').get()!.max_page_count !== 524288 ||
          db.prepare('PRAGMA journal_mode').get()!.journal_mode !== 'delete' ||
          db.prepare('PRAGMA synchronous').get()!.synchronous !== 3 ||
          db.prepare('PRAGMA fullfsync').get()!.fullfsync !== 1
        )
          throw Error('Horse archive durability settings unavailable');
        db.exec(`BEGIN IMMEDIATE;
          CREATE TABLE IF NOT EXISTS archive_meta(id INTEGER PRIMARY KEY CHECK(id=1), legacy_sha TEXT NOT NULL,
            bytes INTEGER NOT NULL, segments INTEGER NOT NULL, records INTEGER NOT NULL,
            max_bytes INTEGER NOT NULL, max_segments INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS archive_segments(sha TEXT PRIMARY KEY, compressed_sha TEXT NOT NULL,
            bytes INTEGER NOT NULL, decoded_bytes INTEGER NOT NULL, records INTEGER NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS archive_events(event_id TEXT PRIMARY KEY, producer_id TEXT NOT NULL,
            sequence INTEGER NOT NULL, hand_key TEXT NOT NULL, record_sha TEXT NOT NULL,
            record_bytes INTEGER NOT NULL, segment_sha TEXT NOT NULL REFERENCES archive_segments(sha),
            ordinal INTEGER NOT NULL, UNIQUE(producer_id,sequence)) STRICT;
          CREATE INDEX IF NOT EXISTS archive_hand ON archive_events(hand_key,producer_id,sequence);
          CREATE TABLE IF NOT EXISTS archive_pending(id INTEGER PRIMARY KEY CHECK(id IN(1,2)), sha TEXT NOT NULL,
            compressed_sha TEXT NOT NULL, bytes INTEGER NOT NULL, decoded_bytes INTEGER NOT NULL,
            records INTEGER NOT NULL, compressed BLOB NOT NULL) STRICT;`);
        db.prepare('INSERT OR IGNORE INTO archive_meta VALUES(1,?,0,0,0,?,?)').run(
          identity.sha256,
          archive.maxBytes,
          archive.maxSegments
        );
        if (
          db.prepare('SELECT legacy_sha FROM archive_meta WHERE id=1').get()?.legacy_sha !==
          identity.sha256
        )
          throw Error('Horse archive legacy identity changed');
        db.prepare('UPDATE archive_meta SET max_bytes=?,max_segments=? WHERE id=1').run(
          archive.maxBytes,
          archive.maxSegments
        );
        db.exec('PRAGMA user_version=1; COMMIT;');
        syncDirectory(archive.directory);
      }
      if (
        db.prepare('SELECT legacy_sha FROM archive_meta WHERE id=1').get()?.legacy_sha !==
        identity.sha256
      )
        throw Error('Horse archive legacy identity changed');
      if (!this.archiveReadOnly) this.finishPending();
    } catch (e) {
      if (this.catalog) {
        rollback(this.catalog);
        this.catalog.close();
      }
      super.close();
      throw e;
    }
  }
  private assertLegacy(): void {
    if (this.archive && legacyStamp(this.legacyPath) !== this.legacyStamp)
      throw Error('Horse archive legacy file changed');
  }
  private readSegment(row: Record<string, unknown>): Segment {
    const sha = String(row.sha);
    if (!SHA.test(sha)) throw Error('Horse archive segment corruption');
    const path = join(this.archive!.directory, 'segments', sha + '.ndjson.gz');
    const s = privatePath(path);
    if (s.size !== row.bytes || s.size > DECODE_BYTES + 65536)
      throw Error('Horse archive segment corruption');
    const segment = decodeSegment(
      readFileSync(path),
      sha,
      String(row.compressed_sha),
      Number(row.bytes),
      Number(row.decoded_bytes)
    );
    if (segment.records.length !== row.records) throw Error('Horse archive segment corruption');
    return segment;
  }
  private publishSegment(segment: Segment): void {
    const dir = join(this.archive!.directory, 'segments'),
      final = join(dir, segment.sha + '.ndjson.gz');
    const stage = join(dir, segment.sha + '.pending');
    if (!existsSync(final)) {
      // Only this pending-slot-owned scratch file is replaceable. Its complete
      // bytes remain in the committed catalog until verified custody finishes.
      if (existsSync(stage)) privatePath(stage);
      const fd = openSync(
        stage,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600
      );
      try {
        writeFileSync(fd, segment.compressed);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      const staged = readFileSync(stage);
      decodeSegment(
        staged,
        segment.sha,
        segment.compressedSha,
        segment.bytes,
        segment.decodedBytes
      );
      linkSync(stage, final);
      // Recovery after the link but before unlink checks the shared inode first.
    }
    if (existsSync(stage)) {
      const a = lstatSync(stage),
        b = lstatSync(final);
      if (
        a.isSymbolicLink() ||
        b.isSymbolicLink() ||
        a.ino !== b.ino ||
        a.dev !== b.dev ||
        b.nlink !== 2
      )
        throw Error('Horse archive staging identity changed');
      unlinkSync(stage);
    }
    syncDirectory(dir);
    this.readSegment({
      sha: segment.sha,
      compressed_sha: segment.compressedSha,
      bytes: segment.bytes,
      decoded_bytes: segment.decodedBytes,
      records: segment.records.length,
    });
  }
  /** Caller holds the catalog transaction. Validate every pending segment before
   * publishing or deciding whether a selected hand is affected; this is at most
   * one original batch (two segments, sixteen records), never a catalog scan. */
  private readPendingSegments(): Segment[] {
    const db = this.catalog!;
    const sizes = db
      .prepare('SELECT length(compressed) AS bytes FROM archive_pending LIMIT 3')
      .all();
    if (
      sizes.length > 2 ||
      sizes.some((s) => Number(s.bytes) < 1 || Number(s.bytes) > DECODE_BYTES + 65536) ||
      sizes.reduce((n, s) => n + Number(s.bytes), 0) > DECODE_BYTES + 131072
    )
      throw Error('Horse archive pending exceeds bounds');
    const pending = db.prepare('SELECT * FROM archive_pending ORDER BY id LIMIT 3').all();
    if (pending.length > 2) throw Error('Horse archive pending exceeds bounds');
    const segments: Segment[] = [];
    let total = 0,
      records = 0;
    for (const row of pending) {
      if (!(row.compressed instanceof Uint8Array)) throw Error('Horse archive pending corruption');
      const segment = decodeSegment(
        Buffer.from(row.compressed),
        String(row.sha),
        String(row.compressed_sha),
        Number(row.bytes),
        Number(row.decoded_bytes)
      );
      total += segment.decodedBytes;
      records += segment.records.length;
      if (records > 16 || total > DECODE_BYTES + 16 || segment.records.length !== row.records)
        throw Error('Horse archive pending exceeds bounds');
      segments.push(segment);
    }
    return segments;
  }
  private finishPending(inTransaction = false): void {
    const db = this.catalog!;
    if (!inTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      for (const segment of this.readPendingSegments()) {
        this.publishSegment(segment);
        db.prepare('INSERT INTO archive_segments VALUES(?,?,?,?,?)').run(
          segment.sha,
          segment.compressedSha,
          segment.bytes,
          segment.decodedBytes,
          segment.records.length
        );
        segment.records.forEach((record, ordinal) =>
          db
            .prepare('INSERT INTO archive_events VALUES(?,?,?,?,?,?,?,?)')
            .run(
              record.eventId,
              record.producerId,
              record.sequence,
              record.handKey,
              digest(horseJournalJson(record)),
              Buffer.byteLength(horseJournalJson(record)),
              segment.sha,
              ordinal
            )
        );
      }
      db.exec('DELETE FROM archive_pending;');
      if (!inTransaction) db.exec('COMMIT');
    } catch (e) {
      if (!inTransaction) rollback(db);
      throw e;
    }
  }
  override appendBatch(records: readonly HorseJournalRecord[]): Array<'recorded' | 'replayed'> {
    if (!this.archive) return super.appendBatch(records);
    if (this.archiveReadOnly) throw Error('Horse journal is read only');
    this.assertLegacy();
    if (!Array.isArray(records) || records.length < 1 || records.length > 16)
      throw Error('Horse journal batch exceeds bounds');
    for (const record of records) validateHorseJournalRecord(record);
    const captured = records.map((r) => JSON.parse(horseJournalJson(r)) as HorseJournalRecord);
    if (captured.reduce((n, r) => n + Buffer.byteLength(horseJournalJson(r)), 0) > DECODE_BYTES)
      throw Error('Horse journal batch exceeds bounds');
    this.finishPending();
    const db = this.catalog!;
    db.exec('BEGIN IMMEDIATE');
    let outcomes: Array<'recorded' | 'replayed'>;
    try {
      // A competing connection may have reserved a batch after finishPending.
      if (db.prepare('SELECT id FROM archive_pending LIMIT 1').get()) this.finishPending(true);
      const fresh: HorseJournalRecord[] = [];
      outcomes = captured.map((record) => {
        const json = horseJournalJson(record);
        const old = this.db
          .prepare(
            'SELECT record_json FROM horse_journal_events WHERE event_id=? OR (producer_id=? AND sequence=?)'
          )
          .all(record.eventId, record.producerId, record.sequence);
        const archived = db
          .prepare(
            'SELECT * FROM archive_events WHERE event_id=? OR (producer_id=? AND sequence=?)'
          )
          .all(record.eventId, record.producerId, record.sequence);
        const local = fresh.filter(
          (r) =>
            r.eventId === record.eventId ||
            (r.producerId === record.producerId && r.sequence === record.sequence)
        );
        if (old.length + archived.length + local.length) {
          if (
            old.length + archived.length + local.length !== 1 ||
            (old.length && old[0]!.record_json !== json) ||
            (local.length && horseJournalJson(local[0]) !== json)
          )
            throw Error('Horse journal identity conflict');
          if (archived.length) {
            const row = archived[0]!;
            if (row.record_sha !== digest(json)) throw Error('Horse journal identity conflict');
            const meta = db
              .prepare('SELECT * FROM archive_segments WHERE sha=?')
              .get(row.segment_sha!);
            if (
              !meta ||
              horseJournalJson(this.readSegment(meta).records[Number(row.ordinal)]) !== json
            )
              throw Error('Horse archive replay custody unavailable');
          }
          return 'replayed';
        }
        fresh.push(record);
        return 'recorded';
      });
      const segments = segmentsFor(fresh),
        usage = db.prepare('SELECT * FROM archive_meta WHERE id=1').get()!;
      if (
        !usage ||
        [usage.bytes, usage.segments, usage.records].some(
          (n) => !Number.isSafeInteger(n) || Number(n) < 0
        ) ||
        Number(usage.segments) > 500000 ||
        Number(usage.records) > 8000000
      )
        throw Error('Horse archive usage corruption');
      if (
        usage.max_bytes !== this.archive.maxBytes ||
        usage.max_segments !== this.archive.maxSegments
      )
        throw Error('Horse archive writer allocation changed');
      const bytes = segments.reduce((n, s) => n + s.bytes, 0);
      if (fresh.length && Number(usage.bytes) + bytes > this.archive.maxBytes)
        throw Error('horse_archive_byte_capacity');
      if (
        fresh.length &&
        (Number(usage.segments) + segments.length > this.archive.maxSegments ||
          Number(usage.records) + fresh.length > this.archive.maxSegments * 16)
      )
        throw Error('horse_archive_segment_capacity');
      segments.forEach((s, i) =>
        db
          .prepare('INSERT INTO archive_pending VALUES(?,?,?,?,?,?,?)')
          .run(
            i + 1,
            s.sha,
            s.compressedSha,
            s.bytes,
            s.decodedBytes,
            s.records.length,
            s.compressed
          )
      );
      db.prepare(
        'UPDATE archive_meta SET bytes=bytes+?,segments=segments+?,records=records+? WHERE id=1'
      ).run(bytes, segments.length, fresh.length);
      this.assertLegacy();
      db.exec('COMMIT');
    } catch (e) {
      rollback(db);
      throw e;
    }
    this.finishPending();
    return outcomes;
  }
  override readHand(handKey: string): readonly HorseJournalRecord[] {
    this.assertLegacy();
    const old = super.readHand(handKey);
    if (!this.archive) return old;
    const db = this.catalog!;
    db.exec('BEGIN');
    try {
      // Validate all pending custody in this same snapshot. A valid unrelated
      // batch does not invalidate already committed evidence for this hand.
      // Pending evidence for the selected hand remains explicitly unavailable.
      const pending = this.readPendingSegments();
      let decodedBytes = pending.reduce((total, segment) => total + segment.decodedBytes, 0);
      if (pending.some((segment) => segment.records.some((record) => record.handKey === handKey)))
        throw Error('Horse archive custody pending');
      const rows = db
        .prepare(
          'SELECT * FROM archive_events WHERE hand_key=? ORDER BY producer_id,sequence LIMIT 257'
        )
        .all(handKey);
      if (
        old.length + rows.length > 256 ||
        old.reduce((n, r) => n + Buffer.byteLength(horseJournalJson(r)), 0) +
          rows.reduce((n, r) => n + Number(r.record_bytes), 0) >
          8 * 1024 * 1024
      )
        throw Error('Horse journal read exceeds bounds');
      const records = [...old],
        seen = new Set(old.map((r) => r.eventId));
      // Bound total decoding independently of selected-record bytes. An
      // unusually dispersed hand is explicitly unavailable, never truncated.
      const grouped = new Map<string, typeof rows>();
      for (const row of rows) {
        const key = String(row.segment_sha);
        const group = grouped.get(key) ?? [];
        group.push(row);
        grouped.set(key, group);
      }
      for (const [sha, group] of grouped) {
        const meta = db.prepare('SELECT * FROM archive_segments WHERE sha=?').get(sha);
        if (!meta) throw Error('Horse archive index corruption');
        decodedBytes += Number(meta.decoded_bytes);
        if (!Number.isSafeInteger(decodedBytes) || decodedBytes > 32 * 1024 * 1024)
          throw Error('Horse journal archive read exceeds decode bounds');
        const segment = this.readSegment(meta);
        for (const row of group) {
          const record = segment.records[Number(row.ordinal)];
          if (
            !record ||
            record.eventId !== row.event_id ||
            record.producerId !== row.producer_id ||
            record.sequence !== row.sequence ||
            record.handKey !== handKey ||
            digest(horseJournalJson(record)) !== row.record_sha ||
            Buffer.byteLength(horseJournalJson(record)) !== row.record_bytes ||
            seen.has(record.eventId)
          )
            throw Error('Horse archive index corruption');
          seen.add(record.eventId);
          records.push(Object.freeze(record));
        }
      }
      this.assertLegacy();
      db.exec('COMMIT');
      return records.sort(
        (a, b) => a.producerId.localeCompare(b.producerId) || a.sequence - b.sequence
      );
    } catch (e) {
      rollback(db);
      throw e;
    }
  }
  /** Aggregate-only private operational output. Reserved includes the sole
   * pending batch; no IDs, cards, paths or record bodies are returned. */
  storageStats(): {
    legacy: { bytes: number; records: number; maxBytes: number; maxRecords: number };
    archive: null | {
      compressedBytes: number;
      segments: number;
      records: number;
      pendingSegments: number;
      catalogBytes: number;
      maxBytes: number;
      maxSegments: number;
      maxCatalogBytes: number;
    };
  } {
    this.assertLegacy();
    const legacy = this.db
      .prepare('SELECT bytes,records FROM horse_journal_usage WHERE id=1')
      .get()!;
    let archive = null;
    if (this.catalog) {
      this.catalog.exec('BEGIN');
      try {
        const usage = this.catalog.prepare('SELECT * FROM archive_meta WHERE id=1').get()!;
        if (
          !usage ||
          [usage.bytes, usage.segments, usage.records].some(
            (n) => !Number.isSafeInteger(n) || Number(n) < 0
          ) ||
          !Number.isSafeInteger(usage.max_bytes) ||
          Number(usage.max_bytes) < 1 ||
          !Number.isSafeInteger(usage.max_segments) ||
          Number(usage.max_segments) < 1 ||
          Number(usage.max_segments) > 500000
        )
          throw Error('Horse archive usage corruption');
        archive = {
          compressedBytes: Number(usage.bytes),
          segments: Number(usage.segments),
          records: Number(usage.records),
          pendingSegments: Number(
            this.catalog.prepare('SELECT count(*) AS n FROM archive_pending').get()!.n
          ),
          catalogBytes: Number(this.catalog.prepare('PRAGMA page_count').get()!.page_count) * 4096,
          maxBytes: Number(usage.max_bytes),
          maxSegments: Number(usage.max_segments),
          maxCatalogBytes: CATALOG_BYTES,
        };
        this.catalog.exec('COMMIT');
      } catch (e) {
        rollback(this.catalog);
        throw e;
      }
    }
    return {
      legacy: {
        bytes: Number(legacy.bytes),
        records: Number(legacy.records),
        maxBytes: this.maxBytes,
        maxRecords: this.maxRecords,
      },
      archive,
    };
  }
  override close(): void {
    try {
      this.catalog?.close();
    } finally {
      super.close();
    }
  }
}

/** Deliberately finite public diagnostics; never forward arbitrary SQLite or
 * filesystem messages. BUSY/LOCKED retry classification stays unchanged. */
export function horseJournalCapacityReason(
  error: unknown
): 'archive_bytes' | 'archive_segments' | 'archive_storage_capacity' | undefined {
  if (error instanceof Error && error.message === 'horse_archive_byte_capacity')
    return 'archive_bytes';
  if (error instanceof Error && error.message === 'horse_archive_segment_capacity')
    return 'archive_segments';
  const e = error as { code?: unknown; errcode?: unknown } | null;
  if (e?.code === 'ENOSPC') return 'archive_storage_capacity';
  if (e?.code === 'ERR_SQLITE_ERROR' && typeof e.errcode === 'number' && (e.errcode & 255) === 13)
    return 'archive_storage_capacity';
  return undefined;
}
