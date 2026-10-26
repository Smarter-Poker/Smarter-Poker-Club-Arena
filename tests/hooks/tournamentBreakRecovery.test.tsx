import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useTableTournament } from '../../src/hooks/useTableTournament';

const db = vi.hoisted(() => ({ reads: [] as Array<{ id: string; resolve: (v: any) => void }> }));
vi.mock('../../src/lib/supabase', () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: (_: string, id: string) => ({
          maybeSingle: () => new Promise((resolve) => db.reads.push({ id, resolve })),
        }),
      }),
    }),
  },
}));
vi.mock('../../src/utils/errorReporter', () => ({ reportError: vi.fn() }));
const active = {
  active: true,
  phase: 'counting_down' as const,
  breakEndsAtMs: 1000,
  timeRemaining: 0,
};
const ended = { data: { id: 'A', on_break: false, break_ends_at: null }, error: null };
afterEach(() => {
  cleanup();
  db.reads.length = 0;
});
function mount() {
  // The production hook must recover on socket continuity, without a timer.
  return renderHook(
    ({ id, status }) => useTableTournament({ tournamentId: id, engineStatus: status }),
    {
      initialProps: { id: 'A', status: 'connected' },
    }
  );
}
async function answer(index: number, value: any) {
  await act(async () => {
    db.reads[index].resolve(value);
  });
}
it('removes a stale break after reconnect when break_ended was lost', async () => {
  const { result, rerender } = mount();
  if (db.reads[0]) await answer(0, ended);
  act(() => result.current.setTournamentBreak(active));
  rerender({ id: 'A', status: 'reconnecting' });
  expect(result.current.tournamentBreak.active).toBe(true);
  rerender({ id: 'A', status: 'connected' });
  if (db.reads[1]) await answer(1, ended);
  expect(result.current.tournamentBreak.active).toBe(false);
  expect(result.current.tournamentBreak.timeRemaining).toBe(0);
});
it('restores a break missed entirely while disconnected, using its original deadline', async () => {
  const { result } = mount();
  const deadline = Date.now() + 42_000;
  await answer(0, {
    data: {
      id: 'A',
      on_break: true,
      break_ends_at: new Date(deadline).toISOString(),
      current_level: 4,
    },
    error: null,
  });
  expect(result.current.tournamentBreak).toMatchObject({
    active: true,
    phase: 'counting_down',
    breakEndsAtMs: deadline,
    level: 4,
  });
  expect(result.current.tournamentBreak.timeRemaining).toBeLessThanOrEqual(42);
});
it('does not unpause on an expired deadline while the server still owns the break', async () => {
  const { result } = mount();
  await answer(0, {
    data: { id: 'A', on_break: true, break_ends_at: new Date(Date.now() - 1000).toISOString() },
    error: null,
  });
  expect(result.current.tournamentBreak).toMatchObject({ active: true, timeRemaining: 0 });
});
it('keeps the last-hand phase when the authoritative countdown has not started', async () => {
  const { result } = mount();
  await answer(0, { data: { id: 'A', on_break: true, break_ends_at: null }, error: null });
  expect(result.current.tournamentBreak).toMatchObject({
    active: true,
    phase: 'last_hand',
    breakEndsAtMs: null,
  });
});
it.each([
  { data: null, error: { message: 'offline' } },
  { data: null, error: null },
  { data: { id: 'A', on_break: null }, error: null },
])('preserves known state when the read is unknown: %j', async (response) => {
  const { result } = mount();
  act(() => result.current.setTournamentBreak(active));
  // A fresh explicit reconnect read starts after the last known event.
  act(() => {
    void result.current.refreshTournamentBreak();
  });
  await answer(1, response);
  expect(result.current.tournamentBreak.active).toBe(true);
});
it('does not let an old row overwrite a newer live break event', async () => {
  const { result } = mount();
  act(() => result.current.setTournamentBreak(active));
  await answer(0, ended);
  expect(result.current.tournamentBreak).toEqual(active);
});
it('does not let an old row reopen a break after the live end event', async () => {
  const { result } = mount();
  act(() => result.current.setTournamentBreak({ active: false, timeRemaining: 0 }));
  await answer(0, { data: { id: 'A', on_break: true, break_ends_at: null }, error: null });
  expect(result.current.tournamentBreak.active).toBe(false);
});
it('retires reads and old callbacks on table/tournament switch', async () => {
  const { result, rerender } = mount();
  const oldRefresh = result.current.refreshTournamentBreak;
  rerender({ id: 'B', status: 'connected' });
  await answer(1, { data: { id: 'B', on_break: false }, error: null });
  await answer(0, { data: { id: 'A', on_break: true, break_ends_at: null }, error: null });
  expect(result.current.tournamentBreak.active).toBe(false);
  await act(async () => {
    await oldRefresh();
  });
  expect(db.reads).toHaveLength(2);
});
it('ignores a superseded recovery response and retires reads on unmount', async () => {
  const { result, unmount } = mount();
  act(() => {
    void result.current.refreshTournamentBreak();
  });
  await answer(1, ended);
  await answer(0, { data: { id: 'A', on_break: true, break_ends_at: null }, error: null });
  expect(result.current.tournamentBreak.active).toBe(false);
  const refresh = result.current.refreshTournamentBreak;
  unmount();
  await refresh();
  expect(db.reads).toHaveLength(2);
});

it('keeps the live-event setter valid when bootstrap first discovers the tournament', async () => {
  const { result, rerender } = renderHook(({ id }) => useTableTournament({ tournamentId: id }), {
    initialProps: { id: null as string | null },
  });
  const retainedSetter = result.current.setTournamentBreak;
  rerender({ id: 'A' });
  act(() => retainedSetter(active));
  await answer(0, ended);
  expect(result.current.tournamentBreak).toEqual(active);
});
it('retires the first A read across A -> B -> A', async () => {
  const { result, rerender } = mount();
  rerender({ id: 'B', status: 'connected' });
  rerender({ id: 'A', status: 'connected' });
  await answer(2, ended);
  await answer(0, { data: { id: 'A', on_break: true, break_ends_at: null }, error: null });
  expect(result.current.tournamentBreak.active).toBe(false);
});
