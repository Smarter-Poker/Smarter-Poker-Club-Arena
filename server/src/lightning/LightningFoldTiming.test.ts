import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLightningFoldTiming, type LightningFoldFetchTrace } from './LightningFoldTiming.js';

const ID = '027ab7d1-b13c-4a9d-a7c3-4616f3d39e29';
const PROVIDER = '121f80d2-5290-42e5-a32b-4d3a702e2772';
afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  let now = 0;
  const lines: string[] = [];
  const timing = createLightningFoldTiming({ now: () => now, log: (line) => lines.push(line) });
  return {
    ...timing,
    lines,
    advance: (ms: number) => {
      now += ms;
    },
    read: () => JSON.parse(lines.at(-1)!.slice('[LightningFoldTiming] '.length)),
  };
}

describe('original Lightning fold timing', () => {
  it('returns the identical promise for an untraced fetch without an extra async boundary', async () => {
    const f = fixture();
    const response = new Response();
    const original = Promise.resolve(response);
    expect(f.measureLightningFoldFetch(() => original)).toBe(original);
    expect(await original).toBe(response);
    expect(f.lines).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reports a fetch still pending at the original request boundary without inventing its outcome', async () => {
    const f = fixture();
    let finish!: (response: Response) => void;
    let phases!: LightningFoldFetchTrace;
    let fetchPromise!: Promise<Response>;
    const boundaryError = new Error('original boundary');
    await expect(
      f.traceLightningFold(ID, async () => {
        fetchPromise = f.measureLightningFoldFetch((trace) => {
          phases = trace;
          return new Promise<Response>((resolve) => {
            finish = resolve;
          });
        });
        f.advance(400);
        throw boundaryError;
      })
    ).rejects.toBe(boundaryError);
    expect(f.read()).toMatchObject({
      outcome: 'rejected',
      attempts: [{ outcome: 'pending', headersMs: null, bodyMs: null }],
    });
    const logged = f.lines[0];
    const response = new Response();
    phases.headers(response);
    phases.bodyComplete();
    finish(response);
    expect(await fetchPromise).toBe(response);
    expect(f.lines).toEqual([logged]);
    expect(f.read().attempts[0].outcome).toBe('pending');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves the original response and safe provider timings without recording other data', async () => {
    const f = fixture();
    const response = new Response('private payload', {
      status: 200,
      headers: {
        'sb-request-id': PROVIDER,
        'x-envoy-upstream-service-time': '12.5',
        authorization: 'never-record-this',
      },
    });
    const work = vi.fn(async (trace: LightningFoldFetchTrace) => {
      f.advance(90);
      trace.headers(response);
      f.advance(280);
      trace.bodyComplete();
      return response;
    });
    const result = await f.traceLightningFold(ID, () => f.measureLightningFoldFetch(work));
    expect(result).toBe(response);
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.read()).toMatchObject({
      requestId: ID,
      totalMs: 370,
      outcome: 'fulfilled',
      attempts: [
        {
          startMs: 0,
          headersMs: 90,
          bodyMs: 370,
          status: 200,
          providerRequestId: PROVIDER,
          upstreamMs: 12.5,
          outcome: 'fulfilled',
        },
      ],
    });
    expect(f.lines.join()).not.toMatch(/private payload|authorization|never-record-this/);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves the identical error and never retries a failed fetch', async () => {
    const f = fixture();
    const error = new Error('secret error details');
    const work = vi.fn(async () => {
      f.advance(400);
      throw error;
    });
    await expect(f.traceLightningFold(ID, () => f.measureLightningFoldFetch(work))).rejects.toBe(
      error
    );
    expect(work).toHaveBeenCalledTimes(1);
    expect(f.read()).toMatchObject({
      outcome: 'rejected',
      attempts: [
        {
          headersMs: null,
          bodyMs: null,
          status: null,
          providerRequestId: null,
          upstreamMs: null,
          outcome: 'rejected',
        },
      ],
    });
    expect(f.lines.join()).not.toContain('secret');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disables diagnostics for invalid IDs and untraced calls without changing work', async () => {
    const f = fixture();
    const response = new Response();
    const work = vi.fn(async (trace: LightningFoldFetchTrace) => {
      trace.headers(response);
      f.advance(500);
      trace.bodyComplete();
      return response;
    });
    expect(
      await f.traceLightningFold('invalid private identity', () =>
        f.measureLightningFoldFetch(work)
      )
    ).toBe(response);
    expect(await f.measureLightningFoldFetch(work)).toBe(response);
    expect(work).toHaveBeenCalledTimes(2);
    expect(f.lines).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('caps attempts, sanitizes provider values, and bounds slow logging with omitted counts', async () => {
    const f = fixture();
    for (let line = 0; line < 22; line++) {
      await f.traceLightningFold(ID, async () => {
        for (let attempt = 0; attempt < 8; attempt++)
          await f.measureLightningFoldFetch(async (trace) => {
            const r = new Response('', {
              headers: {
                'sb-request-id': 'Bearer private-token',
                'x-envoy-upstream-service-time': 'Infinity',
              },
            });
            trace.headers(r);
            f.advance(50);
            trace.bodyComplete();
            return r;
          });
      });
    }
    expect(f.lines).toHaveLength(20);
    expect(f.read().attempts).toHaveLength(6);
    expect(f.read().attemptsOmitted).toBe(2);
    expect(f.read().attempts[0]).toMatchObject({ providerRequestId: null, upstreamMs: null });
    f.advance(60_000);
    await f.traceLightningFold(ID, async () => {
      f.advance(350);
    });
    expect(f.lines).toHaveLength(21);
    expect(f.read().omitted).toBe(2);
    expect(f.lines.join()).not.toContain('private-token');
  });

  it('measures timer lateness and clears the timer while retaining concurrent request isolation', async () => {
    const f = fixture();
    let finish!: () => void;
    const pending = f.traceLightningFold(
      ID,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    f.advance(400);
    await vi.advanceTimersByTimeAsync(50);
    finish();
    await pending;
    expect(f.read().timerLateMs).toBe(350);
    expect(vi.getTimerCount()).toBe(0);
    const other = 'b13cc1cf-8efc-4147-a262-cb2c640bf701';
    await Promise.all(
      [ID, other].map((id) =>
        f.traceLightningFold(id, async () => {
          await Promise.resolve();
          await f.measureLightningFoldFetch(async (trace) => {
            const r = new Response();
            trace.headers(r);
            f.advance(400);
            trace.bodyComplete();
            return r;
          });
        })
      )
    );
    expect(
      f.lines
        .slice(-2)
        .map((line) => JSON.parse(line.slice('[LightningFoldTiming] '.length)).requestId)
        .sort()
    ).toEqual([ID, other].sort());
    expect(
      f.lines
        .slice(-2)
        .every(
          (line) => JSON.parse(line.slice('[LightningFoldTiming] '.length)).attempts.length === 1
        )
    ).toBe(true);
  });

  it('never turns diagnostic logger failures into an operation failure and stays silent for fast calls', async () => {
    const f = fixture();
    await f.traceLightningFold(ID, async () => {
      f.advance(349);
    });
    expect(f.lines).toEqual([]);
    let now = 0;
    const timing = createLightningFoldTiming({
      now: () => now,
      log: () => {
        throw new Error('logger');
      },
    });
    expect(
      await timing.traceLightningFold(ID, async () => {
        now = 400;
        return 7;
      })
    ).toBe(7);
    expect(vi.getTimerCount()).toBe(0);
  });
});
