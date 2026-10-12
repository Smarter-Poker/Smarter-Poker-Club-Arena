/* THE JOURNAL WRITER IS NOT BORN NICE (2026-09-29).
 *
 * Each Horse decision worker lowers its own thread to nice 10 at its first line
 * (workerPriority.ts) and Linux gives a new thread the priority of the thread
 * that creates it. The journal writer was created from that thread, so on
 * fa480b9b both writer threads of engine-01 ran at nice 10 (read from
 * /proc/<pid>/task/<tid>/stat): about a tenth of a core each, about a thousand
 * involuntary preemptions a second, a ceiling of about 100 records a second
 * against about 120 offered to each shard, and the difference shed at
 * queue_capacity. A thread cannot raise its own priority without CAP_SYS_NICE,
 * which the engine container lacks, so the writer has to be created BEFORE the
 * decision worker lowers itself. Three pins:
 *
 *  1. the mechanism, on real threads: what is created before the priority is
 *     lowered keeps it, and what is created after inherits it (Linux only);
 *  2. the order in the decision worker's entry file;
 *  3. the adoption: the journal's first writer is the one already created, and
 *     a writer made for a different shard is never reused.
 */
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The module mocked below replaces the ES import of node:worker_threads only;
// a CommonJS require still returns the real one, which pin 1 needs.
const RealWorker = (
  createRequire(import.meta.url)('node:worker_threads') as typeof import('node:worker_threads')
).Worker;

const spawned = vi.hoisted(() => ({
  workers: [] as Array<{ terminated: boolean; data: unknown }>,
}));
vi.mock('node:worker_threads', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:worker_threads')>();
  const { EventEmitter: Emitter } = await import('node:events');
  class MockWorker extends Emitter {
    terminated = false;
    data: unknown;
    private started = false;
    constructor(_url: unknown, options?: { workerData?: unknown }) {
      super();
      this.data = options?.workerData;
      spawned.workers.push(this);
    }
    // A real Worker queues what it says until somebody listens; a listener
    // added later still hears READY.
    override on(event: string, listener: (...args: unknown[]) => void) {
      super.on(event, listener);
      if (event === 'message' && !this.started) {
        this.started = true;
        setImmediate(() => this.emit('message', { type: 'READY' }));
      }
      return this;
    }
    postMessage(message: { type: string }) {
      if (message.type === 'STOP') setImmediate(() => this.emit('message', { type: 'STOPPED' }));
    }
    async terminate() {
      this.terminated = true;
      return 0;
    }
    unref() {}
  }
  return { ...actual, Worker: MockWorker };
});

const { prespawnHorseDecisionJournalWriter, startHorseDecisionJournal, stopHorseDecisionJournal } =
  await import('../../services/HorseDecisionJournal.js');

describe('pin 1: a thread keeps the priority it was created with (Linux)', () => {
  it.skipIf(process.platform !== 'linux')(
    "a thread created before its parent is lowered keeps the parent's old priority",
    async () => {
      // Real threads and the real kernel, no mocks: the property the fix
      // depends on. `parent` creates `before`, lowers itself to nice 10, then
      // creates `after`. Each child reports its own thread's nice.
      const scratch = mkdtempSync(join(tmpdir(), 'horse-nice-'));
      try {
        writeFileSync(
          join(scratch, 'child.cjs'),
          `const { parentPort } = require('node:worker_threads');
           const os = require('node:os'); const fs = require('node:fs');
           const tid = Number(/task\\/(\\d+)$/.exec(fs.readlinkSync('/proc/thread-self'))[1]);
           parentPort.postMessage(os.getPriority(tid));`
        );
        writeFileSync(
          join(scratch, 'parent.cjs'),
          `const { Worker, parentPort } = require('node:worker_threads');
           const os = require('node:os'); const fs = require('node:fs'); const path = require('node:path');
           const tid = () => Number(/task\\/(\\d+)$/.exec(fs.readlinkSync('/proc/thread-self'))[1]);
           const child = () => new Promise((resolve) => {
             const w = new Worker(path.join(__dirname, 'child.cjs'));
             w.once('message', resolve);
           });
           (async () => {
             const start = os.getPriority(tid());
             const before = await child();
             os.setPriority(tid(), Math.max(start, 10));
             const after = await child();
             parentPort.postMessage({ start, before, after, self: os.getPriority(tid()) });
           })();`
        );
        const result = await new Promise<{
          start: number;
          before: number;
          after: number;
          self: number;
        }>((resolve, reject) => {
          const worker = new RealWorker(join(scratch, 'parent.cjs'));
          worker.once('message', resolve);
          worker.once('error', reject);
        });
        expect(result.self).toBe(Math.max(result.start, 10));
        expect(result.before).toBe(result.start);
        expect(result.after).toBe(result.self);
        expect(result.before).toBeLessThan(result.after);
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
    20_000
  );
});

describe('pin 2: the decision worker creates the writer before it lowers itself', () => {
  it('calls prespawnHorseDecisionJournalWriter ahead of lowerDecisionWorkerPriority', () => {
    const source = readFileSync(new URL('./worker.ts', import.meta.url), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    const prespawn = code.indexOf('prespawnHorseDecisionJournalWriter(shard)');
    const lower = code.indexOf('lowerDecisionWorkerPriority()');
    expect(prespawn).toBeGreaterThan(-1);
    expect(lower).toBeGreaterThan(-1);
    expect(prespawn).toBeLessThan(lower);
  });
});

describe('pin 3: the journal adopts the writer that was created for it', () => {
  let dir = '';
  const saved = process.env.HORSE_DECISION_JOURNAL_DIR;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'horse-journal-nice-'));
    process.env.HORSE_DECISION_JOURNAL_DIR = dir;
    spawned.workers.length = 0;
  });
  afterEach(async () => {
    await stopHorseDecisionJournal();
    if (saved === undefined) delete process.env.HORSE_DECISION_JOURNAL_DIR;
    else process.env.HORSE_DECISION_JOURNAL_DIR = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates exactly one writer when it was prespawned for the same shard', () => {
    prespawnHorseDecisionJournalWriter({ index: 1 });
    expect(spawned.workers).toHaveLength(1);
    startHorseDecisionJournal({ index: 1 });
    // Adopted, not created again: the second writer would be born nice.
    expect(spawned.workers).toHaveLength(1);
    expect(spawned.workers[0]!.terminated).toBe(false);
  });

  it('creates its own writer when nothing was prespawned', () => {
    startHorseDecisionJournal({ index: 0 });
    expect(spawned.workers).toHaveLength(1);
  });

  it('never reuses a writer that was created for another shard', () => {
    prespawnHorseDecisionJournalWriter({ index: 0 });
    startHorseDecisionJournal({ index: 1 });
    expect(spawned.workers).toHaveLength(2);
    expect(spawned.workers[0]!.terminated).toBe(true);
    expect(spawned.workers[1]!.terminated).toBe(false);
  });

  it('does nothing without a journal directory', () => {
    delete process.env.HORSE_DECISION_JOURNAL_DIR;
    prespawnHorseDecisionJournalWriter({ index: 0 });
    expect(spawned.workers).toHaveLength(0);
  });

  it('a writer that dies before it is adopted does not take the thread down', () => {
    prespawnHorseDecisionJournalWriter({ index: 0 });
    // No listener is attached yet apart from the guard: an unhandled 'error'
    // event on a real Worker would throw in the decision worker.
    expect(() =>
      (spawned.workers[0] as unknown as EventEmitter).emit('error', new Error('x'))
    ).not.toThrow();
  });
});
