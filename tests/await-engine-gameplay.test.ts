import { describe, expect, it, vi } from 'vitest';
import {
  awaitEngineGameplay,
  gameplayHasResumed,
  GAMEPLAY_WAIT_MS,
} from '../scripts/ci/await-engine-gameplay.mjs';

const SHA = 'a'.repeat(40);
const health = (maintenance: object, releaseSha = SHA) =>
  JSON.stringify({ releaseSha, running: true, liveness: 'ok', maintenance });
const idle = { active: false, phase: 'idle', resumeWaves: null };
const frozen = { active: true, phase: 'counting_down' };
const reply = (raw: string) => new Response(raw, { status: 200 });

describe('the existing certification waits only for its engine maintenance boundary', () => {
  it('admits a resumed exact engine immediately without sleeping', async () => {
    const pause = vi.fn();
    expect(
      await awaitEngineGameplay(SHA, { fetchImpl: async () => reply(health(idle)), pause })
    ).toBe(SHA);
    expect(pause).not.toHaveBeenCalled();
  });

  it('does not open fixtures until the countdown and all resume waves finish', async () => {
    let elapsed = 0;
    const states = [
      frozen,
      { active: true, phase: 'finalizing' },
      { ...idle, resumeWaves: { total: 8, done: 3 } },
      { ...idle, resumeWaves: { total: 8, done: 8 } },
    ];
    const report = vi.fn();
    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.headers['Cache-Control']).toBe('no-store');
      return reply(health(states.shift()!));
    });
    const result = await awaitEngineGameplay(SHA, {
      fetchImpl,
      now: () => elapsed,
      pause: async (ms: number) => {
        elapsed += ms;
      },
      report,
    });
    expect(result).toBe(SHA);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(elapsed).toBe(15_000);
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('refuses a changed engine while waiting instead of certifying a replacement', async () => {
    let calls = 0;
    await expect(
      awaitEngineGameplay(SHA, {
        fetchImpl: async () => reply(health(frozen, ++calls === 1 ? SHA : 'b'.repeat(40))),
        pause: async () => {},
        report: () => {},
      })
    ).rejects.toThrow('has not reached required');
    expect(calls).toBe(2);
  });

  it('fails after a fixed budget if maintenance never ends', async () => {
    let elapsed = 0;
    const fetchImpl = vi.fn(async () => reply(health(frozen)));
    await expect(
      awaitEngineGameplay(SHA, {
        fetchImpl,
        now: () => elapsed,
        pause: async (ms: number) => {
          elapsed += ms;
        },
        report: () => {},
      })
    ).rejects.toThrow('eight-minute');
    expect(elapsed).toBe(GAMEPLAY_WAIT_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(GAMEPLAY_WAIT_MS / 5000);
  });

  it('does not accept a response that arrives after its deadline', async () => {
    let elapsed = 0;
    await expect(
      awaitEngineGameplay(SHA, {
        now: () => elapsed,
        fetchImpl: async () => {
          elapsed = GAMEPLAY_WAIT_MS;
          return reply(health(idle));
        },
      })
    ).rejects.toThrow('eight-minute');
  });

  it.each([
    undefined,
    {},
    { active: 'false', phase: 'idle' },
    { active: true, phase: 'unknown' },
    { active: false, phase: 'counting_down' },
    { ...idle, resumeWaves: { total: 8, done: 9 } },
    { ...idle, resumeWaves: { total: 8, done: '8' } },
  ])('refuses missing or contradictory maintenance evidence %#', (maintenance) => {
    expect(() => gameplayHasResumed(health(maintenance as object), SHA)).toThrow();
  });

  it('does not retry transport, HTTP or malformed health failures', async () => {
    for (const fetcher of [
      async () => {
        throw Error('network unavailable');
      },
      async () => new Response('', { status: 503 }),
      async () => reply('{'),
    ]) {
      const fetchImpl = vi.fn(fetcher);
      await expect(awaitEngineGameplay(SHA, { fetchImpl })).rejects.toThrow();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });
});
