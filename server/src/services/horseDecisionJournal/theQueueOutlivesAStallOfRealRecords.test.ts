/* THE QUEUE IS SIZED FOR THE RECORDS THE FLEET REALLY WRITES (2026-09-29).
 *
 * The bound that #5541 raised was "4,096 records / 16 MiB", justified as "a few
 * hundred bytes a decision". A decision record is about 9,000 bytes: 8,853 and
 * 9,146 decoded bytes per record in the two live archives on fa480b9b. 16 MiB
 * is therefore about 1,800 records, the count bound never applied, and the byte
 * bound held about fifteen seconds of a shard's traffic. The throughput test
 * beside it (theJournalKeepsUpWithTheFleet) fires `{ tag, i }` payloads of a
 * hundred bytes, so it could not see any of this: it passed on a journal that
 * went on to refuse 8% and 18% of every minute at queue_capacity.
 *
 * This test uses records of the measured size. The writer is a stalled fake
 * (it acknowledges nothing), which is what a lock-retry ladder, a writer
 * restart or the burst at the end of a maintenance break looks like to the
 * queue in front of it. About a minute of the measured 120 records a second
 * offered to a shard (7,200 records) must fit; a queue that fits fifteen seconds
 * fails it. Red on 16 MiB, green on 64 MiB. */
import { describe, expect, it } from 'vitest';
import {
  HORSE_JOURNAL_QUEUE_MAX_BYTES,
  HORSE_JOURNAL_QUEUE_MAX_RECORDS,
  HorseDecisionJournalPublisher,
  type HorseJournalWorker,
} from '../HorseDecisionJournal.js';

class StalledWriter implements HorseJournalWorker {
  sent = 0;
  postMessage() {
    this.sent++;
  }
  on() {
    return this;
  }
  terminate = async () => 0;
}

/** A body of about 9 KB after canonical serialisation. */
const decisionPayload = (n: number) => ({
  schema: 'decision',
  n,
  cells: Array.from({ length: 90 }, (_, i) => ({
    id: `cell-${i}`,
    action: ['fold', 'call', 'raise'][i % 3],
    freq: (i * 37 + n) / 1000,
    ev: (i * 91 + n) / 100,
    flags: [i % 2 === 0, i % 3 === 0],
  })),
});

describe('the journal queue outlives a stall of real-sized records', () => {
  it('holds about a minute of the offered rate without shedding a decision', () => {
    const notes: string[] = [];
    const publisher = new HorseDecisionJournalPublisher(new StalledWriter(), (n) => notes.push(n));
    const OFFERED_PER_SECOND = 120;
    const SECONDS = 60;
    for (let i = 0; i < OFFERED_PER_SECOND * SECONDS; i++)
      publisher.record('decision', `hand-${i}`, `turn-${i}`, decisionPayload(i));
    const count = (key: string) => notes.filter((n) => n === key).length;
    expect(count('phase15_journal_enqueued')).toBe(OFFERED_PER_SECOND * SECONDS);
    expect(count('phase15_journal_queue_capacity')).toBe(0);
    expect(publisher.health().queued).toBe(OFFERED_PER_SECOND * SECONDS);
  });

  it('is bounded in bytes and in records, and refuses past either by name', () => {
    expect(HORSE_JOURNAL_QUEUE_MAX_BYTES).toBeGreaterThanOrEqual(64 * 1024 * 1024);
    // 64 MiB of about-9 KB records is about 7,000; the count bound sits above it.
    expect(HORSE_JOURNAL_QUEUE_MAX_RECORDS).toBeGreaterThan(7_000);
    const notes: string[] = [];
    const publisher = new HorseDecisionJournalPublisher(new StalledWriter(), (n) => notes.push(n));
    let offered = 0;
    while (!notes.includes('phase15_journal_queue_capacity') && offered < 20_000) {
      publisher.record('decision', `hand-${offered}`, `turn-${offered}`, decisionPayload(offered));
      offered++;
    }
    expect(notes).toContain('phase15_journal_queue_capacity');
    // It refuses only once the bound is really reached: never below a minute.
    expect(offered).toBeGreaterThan(7_000);
    // And it stays bounded: the queue never holds more than the record bound.
    expect(publisher.health().queued).toBeLessThanOrEqual(HORSE_JOURNAL_QUEUE_MAX_RECORDS);
  });
});
