import { describe, expect, it, vi } from 'vitest';
import {
  TournamentLifecycleAbortedError,
  TournamentLifecycleEpoch,
} from './TournamentLifecycleEpoch.js';

describe('TournamentLifecycleEpoch', () => {
  it('invalidates the previous generation before publishing a replacement', () => {
    const lifecycle = new TournamentLifecycleEpoch();
    const first = lifecycle.begin();
    const second = lifecycle.begin();

    expect(first.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(first)).toBe(false);
    expect(lifecycle.isCurrent(second)).toBe(true);
    expect(second.generation).toBeGreaterThan(first.generation);
    expect(() => lifecycle.assertCurrent(first)).toThrow(TournamentLifecycleAbortedError);
  });

  it('makes stop a synchronous fence for awaited continuations and timers', async () => {
    vi.useFakeTimers();
    const lifecycle = new TournamentLifecycleEpoch();
    const token = lifecycle.begin();
    const mutations: string[] = [];

    const continuation = Promise.resolve().then(() => {
      if (lifecycle.isCurrent(token)) mutations.push('awaited');
    });
    setTimeout(() => {
      if (lifecycle.isCurrent(token)) mutations.push('timer');
    }, 10);

    lifecycle.abort();
    await continuation;
    await vi.advanceTimersByTimeAsync(10);

    expect(token.signal.aborted).toBe(true);
    expect(mutations).toEqual([]);
    vi.useRealTimers();
  });

  it('never revives an aborted token after later starts', () => {
    const lifecycle = new TournamentLifecycleEpoch();
    const retired = lifecycle.begin();
    lifecycle.abort();
    const replacement = lifecycle.begin();

    expect(lifecycle.isCurrent(retired)).toBe(false);
    expect(lifecycle.isCurrent(replacement)).toBe(true);
    expect(replacement.generation).toBeGreaterThan(retired.generation);
  });
});
