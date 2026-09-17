import { createRequire } from 'node:module';
import type { DatabaseSync as Database } from 'node:sqlite';
// Native Node resolution also works with the repository's older Vite builtin
// inventory; this is the bundled Node implementation, not an added dependency.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite');
import { closeSync, lstatSync, mkdirSync, openSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { horseJournalJson, validateHorseJournalRecord, type HorseJournalRecord } from './record.js';

/** Private host-local spool. Its synchronous I/O belongs ONLY in the dedicated
 * journal worker, never the engine or HorseLogic event loop. SQLite supplies
 * transactions and restart/competing-writer recovery without a PID lockfile.
 * No read or local write is a Supabase acknowledgement or complete population. */
export class HorseDecisionJournalStore {
  private readonly db: Database;
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
