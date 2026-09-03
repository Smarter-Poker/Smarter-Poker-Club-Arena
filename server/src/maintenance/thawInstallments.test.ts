import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runThawInstallments, type ThawCallResult } from './thawInstallments.js';

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
    const { call, calls } = scripted([{ ok: true, complete: true, steps_this_call: ['a'] }]);
    const s = await runThawInstallments(call, { sleep: noSleep });
    expect(s.complete).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('keeps calling while the function reports partial progress, then stops', async () => {
    const { call, calls } = scripted([
      { ok: true, complete: false, steps_this_call: ['sit_out_at', 'hold_expires_at'] },
      { ok: true, complete: false, steps_this_call: [] }, // a level-clock chunk
      { ok: true, complete: false, steps_this_call: [] },
      { ok: true, complete: true, steps_this_call: ['level_started_at'] },
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
      { ok: true, complete: true },
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

  it('gives up after the call budget if the function never reports complete', async () => {
    const { call, calls } = scripted([{ ok: true, complete: false }]);
    await expect(runThawInstallments(call, { sleep: noSleep, maxCalls: 5 })).rejects.toThrow(
      /incomplete after 5 call/
    );
    expect(calls.length).toBe(5);
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

  it('treats an already-thawed answer as complete (losing the race is success)', async () => {
    const { call } = scripted([{ ok: true, complete: true, reason: 'already_thawed' }]);
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
      { ok: true, complete: true },
    ]);
    await runThawInstallments(call, { sleep, pauseMs: 250 });
    expect(pauses).toEqual([250]);
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
});
