/**
 * A BENCHED HORSE IS NOT A FREE HORSE (2026-10-12).
 *
 * pickFreeHorses fills every seat-first board (Spins, Heads-Up, SNGs, the
 * past-start top-up and the board opener). It read every `is_horse` profile,
 * including the 62 identities retired on 2026-10-06 (horse_status
 * 'disabled', zero chips in every club wallet). A benched horse is never
 * seated, so it is never busy, so it was always in the free pool, and the
 * seat door refused it for insufficient_balance every time it was offered.
 * Engine 0a8f92f4, three hours on 2026-10-12: 5,288 such refusals and nine
 * SEAT-FIRST BOARD STUCK reports.
 *
 * This runs the real pickFreeHorses against a fleet that holds both kinds
 * and proves only a horse that can play is ever offered, and that an active
 * horse is offered exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { id: string; is_horse: boolean; horse_status: string | null };
let profiles: Row[] = [];

vi.mock('./supabase/client.js', () => {
  const builder = (table: string) => {
    const preds: Array<(r: Row) => boolean> = [];
    let cursor: string | null = null;
    let lim = Infinity;
    const b: Record<string, unknown> = {};
    b.select = () => b;
    b.eq = (col: keyof Row, v: unknown) => {
      preds.push((r) => r[col] === v);
      return b;
    };
    b.neq = (col: keyof Row, v: unknown) => {
      // PostgREST neq is SQL <>: a NULL never matches.
      preds.push((r) => r[col] !== null && r[col] !== v);
      return b;
    };
    b.order = () => b;
    b.limit = (n: number) => {
      lim = n;
      return b;
    };
    b.gt = (_col: string, v: string) => {
      cursor = v;
      return b;
    };
    const answer = () => {
      if (table !== 'profiles') return Promise.resolve({ data: [], error: null });
      const rows = profiles
        .filter((r) => preds.every((p) => p(r)))
        .filter((r) => cursor === null || r.id > cursor)
        .sort((a, z) => (a.id < z.id ? -1 : 1))
        .slice(0, lim)
        .map((r) => ({ id: r.id }));
      return Promise.resolve({ data: rows, error: null });
    };
    b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => answer().then(ok, bad);
    return b;
  };
  const client = { rpc: vi.fn(), from: (table: string) => builder(table) };
  return { supabase: client, maintenanceSupabase: client };
});
vi.mock('./errorReporter.js', () => ({ reportError: vi.fn() }));

import { TournamentRecurringService } from './TournamentRecurringService.js';

const id = (prefix: string, n: number) =>
  `${prefix}${n.toString(16).padStart(4, '0')}-0000-4000-8000-000000000000`;

describe('the seat-first free pool', () => {
  let svc: TournamentRecurringService;
  const active = Array.from({ length: 400 }, (_, n) => id('a000', n));
  const benched = Array.from({ length: 62 }, (_, n) => id('0000', n));

  beforeEach(() => {
    profiles = [
      ...active.map((i) => ({ id: i, is_horse: true, horse_status: 'available' })),
      ...benched.map((i) => ({ id: i, is_horse: true, horse_status: 'disabled' })),
    ];
    svc = new TournamentRecurringService();
    vi.spyOn(
      svc as unknown as { horseLoadMap: () => Promise<Map<string, number> | null> },
      'horseLoadMap'
    ).mockResolvedValue(new Map());
    vi.spyOn(
      svc as unknown as { cashRoomReserve: () => Promise<number> },
      'cashRoomReserve'
    ).mockResolvedValue(0);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  const pick = (count: number, allLanes: boolean) =>
    (
      svc as unknown as { pickFreeHorses: (c: number, a: boolean) => Promise<string[]> }
    ).pickFreeHorses(count, allLanes);

  it('never offers a benched horse, however many seats are asked for', async () => {
    for (const allLanes of [false, true]) {
      const picked = await pick(1000, allLanes);
      expect(picked.length).toBeGreaterThan(0);
      for (const h of picked) expect(benched).not.toContain(h);
    }
  });

  it('offers an active horse exactly as before', async () => {
    const picked = await pick(5, true);
    expect(picked).toHaveLength(5);
    for (const h of picked) expect(active).toContain(h);
  });

  it('with only benched horses idle, offers nobody rather than a seat the door must refuse', async () => {
    profiles = benched.map((i) => ({ id: i, is_horse: true, horse_status: 'disabled' }));
    expect(await pick(3, true)).toEqual([]);
  });
});
