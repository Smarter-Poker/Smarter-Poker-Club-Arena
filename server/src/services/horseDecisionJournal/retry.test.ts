import { afterEach, describe, expect, it, vi } from 'vitest';
import { HorseDecisionJournalPublisher, type HorseJournalWorker } from '../HorseDecisionJournal.js';
import { horseJournalFailureKind } from './failure.js';
import type { HorseJournalRecord } from './record.js';

class Writer implements HorseJournalWorker {
  sent: Array<Parameters<HorseJournalWorker['postMessage']>[0]> = [];
  listeners = new Map<string, (message: any) => void>();
  terminate = vi.fn(async () => 0);
  on(event: string, callback: (message: any) => void) {
    this.listeners.set(event, callback);
  }
  postMessage(message: Parameters<HorseJournalWorker['postMessage']>[0]) {
    this.sent.push(message);
  }
  emit(message: any) {
    this.listeners.get('message')?.(message);
  }
  exit() {
    this.listeners.get('exit')?.(1);
  }
  batch() {
    return (
      this.sent
        .slice()
        .reverse()
        .find((x) => x.type === 'APPEND') as { records: HorseJournalRecord[] }
    ).records;
  }
  ack(status: 'recorded' | 'replayed' = 'recorded') {
    this.emit({
      type: 'ACK',
      receipts: this.batch().map((r) => ({ eventId: r.eventId, sha256: r.sha256, status })),
    });
  }
}
const tick = async (ms: number) => {
  await vi.advanceTimersByTimeAsync(ms);
};
afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers();
  const a = new Writer(),
    b = new Writer(),
    c = new Writer(),
    writers = [b, c],
    notes: string[] = [];
  const restart = vi.fn(() => writers.shift()!);
  const p = new HorseDecisionJournalPublisher(a, (x) => notes.push(x), {
    restart,
    now: () => Date.now(),
  });
  p.record('decision', 'hand', 'turn', { value: 1 });
  a.emit({ type: 'READY' });
  return { a, b, c, p, notes, restart };
}
describe('bounded private Horse journal retry ownership', () => {
  it('rejects an oversized encoded envelope without poisoning subsequent capture', async () => {
    const a = new Writer(),
      notes: string[] = [];
    const p = new HorseDecisionJournalPublisher(a, (x) => notes.push(x));
    p.record('decision', 'hand', 'turn', { value: '"'.repeat(200000) });
    p.record('decision', 'hand', 'turn', { value: 1 });
    a.emit({ type: 'READY' });
    expect(notes.filter((n) => n === 'phase15_journal_capture_unavailable')).toHaveLength(1);
    expect(a.batch()).toHaveLength(1);
    expect(a.batch()[0]!.sequence).toBe(2);
    a.ack();
    const stop = p.stop();
    a.emit({ type: 'STOPPED' });
    await stop;
    expect(notes).not.toContain('phase15_journal_unavailable');
  });
  it('retains exact identities/bytes after lost ACK and ignores retired-writer messages', async () => {
    const { a, b, p, notes, restart } = fixture(),
      original = structuredClone(a.batch());
    let terminated!: (value: number) => void;
    a.terminate.mockImplementation(
      () =>
        new Promise((resolve) => {
          terminated = resolve;
        })
    );
    a.exit();
    p.record('execution', 'hand', 'turn', { value: 2 });
    await tick(250);
    expect(restart).not.toHaveBeenCalled();
    terminated(0);
    await tick(250);
    expect(restart).toHaveBeenCalledOnce();
    b.emit({ type: 'READY' });
    expect(b.batch()[0]).toEqual(original[0]);
    expect(b.batch()).toHaveLength(2);
    expect(b.batch()[0]!.producerId).toBe(b.batch()[1]!.producerId);
    expect(b.batch()[1]!.sequence).toBe(original[0]!.sequence + 1);
    a.ack();
    a.emit({ type: 'UNAVAILABLE' });
    a.exit();
    expect(notes).not.toContain('phase15_journal_recorded');
    b.ack('replayed');
    expect(notes.filter((n) => n === 'phase15_journal_replayed')).toHaveLength(2);
    expect(notes.filter((n) => n === 'phase15_journal_retry_recovered')).toHaveLength(1);
    const stop = p.stop();
    b.emit({ type: 'STOPPED' });
    await stop;
    expect(notes).not.toContain('phase15_journal_unavailable');
    expect(p.stop()).toBe(stop);
  });
  it('bounds the queue while a writer is recovering', async () => {
    const { a, b, p, notes } = fixture();
    a.emit({ type: 'RETRYABLE' });
    for (let i = 0; i < 64; i++) p.record('decision', 'hand', 'turn', {});
    expect(notes.filter((n) => n === 'phase15_journal_enqueued')).toHaveLength(64);
    expect(notes).toContain('phase15_journal_queue_capacity');
    await tick(250);
    b.emit({ type: 'READY' });
    b.emit({ type: 'UNAVAILABLE' });
    await p.stop();
  });
  it('allows at most two replacement workers even when each reports a transient lock', async () => {
    const { a, b, c, p, notes, restart } = fixture();
    a.emit({ type: 'RETRYABLE' });
    await tick(250);
    b.emit({ type: 'READY' });
    b.emit({ type: 'RETRYABLE' });
    await tick(999);
    expect(restart).toHaveBeenCalledTimes(1);
    await tick(1);
    c.emit({ type: 'READY' });
    c.emit({ type: 'RETRYABLE' });
    await tick(10000);
    expect(restart).toHaveBeenCalledTimes(2);
    expect(notes).toContain('phase15_journal_retry_exhausted');
    expect(notes).not.toContain('phase15_journal_recorded');
    await p.stop();
    expect(notes).toContain('phase15_journal_shutdown_unverified');
  });
  it.each(['wrong_ack', 'permanent_failure', 'premature_stopped'])(
    'does not retry %s as a recoverable lock',
    async (reason) => {
      const { a, p, notes, restart } = fixture();
      a.emit(
        reason === 'wrong_ack'
          ? { type: 'ACK', receipts: [{ eventId: 'wrong', sha256: 'wrong', status: 'recorded' }] }
          : reason === 'permanent_failure'
            ? { type: 'UNAVAILABLE' }
            : { type: 'STOPPED' }
      );
      await tick(5000);
      expect(restart).not.toHaveBeenCalled();
      expect(notes).toContain('phase15_journal_unavailable');
      await p.stop();
    }
  );
  it.each(['never', 'reject', 'throw'])(
    'refuses overlap when termination does %s',
    async (mode) => {
      const { a, p, notes, restart } = fixture();
      a.terminate.mockImplementation(() =>
        mode === 'never'
          ? new Promise(() => {})
          : mode === 'reject'
            ? Promise.reject(Error('private'))
            : (() => {
                throw Error('private');
              })()
      );
      a.exit();
      await tick(1100);
      expect(restart).not.toHaveBeenCalled();
      expect(a.terminate).toHaveBeenCalledOnce();
      expect(notes.filter((n) => n === 'phase15_journal_termination_unverified')).toHaveLength(1);
      await p.stop();
    }
  );
  it('fails closed when the replacement factory throws or reuses a retired writer', async () => {
    for (const reuse of [false, true]) {
      const { a, p, restart, notes } = fixture();
      restart.mockImplementation(() => {
        if (reuse) return a;
        throw Error('private path');
      });
      a.exit();
      await tick(250);
      expect(notes).toContain('phase15_journal_unavailable');
      expect(a.terminate).toHaveBeenCalledOnce();
      await p.stop();
    }
  });
  it('drains through recovery during shutdown and does not claim recovery from readiness alone', async () => {
    const { a, b, p, notes } = fixture(),
      stop = p.stop();
    a.exit();
    await tick(250);
    b.emit({ type: 'READY' });
    expect(notes).not.toContain('phase15_journal_retry_recovered');
    b.ack('replayed');
    expect(b.sent.at(-1)).toEqual({ type: 'STOP' });
    b.emit({ type: 'STOPPED' });
    await stop;
    expect(notes).not.toContain('phase15_journal_shutdown_unverified');
  });
  it('makes shutdown loss explicit if a writer exits with an unacknowledged batch', async () => {
    vi.useFakeTimers();
    const a = new Writer(),
      notes: string[] = [];
    const p = new HorseDecisionJournalPublisher(a, (x) => notes.push(x));
    p.record('decision', 'hand', 'turn', {});
    a.emit({ type: 'READY' });
    const stopping = p.stop();
    a.exit();
    await tick(0);
    await stopping;
    expect(notes).toContain('phase15_journal_shutdown_unverified');
    expect(notes).not.toContain('phase15_journal_recorded');
  });
  it('cancels delayed replacement at the bounded shutdown deadline', async () => {
    const { a, b, p, restart, notes } = fixture();
    a.emit({ type: 'RETRYABLE' });
    await tick(250);
    b.emit({ type: 'READY' });
    const stop = p.stop();
    await tick(5000);
    await stop;
    await tick(10000);
    expect(notes).toContain('phase15_journal_shutdown_unverified');
    expect(restart).toHaveBeenCalledOnce();
  });
  it('uses the monotonic deadline rather than an adjusted wall clock', async () => {
    vi.useFakeTimers();
    let monotonic = 0;
    const a = new Writer(),
      b = new Writer(),
      restart = vi.fn(() => b);
    const p = new HorseDecisionJournalPublisher(a, () => {}, { restart, now: () => monotonic });
    p.record('decision', 'hand', 'turn', {});
    a.emit({ type: 'READY' });
    vi.setSystemTime(new Date('2099-01-01'));
    await tick(6000);
    expect(restart).not.toHaveBeenCalled();
    monotonic = 6001;
    await tick(1000);
    await tick(250);
    expect(restart).toHaveBeenCalledOnce();
    b.emit({ type: 'READY' });
    b.ack('replayed');
    const stop = p.stop();
    b.emit({ type: 'STOPPED' });
    await stop;
  });
});
describe('private SQLite failure classification', () => {
  it.each([5, 6, 261, 262, 517, 773])(
    'permits a bounded retry for busy/locked code %s',
    (errcode) =>
      expect(horseJournalFailureKind({ code: 'ERR_SQLITE_ERROR', errcode })).toBe('RETRYABLE')
  );
  it.each([
    null,
    {},
    Error('SQLITE_BUSY'),
    { code: 'ERR_SQLITE_ERROR', errcode: 13 },
    { code: 'ERR_SQLITE_ERROR', errcode: 11 },
    { code: 'ERR_SQLITE_ERROR', errcode: 8 },
    { code: 'ERR_SQLITE_ERROR', errcode: 10 },
    { code: 'ERR_SQLITE_ERROR', errcode: '5' },
    { code: 'ERR_SQLITE_ERROR', errcode: -251 },
    { code: 'ERR_SQLITE_ERROR', errcode: 5.1 },
  ])('keeps permanent/unknown failure %j unavailable', (error) =>
    expect(horseJournalFailureKind(error)).toBe('UNAVAILABLE')
  );
});
