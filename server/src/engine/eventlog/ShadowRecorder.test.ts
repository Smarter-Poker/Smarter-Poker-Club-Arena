import { describe, it, expect, vi } from 'vitest';
import { ShadowRecorder, type EngineFinalState } from './ShadowRecorder.js';
import { EventLog, InMemoryEventSink, SupabaseEventSink } from './EventLog.js';

/** Drive a recorder through the same example hand as testFixtures. */
function recordExampleHand(rec: ShadowRecorder): void {
  rec.recordHandStarted({
    seed: 424242,
    handNumber: 1,
    buttonSeat: 1,
    players: [
      { seat: 1, userId: 'u1', stack: 1000 },
      { seat: 2, userId: 'u2', stack: 1000 },
      { seat: 3, userId: 'u3', stack: 1000 },
    ],
    stakes: { smallBlind: 5, bigBlind: 10 },
  });
  rec.recordBlindsPosted([
    { seat: 2, kind: 'small_blind', amount: 5 },
    { seat: 3, kind: 'big_blind', amount: 10 },
  ]);
  rec.recordHoleCardsDealt(2, [
    {
      seat: 1,
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
    },
    {
      seat: 2,
      cards: [
        { rank: '7', suit: 'hearts' },
        { rank: '2', suit: 'clubs' },
      ],
    },
    {
      seat: 3,
      cards: [
        { rank: 'Q', suit: 'diamonds' },
        { rank: 'Q', suit: 'clubs' },
      ],
    },
  ]);
  rec.recordPlayerActed(1, 'raise', 30);
  rec.recordPlayerActed(2, 'fold', 0);
  rec.recordPlayerActed(3, 'call', 0);
  rec.recordStreetAdvanced('flop', [
    { rank: 'A', suit: 'hearts' },
    { rank: 'Q', suit: 'spades' },
    { rank: '2', suit: 'diamonds' },
  ]);
  rec.recordPlayerActed(3, 'check', 0);
  rec.recordPlayerActed(1, 'bet', 40);
  rec.recordPlayerActed(3, 'call', 0);
  rec.recordStreetAdvanced('turn', [
    { rank: 'A', suit: 'hearts' },
    { rank: 'Q', suit: 'spades' },
    { rank: '2', suit: 'diamonds' },
    { rank: '9', suit: 'clubs' },
  ]);
  rec.recordPlayerActed(3, 'check', 0);
  rec.recordPlayerActed(1, 'check', 0);
  rec.recordStreetAdvanced('river', [
    { rank: 'A', suit: 'hearts' },
    { rank: 'Q', suit: 'spades' },
    { rank: '2', suit: 'diamonds' },
    { rank: '9', suit: 'clubs' },
    { rank: '5', suit: 'hearts' },
  ]);
  rec.recordPlayerActed(3, 'check', 0);
  rec.recordPlayerActed(1, 'bet', 100);
  rec.recordPlayerActed(3, 'call', 0);
  rec.recordShowdownRevealed([
    {
      seat: 1,
      userId: 'u1',
      cards: [
        { rank: 'A', suit: 'spades' },
        { rank: 'K', suit: 'spades' },
      ],
    },
    {
      seat: 3,
      userId: 'u3',
      cards: [
        { rank: 'Q', suit: 'diamonds' },
        { rank: 'Q', suit: 'clubs' },
      ],
    },
  ]);
  rec.recordPotAwarded([{ seat: 1, userId: 'u1', amount: 340, potIndex: 0 }], 5);
  rec.recordHandEnded(1);
}

const ACTUAL_MATCH: EngineFinalState = {
  seats: [
    { seat: 1, userId: 'u1', stack: 1170 },
    { seat: 2, userId: 'u2', stack: 995 },
    { seat: 3, userId: 'u3', stack: 830 },
  ],
  pot: 0,
};

describe('ShadowRecorder - records + replays + verifies', () => {
  it('reports NO divergence when the replay matches the engine', () => {
    const sink = new InMemoryEventSink();
    const log = new EventLog(sink);
    let clock = 1000;
    const rec = new ShadowRecorder('hand-shadow-1', { log, now: () => clock++ });

    recordExampleHand(rec);
    expect(rec.events()).toHaveLength(20);

    const report = rec.finalize(ACTUAL_MATCH);
    expect(report.ok).toBe(true);
    expect(report.seatDivergences).toHaveLength(0);
    expect(report.potDivergence).toBeUndefined();
    expect(report.conservation.ok).toBe(true);
    // Events also flowed to the durable sink.
    expect(sink.events).toHaveLength(20);
    // Timestamps were stamped by the injected clock (not Date.now).
    expect(rec.events()[0].ts).toBe(1000);
  });

  it('detects a divergence when the engine final stacks disagree', () => {
    const onDivergence = vi.fn();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const rec = new ShadowRecorder('hand-shadow-2', { onDivergence, logger });
    recordExampleHand(rec);

    const wrong: EngineFinalState = {
      seats: [
        { seat: 1, userId: 'u1', stack: 9999 }, // engine says something else
        { seat: 2, userId: 'u2', stack: 995 },
        { seat: 3, userId: 'u3', stack: 830 },
      ],
    };
    const report = rec.finalize(wrong);
    expect(report.ok).toBe(false);
    expect(report.seatDivergences.map((d) => d.seat)).toContain(1);
    expect(report.seatDivergences[0].diff).toBeCloseTo(1170 - 9999, 6);
    expect(onDivergence).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('never throws into the caller even if recording is bogus', () => {
    const rec = new ShadowRecorder('hand-shadow-3', { logger: { warn: vi.fn(), error: vi.fn() } });
    // Only a partial stream; finalize must still return a report, not throw.
    rec.recordHandStarted({
      seed: 1,
      handNumber: 9,
      buttonSeat: 1,
      players: [{ seat: 1, userId: 'u1', stack: 100 }],
      stakes: { smallBlind: 1, bigBlind: 2 },
    });
    expect(() => rec.finalize({ seats: [{ seat: 1, userId: 'u1', stack: 100 }] })).not.toThrow();
  });
});

describe('EventLog - append-only + durable sink', () => {
  it('enforces monotonic seq per hand', () => {
    const log = new EventLog();
    log.append({ type: 'HandEnded', handNumber: 1, handId: 'h', seq: 0, ts: 1, v: 1 });
    expect(() =>
      log.append({ type: 'HandEnded', handNumber: 1, handId: 'h', seq: 0, ts: 2, v: 1 })
    ).toThrow(/monotonic/);
  });

  it('SupabaseEventSink batches inserts into hand_events', async () => {
    const inserted: unknown[][] = [];
    const client = {
      from: (_t: string) => ({
        insert: async (rows: unknown[]) => {
          inserted.push(rows);
          return { error: null };
        },
      }),
    };
    const sink = new SupabaseEventSink(client, { batchSize: 2 });
    await sink.append([
      { type: 'HandEnded', handNumber: 1, handId: 'h', seq: 0, ts: 1, v: 1 },
      { type: 'HandEnded', handNumber: 1, handId: 'h', seq: 1, ts: 2, v: 1 },
      { type: 'HandEnded', handNumber: 1, handId: 'h', seq: 2, ts: 3, v: 1 },
    ]);
    await sink.flush();
    // First full batch of 2 flushed during append, remainder on flush.
    expect(inserted.length).toBe(2);
    expect(inserted[0]).toHaveLength(2);
    expect(inserted[1]).toHaveLength(1);
    expect((inserted[0][0] as { event_type: string }).event_type).toBe('HandEnded');
  });
});
