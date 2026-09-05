/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  1,000-HAND SOAK (spec 98, 99, 100, 101)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ROUND 2 2026-09-05. "There must be no linear resource leak." A leak in a
 * presentation engine is invisible for the first hour: nothing looks wrong,
 * the animation still plays, and the tab simply gets heavier until a
 * multi-tabling player's machine starts dropping frames on everything.
 *
 * So this drives a thousand hands through the real engine - turn and river,
 * three boards each, plus the interrupts a real session produces (a hand
 * abandoned mid-flip, a duplicate snapshot, a table going hidden) - and then
 * asserts that every internal map is back where it started. It counts
 * TIMERS too: the engine schedules two per presentation (completion and the
 * reveal beat), and a cancel path that forgot one of them would leak a
 * timer per hand while every other assertion passed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CardPresentationEngine } from '../../../src/presentation/cardPresentation/CardPresentationEngine';
import { noopFrameSampler } from '../../../src/presentation/cardPresentation/frameSampler';
import type {
  CardPresentationTelemetry,
  ResolveProfileInput,
} from '../../../src/presentation/cardPresentation/types';

const HANDS = 1000;
const BOARDS = 3;

const focused: ResolveProfileInput = {
  mode: 'cash',
  platform: 'desktop',
  focus: 'focused',
  reducedMotion: false,
  allIn: false,
};

/** Live setTimeout handles, so a forgotten clearTimeout is visible. */
function countLiveTimers(): number {
  return vi.getTimerCount();
}

describe('1,000 hands through the engine leak nothing', () => {
  let now = 0;
  let engine: CardPresentationEngine;
  let events: CardPresentationTelemetry[];

  beforeEach(() => {
    vi.useFakeTimers();
    now = 0;
    events = [];
    engine = new CardPresentationEngine({
      telemetry: (t) => events.push(t),
      now: () => now,
      speed: () => 1,
      frameSampler: noopFrameSampler,
      frameSampleRate: 0,
    });
  });
  afterEach(() => {
    engine.dispose();
    vi.useRealTimers();
  });

  it('every presentation completes and releases its timers', () => {
    const before = countLiveTimers();
    for (let hand = 1; hand <= HANDS; hand++) {
      for (let board = 0; board < BOARDS; board++) {
        for (const [street, slot] of [
          ['turn', 3],
          ['river', 4],
        ] as const) {
          const r = engine.presentCard(
            {
              tableId: 't',
              handId: hand,
              boardIndex: board,
              street,
              slotIndex: slot,
              sequence: slot + 1,
            },
            focused
          );
          expect(r.status).toBe('started');
          // Let it finish before the next street, as a real hand does.
          now += r.durationMs;
          vi.advanceTimersByTime(r.durationMs);
        }
      }
      expect(engine.activeCount, `hand ${hand} left something in flight`).toBe(0);
    }
    expect(countLiveTimers(), 'a timer survived the run').toBe(before);
    // Bounded registry: 6,000 presentations, never 6,000 remembered keys.
    expect(engine.processedSize).toBeLessThanOrEqual(engine.maxProcessedKeys);
    expect(engine.laneCount).toBe(0);
    expect(engine.trackedTableCount).toBe(1);
    expect(events.filter((e) => e.event === 'animation_completed')).toHaveLength(
      HANDS * BOARDS * 2
    );
  });

  it('a thousand hands abandoned MID-FLIP leak nothing either', () => {
    const before = countLiveTimers();
    for (let hand = 1; hand <= HANDS; hand++) {
      const r = engine.presentCard(
        {
          tableId: 't2',
          handId: hand,
          boardIndex: 0,
          street: 'river',
          slotIndex: 4,
          sequence: 5,
        },
        focused
      );
      expect(r.status).toBe('started');
      // Interrupted a third of the way in - the next hand starts on top.
      now += Math.round(r.durationMs / 3);
      vi.advanceTimersByTime(Math.round(r.durationMs / 3));
      engine.cancel(r.key, 'new-hand');
      expect(engine.activeCount).toBe(0);
    }
    expect(countLiveTimers(), 'a cancelled presentation left a timer').toBe(before);
    expect(engine.laneCount).toBe(0);
  });

  it('duplicates, stale hands and hidden tables cost nothing over a thousand hands', () => {
    const before = countLiveTimers();
    for (let hand = 1; hand <= HANDS; hand++) {
      const ev = {
        tableId: 't3',
        handId: hand,
        boardIndex: 0,
        street: 'river' as const,
        slotIndex: 4,
        sequence: 5,
      };
      const r = engine.presentCard(ev, focused);
      // the same snapshot again, and a hidden table, and a hand from the past
      expect(engine.presentCard(ev, focused).status).toBe('duplicate');
      expect(
        engine.presentCard({ ...ev, boardIndex: 1 }, { ...focused, focus: 'hidden' }).status
      ).toBe('instant');
      if (hand > 1) {
        // A genuinely NEW key from an OLD hand - board 2 of the previous hand
        // was never presented, so the registry cannot answer and the
        // stale-hand check is what has to reject it. Re-sending the previous
        // hand's board 0 would come back `duplicate` from the registry first,
        // which proves the registry rather than the staleness rule.
        expect(engine.presentCard({ ...ev, handId: hand - 1, boardIndex: 2 }, focused).status).toBe(
          'stale'
        );
      }
      now += r.durationMs;
      vi.advanceTimersByTime(r.durationMs);
    }
    expect(engine.activeCount).toBe(0);
    expect(countLiveTimers()).toBe(before);
    expect(engine.processedSize).toBeLessThanOrEqual(engine.maxProcessedKeys);
  });

  it('listeners are dropped on unsubscribe and on dispose', () => {
    const seen: string[] = [];
    const off = engine.subscribe((c) => seen.push(c.phase));
    const a = engine.presentCard(
      { tableId: 't4', handId: 1, boardIndex: 0, street: 'river', slotIndex: 4, sequence: 5 },
      focused
    );
    now += a.durationMs;
    vi.advanceTimersByTime(a.durationMs);
    const afterFirst = seen.length;
    expect(afterFirst).toBeGreaterThan(0);
    off();
    const b = engine.presentCard(
      { tableId: 't4', handId: 2, boardIndex: 0, street: 'river', slotIndex: 4, sequence: 5 },
      focused
    );
    now += b.durationMs;
    vi.advanceTimersByTime(b.durationMs);
    expect(seen.length).toBe(afterFirst);
    expect(engine.listenerCount).toBe(0);
  });

  it('dispose returns every counter to zero', () => {
    for (let hand = 1; hand <= 50; hand++) {
      engine.presentCard(
        { tableId: 't5', handId: hand, boardIndex: 0, street: 'river', slotIndex: 4, sequence: 5 },
        focused
      );
    }
    engine.subscribe(() => {});
    engine.dispose();
    expect(engine.activeCount).toBe(0);
    expect(engine.laneCount).toBe(0);
    expect(engine.listenerCount).toBe(0);
    expect(engine.processedSize).toBe(0);
    expect(engine.trackedTableCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
