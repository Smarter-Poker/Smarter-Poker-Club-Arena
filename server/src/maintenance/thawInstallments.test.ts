import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  runThawInstallments,
  THAW_RETRY_AFTER_MAX_MS,
  ThawAbandonedError,
  ThawRefusedError,
  type ThawCallResult,
} from './thawInstallments.js';

const noSleep = async () => undefined;

function scripted(responses: Array<ThawCallResult | Error>) {
  let i = 0;
  const calls: number[] = [];
  const call = async (): Promise<ThawCallResult> => {
    const r = responses[Math.min(i, responses.length - 1)];
    calls.push(i);
    i += 1;
    if (r instanceof Error) throw r;
    return r;
  };
  return { call, calls };
}

describe('the thaw runs in installments until the database says complete', () => {
  it('returns after one call when the function finished everything at once', async () => {
    const { call, calls } = scripted([
      { ok: true, complete: true, released: true, steps_this_call: ['a'] },
    ]);
    const s = await runThawInstallments(call, { sleep: noSleep });
    expect(s.complete).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('keeps calling while the function reports partial progress, then stops', async () => {
    const { call, calls } = scripted([
      { ok: true, complete: false, steps_this_call: ['sit_out_at', 'hold_expires_at'] },
      { ok: true, complete: false, steps_this_call: [] }, // a level-clock chunk
      { ok: true, complete: false, steps_this_call: [] },
      { ok: true, complete: true, released: true, steps_this_call: ['level_started_at'] },
    ]);
    const s = await runThawInstallments(call, { sleep: noSleep });
    expect(s.complete).toBe(true);
    expect(s.calls).toBe(4);
    expect(calls.length).toBe(4);
  });

  it('retries a call that died (a timeout committed nothing) and still completes', async () => {
    const { call } = scripted([
      { ok: true, complete: false },
      new Error('canceling statement due to statement timeout'),
      { ok: true, complete: true, released: true },
    ]);
    const s = await runThawInstallments(call, { sleep: noSleep });
    expect(s.complete).toBe(true);
    expect(s.calls).toBe(3);
    expect(s.errors).toBe(1);
  });

  it('gives up after the consecutive-error budget so the resume is never held hostage', async () => {
    const { call, calls } = scripted([new Error('PGRST002')]);
    await expect(
      runThawInstallments(call, { sleep: noSleep, maxConsecutiveErrors: 3 })
    ).rejects.toThrow(/abandoned after 3 error/);
    expect(calls.length).toBe(3);
  });

  it('does not misclassify more than 480 batched targets as incomplete or erroneous', async () => {
    // level_started_at advances 40 targets per v3 call. Thirteen healthy
    // partial receipts represent 520 targets, beyond the old 12-call/480-row
    // boundary, followed by the exact atomic release receipt.
    const partials: ThawCallResult[] = Array.from({ length: 13 }, (_unused, index) => ({
      ok: true,
      complete: false,
      retryable: true,
      reason: 'thaw_tail_checkpointed',
      retry_after_ms: 0,
      steps_this_call: [`level_started_at:${index}`],
    }));
    const { call, calls } = scripted([...partials, { ok: true, complete: true, released: true }]);
    const result = await runThawInstallments(call, { sleep: noSleep });
    expect(result).toMatchObject({ complete: true, calls: 14, errors: 0 });
    expect(calls).toHaveLength(14);
  });

  it('does not retry a refusal - an implausible frozen duration will not become plausible', async () => {
    const { call, calls } = scripted([
      { ok: false, complete: false, reason: 'implausible_frozen_seconds' },
    ]);
    await expect(runThawInstallments(call, { sleep: noSleep })).rejects.toThrow(
      /refused: implausible_frozen_seconds/
    );
    expect(calls.length).toBe(1);
  });

  it('types a terminal refusal so the lifecycle never retries it as transport noise', async () => {
    const { call, calls } = scripted([
      { ok: false, complete: false, retryable: false, reason: 'maintenance_ownership_changed' },
    ]);
    await expect(runThawInstallments(call, { sleep: noSleep })).rejects.toBeInstanceOf(
      ThawRefusedError
    );
    expect(calls).toHaveLength(1);
  });

  it('accepts abandonment only with an atomic release receipt and types it separately', async () => {
    const { call, calls } = scripted([
      {
        ok: true,
        complete: true,
        retryable: false,
        released: true,
        abandoned: true,
        reason: 'recovery_window_expired',
      },
    ]);
    await expect(runThawInstallments(call, { sleep: noSleep })).rejects.toBeInstanceOf(
      ThawAbandonedError
    );
    expect(calls).toHaveLength(1);
  });

  it('backs off instead of hot-spinning a transient not-due receipt', async () => {
    const pauses: number[] = [];
    const { call, calls } = scripted([
      {
        ok: false,
        complete: false,
        retryable: true,
        reason: 'maintenance_break_not_due',
        retry_after_ms: 4_321,
      },
      { ok: true, complete: true, released: true },
    ]);
    const result = await runThawInstallments(call, {
      pauseMs: 250,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result.complete).toBe(true);
    expect(result.calls).toBe(2);
    expect(result.errors).toBe(0);
    expect(calls).toHaveLength(2);
    expect(pauses).toEqual([4_321]);
  });

  it('keeps the caller anti-spin floor when the database retry hint is shorter', async () => {
    const pauses: number[] = [];
    const { call } = scripted([
      {
        ok: true,
        complete: false,
        retryable: true,
        reason: 'thaw_checkpointed',
        retry_after_ms: 0,
      },
      { ok: true, complete: true, released: true },
    ]);
    const result = await runThawInstallments(call, {
      pauseMs: 250,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(pauses).toEqual([250]);
    expect(result).toMatchObject({ calls: 2, errors: 0, complete: true });
  });

  it('bounds an excessive retry hint without classifying the prepared wait as an error', async () => {
    const pauses: number[] = [];
    const { call } = scripted([
      {
        ok: false,
        complete: false,
        retryable: true,
        reason: 'maintenance_break_not_due',
        retry_after_ms: Number.MAX_SAFE_INTEGER,
      },
      { ok: true, complete: true, released: true },
    ]);
    const result = await runThawInstallments(call, {
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(pauses).toEqual([THAW_RETRY_AFTER_MAX_MS]);
    expect(result).toMatchObject({ calls: 2, errors: 0, complete: true });
  });

  it('lifecycle-cancels the database-directed retry wait before another call starts', async () => {
    const ctl = new AbortController();
    const calls: number[] = [];
    let observedPause = 0;
    let sleeping!: () => void;
    const enteredSleep = new Promise<void>((resolve) => {
      sleeping = resolve;
    });
    const run = runThawInstallments(
      async () => {
        calls.push(Date.now());
        return {
          ok: false,
          complete: false,
          retryable: true,
          reason: 'maintenance_break_not_due',
          retry_after_ms: 9_000,
        };
      },
      {
        signal: ctl.signal,
        sleep: async (ms, signal) => {
          observedPause = ms;
          sleeping();
          await new Promise<void>((_resolve, reject) =>
            signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
          );
        },
      }
    );

    await enteredSleep;
    ctl.abort(new Error('server stopping'));
    await expect(run).rejects.toThrow('server stopping');
    expect(observedPause).toBe(9_000);
    expect(calls).toHaveLength(1);
  });

  it('refuses a complete result that did not atomically release its exact break row', async () => {
    const { call } = scripted([{ ok: true, complete: true, released: false }]);
    await expect(runThawInstallments(call, { sleep: noSleep })).rejects.toThrow(
      'complete_without_atomic_release'
    );
  });

  it('treats an already-thawed answer as complete (losing the race is success)', async () => {
    const { call } = scripted([
      { ok: true, complete: true, released: true, reason: 'already_thawed' },
    ]);
    const s = await runThawInstallments(call, { sleep: noSleep });
    expect(s.complete).toBe(true);
  });

  it('pauses between calls, but not after the last one', async () => {
    const pauses: number[] = [];
    const sleep = async (ms: number) => {
      pauses.push(ms);
    };
    const { call } = scripted([
      { ok: true, complete: false },
      { ok: true, complete: true, released: true },
    ]);
    await runThawInstallments(call, { sleep, pauseMs: 250 });
    expect(pauses).toEqual([250]);
  });

  it('cancels the inter-installment backoff without starting another database call', async () => {
    const ctl = new AbortController();
    const calls: number[] = [];
    const sleeping = new Promise<void>((resolve) => {
      const sleep = async (_ms: number, signal?: AbortSignal) => {
        resolve();
        await new Promise<void>((_done, reject) =>
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        );
      };
      void runThawInstallments(
        async () => {
          calls.push(Date.now());
          return { ok: true, complete: false };
        },
        { signal: ctl.signal, sleep }
      ).catch(() => undefined);
    });

    await sleeping;
    ctl.abort(new Error('server stopping'));
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });
});

describe('source law: the engine drives the thaw through the installment loop', () => {
  // GameServer's thaw dependency must go through runThawInstallments. A
  // one-shot supabase.rpc('fn_thaw_platform') call is what this phase retires:
  // with the checkpointing function, a single call that ran out of budget
  // returns complete:false and a caller that does not call again leaves the
  // remaining clocks unshifted.
  const src = readFileSync(resolve(__dirname, '../GameServer.ts'), 'utf8');

  it('GameServer imports runThawInstallments and uses it for the thaw', () => {
    expect(src).toMatch(
      /import\s*\{[^}]*runThawInstallments[^}]*\}\s*from\s*'\.\/maintenance\/thawInstallments(\.js)?'/
    );
    expect(src).toMatch(/runThawInstallments\(/);
  });

  it('every fn_thaw_platform call in GameServer sits inside the installment loop', () => {
    const rpcSites = src.split("rpc('fn_thaw_platform'").length - 1;
    expect(rpcSites, 'exactly one thaw RPC site').toBe(1);
    const at = src.indexOf("rpc('fn_thaw_platform'");
    const window = src.slice(Math.max(0, at - 600), at);
    expect(
      window,
      'the RPC call is the body of the callback handed to runThawInstallments'
    ).toMatch(/runThawInstallments\(/);
  });

  it('a post-release manager refresh cannot gate local table resume', () => {
    const resyncAt = src.indexOf('resyncManagersAfterMaintenanceThaw(');
    expect(resyncAt, 'the post-thaw manager refresh is not wired').toBeGreaterThan(-1);
    const launchAt = src.lastIndexOf('this.launchServerLifecycleJob(', resyncAt);
    expect(launchAt, 'the manager refresh is not lifecycle-owned').toBeGreaterThan(-1);
    const between = src.slice(launchAt, resyncAt);
    expect(between).not.toMatch(/\bawait\b/);
  });

  it('passes the exact credited-through receipt to the maintenance owner', () => {
    expect(src).toContain('summary.last?.credited_through_at');
    expect(src).toContain('return { creditedThroughAtMs }');
  });
});
