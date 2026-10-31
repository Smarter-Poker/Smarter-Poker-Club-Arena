import { describe, expect, it } from 'vitest';
import { PostHandStageTiming, copyPostHandStageSnapshot } from './PostHandStageTiming.js';

describe('bounded exact-hand post-hold stage evidence', () => {
  it('distinguishes queueing, parallel execution and only the part after the actual hold', () => {
    let now = 0;
    const trace = new PostHandStageTiming(41, () => now);
    const record = trace.queue('hand_history', 'record');
    record.start();
    now = 20;
    const seats = trace.queue('leave_pending', 'seats');
    now = 40;
    seats.start();
    now = 80;
    record.finish('returned');
    now = 150;
    seats.finish('returned');
    const result = trace.snapshot({ handNumber: 41, atMs: 1000, monotonicMs: 50 })!;
    expect(result.stages).toEqual([
      {
        name: 'hand_history',
        lane: 'record',
        outcome: 'returned',
        queuedOffsetMs: -50,
        startedOffsetMs: -50,
        finishedOffsetMs: 30,
        elapsedMs: 80,
        postHoldMs: 30,
      },
      {
        name: 'leave_pending',
        lane: 'seats',
        outcome: 'returned',
        queuedOffsetMs: -30,
        startedOffsetMs: -10,
        finishedOffsetMs: 100,
        elapsedMs: 110,
        postHoldMs: 100,
      },
    ]);
    expect(result.overlappingStages).toBe(true);
    // A caller must not sum these parallel intervals into a 130ms gap.
    expect(Math.max(...result.stages.map((s) => s.finishedOffsetMs!))).toBe(100);
  });

  it('keeps an unfinished successful-path read observable without claiming completion', () => {
    let now = 100;
    const trace = new PostHandStageTiming(42, () => now);
    trace.start('committed_seat_refresh', 'barrier');
    now = 400;
    const result = trace.snapshot({ handNumber: 42, atMs: 2000, monotonicMs: 200 })!;
    expect(result.pipelineComplete).toBe(false);
    expect(result.stages[0]).toMatchObject({
      outcome: 'pending',
      elapsedMs: 300,
      startedOffsetMs: -100,
      finishedOffsetMs: null,
      postHoldMs: 200,
    });
  });

  it('does not assign another hand’s hold or turn absent timing into zero', () => {
    let now = 10;
    const trace = new PostHandStageTiming(42, () => now);
    const finish = trace.start('addon_announcement', 'barrier');
    now = 30;
    finish('threw');
    expect(trace.snapshot({ handNumber: 43, atMs: 1, monotonicMs: 5 })!.stages[0]).toMatchObject({
      elapsedMs: 20,
      startedOffsetMs: null,
      postHoldMs: null,
    });
    const broken = new PostHandStageTiming(43, () => {
      throw new Error('PRIVATE');
    });
    expect(() => broken.start('hand_history', 'record')('returned')).not.toThrow();
    expect(broken.snapshot()).toMatchObject({ captureIncomplete: true });
    expect(new PostHandStageTiming(Number.NaN).snapshot()).toBeNull();
  });

  it('bounds stage storage and allowlists the public copy independently', () => {
    const trace = new PostHandStageTiming(44, () => 1);
    for (let i = 0; i < 30; i++) trace.start('hand_history', 'record')('returned');
    trace.start('PRIVATE_STAGE', 'record')('returned');
    const snapshot = trace.snapshot()!;
    expect(snapshot.stages).toHaveLength(24);
    expect(snapshot.truncated).toBe(true);
    const safe = copyPostHandStageSnapshot({
      ...snapshot,
      privateLease: 'PRIVATE',
      stages: snapshot.stages.map((s) => ({ ...s, userId: 'PRIVATE' })),
    });
    expect(safe).toEqual(snapshot);
    expect(JSON.stringify(safe)).not.toContain('PRIVATE');
    expect(
      copyPostHandStageSnapshot({ ...snapshot, stages: [...snapshot.stages, snapshot.stages[0]] })
    ).toBeNull();
    expect(
      copyPostHandStageSnapshot({
        ...snapshot,
        stages: [{ ...snapshot.stages[0], name: 'PRIVATE' }],
      })
    ).toBeNull();
    expect(
      copyPostHandStageSnapshot({
        ...snapshot,
        stages: [{ ...snapshot.stages[0], elapsedMs: Infinity }],
      })
    ).toBeNull();
    expect(copyPostHandStageSnapshot({ ...snapshot, handNumber: '44' })).toBeNull();
  });
});
