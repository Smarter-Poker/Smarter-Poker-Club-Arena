import { afterEach, describe, it, expect, vi } from 'vitest';
const m = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('../supabase.js', () => ({ supabase: { rpc: m.rpc } }));
import {
  runJournalLoop,
  COMMITMENT_AUDIT_BACKLOG_DELAY_MS,
  COMMITMENT_AUDIT_SETTLED_DELAY_MS,
} from './loop.js';
import { emptyCommittedPotAudit, type CommittedPotAuditReceipt } from './commitmentReceipt.js';
import { processHorseCommittedPotAudit } from '../HorseCommittedPotAudit.js';
import type { AdaptiveJournalWorkResult } from '../HorseAdaptiveJournalWork.js';

const recorded = (): CommittedPotAuditReceipt => ({
  ...emptyCommittedPotAudit('recorded'),
  scannedHands: 256,
});
const prune = async () => ({
  status: 'pruned' as const,
  completedWork: 0,
  batches: 0,
  observations: 0,
});
const completedWork = async (): Promise<AdaptiveJournalWorkResult> => ({
  status: 'completed',
  batchKey: 'a'.repeat(64),
});

/** Injected clock: `wait` advances `now`, and the run stops once `now` passes
 * `until`. Records when each journal claim and each audit step started. */
async function clocked(
  until: number,
  processWork: () => Promise<AdaptiveJournalWorkResult>,
  processCommitments?: () => Promise<CommittedPotAuditReceipt>
) {
  const stop = new AbortController();
  let now = 0;
  const workAt: number[] = [];
  const stepAt: number[] = [];
  const completed = vi.fn();
  await runJournalLoop(stop.signal, {
    processWork: async () => {
      workAt.push(now);
      return processWork();
    },
    ...(processCommitments
      ? {
          processCommitments: async () => {
            stepAt.push(now);
            return processCommitments();
          },
        }
      : {}),
    prune,
    now: () => now,
    started: vi.fn(),
    completed,
    wait: async (ms) => {
      now += ms;
      if (now >= until) stop.abort();
    },
  });
  return { workAt, stepAt, completed };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  m.rpc.mockReset();
});

