/**
 * THE GATE FAILS CLOSED AND FORGETS NOTHING IT WAS NOT TOLD (Phase 10, 2026-10-06)
 *
 * The two switches over anything a horse says at the felt are read here and
 * nowhere else. These tests pin the shape of the answer (CLAUDE.md 10.86): a
 * named reason for every "no", "I could not tell" never folded into a "yes",
 * a definite answer remembered for exactly the TTL and not a millisecond
 * longer, and an unreadable answer asked again on the very next call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Filter = [string, ...unknown[]];
interface Call {
  table: string;
  filters: Filter[];
}

const h = vi.hoisted(() => {
  const state = {
    calls: [] as Call[],
    settings: { data: [{ engine_enabled: true }] as unknown, error: null as unknown },
    mode: { data: { mode: 'table_talk', enabled: true } as unknown, error: null as unknown },
    throwOnRead: false,
  };
  function builder(table: string) {
    const call: Call = { table, filters: [] };
    state.calls.push(call);
    const answer = () => {
      if (state.throwOnRead) throw new Error('supabase_timeout');
      return table === 'content_settings' ? { ...state.settings } : { ...state.mode };
    };
    const b: Record<string, unknown> = {
      select: (cols: string) => (call.filters.push(['select', cols]), b),
      eq: (c: string, v: unknown) => (call.filters.push(['eq', c, v]), b),
      maybeSingle: () => {
        call.filters.push(['maybeSingle']);
        return Promise.resolve(answer());
      },
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve().then(answer).then(res, rej),
    };
    return b;
  }
  return { state, supabase: { from: (t: string) => builder(t) } };
});

vi.mock('./supabase/client.js', () => ({ supabase: h.supabase }));
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import {
  TABLE_TALK_GATE_TTL_MS,
  _resetTableTalkGateForTests,
  readTableTalkGate,
} from './HorseTableTalkGate.js';
import { reportError } from './errorReporter.js';

const reads = () => h.state.calls.length;

beforeEach(() => {
  _resetTableTalkGateForTests();
  h.state.calls = [];
  h.state.settings = { data: [{ engine_enabled: true }], error: null };
  h.state.mode = { data: { mode: 'table_talk', enabled: true }, error: null };
  h.state.throwOnRead = false;
  vi.mocked(reportError).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the table talk gate', () => {
  it('both switches on is the only yes, and it is read from the two switch tables', async () => {
    const v = await readTableTalkGate();
    expect(v).toMatchObject({ allowed: true, reason: 'on' });
    expect(h.state.calls.map((c) => c.table).sort()).toEqual([
      'content_settings',
      'horse_post_modes',
    ]);
    const mode = h.state.calls.find((c) => c.table === 'horse_post_modes')!;
    expect(mode.filters).toContainEqual(['eq', 'mode', 'table_talk']);
    expect(TABLE_TALK_GATE_TTL_MS).toBe(30_000);
  });

  it('the engine switch off is engine_off', async () => {
    h.state.settings = { data: [{ engine_enabled: false }], error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'engine_off' });
  });

  it('the mode row disabled is mode_off, which is how it ships', async () => {
    h.state.mode = { data: { mode: 'table_talk', enabled: false }, error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'mode_off' });
  });

  it('no mode row is mode_missing, never a yes', async () => {
    h.state.mode = { data: null, error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'mode_missing' });
  });

  it('a read error is unreadable and is reported', async () => {
    h.state.settings = { data: null, error: { message: 'PGRST002' } };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'unreadable' });
    expect(reportError).toHaveBeenCalledWith(expect.any(Error), 'HorseTableTalkGate.unreadable');
  });

  it('a thrown read (the bounded client timing out) is unreadable, not a yes', async () => {
    h.state.throwOnRead = true;
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'unreadable' });
  });

  it('two content_settings rows is unreadable: the switch has no single value', async () => {
    h.state.settings = { data: [{ engine_enabled: true }, { engine_enabled: true }], error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'unreadable' });
  });

  it('zero content_settings rows is unreadable too', async () => {
    h.state.settings = { data: [], error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'unreadable' });
  });

  it('a failure is not cached: the next call asks again and gets the real answer', async () => {
    h.state.settings = { data: null, error: { message: 'down' } };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'unreadable' });
    const afterFailure = reads();
    h.state.settings = { data: [{ engine_enabled: true }], error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: true });
    expect(reads()).toBe(afterFailure + 2);
  });

  it('a definite answer is cached for the TTL and re-read once it is 30 s old', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T12:00:00Z') });
    expect(await readTableTalkGate()).toMatchObject({ allowed: true });
    expect(reads()).toBe(2);
    vi.advanceTimersByTime(TABLE_TALK_GATE_TTL_MS - 1);
    expect(await readTableTalkGate()).toMatchObject({ allowed: true });
    expect(reads()).toBe(2);
    // the owner flips the mode off; the cached yes is still served until the TTL
    h.state.mode = { data: { mode: 'table_talk', enabled: false }, error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: true });
    expect(reads()).toBe(2);
    vi.advanceTimersByTime(1);
    // exactly 30 s old: never used
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'mode_off' });
    expect(reads()).toBe(4);
  });

  it('a verdict older than the TTL is never used, even when the clock jumps', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T12:00:00Z') });
    expect(await readTableTalkGate()).toMatchObject({ allowed: true });
    vi.advanceTimersByTime(10 * 60_000);
    h.state.settings = { data: [{ engine_enabled: false }], error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'engine_off' });
    expect(reads()).toBe(4);
  });

  it('an off answer is cached as well: a disabled mode does not cost two reads per hand', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-06T12:00:00Z') });
    h.state.mode = { data: { mode: 'table_talk', enabled: false }, error: null };
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'mode_off' });
    expect(await readTableTalkGate()).toMatchObject({ allowed: false, reason: 'mode_off' });
    expect(reads()).toBe(2);
  });

  it('concurrent callers share one read in flight', async () => {
    const [a, b, c] = await Promise.all([
      readTableTalkGate(),
      readTableTalkGate(),
      readTableTalkGate(),
    ]);
    expect(a.allowed && b.allowed && c.allowed).toBe(true);
    expect(reads()).toBe(2);
  });
});
