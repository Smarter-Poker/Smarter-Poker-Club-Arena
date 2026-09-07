/**
 * THE ENGINE STOPS ASKING A QUESTION WHOSE ANSWER IS ALMOST ALWAYS NO.
 *
 * The phase-4 deep dive caught this before it shipped: the drill claim was on
 * the settlement path of every contested showdown. Measured on production that
 * is 137,923 database round trips in twenty-four hours - about 1.6 a second,
 * for ever - and every one of them answers "no", because a table is armed only
 * during a drill somebody is watching. The engine is ONE core and horse Monte
 * Carlo is already 90% of it.
 *
 * These pin the replacement and, more importantly, pin that it is only ever a
 * FILTER: it can delay a drill, never cause one.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { blankNonCode } from '../../testHelpers/sourceWindow.js';

const from = vi.fn();
vi.mock('./client.js', () => ({ supabase: { from: (t: string) => from(t) } }));
const reportError = vi.fn();
vi.mock('../errorReporter.js', () => ({ reportError: (...a: unknown[]) => reportError(...a) }));

import {
  maybeArmed,
  __resetBbjDrillRegistryForTests,
  DRILL_REGISTRY_TTL_MS,
} from './bbjDrillRegistry.js';

/** One `select(...).is(...)` chain resolving to whatever the test wants. */
function rows(result: { data?: { table_id: string }[]; error?: { message: string } }) {
  return { select: () => ({ is: async () => result }) };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  from.mockReset();
  reportError.mockReset();
  __resetBbjDrillRegistryForTests();
});

describe('it asks once a minute, not once a hand', () => {
  it('a hundred showdowns cost ONE query', async () => {
    from.mockReturnValue(rows({ data: [{ table_id: 'armed-1' }] }));
    for (let i = 0; i < 100; i++) await maybeArmed(`table-${i}`);
    expect(from).toHaveBeenCalledTimes(1);
  });

  it('and asks again once the list is stale', async () => {
    from.mockReturnValue(rows({ data: [] }));
    await maybeArmed('t');
    expect(from).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DRILL_REGISTRY_TTL_MS + 1);
    await maybeArmed('t');
    expect(from).toHaveBeenCalledTimes(2);
  });

  it('forty tables settling at once do not become forty queries', async () => {
    let resolveRead: (v: unknown) => void = () => undefined;
    from.mockReturnValue({
      select: () => ({ is: () => new Promise((r) => (resolveRead = r)) }),
    });
    const all = Promise.all(Array.from({ length: 40 }, (_, i) => maybeArmed(`t${i}`)));
    resolveRead({ data: [] });
    await all;
    expect(from).toHaveBeenCalledTimes(1);
  });
});

describe('it can delay a drill, never cause one', () => {
  it('an armed table is reported as armed', async () => {
    from.mockReturnValue(rows({ data: [{ table_id: 'armed-1' }] }));
    expect(await maybeArmed('armed-1')).toBe(true);
    expect(await maybeArmed('other')).toBe(false);
  });

  it('before the first successful read, NO table is armed', async () => {
    /* Silence is not consent. A process that has never managed to read the
       list must not guess, and the guess that matters is the dangerous one. */
    from.mockReturnValue(rows({ error: { message: 'network' } }));
    expect(await maybeArmed('anything')).toBe(false);
    expect(reportError).toHaveBeenCalled();
  });

  it('a failed refresh keeps the last known list rather than emptying it', async () => {
    /* "I could not tell" is not "no" either (CLAUDE.md 10.86). Emptying here
       would make a drill silently impossible during a database blip, and the
       operator would have no way to know why nothing happened. */
    from.mockReturnValue(rows({ data: [{ table_id: 'armed-1' }] }));
    expect(await maybeArmed('armed-1')).toBe(true);

    from.mockReturnValue(rows({ error: { message: 'network' } }));
    vi.advanceTimersByTime(DRILL_REGISTRY_TTL_MS + 1);
    expect(await maybeArmed('armed-1')).toBe(true);
  });

  it('a disarmed table stops being reported after the next read', async () => {
    from.mockReturnValue(rows({ data: [{ table_id: 'armed-1' }] }));
    expect(await maybeArmed('armed-1')).toBe(true);
    from.mockReturnValue(rows({ data: [] }));
    vi.advanceTimersByTime(DRILL_REGISTRY_TTL_MS + 1);
    expect(await maybeArmed('armed-1')).toBe(false);
  });

  it('never claims anything itself', async () => {
    /* The registry READS. Only fn_bbj_claim_drill fires a drill, and it is
       atomic and single-shot.

       Judged on the CODE, not the prose: `blankNonCode` strips comments and
       strings first, because this file's own header names the claim function
       while explaining that it does not call it - and a guard that cannot tell
       an explanation from an instruction fails on the documentation. */
    const src = (await import('node:fs')).readFileSync(
      new URL('./bbjDrillRegistry.ts', import.meta.url),
      'utf8'
    );
    const code = blankNonCode(src);
    expect(code).not.toMatch(/fn_bbj_claim_drill/);
    expect(code).not.toMatch(/\.rpc\(/);
    expect(code).not.toMatch(/\.update\(|\.insert\(|\.delete\(/);
  });
});
