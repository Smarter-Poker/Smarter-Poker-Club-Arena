import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DIAMOND_SPINS_RPC_DEADLINE_MS,
  fetchDiamondSpinsRpc,
} from '../../src/lib/diamondSpinsRpcDeadline';

const DOOR = 'https://unit.supabase.co/rest/v1/rpc/fn_crash_settle';

/** Lets a test ask whether the caller is still waiting, without awaiting it. */
function watch<T>(promise: Promise<T>) {
  const state = { settled: false, value: undefined as unknown };
  const done = promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
      return value as unknown;
    },
    (error) => {
      state.settled = true;
      state.value = error;
      return error as unknown;
    }
  );
  return { state, done };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a Diamond Spins request that never answers', () => {
  it('holds its caller for the whole budget, then hands back a lost answer', async () => {
    const send = vi.fn().mockReturnValue(new Promise(() => {}));
    const { state, done } = watch(fetchDiamondSpinsRpc(DOOR, { method: 'POST' }, send));
    await vi.advanceTimersByTimeAsync(DIAMOND_SPINS_RPC_DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = (await done) as Error;
    expect(outcome.name).toBe('RequestDeadlineError');
    // The page reads this through postgrest-js, which carries no code for a
    // transport failure: the wager is unanswered, not refused.
    expect((outcome as unknown as { code?: unknown }).code).toBeUndefined();
    expect(send.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the budget running until the answer has a body', async () => {
    const send = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      arrayBuffer: () => new Promise(() => {}),
    });
    const { state, done } = watch(fetchDiamondSpinsRpc(DOOR, { method: 'POST' }, send));
    await vi.advanceTimersByTimeAsync(DIAMOND_SPINS_RPC_DEADLINE_MS - 1);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(((await done) as Error).name).toBe('RequestDeadlineError');
  });
});

describe('an answer that does arrive', () => {
  it('reaches the page exactly as the server wrote it', async () => {
    const send = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, status: 'cashed' }), {
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'application/json', 'sb-gateway-version': '1' },
      })
    );
    const response = await fetchDiamondSpinsRpc(DOOR, { method: 'POST' }, send);
    expect(response.status).toBe(200);
    expect(response.headers.get('sb-gateway-version')).toBe('1');
    expect(await response.json()).toEqual({ ok: true, status: 'cashed' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('carries an answer that has no body of its own', async () => {
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const response = await fetchDiamondSpinsRpc(DOOR, undefined, send);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
  });
});

describe('the caller keeps its own cancellation', () => {
  it('stops the request when the page drops it', async () => {
    const controller = new AbortController();
    const send = vi.fn().mockReturnValue(new Promise(() => {}));
    const { done } = watch(
      fetchDiamondSpinsRpc(DOOR, { method: 'POST', signal: controller.signal }, send)
    );
    await vi.advanceTimersByTimeAsync(0); // the request is out
    expect(send).toHaveBeenCalledTimes(1);
    controller.abort();
    const outcome = (await done) as Error;
    expect(outcome.name).toBe('AbortError');
    expect(send.mock.calls[0][1].signal.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never sends a request the page has already dropped', async () => {
    const controller = new AbortController();
    controller.abort();
    const send = vi.fn();
    await expect(
      fetchDiamondSpinsRpc(DOOR, { signal: controller.signal }, send)
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(send).not.toHaveBeenCalled();
  });
});
