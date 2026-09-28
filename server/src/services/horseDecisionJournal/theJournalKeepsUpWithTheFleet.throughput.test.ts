/* THE JOURNAL KEEPS UP WITH THE FLEET (2026-09-28). On the serving release
 * (763e4cec), both Horse decision-shard writers opened the SAME shared SQLite
 * catalog (runtimeHorseJournalArchiveOptions resolved every shard to
 * 'archive' regardless of index): SQLite allows one writer per file, so a
 * shard's `BEGIN IMMEDIATE` routinely found the other shard's commit already
 * holding the write lock, and at the archive's steady-state byte ceiling -
 * where every append also retires a segment inside that same transaction -
 * the loser paid a 250ms busy wait plus the lock-retry ladder before its
 * batch was retried, long enough to overflow the publisher's bounded queue.
 * Per `horse_brain_flush_receipts`, 20-40% of decisions were shed at
 * queue_capacity at peak (e.g. 14:15Z: enqueued 92,691, queue_capacity
 * 60,237, lock_retry 424).
 *
 * This test drives the REAL production pieces - the real writer worker
 * module (worker.ts) in real OS worker threads, the real publisher class,
 * and the real runtimeHorseJournalArchiveOptions this change edited - through
 * two concurrent decision-shard writers submitting a representative burst
 * each, and asserts the outcome the task names directly: queue_capacity
 * drops at ~0, with the specific root-cause signal (phase15_journal_lock_retry,
 * fired only when a shard's writer meets SQLITE_BUSY) also at 0, since each
 * shard's writer now owns its own catalog file and cannot contend with its
 * sibling at all. On main (where runtimeHorseJournalArchiveOptions ignores a
 * shard argument and always resolves 'archive', and the queue bound is a
 * flat 64 records) this same test fails: both shards' writers open the
 * identical catalog file, and 320 decisions per shard enqueued back to back
 * overflow that queue long before contended drainage - measured separately at
 * 1,368 rec/s shared vs 2,204 rec/s sharded, 0 lock retries either way once
 * sharded, 9 in a 4-second shared run of the same fixture - can clear it.
 *
 * The fixture pre-creates the legacy `horse-decisions.sqlite` (and opens
 * shard 0 once) before starting the two shards concurrently, matching the
 * actual production host this ships onto: it has carried that file, and
 * shard 0's archive, for weeks. A brand-new, never-before-bootstrapped
 * directory has its own narrow concurrent-first-boot race, fixed separately
 * in store.ts's bootstrapLegacyJournalOnce and pinned by
 * legacyBootstrapIsRaceFree.test.ts; this file is about steady-state
 * throughput on an already-warm host, not cold start. */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { HorseDecisionJournalPublisher, type HorseJournalWorker } from '../HorseDecisionJournal.js';
import { runtimeHorseJournalArchiveOptions } from './config.js';
import { HorseDecisionJournalStore } from './store.js';

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
  const d = mkdtempSync(join(tmpdir(), 'horse-journal-throughput-'));
  dirs.push(d);
  return d;
};

const workerEntry = new URL(
  import.meta.url.endsWith('.ts') ? './worker.ts' : './worker.js',
  import.meta.url
);

function spawnShardWriter(
  dir: string,
  index: number
): { publisher: HorseDecisionJournalPublisher; notes: string[] } {
  const archive = runtimeHorseJournalArchiveOptions(dir, {}, { index });
  const worker = new Worker(workerEntry, { workerData: { directory: dir, archive } });
  workers.push(worker);
  const notes: string[] = [];
  const publisher = new HorseDecisionJournalPublisher(
    worker as unknown as HorseJournalWorker,
    (note) => notes.push(note)
  );
  return { publisher, notes };
}

/** ~2x the measured per-shard peak (see HORSE_JOURNAL_QUEUE_MAX_RECORDS's
 * derivation comment), scaled down from a 15-minute window to a single burst
 * so the test runs in seconds rather than minutes. Both queue bounds (main's
 * 64, this branch's 4096) see every one of these submitted before the first
 * ACK can possibly return, so the outcome turns on whether the two shards'
 * writers actually contend for one file - the fix this test exists to pin -
 * not on submission pacing. */
const RECORDS_PER_SHARD = 320;

function fireDecisions(publisher: HorseDecisionJournalPublisher, tag: string, count: number): void {
  for (let i = 0; i < count; i++) {
    publisher.record('decision', `${tag}-hand-${i}`, `${tag}-turn-${i}`, { tag, i });
  }
}

describe('the journal keeps up with the fleet', () => {
  it(
    'sheds ~0 decisions at queue_capacity, with 0 lock retries, once each shard owns its own catalog',
    async () => {
      const dir = directory();
      // Match the already-warm production host: the legacy database and
      // shard 0's archive already exist before a second shard ever starts.
      const bootstrap = new HorseDecisionJournalStore(dir, {
        archive: runtimeHorseJournalArchiveOptions(dir, {}, { index: 0 }),
      });
      bootstrap.close();

      const a = spawnShardWriter(dir, 0);
      const b = spawnShardWriter(dir, 1);

      fireDecisions(a.publisher, 'shard-a', RECORDS_PER_SHARD);
      fireDecisions(b.publisher, 'shard-b', RECORDS_PER_SHARD);

      // stop() drains whatever remains queued (each ACK re-dispatches the
      // next batch) before it actually asks the writer to stop, so this both
      // waits out the whole burst and gives a definite end to wait for.
      await Promise.all([a.publisher.stop(), b.publisher.stop()]);

      const count = (notes: string[], key: string) => notes.filter((n) => n === key).length;
      for (const [name, { publisher, notes }] of [
        ['shard-a', a],
        ['shard-b', b],
      ] as const) {
        expect(count(notes, 'phase15_journal_enqueued'), `${name} enqueued`).toBe(
          RECORDS_PER_SHARD
        );
        expect(count(notes, 'phase15_journal_queue_capacity'), `${name} queue_capacity drops`).toBe(
          0
        );
        expect(count(notes, 'phase15_journal_lock_retry'), `${name} lock retries`).toBe(0);
        expect(count(notes, 'phase15_journal_capture_unavailable'), `${name} capture_unavailable`).toBe(
          0
        );
        expect(publisher.health().mode, `${name} final mode`).toBe('stopped');
        expect(publisher.health().queued, `${name} left queued at stop`).toBe(0);
      }
    },
    20000
  );
});
