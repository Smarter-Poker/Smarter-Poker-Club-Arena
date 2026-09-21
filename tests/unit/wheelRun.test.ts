/**
 * THE RUN IS THE SERVER'S (owner ruling 2026-09-21, R18). The client declares
 * a run before its first spin and closes it after its last, and reads the
 * open run and the queue of unplayed games back from the wheel state so a
 * refresh loses neither. Every field is tolerated when absent: the client
 * ships before the migration, and an older server simply has no run and no
 * queue.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
const rpc = vi.hoisted(() => vi.fn());
vi.mock('../../src/lib/supabase', () => ({ supabase: { rpc } }));
import service from '../../src/services/DiamondWheelService';

const CLUB = '10000000-0000-0000-0000-000000000002';
const RUN = '10000000-0000-0000-0000-000000000009';
const award = {
  id: '10000000-0000-0000-0000-000000000031',
  game: 'mines',
  base_diamonds: 100,
  boost_multiplier: 1,
  entry_diamonds: 100,
  created_at: '2026-09-21T15:00:00Z',
};
const twelve = Array.from({ length: 12 }, (_, i) => ({
  ord: i + 1,
  kind:
    i < 4
      ? 'bonus'
      : i === 4
        ? 'upgrade'
        : i < 8
          ? 'chips'
          : ['throwables', 'time_bank', 'rabbit_hunt', 'diamonds'][i - 8],
  game: i < 4 ? ['plinko', 'crash', 'crossing', 'mines'][i] : undefined,
  amount: 1,
  value_chips: 1,
  weight: 1,
  probability: 1 / 12,
  locked: false,
}));
const baseState = {
  ok: true,
  enabled: true,
  contract_version: 2,
  available: true,
  min_entry: 25,
  max_entry: 2500,
  host_id: CLUB,
  host_kind: 'club',
  segments: twelve,
};
beforeEach(() => rpc.mockReset());

describe('fn_wheel_run_begin and fn_wheel_run_end', () => {
  it('declares a run of N spins and reads the server run back', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, run_id: RUN, spins: 10, spins_done: 0 },
      error: null,
    });
    await expect(service.runBegin(CLUB, 10)).resolves.toEqual({
      ok: true,
      run_id: RUN,
      spins: 10,
      spins_done: 0,
    });
    expect(rpc).toHaveBeenCalledWith('fn_wheel_run_begin', { p_club_id: CLUB, p_spins: 10 });
  });

  it('passes a refusal through with its reason and starts nothing', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: false, error: 'Finish Your Bonus Game Before Another Spin' },
      error: null,
    });
    await expect(service.runBegin(CLUB, 5)).resolves.toMatchObject({
      ok: false,
      error: 'Finish Your Bonus Game Before Another Spin',
    });
  });

  it('refuses a run the server did not confirm at the asked size, or not at all', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, run_id: RUN, spins: 7, spins_done: 0 },
      error: null,
    });
    await expect(service.runBegin(CLUB, 5)).rejects.toThrow('The Run Could Not Be Confirmed');
    rpc.mockResolvedValueOnce({
      data: { ok: true, run_id: 'not-a-uuid', spins: 5, spins_done: 0 },
      error: null,
    });
    await expect(service.runBegin(CLUB, 5)).rejects.toThrow('The Run Could Not Be Confirmed');
    rpc.mockResolvedValueOnce({ data: null, error: null });
    await expect(service.runBegin(CLUB, 5)).rejects.toThrow('The Run Could Not Be Started');
    rpc.mockResolvedValueOnce({
      data: null,
      error: new Error('function fn_wheel_run_begin does not exist'),
    });
    await expect(service.runBegin(CLUB, 5)).rejects.toThrow('does not exist');
  });

  it('closes a run and returns the games it left unplayed, normalised', async () => {
    rpc.mockResolvedValueOnce({
      data: { ok: true, run_id: RUN, spins_done: '4', pending_awards: [award, null, 'junk'] },
      error: null,
    });
    await expect(service.runEnd(RUN)).resolves.toEqual({
      ok: true,
      run_id: RUN,
      spins_done: 4,
      pending_awards: [award],
    });
    expect(rpc).toHaveBeenCalledWith('fn_wheel_run_end', { p_run_id: RUN });
  });

  it('a closed run with no queue reads as an empty queue, and a refusal keeps its reason', async () => {
    rpc.mockResolvedValueOnce({ data: { ok: true, run_id: RUN, spins_done: 10 }, error: null });
    await expect(service.runEnd(RUN)).resolves.toEqual({
      ok: true,
      run_id: RUN,
      spins_done: 10,
      pending_awards: [],
    });
    rpc.mockResolvedValueOnce({ data: { ok: false, error: 'No Open Run' }, error: null });
    await expect(service.runEnd(RUN)).resolves.toMatchObject({ ok: false, error: 'No Open Run' });
    rpc.mockResolvedValueOnce({ data: { ok: true, run_id: 'other', spins_done: 1 }, error: null });
    await expect(service.runEnd(RUN)).rejects.toThrow('The Run Could Not Be Confirmed');
  });
});

describe('fn_wheel_state_v2 carries the open run and the queue, or neither', () => {
  it('reads auto_run and pending_awards from the R18 server', async () => {
    rpc.mockResolvedValueOnce({
      data: {
        ...baseState,
        auto_run: { run_id: RUN, spins: '25', spins_done: 3 },
        pending_awards: [award],
      },
      error: null,
    });
    const state = await service.getStateV2(CLUB, 100);
    expect(state.auto_run).toEqual({ run_id: RUN, spins: 25, spins_done: 3 });
    expect(state.pending_awards).toEqual([award]);
  });

  it('reads the older server, which names the queue `awards` and has no run', async () => {
    const { created_at: _dropped, ...older } = award;
    rpc.mockResolvedValueOnce({ data: { ...baseState, awards: [older] }, error: null });
    const state = await service.getStateV2(CLUB, 100);
    expect(state.auto_run).toBeNull();
    expect(state.pending_awards).toEqual([older]);
    expect(state.pending_awards![0]).not.toHaveProperty('created_at');
  });

  it('a malformed run is no run at all, never a run to resume', async () => {
    for (const auto_run of [
      { run_id: RUN, spins: 0, spins_done: 0 },
      { run_id: RUN, spins: 5, spins_done: 6 },
      { run_id: RUN, spins: 5, spins_done: -1 },
      { run_id: 'x', spins: 5, spins_done: 1 },
      { run_id: RUN, spins: 2.5, spins_done: 1 },
      'open',
      [],
      null,
    ]) {
      rpc.mockResolvedValueOnce({ data: { ...baseState, auto_run }, error: null });
      const state = await service.getStateV2(CLUB, 100);
      expect(state.auto_run, JSON.stringify(auto_run)).toBeNull();
    }
  });
});
