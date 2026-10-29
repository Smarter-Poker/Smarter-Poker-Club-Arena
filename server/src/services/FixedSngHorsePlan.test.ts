import { describe, expect, it, vi } from 'vitest';
import { fixedSngHorseCount } from './FixedSngHorsePlan.js';
import { TournamentRecurringService } from './TournamentRecurringService.js';
import { supabase } from './supabase.js';
const controls = vi.hoisted(() => ({ frozen: false }));
vi.mock('../maintenance/freezeState.js', () => ({ isMaintenanceFrozen: () => controls.frozen }));
vi.mock('./supabase/pagination.js', () => ({ fetchAllRows: vi.fn() }));
import { fetchAllRows } from './supabase/pagination.js';
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));
describe('fixed satellite paid admission plans', () => {
  it.each([6, 9])('keeps the final human seat while a %s-player field waits', (seats) => {
    expect(fixedSngHorseCount({ ok: true, target_players: seats - 1 }, seats, 0, seats)).toBe(
      seats - 1
    );
    expect(
      fixedSngHorseCount({ ok: true, target_players: seats - 1 }, seats, seats - 1, seats)
    ).toBe(0);
    expect(fixedSngHorseCount({ ok: true, target_players: seats }, seats, seats - 1, seats)).toBe(
      1
    );
  });
  it.each([
    null,
    {},
    { ok: false, target_players: 9 },
    { ok: true, target_players: '9' },
    { ok: true, target_players: 10 },
    { ok: true, target_players: 8.5 },
  ])('refuses unreadable or unadmitted plan %j', (plan) => {
    expect(fixedSngHorseCount(plan, 9, 0, 9)).toBe(0);
  });
  it('does not buy after a full field or exceed the requested shortfall', () => {
    expect(fixedSngHorseCount({ ok: true, target_players: 9 }, 9, 9, 9)).toBe(0);
    expect(fixedSngHorseCount({ ok: true, target_players: 9 }, 9, 3, 2)).toBe(2);
  });
  it('blocks every automated caller before horse selection when the union plan refuses', async () => {
    const service = new TournamentRecurringService() as any;
    const load = vi.spyOn(service, 'horseLoadMap').mockResolvedValue(null);
    const event = {
      format_contract: 'sng-v1',
      tournament_type: 'SNG',
      variant: 'sng',
      max_players: 9,
      min_players: 9,
      table_size: 9,
      satellite_seats: 2,
      satellite_target_id: 'target',
      current_players: 0,
    };
    const from = vi.spyOn(supabase, 'from').mockImplementation(() => {
      const b: any = {};
      for (const k of ['select', 'eq']) b[k] = () => b;
      b.maybeSingle = async () => ({ data: event, error: null });
      return b;
    });
    const rpc = vi
      .spyOn(supabase, 'rpc')
      .mockResolvedValue({ data: { ok: false, reason: 'daily_budget' }, error: null } as never);
    try {
      expect(await service.registerHorses('satellite', 9)).toBe(0);
      expect(rpc).toHaveBeenCalledWith('fn_sng_satellite_horse_fill_plan', {
        p_tournament_id: 'satellite',
      });
      expect(load).not.toHaveBeenCalled();
      rpc.mockClear();
      event.format_contract = 'mtt-v2';
      await service.registerHorses('satellite', 9);
      expect(rpc).not.toHaveBeenCalled();
    } finally {
      from.mockRestore();
      rpc.mockRestore();
      load.mockRestore();
    }
  });
});

describe('existing SNG tick fixed satellite producer', () => {
  const board = (id: string, seats = 9) => ({
    id,
    current_players: 0,
    union_id: 'union',
    format_contract: 'sng-v1',
    tournament_type: 'SNG',
    variant: 'sng',
    max_players: seats,
    min_players: seats,
    table_size: seats,
    satellite_seats: 2,
    satellite_target_id: 'target',
  });
  it('reads the complete union domain then bounds paid attempts to twelve exact fields', async () => {
    const service = new TournamentRecurringService() as any;
    const topUp = vi.spyOn(service, 'topUpWithHorses').mockResolvedValue(0);
    const calls: unknown[][] = [];
    const from = vi.spyOn(supabase, 'from').mockImplementation(() => {
      const b: any = {};
      for (const k of ['select', 'eq', 'in', 'not', 'or', 'order', 'limit', 'gt'])
        b[k] = (...args: unknown[]) => {
          calls.push([k, ...args]);
          return b;
        };
      return b;
    });
    vi.mocked(fetchAllRows).mockImplementationOnce(async (query, options) => {
      expect(options?.maxRows).toBe(50_000);
      query('cursor', 1000);
      return {
        complete: true,
        rows: [
          ...Array.from({ length: 15 }, (_, i) => ({
            ...board(`board-${i}`, i % 2 ? 6 : 9),
            satellite_target_id: null,
            satellite_target: 'target',
          })),
          { ...board('club-only'), union_id: null },
          { ...board('contradictory'), table_size: 3 },
        ],
      };
    });
    try {
      await service.fillFixedSngSatellites();
      expect(calls).toContainEqual(['not', 'union_id', 'is', null]);
      expect(calls).toContainEqual([
        'or',
        'satellite_target_id.not.is.null,satellite_target.not.is.null',
      ]);
      expect(calls).toContainEqual(['gt', 'id', 'cursor']);
      expect(topUp).toHaveBeenCalledTimes(12);
      expect(new Set(topUp.mock.calls.map((c) => c[0])).size).toBe(12);
      for (const [id, target] of topUp.mock.calls) {
        expect(id).toMatch(/^board-/);
        expect(target).toBe(Number(String(id).slice(6)) % 2 ? 6 : 9);
      }
    } finally {
      from.mockRestore();
      topUp.mockRestore();
    }
  });
  it('does not act on an incomplete read or after lifecycle stop/freeze', async () => {
    const service = new TournamentRecurringService() as any;
    const topUp = vi.spyOn(service, 'topUpWithHorses').mockResolvedValue(0);
    vi.mocked(fetchAllRows).mockResolvedValueOnce({ complete: false, rows: [board('partial')] });
    await service.fillFixedSngSatellites();
    service.stopOperation = Promise.resolve();
    await service.fillFixedSngSatellites();
    service.stopOperation = null;
    controls.frozen = true;
    try {
      await service.fillFixedSngSatellites();
      expect(topUp).not.toHaveBeenCalled();
    } finally {
      controls.frozen = false;
      topUp.mockRestore();
    }
  });
  it('serves durable paid and unknown continuations before twelve new boards after every restart', async () => {
    const rows = [
      ...Array.from({ length: 29 }, (_, i) => board(`empty-${i}`)),
      { ...board('paid-outside-twelve'), current_players: 8 },
      { ...board('unknown'), current_players: null },
      { ...board('full-cache'), current_players: 9 },
    ];
    for (let restart = 0; restart < 2; restart++) {
      const service = new TournamentRecurringService() as any;
      const topUp = vi.spyOn(service, 'topUpWithHorses').mockResolvedValue(0);
      vi.mocked(fetchAllRows).mockResolvedValueOnce({ complete: true, rows });
      await service.fillFixedSngSatellites();
      expect(topUp.mock.calls.slice(0, 3).map((call) => call[0])).toEqual([
        'paid-outside-twelve',
        'unknown',
        'full-cache',
      ]);
      expect(topUp).toHaveBeenCalledTimes(15);
      topUp.mockRestore();
    }
  });
});
