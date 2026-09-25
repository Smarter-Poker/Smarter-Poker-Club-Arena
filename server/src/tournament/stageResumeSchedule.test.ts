/**
 * The multi-day stage-resume lane: one wake per due time, the schedule is the
 * product, and the RUNNING re-adoption lane never sees a BAGGED row.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabase } from '../services/supabase.js';
import { sliceMethod } from '../testHelpers/sourceWindow.js';
import {
  StageResumeSchedule,
  readStageResumeBoard,
  stageResumeBackoffMs,
  type StageResumeDue,
  type StageResumeTimerApi,
} from './stageResumeSchedule.js';

afterEach(() => vi.restoreAllMocks());

function clock(start = 1_000_000) {
  let now = start;
  const pending = new Map<number, { at: number; callback: () => void }>();
  let next = 1;
  const api: StageResumeTimerApi = {
    set: (callback, delayMs) => {
      const id = next++;
      pending.set(id, { at: now + delayMs, callback });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clear: (timer) => {
      pending.delete(timer as unknown as number);
    },
    now: () => now,
  };
  return {
    api,
    pending,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...pending]) {
        if (timer.at <= now) {
          pending.delete(id);
          timer.callback();
        }
      }
    },
    get now() {
      return now;
    },
  };
}

function due(overrides: Partial<StageResumeDue> = {}): StageResumeDue {
  return {
    tournamentId: 't1',
    name: 'Two Day Main',
    stageNo: 2,
    scheduleGeneration: 1,
    dueAtMs: 1_000_000 + 60_000,
    ...overrides,
  };
}

describe('StageResumeSchedule', () => {
  it('arms exactly one wake per event and fires it at the due time', () => {
    const c = clock();
    const woken: StageResumeDue[] = [];
    const schedule = new StageResumeSchedule((d) => woken.push(d), c.api);
    schedule.reconcile([due()]);
    schedule.reconcile([due()]);
    expect(c.pending.size).toBe(1);
    c.advance(59_999);
    expect(woken).toHaveLength(0);
    c.advance(1);
    expect(woken).toEqual([due()]);
  });

  it('a reschedule (new generation) replaces the old wake; the old one never fires', () => {
    const c = clock();
    const woken: StageResumeDue[] = [];
    const schedule = new StageResumeSchedule((d) => woken.push(d), c.api);
    schedule.reconcile([due()]);
    schedule.reconcile([due({ scheduleGeneration: 2, dueAtMs: c.now + 120_000 })]);
    expect(c.pending.size).toBe(1);
    c.advance(60_000);
    expect(woken).toHaveLength(0);
    c.advance(60_000);
    expect(woken).toEqual([due({ scheduleGeneration: 2, dueAtMs: 1_000_000 + 120_000 })]);
  });

  it('an event that left the board loses its wake', () => {
    const c = clock();
    const woken: StageResumeDue[] = [];
    const schedule = new StageResumeSchedule((d) => woken.push(d), c.api);
    schedule.reconcile([due()]);
    schedule.reconcile([]);
    expect(c.pending.size).toBe(0);
    c.advance(120_000);
    expect(woken).toHaveLength(0);
  });

  it('an overdue or resuming stage wakes at once', () => {
    const c = clock();
    const woken: StageResumeDue[] = [];
    const schedule = new StageResumeSchedule((d) => woken.push(d), c.api);
    schedule.reconcile([due({ dueAtMs: 0 })]);
    c.advance(0);
    expect(woken).toHaveLength(1);
  });

  it('an event still BAGGED after its wake is woken again with a bounded backoff', () => {
    const c = clock();
    const woken: number[] = [];
    const schedule = new StageResumeSchedule(() => woken.push(c.now), c.api);
    const d = due({ dueAtMs: 0 });
    schedule.reconcile([d]);
    c.advance(0);
    schedule.reconcile([d]);
    c.advance(stageResumeBackoffMs(1) - 1);
    expect(woken).toHaveLength(1);
    c.advance(1);
    expect(woken).toHaveLength(2);
    schedule.reconcile([d]);
    c.advance(stageResumeBackoffMs(2));
    expect(woken).toHaveLength(3);
    expect(stageResumeBackoffMs(50)).toBe(15 * 60_000);
  });
});

describe('readStageResumeBoard', () => {
  function fake(tournaments: unknown, stages: unknown) {
    const tables: string[] = [];
    vi.spyOn(supabase, 'from').mockImplementation(((name: string) => {
      tables.push(name);
      const result = name === 'tournaments' ? tournaments : stages;
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        gt: () => chain,
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve),
      };
      return chain;
    }) as never);
    return tables;
  }

  it('before any row is BAGGED it is one empty read of tournaments and nothing else', async () => {
    const tables = fake({ data: [], error: null }, null);
    expect(await readStageResumeBoard()).toEqual([]);
    expect(tables).toEqual(['tournaments']);
  });

  it('maps a scheduled stage to its start and a resuming stage to now', async () => {
    fake(
      {
        data: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
        error: null,
      },
      {
        data: [
          {
            tournament_id: 'a',
            stage_no: 1,
            scheduled_start_utc: null,
            schedule_generation: 1,
            state: 'bagged',
          },
          {
            tournament_id: 'a',
            stage_no: 2,
            scheduled_start_utc: '2026-09-25T17:00:00.000Z',
            schedule_generation: 3,
            state: 'scheduled',
          },
          {
            tournament_id: 'b',
            stage_no: 1,
            scheduled_start_utc: null,
            schedule_generation: 1,
            state: 'bagged',
          },
          {
            tournament_id: 'b',
            stage_no: 2,
            scheduled_start_utc: '2026-09-25T17:00:00.000Z',
            schedule_generation: 1,
            state: 'resuming',
          },
        ],
        error: null,
      }
    );
    expect(await readStageResumeBoard()).toEqual([
      {
        tournamentId: 'a',
        name: 'A',
        stageNo: 2,
        scheduleGeneration: 3,
        dueAtMs: Date.parse('2026-09-25T17:00:00.000Z'),
      },
      { tournamentId: 'b', name: 'B', stageNo: 2, scheduleGeneration: 1, dueAtMs: 0 },
    ]);
  });

  it('an unreadable board is UNKNOWN (null), never "nothing is due"', async () => {
    fake({ data: [{ id: 'a', name: 'A' }], error: null }, { data: null, error: { message: 'x' } });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await readStageResumeBoard()).toBeNull();
  });
});

describe('GameServer lanes', () => {
  const source = readFileSync(path.join(process.cwd(), 'src/GameServer.ts'), 'utf8');

  it('the RUNNING re-adoption lane reads RUNNING only, so it ignores BAGGED', () => {
    const lane = sliceMethod(source, 'private async discoverRunningResumes()');
    expect(lane).toContain(".eq('status', 'RUNNING')");
    expect(lane).not.toContain('BAGGED');
  });

  it('the stage-resume lane admits a manager in stage_resume mode and starts beside it', () => {
    const lane = sliceMethod(source, 'private admitDueStageResume(');
    expect(lane).toContain("'stage_resume'");
    expect(lane).toContain('this.ensureTournamentManagerAdmission(');
    const boot = sliceMethod(source, 'private async performStart(');
    expect(boot.indexOf('this.discoverStageResumes()')).toBeGreaterThan(
      boot.indexOf('this.discoverRunningResumes()')
    );
    const admission = sliceMethod(source, 'private async performTournamentManagerAdmission(');
    expect(admission).toContain("else if (mode === 'stage_resume') await manager.resumeStage();");
  });
});
