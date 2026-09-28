/* THE LEGACY DATABASE'S BOOTSTRAP IS SINGLE-WRITER AGAIN (2026-09-28). Every
 * decision-shard writer that shares a base directory also shares that
 * directory's pre-archive legacy database (deliberately - every shard's
 * reader must still see it, see readonlyHorseJournalStoreOptions). Before
 * sharding, exactly one HorseDecisionJournalStore ever opened a given
 * directory in its process's lifetime, so "create the v1 legacy database if
 * it is missing" (HorseDecisionJournalStore's constructor) could never run
 * twice at once. Two shards constructing their stores concurrently against a
 * brand-new directory - a fresh host, a wiped fixture, never the already-
 * bootstrapped production archive the per-shard-catalog change ships onto -
 * broke that: both independently saw the file missing and both bootstrapped
 * it, and whichever construction captured legacyIdentity() before the
 * other's later-settling write finished persisted a since-stale hash into
 * its own catalog's archive_meta.legacy_sha, failing assertLegacy() on its
 * very next append and then on every future open of that same catalog for
 * good - not a lock-retry away, since the mismatch itself is what got
 * written down. Reproduced directly: two real worker threads constructing
 * concurrently against one fresh directory failed intermittently (~1 run in
 * 3-5 of a tight loop) with exactly that shape - the first shard failing
 * mid-burst with 'Horse archive legacy file changed', every following run
 * against that same now-poisoned catalog failing at construction with
 * 'Horse archive legacy identity changed' - before bootstrapLegacyJournalOnce
 * made the bootstrap itself single-writer (an exclusive-create lock file, the
 * same race-free primitive this file already uses for the sqlite files
 * themselves; a concurrent construction waits for it to clear rather than
 * racing its own bootstrap). This file repeats that exact concurrent
 * cold-start shape across several fresh directories and requires it to
 * succeed cleanly every time. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { HorseDecisionJournalPublisher, type HorseJournalWorker } from '../HorseDecisionJournal.js';
import { runtimeHorseJournalArchiveOptions } from './config.js';

const dirs: string[] = [];
const workers: Worker[] = [];
afterEach(async () => {
  for (const w of workers.splice(0)) {
    try {
      await w.terminate();
    } catch {
      /* best effort teardown */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const directory = () => {
  const d = mkdtempSync(join(tmpdir(), 'horse-journal-cold-start-'));
  dirs.push(d);
  return d;
};

// A worker thread does its own module resolution from scratch and does not
// inherit vitest/vite-node's transform, so a plain `new Worker(url)` pointed
// at worker.ts fails on that file's own `./store.js` import under vitest
// specifically (ERR_MODULE_NOT_FOUND) even though the identical file loads
// fine in production, where either the compiled .js is loaded directly or
// `tsx watch` has registered a process-wide loader new threads inherit. This
// is the same `tsImport` bootstrap HorseDecisionJournal.test.ts already uses
// to run the real worker.ts under vitest ("the actual dedicated worker writes
// configured archive custody..."); a compiled worker.js (CI's built output)
// needs no bootstrap at all.
const isTs = import.meta.url.endsWith('.ts');
const workerEntryUrl = new URL(isTs ? './worker.ts' : './worker.js', import.meta.url).href;
const tsxApiUrl = isTs
  ? pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm/api')).href
  : undefined;
function spawnJournalWorker(workerData: unknown): Worker {
  if (!isTs) return new Worker(new URL(workerEntryUrl), { workerData });
  const code = `import { tsImport } from ${JSON.stringify(tsxApiUrl)}; await tsImport(${JSON.stringify(workerEntryUrl)}, ${JSON.stringify(import.meta.url)});`;
  return new Worker(new URL('data:text/javascript,' + encodeURIComponent(code)), { workerData });
}

/** Matches startHorseDecisionJournal's actual production wiring, which always
 * passes `restart: createWriter` (see HorseDecisionJournal.ts), so a writer
 * the publisher's watchdog judges dead is replaced rather than left
 * permanently failed - the same resilience a real deployment has. */
function spawnShardWriter(
  dir: string,
  index: number
): { publisher: HorseDecisionJournalPublisher; notes: string[] } {
  const archive = runtimeHorseJournalArchiveOptions(dir, {}, { index });
  const create = (): HorseJournalWorker => {
    const worker = spawnJournalWorker({ directory: dir, archive });
    workers.push(worker);
    return worker as unknown as HorseJournalWorker;
  };
  const notes: string[] = [];
  const publisher = new HorseDecisionJournalPublisher(create(), (note) => notes.push(note), {
    restart: create,
  });
  return { publisher, notes };
}

const RECORDS_PER_SHARD = 24;

describe('legacy database bootstrap on a brand-new shared directory', () => {
  it.each([0, 1, 2, 3, 4, 5])(
    'never fails either shard when two writers construct concurrently against a fresh directory (trial %i)',
    async () => {
      const dir = directory();
      // Deliberately NO pre-bootstrap here: this is exactly the fresh,
      // never-before-written directory the race required.
      const a = spawnShardWriter(dir, 0);
      const b = spawnShardWriter(dir, 1);

      for (let i = 0; i < RECORDS_PER_SHARD; i++) {
        a.publisher.record('decision', `cold-a-hand-${i}`, `cold-a-turn-${i}`, { i });
        b.publisher.record('decision', `cold-b-hand-${i}`, `cold-b-turn-${i}`, { i });
      }

      await Promise.all([a.publisher.stop(), b.publisher.stop()]);

      const count = (notes: string[], key: string) => notes.filter((n) => n === key).length;
      for (const [name, { publisher, notes }] of [
        ['shard-a', a],
        ['shard-b', b],
      ] as const) {
        expect(count(notes, 'phase15_journal_enqueued'), `${name} enqueued`).toBe(
          RECORDS_PER_SHARD
        );
        expect(count(notes, 'phase15_journal_capture_unavailable'), `${name} capture_unavailable`).toBe(
          0
        );
        expect(publisher.health().mode, `${name} final mode`).toBe('stopped');
        expect(publisher.health().lastFailureReason, `${name} last failure reason`).toBeNull();
        expect(publisher.health().queued, `${name} left queued at stop`).toBe(0);
      }
    },
    15000
  );
});