describe('daily committed-pot audit isolated caller', () => {
  it('names the measured cadence', () => {
    expect(COMMITMENT_AUDIT_BACKLOG_DELAY_MS).toBe(5000);
    expect(COMMITMENT_AUDIT_SETTLED_DELAY_MS).toBe(60000);
  });

  it('runs the next step 5 s after a recorded (backlogged) receipt, not after journal turns', async () => {
    const { workAt, stepAt } = await clocked(30000, completedWork, async () => recorded());
    expect(stepAt).toEqual([0, 5000, 10000, 15000, 20000, 25000]);
    // Journal claims keep their own one-second cadence around the audit.
    expect(workAt).toEqual(Array.from({ length: 30 }, (_, i) => i * 1000));
  });

  it('keeps the 5 s backlog cadence while journal work is backed off for a minute', async () => {
    const failing = async (): Promise<AdaptiveJournalWorkResult> => ({
      status: 'unavailable',
      reason: 'failed',
    });
    const alone = await clocked(122001, failing);
    const withAudit = await clocked(122001, failing, async () => recorded());
    // The old cadence needed four journal turns: one step in two minutes here.
    expect(withAudit.stepAt.length).toBeGreaterThanOrEqual(20);
    for (let i = 1; i < withAudit.stepAt.length; i++) {
      const gap = withAudit.stepAt[i] - withAudit.stepAt[i - 1];
      expect(gap).toBeGreaterThanOrEqual(5000);
      // At most one short pause late, never held back to the next journal turn
      // of a long backoff.
      expect(gap).toBeLessThanOrEqual(9000);
    }
    expect(withAudit.workAt).toEqual(alone.workAt);
    expect(alone.workAt).toEqual([0, 2000, 6000, 14000, 30000, 62000, 122000]);
  });

  it.each(['pass_complete', 'idle', 'busy', 'disabled', 'unknown', 'thrown'] as const)(
    'waits 60 s after a %s receipt',
    async (status) => {
      const { workAt, stepAt, completed } = await clocked(150000, completedWork, async () => {
        if (status === 'thrown') throw Error('lost');
        return emptyCommittedPotAudit(status);
      });
      expect(stepAt).toEqual([0, 60000, 120000]);
      expect(workAt).toEqual(Array.from({ length: 150 }, (_, i) => i * 1000));
      const receipts = completed.mock.calls.filter(([r]) => r.commitment);
      expect(receipts).toHaveLength(3);
      for (const [r] of receipts)
        expect(r).toEqual({
          work: 'skipped',
          retention: 'skipped',
          commitment: emptyCommittedPotAudit(status === 'thrown' ? 'unknown' : status),
        });
    }
  );

  it('respects the HORSE_COMMITMENT_AUDIT=off switch: no query, one-minute cadence', async () => {
    vi.stubEnv('HORSE_COMMITMENT_AUDIT', 'off');
    const { stepAt, completed } = await clocked(
      125000,
      completedWork,
      processHorseCommittedPotAudit
    );
    expect(m.rpc).not.toHaveBeenCalled();
    expect(stepAt).toEqual([0, 60000, 120000]);
    for (const [r] of completed.mock.calls.filter(([c]) => c.commitment))
      expect(r.commitment.status).toBe('disabled');
  });

  it('never overlaps a step with another step or with journal work, and keeps journal timing (fake timers)', async () => {
    vi.useFakeTimers({ now: 0 });
    const wait = (ms: number, signal: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(t);
            reject(signal.reason);
          },
          { once: true }
        );
      });
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const run = async (withAudit: boolean) => {
      const stop = new AbortController();
      const start = Date.now();
      let active = 0;
      let maxActive = 0;
      const workAt: number[] = [];
      const stepAt: number[] = [];
      const enter = () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
      };
      const task = runJournalLoop(stop.signal, {
        processWork: async () => {
          enter();
          workAt.push(Date.now() - start);
          await sleep(200);
          active -= 1;
          return { status: 'completed', batchKey: 'a'.repeat(64) };
        },
        ...(withAudit
          ? {
              // The measured mean step runtime.
              processCommitments: async () => {
                enter();
                stepAt.push(Date.now() - start);
                await sleep(241);
                active -= 1;
                return recorded();
              },
            }
          : {}),
        prune,
        now: Date.now,
        started: vi.fn(),
        completed: vi.fn(),
        wait,
      });
      await vi.advanceTimersByTimeAsync(30000);
      stop.abort();
      await vi.advanceTimersByTimeAsync(1000);
      await task;
      return { workAt, stepAt, maxActive };
    };
    const alone = await run(false);
    const audited = await run(true);
    expect(audited.maxActive).toBe(1);
    expect(audited.workAt).toEqual(alone.workAt);
    // Due 5 s after the previous step ended; it runs at the next pause start,
    // so the spacing is 5 s plus at most one journal cycle (200 ms + 1 s).
    expect(audited.stepAt.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < audited.stepAt.length; i++) {
      const gap = audited.stepAt[i] - audited.stepAt[i - 1];
      expect(gap).toBeGreaterThanOrEqual(5000);
      expect(gap).toBeLessThanOrEqual(5000 + 241 + 1200);
    }
  });

  it('runs bounded audit steps while journal and model work continue', async () => {
    const stop = new AbortController();
    let now = 0,
      cycles = 0;
    const completed = vi.fn();
    const work = vi.fn(completedWork);
    const process = vi.fn(async () => recorded());
    const model = vi.fn(async () => 'recorded' as const);
    await runJournalLoop(stop.signal, {
      processWork: work,
      processCommitments: process,
      processModels: model,
      prune,
      now: () => now,
      started: vi.fn(),
      completed,
      wait: async (ms) => {
        now += ms;
        if (++cycles === 20) stop.abort();
      },
    });
    expect(process.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(model).toHaveBeenCalled();
    expect(work.mock.calls.length).toBeGreaterThanOrEqual(12);
    for (const [r] of completed.mock.calls)
      if (r.commitment) expect(r).toMatchObject({ work: 'skipped', retention: 'skipped' });
  });

  it('pairs every audit step with its own started/completed cycle for the supervisor', async () => {
    const stop = new AbortController();
    let now = 0;
    const events: string[] = [];
    await runJournalLoop(stop.signal, {
      processWork: completedWork,
      processCommitments: async () => recorded(),
      prune,
      now: () => now,
      started: () => events.push('S'),
      completed: () => events.push('C'),
      wait: async (ms) => {
        now += ms;
        if (now >= 12000) stop.abort();
      },
    });
    expect(events.join('')).toMatch(/^(SC)+S?$/);
  });

  it('backs off a failing audit without blocking ordinary work', async () => {
    const stop = new AbortController();
    let now = 0,
      cycles = 0;
    const completed = vi.fn();
    const process = vi.fn(async () => {
      throw Error('lost');
    });
    const work = vi.fn(completedWork);
    await runJournalLoop(stop.signal, {
      processWork: work,
      processCommitments: process,
      prune,
      now: () => now,
      started: vi.fn(),
      completed,
      wait: async (ms) => {
        now += ms;
        if (++cycles === 20) stop.abort();
      },
    });
    expect(process).toHaveBeenCalledTimes(1);
    expect(work).toHaveBeenCalledTimes(20);
    expect(completed.mock.calls.find(([r]) => r.commitment)?.[0].commitment.status).toBe('unknown');
  });

  it('discards an interrupted completion while the durable database cursor remains the retry owner', async () => {
    const stop = new AbortController();
    let now = 0;
    const completed = vi.fn();
    await runJournalLoop(stop.signal, {
      processWork: completedWork,
      processCommitments: async () => {
        stop.abort();
        return recorded();
      },
      prune,
      now: () => now,
      started: vi.fn(),
      completed,
      wait: async (ms) => {
        now += ms;
      },
    });
    expect(completed.mock.calls.every(([r]) => r.commitment === undefined)).toBe(true);
  });
});
