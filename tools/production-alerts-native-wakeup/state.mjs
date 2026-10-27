import { mkdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';

// One local SQLite connection owns the service, using OS locks, not a stale PID
// file or heartbeat. Committed submission state survives process death; the OS
// releases ownership automatically. Nothing in this store can initiate a wake.
export async function openState(directory) {
  const [major, minor, patch] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && (minor < 23 || (minor === 23 && patch < 2))))
    throw new Error('native wakeup requires Node22.23.2 or newer');
  const { DatabaseSync } = await import('node:sqlite');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'intake.sqlite');
  let db;
  try {
    db = new DatabaseSync(path);
    db.exec(`PRAGMA busy_timeout=0;
      PRAGMA locking_mode=EXCLUSIVE;
      PRAGMA journal_mode=DELETE;
      PRAGMA synchronous=EXTRA;
      PRAGMA fullfsync=ON;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS intake_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL);
      INSERT OR IGNORE INTO intake_state VALUES(1,'null');
      COMMIT;`);
    if (
      db.prepare('PRAGMA locking_mode').get().locking_mode !== 'exclusive' ||
      db.prepare('PRAGMA synchronous').get().synchronous !== 3
    )
      throw new Error('durable state settings unavailable');
    await chmod(path, 0o600);
  } catch {
    db?.close();
    throw new Error('native intake state is owned or unavailable');
  }
  const read = db.prepare('SELECT value FROM intake_state WHERE singleton=1');
  const write = db.prepare('UPDATE intake_state SET value=? WHERE singleton=1');
  let closed = false;
  return {
    async load() {
      return JSON.parse(read.get().value);
    },
    async save(value) {
      db.exec('BEGIN IMMEDIATE');
      try {
        write.run(JSON.stringify(value));
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      if (!closed) {
        db.close();
        closed = true;
      }
    },
  };
}
