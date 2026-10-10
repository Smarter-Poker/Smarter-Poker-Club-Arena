import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../src/lib/supabase', async () => {
  const { createClient } = await import('@supabase/supabase-js');
  return {
    supabase: createClient('https://fixture.example.invalid', 'fixture-public-key', {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: (...args: Parameters<typeof fetch>) => state.fetch(...args) },
    }),
  };
});
import ClubRosterService, { MemberAccessDeniedError } from '../../src/services/ClubRosterService';
import { RequestDeadlineError } from '../../src/utils/requestDeadline';
import { RosterReadTimeoutError } from '../../src/utils/rosterReadReliability';

beforeEach(() => {
  vi.useFakeTimers();
  state.fetch.mockReset();
});
afterEach(() => vi.useRealTimers());
const calls = [
  () => ClubRosterService.getRoster('club'),
  () => ClubRosterService.getMemberDetail('club', 'player'),
  () => ClubRosterService.getDownline('club', 'player'),
  () => ClubRosterService.getMemberStatistics('club', 'player'),
  () => ClubRosterService.getGrantableRoles('club', 'player'),
];

describe('real PostgREST member reads have one request deadline', () => {
  it.each(calls.map((call, i) => [i, call] as const))(
    'bounds stalled transport for read %i',
    async (_i, call) => {
      state.fetch.mockImplementation(() => new Promise(() => {}));
      const pending = call();
      const rejected = expect(pending).rejects.toBeInstanceOf(RosterReadTimeoutError);
      await vi.advanceTimersByTimeAsync(40_000);
      await rejected;
      expect(state.fetch).toHaveBeenCalledTimes(1);
      expect(state.fetch.mock.calls[0][1].signal.aborted).toBe(true);
    }
  );
  it('bounds response decoding after successful headers', async () => {
    state.fetch.mockResolvedValue(
      new Response(new ReadableStream({ start() {} }), { status: 200 })
    );
    const pending = ClubRosterService.getMemberStatistics('club', 'player');
    const rejected = expect(pending).rejects.toBeInstanceOf(RosterReadTimeoutError);
    await vi.advanceTimersByTimeAsync(40_000);
    await rejected;
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it('cancels superseded reads without a second request', async () => {
    state.fetch.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = ClubRosterService.getMemberDetail(
      'club',
      'player',
      undefined,
      controller.signal
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await rejected;
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it('returns permission denial once and never reports an empty success', async () => {
    state.fetch.mockResolvedValue(
      new Response(JSON.stringify({ code: '42501', message: 'denied' }), { status: 403 })
    );
    await expect(ClubRosterService.getMemberStatistics('club', 'player')).rejects.toMatchObject({
      code: '42501',
    });
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it.each(calls.map((call, i) => [i, call] as const))(
    'distinguishes a null access denial from incomplete reads for read %i',
    async (i, call) => {
      state.fetch.mockResolvedValue(new Response('null', { status: 200 }));
      if (i === 1) await expect(call()).rejects.toBeInstanceOf(MemberAccessDeniedError);
      else await expect(call()).rejects.toThrow(/Incomplete/);
    }
  );
  it('keeps an explicit statistics restriction', async () => {
    state.fetch.mockResolvedValue(
      new Response(JSON.stringify({ authorized: false, reason: 'restricted' }), { status: 200 })
    );
    await expect(ClubRosterService.getMemberStatistics('club', 'player')).resolves.toMatchObject({
      authorized: false,
      reason: 'restricted',
    });
  });
});

describe('audited member operations never retry an unknown acknowledgement', () => {
  it.each([
    () => ClubRosterService.exportRoster('club', {}),
    () => ClubRosterService.updateMemberNotes('club', 'player', 'Name', 'Note', 'receipt'),
  ])('bounds one operation without replay', async (call) => {
    state.fetch.mockImplementation(() => new Promise(() => {}));
    const pending = call();
    const rejected = expect(pending).rejects.toBeInstanceOf(RequestDeadlineError);
    await vi.advanceTimersByTimeAsync(40_000);
    await rejected;
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it('refuses an incomplete export instead of downloading an empty success', async () => {
    state.fetch.mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
    await expect(ClubRosterService.exportRoster('club', {})).rejects.toThrow('Incomplete');
  });
});

describe('directory response truth', () => {
  it.each([
    null,
    {},
    { items: [], has_more: false },
    { items: [], has_more: false, filtered_total: 'unknown' },
    { items: [], has_more: false, filtered_total: true },
    { items: [null], has_more: false, filtered_total: 1 },
    { items: [], has_more: true, filtered_total: 1, next_cursor: null },
  ])('rejects incomplete directory success %j', async (data) => {
    state.fetch.mockResolvedValue(new Response(JSON.stringify(data), { status: 200 }));
    await expect(ClubRosterService.getRosterPage('club')).rejects.toThrow(/Incomplete/);
    expect(state.fetch).toHaveBeenCalledTimes(1);
  });
  it('keeps a genuine empty directory valid', async () => {
    state.fetch.mockResolvedValue(
      new Response(
        JSON.stringify({ items: [], has_more: false, filtered_total: 0, next_cursor: null }),
        { status: 200 }
      )
    );
    await expect(ClubRosterService.getRosterPage('club')).resolves.toMatchObject({
      items: [],
      filtered_total: 0,
    });
  });
  it('refuses incomplete summary totals but preserves explicit access denial', async () => {
    state.fetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await expect(ClubRosterService.getSummary('club')).rejects.toThrow(/Incomplete/);
    state.fetch.mockResolvedValueOnce(new Response('null', { status: 200 }));
    await expect(ClubRosterService.getSummary('club')).resolves.toBeNull();
  });
});
