import { describe, it, expect, vi } from 'vitest';
import { runJournalLoop, CAPTURE_BACK_TO_BACK_PAUSE_MS } from './loop.js';
import type { ObservationCaptureResult } from '../HorseObservationCapture.js';
import type { AdaptiveJournalWorkResult } from '../HorseAdaptiveJournalWork.js';

/**
 * HORSE CAPTURE DRAINS IN ORDER (2026-10-25). With the journal queue empty,
 * production ran one capture slice, a 1 s pause, a journal turn and another
 * pause, about 17 s a capture. While the journal has no work of its own,
 * capture slices now run back to back; the fairness pause stays for a real
 * journal backlog.
 */
const empty = () => ({ status: 'pruned' as const, completedWork: 0, batches: 0, observations: 0 });
const KEY = 'b'.repeat(64);

type Script = {
  capture: () => ObservationCaptureResult;
  journal: (calls: number) => AdaptiveJournalWorkResult;
  turns: number;
};
async function drive(s: Script) {
  const stop = new AbortController();
  const events: string[] = [];
  const waits: number[] = [];
  let now = 0,
    journal = 0,
    busy = false;
  const operation = async () => {
    expect(busy).toBe(false);
    busy = true;
    await Promise.resolve();
    busy = false;
  };
  await runJournalLoop(stop.signal, {
    processWork: async () => {
      await operation();
      events.push('journal');
      return s.journal(++journal);
    },
    processCapture: async () => {
      await operation();
      events.push('capture');
      now += 300; // a measured slice read
      return s.capture();
    },
    prune: async () => empty(),
    now: () => now,
    started: vi.fn(),
    completed: vi.fn(),
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
      if (waits.length === s.turns) stop.abort();
    },
  });
  return { events, waits, now };
}

describe('capture runs back to back while the journal is idle', () => {
  it('pauses zero between slices of a draining request when the journal has nothing of its own', async () => {
    let n = 0;
    const r = await drive({
      capture: () => ({ status: ++n % 4 === 0 ? 'captured' : 'continued', requestKey: KEY }),
      // Each capture hands the journal exactly one batch: completed, then idle.
      journal: () => ({ status: 'idle' }),
      turns: 40,
    });
    expect(CAPTURE_BACK_TO_BACK_PAUSE_MS).toBe(0);
    const captures = r.events.filter((e) => e === 'capture').length;
    // After the first journal turn every other cycle is a capture: no pause
    // and no journal turn in between other than the one that finds nothing.
    expect(captures).toBeGreaterThanOrEqual(19);
    expect(r.waits.slice(1).every((w) => w === 0)).toBe(true);
    // 20 slices in seconds of read time, not 20 x ~2 s of pauses.
    expect(r.now).toBeLessThan(1000 + captures * 300 + 1);
  });

  it('records the batch a capture produced on the next turn, then captures again without a pause', async () => {
    let produced = false;
    const r = await drive({
      capture: () => {
        produced = true;
        return { status: 'continued', requestKey: KEY };
      },
      journal: () => {
        if (produced) {
          produced = false;
          return { status: 'completed', batchKey: 'a'.repeat(64) };
        }
        return { status: 'idle' };
      },
      turns: 30,
    });
    // journal(idle), then per slice: capture, journal(its batch), journal
    // (finds nothing of its own), capture again. No pause anywhere after the
    // first idle turn.
    expect(r.events.slice(0, 8)).toEqual([
      'journal',
      'capture',
      'journal',
      'journal',
      'capture',
      'journal',
      'journal',
      'capture',
    ]);
    expect(r.waits.slice(1).every((w) => w === 0)).toBe(true);
  });

  it('keeps the fairness pause and the eight-turn rule while the journal has a backlog of its own', async () => {
    const r = await drive({
      capture: () => ({ status: 'continued', requestKey: KEY }),
      journal: () => ({ status: 'completed', batchKey: 'a'.repeat(64) }),
      turns: 40,
    });
    const captures = r.events.filter((e) => e === 'capture').length;
    const journals = r.events.filter((e) => e === 'journal').length;
    // A real backlog is never starved: at most one capture per eight turns,
    // plus the one zero-pause recheck after the batch each capture produced.
    expect(captures).toBeGreaterThan(0);
    expect(journals).toBeGreaterThanOrEqual(captures * 8);
    expect(r.waits.filter((w) => w === 1000).length).toBeGreaterThan(r.waits.length / 2);
  });

  it('pauses again once capture has nothing left, and backs off on a failed capture', async () => {
    let n = 0;
    const r = await drive({
      capture: () =>
        ++n <= 3
          ? { status: 'continued', requestKey: KEY }
          : n === 4
            ? { status: 'idle' }
            : { status: 'deferred', requestKey: KEY },
      journal: () => ({ status: 'idle' }),
      turns: 30,
    });
    // journal(idle) pauses 1 s; then three progressing slices, each followed
    // by an idle journal turn, run with zero pause; the idle capture brings
    // back the 5 s idle pause, and failures keep their own backoff deadline
    // while the journal pauses 1 s between its own turns.
    expect(r.events.slice(0, 8)).toEqual([
      'journal',
      'capture',
      'journal',
      'capture',
      'journal',
      'capture',
      'journal',
      'capture',
    ]);
    expect(r.waits.slice(0, 8)).toEqual([1000, 0, 0, 0, 0, 0, 0, 5000]);
    expect(r.waits.slice(8).every((w) => w > 0)).toBe(true);
    expect(Math.max(...r.waits)).toBeLessThanOrEqual(5000);
  });

  it('still runs a due commitment-audit step and yields to the event loop between back-to-back captures', async () => {
    const stop = new AbortController();
    let now = 0,
      audits = 0,
      yields = 0;
    await runJournalLoop(stop.signal, {
      processWork: async () => ({ status: 'idle' }),
      processCapture: async () => {
        now += 300;
        return { status: 'continued', requestKey: KEY };
      },
      processCommitments: async () => {
        audits++;
        return {
          status: 'recorded',
          scanned: 256,
          committed: 0,
          day: '2026-10-24',
          cursorHandId: null,
        } as never;
      },
      prune: async () => empty(),
      now: () => now,
      started: vi.fn(),
      completed: vi.fn(),
      wait: async (ms) => {
        if (ms === 0) yields++;
        now += ms;
        if (now >= 60000) stop.abort();
      },
    });
    expect(yields).toBeGreaterThan(50);
    // Backlog cadence of the audit (5 s) holds while captures run back to back.
    expect(audits).toBeGreaterThanOrEqual(10);
  });
});
